import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitForDeployment } from './wait-deployment.mjs'
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'wait-deployment-'))
  return { directory, put: (name, value) => writeFileSync(join(directory, name), JSON.stringify(value)), close: () => rmSync(directory, { recursive: true, force: true }) }
}
const result = generation => ({ preview_url: 'https://f.ondev.store/test/game/blob/sha/', generation: String(generation), screenshots: ['desktop', 'mobile'] })
test('wait for the final message deployment instead of accepting an earlier ready generation', async () => {
  const f = fixture()
  let now = 0, polls = 0
  try {
    f.put('main-completion.json', { message_id: 'msg_final' })
    f.put('deployment-status.json', { state: 'ready', generation: 1, message_id: 'msg_old' })
    f.put('deployment-result.json', result(1))
    const delivered = await waitForDeployment({ directory: f.directory, now: () => now, pause: async () => {
      now += 1000; polls++
      f.put('deployment-status.json', { state: polls === 1 ? 'deploying' : 'ready', generation: 2, message_id: 'msg_final' })
      if (polls === 2) f.put('deployment-result.json', result(2))
    }, reconcile: async () => { if (!polls) throw Error('Temporary HTTP 502') } })
    assert.equal(polls, 2)
    assert.equal(delivered.generation, '2')
  } finally { f.close() }
})
test('fail on final-generation deployment errors, incomplete delivery, or bounded timeout', async () => {
  const f = fixture()
  try {
    f.put('deployment-status.json', { state: 'failed', error: 'Build invalid' })
    await assert.rejects(waitForDeployment({ directory: f.directory }), /Build invalid/)
    f.put('deployment-status.json', { state: 'ready', generation: 2 })
    f.put('deployment-result.json', result(1))
    await assert.rejects(waitForDeployment({ directory: f.directory }), /Incomplete/)
    f.put('deployment-status.json', { state: 'deploying' })
    let now = 0
    await assert.rejects(waitForDeployment({ directory: f.directory, now: () => now, timeoutMs: 2000, pause: async () => { now += 1000 } }), /timed out/)
  } finally { f.close() }
})
