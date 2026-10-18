import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectLogResponse } from './log-response.mjs'
for (const kind of ['current', 'stale', 'missing', 'unknown revision']) test('diagnostic export: ' + kind, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'log-response-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const existing = [{ info: { id: 'msg_saved' } }], fresh = [{ info: { id: 'msg_current' } }]
  if (kind !== 'missing') writeFileSync(join(directory, 'log-session-export.json'), JSON.stringify({ info: { id: 'ses_test', time: { updated: 10 } }, messages: existing }))
  const calls = []
  const result = await collectLogResponse({ directory, sessionId: 'ses_test', api: async path => {
    calls.push(path)
    return path.endsWith('/message') ? fresh : { time: { updated: kind === 'current' ? 10 : kind === 'unknown revision' ? undefined : 11 } }
  } })
  assert.deepEqual(result, kind === 'current' ? existing : fresh)
  assert.equal(calls.length, kind === 'current' ? 1 : 2)
})
