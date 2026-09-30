import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { NinferAdapter } from '../lib/adapter.js'
import { configSchema } from '../lib/config.js'
import { LiveNinferAdapter } from '../lib/index.js'
const native = {
  version: 1,
  instance_id: 'instance-1',
  model: 'fixture',
  input_tokens: 20,
  context_window: 150000,
  thinking_budget: 0,
  thinking_closure_tokens: 0,
}
async function setup(t, respond) {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({ path: req.url, body, instance: req.headers['x-ninfer-instance-id'] })
    if (req.url.endsWith('/count_tokens')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(native))
      return
    }
    respond(req, res, body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  const adapter = new NinferAdapter(
    { credentials: { resolve: async () => ({ value: 'fixture-key' }) } },
    configSchema.parse({
      baseURL: `http://127.0.0.1:${server.address().port}/v1`,
      credentialRef: 'TEST',
      models: [{ id: 'fixture', contextWindow: 150000 }],
    }),
  )
  const options = {
    provider: 'ninfer-local',
    model: 'fixture',
    reasoningEffort: 'off',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'écrire 🧪' }] }],
  }
  return { adapter, options, requests, baseURL: `http://127.0.0.1:${server.address().port}/v1` }
}
test('native edits apply to new calls while a prepared call retains its endpoint and limits', async t => {
  const first = await setup(t, (_req, res, body) => sse(res, body))
  const second = await setup(t, (_req, res, body) => sse(res, body))
  let settings = configSchema.parse({ baseURL: first.baseURL, credentialRef: 'TEST', models: [{ id: 'fixture', contextWindow: 150000, maxTokens: 1024 }] })
  const adapter = new LiveNinferAdapter({ credentials: { resolve: async () => ({ value: 'fixture-key' }) } }, { get: () => settings })
  const prepared = await adapter.prepareCall('ninfer-local', 'fixture')
  await prepared.inspect(first.options)
  settings = { ...settings, baseURL: second.baseURL, safetyMargin: 8192, models: [{ id: 'fixture', contextWindow: 150000, maxTokens: 2048 }] }
  for await (const _ of prepared.stream(first.options)) {}
  for await (const _ of adapter.stream(second.options)) {}
  assert.equal(first.requests.length, 2)
  assert.equal(second.requests.length, 2)
  assert.equal(first.requests[1].body.max_tokens, 150000 - 20 - 4096)
  assert.equal(second.requests[1].body.max_tokens, 150000 - 20 - 8192)
  assert.equal(prepared.model.defaultMaxTokens, 1024)
  assert.equal((await adapter.listModels('ninfer-local'))[0].defaultMaxTokens, 2048)
})
function sse(
  res,
  body,
  {
    finish = 'tool_calls',
    cause = 'stop',
    toolStatus = 'complete',
    input = 20,
    instance = 'instance-1',
    usageInput = 20,
    terminal = true,
  } = {},
) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (data) =>
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'request-1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          ...data,
        }) +
        '\n\n',
    )
  emit({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'write', arguments: '{"file_path":"never.txt","content":"no"}' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  })
  if (terminal)
    emit({
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      ninfer: {
        ...native,
        instance_id: instance,
        input_tokens: input,
        effective_output_tokens: body.max_tokens,
        cause,
        tool_status: toolStatus,
      },
    })
  emit({
    choices: [],
    usage: { prompt_tokens: usageInput, completion_tokens: 10, total_tokens: usageInput + 10 },
  })
  res.end('data: [DONE]\n\n')
}
for (const [name, behavior, code] of [
  ['usage disagrees with the exact count', { usageInput: 21 }, 'NINFER_COUNT_MISMATCH'],
  ['diagnostic count differs', { input: 21 }, 'NINFER_COUNT_MISMATCH'],
  ['server instance changes', { instance: 'instance-2' }, 'NINFER_INSTANCE_CHANGED'],
  ['tool status contradicts the batch', { toolStatus: 'absent' }, 'NINFER_PROTOCOL_ERROR'],
  ['stream closes without a terminal frame', { terminal: false }, 'TRANSPORT'],
  ['terminal reports cancellation', { cause: 'cancelled' }, 'ABORTED'],
])
  test(name + ': emits no executable tool', async (t) => {
    const { adapter, options } = await setup(t, (_req, res, body) => sse(res, body, behavior))
    const chunks = []
    await assert.rejects(
      async () => {
        for await (const chunk of adapter.stream(options)) chunks.push(chunk)
      },
      { code },
    )
    assert.equal(chunks.filter((c) => c.type === 'tool-call-delta').length, 0)
  })
test('a stale preparation is refused without an implicit HTTP retry', async (t) => {
  const { adapter, options, requests } = await setup(t, (_req, res) => {
    res.writeHead(409, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        error: { message: 'Count again', type: 'invalid_request_error', code: 'preparation_expired' },
      }),
    )
  })
  await assert.rejects(
    async () => {
      for await (const _ of adapter.stream(options)) {
      }
    },
    { code: 'preparation_expired' },
  )
  assert.equal(requests.length, 2)
  assert.equal(requests[1].instance, 'instance-1')
})
test('caller cancellation closes an in-flight HTTP generation without retry', async (t) => {
  const controller = new AbortController()
  const { adapter, options, requests } = await setup(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
    controller.abort()
  })
  await assert.rejects(
    async () => {
      for await (const _ of adapter.stream({ ...options, signal: controller.signal })) {
      }
    },
    { code: 'ABORTED' },
  )
  assert.equal(requests.length, 2)
})
test('changing a counted prompt refuses dispatch', async (t) => {
  const { adapter, options, requests } = await setup(t, (_req, res) => res.end())
  const call = await adapter.prepareCall(options.provider, options.model)
  await call.inspect(options)
  await assert.rejects(
    async () => {
      for await (const _ of call.stream({ ...options, system: 'changed' })) {
      }
    },
    { code: 'INVALID_PREPARED_CALL' },
  )
  assert.equal(requests.length, 1)
})
