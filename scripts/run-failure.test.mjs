import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modelFailureReason, readFailureReason, failurePayload } from './run-failure.mjs'
const overloadedMessage = 'We’re running low on spare robot brains. Please try again in a moment!'
const event = error => JSON.stringify({ type: 'error', error })
test('report free quota, rate limits, and rejected credentials without echoing provider bodies', () => {
  assert.equal(modelFailureReason(event({ type: 'provider.free-limit', status: 429, message: 'private provider message' })), overloadedMessage)
  assert.equal(modelFailureReason(event({ message: 'FreeUsageLimitError' })), overloadedMessage)
  assert.equal(modelFailureReason(event({ message: 'free usage limit reached' })), overloadedMessage)
  assert.match(modelFailureReason(event({ type: 'unknown', status: 429 })), /rate limit/)
  assert.match(modelFailureReason(event({ status: 401, message: 'secret-token-value' })), /credentials/)
  assert.doesNotMatch(modelFailureReason(event({ status: 401, message: 'secret-token-value' })), /secret-token/)
  assert.match(modelFailureReason(event({ type: 'model-not-found' })), /model is unavailable/)
  assert.match(modelFailureReason(event({ message: 'sensitive detail' })), /could not complete/)
})
test('read the provider status from the message text and echo only short provider lines', () => {
  assert.match(modelFailureReason(event({ type: 'unknown', message: 'Copilot /auto returned HTTP 401' })), /credentials .*HTTP 401/)
  assert.match(modelFailureReason(event({ type: 'unknown', message: 'Copilot /auto returned HTTP 502' })), /could not complete .*HTTP 502/)
  assert.match(modelFailureReason(event({ message: 'Transport: ECONNRESET: socket closed' })), /could not complete .*ECONNRESET/)
  assert.doesNotMatch(modelFailureReason(event({ message: 'sk-abcdefghijklmnopqrstuvwxyz' })), /sk-/)
  assert.doesNotMatch(modelFailureReason(event({ message: 'sensitive detail' })), /sensitive detail/)
})
test('ignore tool text and malformed lines; select the last structured error', () => {
  assert.match(modelFailureReason('{bad\n' + JSON.stringify({ type: 'tool_use', error: { type: 'provider.free-limit' } })), /workflow failed/)
  assert.match(modelFailureReason(event({ status: 429 }) + '\n' + event({ status: 403 })), /credentials/)
})
test('read bounded tails, tolerate missing startup logs, and construct terminal callback JSON', () => {
  const directory = mkdtempSync(join(tmpdir(), 'run-failure-'))
  try {
    assert.match(readFailureReason(directory), /workflow failed/)
    writeFileSync(join(directory, 'opencode-run.log'), 'x'.repeat(70000) + '\n' + event({ type: 'provider.free-limit', status: 429 }))
    assert.equal(readFailureReason(directory), overloadedMessage)
    const payload = failurePayload({ OPENCODE_WEB_DIR: directory, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }, 5000)
    assert.equal(payload.run, '123'); assert.equal(payload.attempt, 2); assert.equal(payload.sequence, 5000)
    assert.equal(payload.outcome, 'failure'); assert.equal(payload.state, 'ended')
    assert.equal(payload.reason, overloadedMessage)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test('report the current delivery failure, not a stale free-limit error from an earlier model attempt', () => {
  const directory = mkdtempSync(join(tmpdir(), 'run-failure-'))
  try {
    writeFileSync(join(directory, 'opencode-run.log'), event({ type: 'provider.free-limit', status: 429 }))
    writeFileSync(join(directory, 'model-attempts.json'), JSON.stringify([{ model: 'a', code: 1 }, { model: 'b', code: 0 }]))
    assert.match(readFailureReason(directory), /after the AI finished/)
    writeFileSync(join(directory, 'delivery-failure.json'), JSON.stringify({ message: 'Production delivery timed out' }))
    assert.match(readFailureReason(directory), /Publishing timed out/)
    assert.doesNotMatch(failurePayload({ OPENCODE_WEB_DIR: directory, GITHUB_RUN_ID: '1' }).reason, /robot brains/)
    writeFileSync(join(directory, 'delivery-failure.json'), JSON.stringify({ message: 'No generated index.html or supported package project.' }))
    assert.match(readFailureReason(directory), /no playable game/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
