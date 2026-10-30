import { test } from 'node:test'
import assert from 'node:assert/strict'
import { V2LifecycleBridge, isV2MainPrompt } from './session-lifecycle-v2.mjs'

const sid = 'ses_main'
const event = name => ({ type: `session.execution.${name}`, data: { sessionID: sid } })
const completed = () => ({ id: sid, busy: false, messages: [{ type: 'idle', outcome: 'succeeded' }, { type: 'assistant', id: 'msg_new' }] })

test('gate main prompts before sending and ignore child-session traffic', () => {
  assert.equal(isV2MainPrompt('POST', `/api/session/${sid}/prompt?x=1`, sid), true)
  assert.equal(isV2MainPrompt('POST', `/api/session/${sid}/command`, sid), true)
  assert.equal(isV2MainPrompt('GET', `/api/session/${sid}/prompt`, sid), false)
  assert.equal(isV2MainPrompt('POST', '/api/session/ses_child/prompt', sid), false)
  assert.equal(isV2MainPrompt('POST', `/api/session/${sid}/interrupt`, sid), false)
})

test('drain validation once before a prompt, then complete the observed main session', async () => {
  const calls = [], api = { snapshot: async () => completed() }
  const lifecycle = { busy: async () => { calls.push('busy') }, complete: async id => { calls.push(`complete:${id}`) } }
  const bridge = new V2LifecycleBridge({ api, lifecycle, sessionID: sid })
  await bridge.beforePrompt()
  await bridge.observe(event('started'))
  assert.deepEqual(calls, ['busy'])
  await bridge.observe(event('succeeded'))
  assert.deepEqual(calls, ['busy', 'complete:msg_new'])
  await bridge.observe({ type: 'session.execution.succeeded', data: { sessionID: 'ses_child' } })
  assert.deepEqual(calls, ['busy', 'complete:msg_new'])
})

test('discard stale completion when a new prompt arrives during the snapshot', async () => {
  let resolveSnapshot
  const calls = [], api = { snapshot: () => new Promise(resolve => { resolveSnapshot = resolve }) }
  const lifecycle = { busy: async () => { calls.push('busy') }, complete: async id => { calls.push(id) } }
  const bridge = new V2LifecycleBridge({ api, lifecycle, sessionID: sid })
  const pending = bridge.observe(event('succeeded'))
  await bridge.beforePrompt()
  resolveSnapshot(completed())
  await pending
  assert.deepEqual(calls, ['busy'])
})

test('never complete failed or interrupted executions', async () => {
  let completions = 0, snapshots = 0
  const bridge = new V2LifecycleBridge({ api: { snapshot: async () => { snapshots++; return completed() } }, lifecycle: { busy: async () => {}, complete: async () => { completions++ } }, sessionID: sid })
  await bridge.observe(event('started'))
  await bridge.observe(event('failed'))
  await bridge.observe(event('interrupted'))
  assert.equal(snapshots, 0)
  assert.equal(completions, 0)
})

test('reconnecting to an active main session invalidates prior validation', async () => {
  let busy = 0, complete = 0
  const bridge = new V2LifecycleBridge({ api: { snapshot: async () => ({ id: sid, busy: true, messages: [] }) }, lifecycle: { busy: async () => { busy++ }, complete: async () => { complete++ } }, sessionID: sid })
  await bridge.reconcile()
  await bridge.reconcile()
  assert.equal(busy, 1)
  assert.equal(complete, 0)
})
