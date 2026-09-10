/** Canonical DSH history to the one immutable Chat request counted and dispatched. */
import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionContentPart,
} from 'openai/resources/chat/completions'

async function content(
  ctx: Context,
  blocks: readonly ContentBlock[],
  signal?: AbortSignal,
): Promise<ChatCompletionContentPart[]> {
  const parts: ChatCompletionContentPart[] = []
  for (const block of blocks) {
    signal?.throwIfAborted()
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'image') {
      const image = await ctx.attachments.readImage(block.attachment, signal)
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`,
        },
      })
    } else if (block.type !== 'reasoning' && block.type !== 'tool-call' && block.type !== 'tool-result') {
      throw new LlmError(`Unsupported NInfer content block: ${block.type}`, 'UNSUPPORTED_CONTENT')
    }
  }
  return parts
}

export async function prepareBody(
  ctx: Context,
  options: GenerateOptions,
): Promise<ChatCompletionCreateParamsStreaming & { enable_thinking?: boolean; reasoning_effort?: string }> {
  const messages: ChatCompletionMessageParam[] = []
  if (options.system) messages.push({ role: 'system', content: options.system })
  for (const message of options.messages) {
    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
    if (message.role === 'system') messages.push({ role: 'system', content: text })
    else if (message.role === 'assistant') {
      const calls = message.content.filter((b) => b.type === 'tool-call')
      const reasoning = message.content
        .filter((b) => b.type === 'reasoning')
        .map((b) => b.text)
        .join('')
      const value = {
        role: 'assistant' as const,
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      }
      messages.push(value)
    } else if (message.content.some((block) => block.type === 'tool-result')) {
      for (const block of message.content) {
        if (block.type !== 'tool-result')
          throw new LlmError('Tool result history is malformed', 'INVALID_HISTORY')
        const parts = await content(ctx, block.content, options.signal)
        const text = parts
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('\n')
        messages.push({ role: 'tool', tool_call_id: block.toolCallId, content: text })
        const images = parts.filter((p) => p.type === 'image_url')
        if (images.length)
          messages.push({
            role: 'user',
            content: [{ type: 'text', text: `Images returned by tool ${block.toolCallId}:` }, ...images],
          })
      }
    } else if (message.role === 'user')
      messages.push({ role: 'user', content: await content(ctx, message.content, options.signal) })
    else throw new LlmError('Unsupported message role', 'UNSUPPORTED_CONTENT')
  }
  const effort = options.reasoningEffort === 'off' ? 'none' : options.reasoningEffort
  // OpenAI's published effort union does not include NInfer's xhigh extension.
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(options.tools?.length
      ? {
          tools: options.tools.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
  } as ChatCompletionCreateParamsStreaming & { reasoning_effort?: string }
}
