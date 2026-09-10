/** NInfer transport mechanics; admission and retry decisions belong to the harness. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  attributionHeaders,
  assertUsableApiKey,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmRequestInspection,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  StreamChunk,
  GenerationDiagnostics,
} from '@deepseek-ai/dsh-llm'
import OpenAI from 'openai'
import { z } from 'zod'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions'
import type { Settings } from './config.js'
import { prepareBody } from './wire.js'

const countSchema = z.object({
  version: z.literal(1),
  instance_id: z.string().min(1),
  model: z.string(),
  input_tokens: z.number().int().nonnegative(),
  context_window: z.number().int().positive(),
  thinking_budget: z.number().int().nonnegative().nullable(),
  thinking_closure_tokens: z.number().int().nonnegative(),
})
const diagnosticSchema = z.object({
  version: z.literal(1),
  instance_id: z.string(),
  cause: z.enum(['stop', 'output_limit', 'context_capacity', 'cancelled']),
  tool_status: z.enum(['absent', 'complete', 'incomplete', 'invalid']),
  input_tokens: z.number().int().nonnegative(),
  effective_output_tokens: z.number().int().nonnegative(),
  fragment: z.string().optional(),
})
type Body = Awaited<ReturnType<typeof prepareBody>>
type Prepared = { body: Body; inspection: LlmRequestInspection }

function requestKey(options: GenerateOptions): string {
  return JSON.stringify({ ...options, signal: undefined })
}

export class NinferAdapter extends LlmAdapter {
  constructor(
    private readonly ctx: Context,
    private readonly settings: Settings,
  ) {
    super()
  }
  override providerInfo(provider: string) {
    return { id: provider, name: 'NInfer local' }
  }
  override async listModels(provider: string) {
    return Promise.all(this.settings.models.map((m) => this.resolveModel(provider, m.id)))
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = this.settings.models.find((m) => m.id === model)
    if (!entry) throw new LlmError(`Model ${model} is not configured for NInfer`, 'UNKNOWN_MODEL')
    return {
      provider,
      id: model,
      name: entry.name ?? model,
      context: { contextWindow: entry.contextWindow },
      inputModalities: ['text', 'image'],
      ...(entry.maxTokens === undefined ? {} : { defaultMaxTokens: entry.maxTokens }),
      reasoning: {
        defaultEffort: ReasoningEffortId('medium'),
        efforts: ['off', 'low', 'medium', 'xhigh'].map((id) => ({ id: ReasoningEffortId(id), name: id })),
      },
    }
  }
  private async client(): Promise<OpenAI> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.settings.credentialRef))
    const key = assertUsableApiKey(resolved?.value ?? '', 'dsh-llm-ninfer', this.settings.credentialRef)
    return new OpenAI({
      apiKey: key,
      baseURL: this.settings.baseURL,
      maxRetries: 0,
      timeout: this.settings.requestTimeoutMs,
      defaultHeaders: attributionHeaders(),
    })
  }
  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    signal?.throwIfAborted()
    const modelInfo = await this.resolveModel(provider, model)
    const client = await this.client()
    let key: string | undefined
    let pending: Promise<Prepared> | undefined
    const prepare = (options: GenerateOptions): Promise<Prepared> => {
      const actual = requestKey(options)
      if (key !== undefined && actual !== key)
        throw new LlmError('Counted request changed before dispatch', 'INVALID_PREPARED_CALL')
      key = actual
      return (pending ??= this.prepareRequest(client, options))
    }
    return {
      model: modelInfo,
      inspect: async (options) => (await prepare(options)).inspection,
      stream: (options) => this.dispatch(client, options, prepare(options)),
    }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const call = await this.prepareCall(options.provider, options.model, options.signal)
    yield* call.stream(options)
  }
  private async prepareRequest(client: OpenAI, options: GenerateOptions): Promise<Prepared> {
    const body = await prepareBody(this.ctx, options)
    let raw: unknown
    try {
      raw = await client.post('/chat/completions/count_tokens', {
        body: { ...body, stream: false },
        signal: options.signal,
      })
    } catch (error) {
      throw transportError(error)
    }
    const parsed = countSchema.safeParse(raw)
    if (!parsed.success)
      throw new LlmError(
        'NInfer does not expose a valid versioned native token count',
        'NINFER_COUNT_UNAVAILABLE',
      )
    const count = parsed.data
    if (count.model !== options.model)
      throw new LlmError('NInfer model changed during preparation', 'NINFER_MODEL_CHANGED')
    if (count.thinking_budget === null)
      throw new LlmError(
        'NInfer must configure a bounded thinking budget for this route',
        'NINFER_THINKING_UNBOUNDED',
      )
    const available = count.context_window - count.input_tokens - this.settings.safetyMargin
    const maxOutputTokens = Math.min(options.maxTokens ?? Infinity, available)
    const inspection: LlmRequestInspection = Object.freeze({
      instanceId: count.instance_id,
      inputTokens: count.input_tokens,
      contextWindow: count.context_window,
      thinkingTokens: count.thinking_budget,
      thinkingClosureTokens: count.thinking_closure_tokens,
      maxOutputTokens,
      contentReserve: this.settings.contentReserve,
      safetyMargin: this.settings.safetyMargin,
      compactionThreshold: this.settings.compactionThreshold,
      ...(options.maxTokens === undefined ? {} : { hardOutputCap: options.maxTokens }),
    })
    // Output controls do not affect prompt tokenization. The counted prompt and media stay identical.
    body.max_tokens = maxOutputTokens
    return { body, inspection }
  }
  private async *dispatch(
    client: OpenAI,
    options: GenerateOptions,
    prepared: Promise<Prepared>,
  ): AsyncIterable<StreamChunk> {
    const { body, inspection } = await prepared
    if (inspection.maxOutputTokens <= 0)
      throw new LlmError(
        'No output capacity remains after counting the complete request',
        'CONTEXT_WINDOW_EXCEEDED',
      )
    const texts = new Map<number, string>()
    const opened = new Set<number>()
    const calls = new Map<number, { id: string; name: string; arguments: string }>()
    let finish: string | null = null
    let diagnostic: z.output<typeof diagnosticSchema> | undefined
    let requestId: string | undefined
    try {
      const response = await client.chat.completions
        .create(body, {
          signal: options.signal,
          headers: { 'x-ninfer-instance-id': inspection.instanceId, 'x-ninfer-diagnostics': 'fragments' },
        })
        .withResponse()
      requestId = response.request_id ?? undefined
      for await (const raw of response.data) {
        options.signal?.throwIfAborted()
        requestId ??= raw.id
        const native = raw as ChatCompletionChunk & { ninfer?: unknown }
        if (native.ninfer !== undefined) {
          diagnostic = diagnosticSchema.parse(native.ninfer)
          if (diagnostic.instance_id !== inspection.instanceId)
            throw new LlmError('NInfer restarted after token counting', 'NINFER_INSTANCE_CHANGED')
          if (
            diagnostic.input_tokens !== inspection.inputTokens ||
            diagnostic.effective_output_tokens > inspection.maxOutputTokens
          )
            throw new LlmError(
              'NInfer diagnostics differ from the prepared request budget',
              'NINFER_COUNT_MISMATCH',
            )
        }
        if (raw.usage && raw.usage.prompt_tokens !== inspection.inputTokens)
          throw new LlmError(
            'NInfer generation input differs from its prepared token count',
            'NINFER_COUNT_MISMATCH',
          )
        if (raw.usage)
          yield {
            type: 'usage',
            usage: {
              inputTokens: raw.usage.prompt_tokens - (raw.usage.prompt_tokens_details?.cached_tokens ?? 0),
              cacheReadTokens: raw.usage.prompt_tokens_details?.cached_tokens ?? 0,
              outputTokens: raw.usage.completion_tokens,
              reasoningTokens: raw.usage.completion_tokens_details?.reasoning_tokens ?? 0,
              totalTokens: raw.usage.total_tokens,
            },
          }
        const choice = raw.choices[0]
        if (!choice) continue
        const delta = choice.delta as typeof choice.delta & { reasoning_content?: string }
        for (const [index, text, kind] of [
          [0, delta.reasoning_content, 'reasoning'],
          [1, delta.content, 'text'],
        ] as const) {
          if (!text) continue
          if (!opened.has(index)) {
            opened.add(index)
            texts.set(index, '')
            yield { type: 'block-start', index, blockType: kind }
          }
          texts.set(index, (texts.get(index) ?? '') + text)
          yield kind === 'text'
            ? { type: 'text-delta', index, text }
            : { type: 'reasoning-delta', index, text }
        }
        for (const call of delta.tool_calls ?? []) {
          const state = calls.get(call.index) ?? { id: '', name: '', arguments: '' }
          state.id += call.id ?? ''
          state.name += call.function?.name ?? ''
          state.arguments += call.function?.arguments ?? ''
          calls.set(call.index, state)
        }
        if (choice.finish_reason) finish = choice.finish_reason
      }
    } catch (error) {
      throw transportError(error)
    }
    for (const [index, text] of texts)
      yield {
        type: 'block-end',
        index,
        block: index === 0 ? { type: 'reasoning', text } : { type: 'text', text },
      }
    if (!finish) throw new LlmError('NInfer stream closed without a terminal reason', 'TRANSPORT')
    if (!diagnostic) throw new LlmError('NInfer omitted terminal diagnostics', 'NINFER_DIAGNOSTICS_MISSING')
    if (diagnostic.cause === 'cancelled') throw new LlmError('NInfer cancelled the generation', 'ABORTED')
    const limited = diagnostic.cause === 'output_limit' || diagnostic.cause === 'context_capacity'
    if ((finish === 'length') !== limited)
      throw new LlmError('NInfer terminal reason contradicts its diagnostics', 'NINFER_PROTOCOL_ERROR')
    if (finish === 'length') {
      const diagnostics: GenerationDiagnostics = {
        cause: diagnostic.cause === 'context_capacity' ? 'context-capacity' : 'output-limit',
        toolStatus: diagnostic.tool_status,
        instanceId: diagnostic.instance_id,
        inputTokens: diagnostic.input_tokens,
        effectiveOutputTokens: diagnostic.effective_output_tokens,
        ...(requestId ? { requestId } : {}),
        ...(diagnostic.fragment ? { fragment: diagnostic.fragment } : {}),
      }
      yield { type: 'finish', reason: { kind: 'max-tokens', diagnostics } }
      return
    }
    if (diagnostic.tool_status === 'invalid' || diagnostic.tool_status === 'incomplete')
      throw new LlmError('NInfer returned non-executable native tool output', 'invalid_model_output')
    if (finish !== 'stop' && finish !== 'tool_calls')
      throw new LlmError('NInfer returned an unsupported terminal reason', 'NINFER_PROTOCOL_ERROR')
    if (
      calls.size > 0 !== (diagnostic.tool_status === 'complete') ||
      calls.size > 0 !== (finish === 'tool_calls')
    )
      throw new LlmError('NInfer tool batch contradicts its terminal diagnostics', 'NINFER_PROTOCOL_ERROR')
    for (const [order, call] of calls) {
      if (!call.id || !call.name)
        throw new LlmError('NInfer returned an incomplete tool identity', 'invalid_model_output')
      const index = order + 2
      const id = ToolCallId(call.id)
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments }
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id, name: call.name, arguments: call.arguments },
      }
    }
    yield { type: 'finish', reason: { kind: calls.size ? 'tool-calls' : 'stop' } }
  }
}

function transportError(error: unknown): Error {
  if (error instanceof LlmError) return error
  if (error instanceof OpenAI.APIUserAbortError) return new LlmError('NInfer request cancelled', 'ABORTED')
  if (error instanceof OpenAI.APIConnectionTimeoutError)
    return new LlmError('NInfer request timed out', 'TIMEOUT')
  if (error instanceof OpenAI.APIConnectionError) return new LlmError('NInfer connection failed', 'TRANSPORT')
  if (error instanceof OpenAI.APIError) {
    const code =
      error.code === 'invalid_model_output'
        ? error.code
        : error.status === 401
          ? 'INVALID_CREDENTIAL'
          : error.status === 429
            ? 'RATE_LIMIT'
            : (error.status ?? 0) >= 500
              ? 'SERVER'
              : (error.code ?? 'PROVIDER_ERROR')
    return new LlmError(error.message, code, { ...(error.status ? { status: error.status } : {}) })
  }
  return error instanceof Error ? error : new Error(String(error))
}
