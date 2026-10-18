import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionRecovery } from './session-recovery.mjs'
function harness() {
  const user = { info: { id: 'u1', role: 'user' } }
  const failed = n => ({ info: { id: `a${n}`, role: 'assistant', time: { completed: 1 }, agent: 'build', providerID: 'opencode', modelID: 'muse', error: { name: 'APIError', data: { isRetryable: false, message: 'Invalid upload request' } } } })
  let state = { id: 'ses_1', busy: false, messages: [user, failed(0)] }, callback
  const sent = [], reports = []
  const recovery = new SessionRecovery({ snapshot: async () => state, send: async (id, body) => sent.push({ id, body }), report: s => reports.push(s), schedule: (cb, ms) => { assert.equal(ms, 30000); callback = cb; return 1 }, unschedule: () => { callback = undefined } })
  return { recovery, sent, reports, failed, get state() { return state }, set state(s) { state = s }, fire: async () => { const cb = callback; callback = undefined; await cb?.() } }
}
test('resume same session/model with exactly Continue; deduplicate idle events', async () => {
  const h = harness(); h.recovery.observe(h.state); h.recovery.observe(h.state); await h.fire()
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].id, 'ses_1')
  assert.deepEqual(h.sent[0].body.parts, [{ type: 'text', text: 'Continue' }])
  assert.deepEqual(h.sent[0].body.model, { providerID: 'opencode', modelID: 'muse' })
  h.recovery.observe(h.state); await h.fire(); assert.equal(h.sent.length, 1)
})
test('stop after five resumes across automatic user messages and partial progress', async () => {
  const h = harness()
  for (let n = 0; n < 6; n++) {
    h.state.messages.push(h.failed(n)); h.recovery.observe(h.state); await h.fire()
    const sent = h.sent.at(-1)
    h.state.messages.push({ info: { id: sent.body.messageID, role: 'user' } })
    h.recovery.observe({ ...h.state, busy: true })
  }
  assert.equal(h.sent.length, 5)
  assert.ok(h.reports.some(s => s.includes('exhausted')))
})
test('cancel on new input, cancellation, success, or busy state', async () => {
  for (const change of ['input', 'cancel', 'success', 'busy']) {
    const h = harness(); h.recovery.observe(h.state)
    if (change === 'cancel') h.recovery.cancel()
    if (change === 'input') h.state.messages.push({ info: { id: 'u2', role: 'user' } })
    if (change === 'success') h.state.messages.push({ info: { id: 'done', role: 'assistant', time: { completed: 1 } } })
    if (change === 'busy') h.state.busy = true
    await h.fire(); assert.equal(h.sent.length, 0, change)
  }
})
test('do not retry authentication or aborted errors', async () => {
  for (const error of [{ name: 'AbortedError' }, { name: 'APIError', data: { isRetryable: false, message: 'Unauthorized' } }]) {
    const h = harness(); h.state.messages.at(-1).info.error = error
    h.recovery.observe(h.state); await h.fire(); assert.equal(h.sent.length, 0)
  }
})
test('new human request resets budget; retryable provider error qualifies', async () => {
  const h = harness(); h.recovery.attempts = 5
  h.state.messages = [{ info: { id: 'u2', role: 'user' } }, h.failed(2)]
  h.state.messages.at(-1).info.error.data = { isRetryable: true, message: 'Overloaded' }
  h.recovery.observe(h.state); await h.fire(); assert.equal(h.sent.length, 1)
})
