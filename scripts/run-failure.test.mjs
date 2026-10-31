import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modelFailureReason, readFailureReason, failurePayload } from './run-failure.mjs'
const event = error => JSON.stringify({ type: 'error', error })
test('report free quota, rate limits, and rejected credentials without echoing provider bodies', () => {
  assert.match(modelFailureReason(event({ type: 'provider.free-limit', status: 429, message: 'private provider message' })), /free-model quota/)
  assert.match(modelFailureReason(event({ type: 'unknown', status: 429 })), /rate limit/)
  assert.match(modelFailureReason(event({ status: 401, message: 'secret-token-value' })), /credentials/)
  assert.doesNotMatch(modelFailureReason(event({ status: 401, message: 'secret-token-value' })), /secret-token/)
  assert.match(modelFailureReason(event({ type: 'model-not-found' })), /model is unavailable/)
  assert.match(modelFailureReason(event({ message: 'sensitive detail' })), /could not complete/)
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
    assert.match(readFailureReason(directory), /free-model quota/)
    const payload = failurePayload({ OPENCODE_WEB_DIR: directory, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }, 5000)
    assert.equal(payload.run, '123'); assert.equal(payload.attempt, 2); assert.equal(payload.sequence, 5000)
    assert.equal(payload.outcome, 'failure'); assert.equal(payload.state, 'ended')
    assert.match(payload.reason, /free-model quota/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
