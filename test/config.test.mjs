import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, apply } from '../lib/index.js'
import { validateConfiguration } from '../lib/config.js'

test('a fresh native bundle can be activated before entering its connection', () => {
  assert.doesNotThrow(() => validateConfiguration(undefined))
  assert.equal(Config(undefined).get().credentialRef, 'NINFER_API_KEY')
})

test('native edits reject embedded secrets, invalid references, duplicate models and invalid budgets', () => {
  for (const patch of [
    { baseURL: 'https://user:secret@example.test/v1' },
    { baseURL: 'https://example.test/v1?key=secret' },
    { baseURL: 'file:///tmp/api' },
    { credentialRef: 'not a reference' },
    { models: [{ id: 'same', contextWindow: 10 }, { id: 'same', contextWindow: 20 }] },
    { safetyMargin: -1 }, { compactionThreshold: 0 }, { requestTimeoutMs: 2147483648 },
  ]) assert.throws(() => validateConfiguration(patch))
})

test('volatile route edits register, rename and withdraw without restarting; conflicts fail before persistence', () => {
  const hooks = new Map()
  const routes = new Set(['occupied'])
  const fiber = {}
  let value = Config(undefined).get()
  let registrations = 0
  const ctx = {
    fiber,
    inject() {},
    on(name, handler) { hooks.set(name, handler) },
    llm: {
      listProviders() { return [...routes].map(id => ({ id })) },
      registerAdapter(initial) {
        registrations++
        let own = initial
        initial.forEach(id => routes.add(id))
        return { replace(next) { own.forEach(id => routes.delete(id)); next.forEach(id => routes.add(id)); own = next } }
      },
    },
  }
  apply(ctx, { get: () => value })
  function edit(patch) {
    const candidate = { ...value, ...patch }
    hooks.get('internal/config').call(fiber, candidate, () => candidate)
    value = Config(candidate).get()
    hooks.get('loader/volatile-update')()
  }
  assert.equal(registrations, 0)
  edit({ baseURL: 'http://localhost:8000/v1', models: [{ id: 'test', contextWindow: 1000 }] })
  assert.ok(routes.has('ninfer-local'))
  assert.throws(() => edit({ provider: 'occupied' }), /already used/)
  assert.equal(value.provider, 'ninfer-local')
  assert.throws(() => edit({ baseURL: 'file:///api' }))
  assert.equal(value.baseURL, 'http://localhost:8000/v1')
  edit({ provider: 'renamed' })
  assert.ok(routes.has('renamed'))
  assert.ok(!routes.has('ninfer-local'))
  edit({ models: [] })
  assert.deepEqual([...routes], ['occupied'])
  assert.equal(registrations, 1)
})
