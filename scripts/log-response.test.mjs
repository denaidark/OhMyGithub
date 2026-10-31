import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectLogResponse } from './log-response.mjs'
test('diagnostics export the current v2 conversation', async () => {
  const messages = [{ type: 'user', id: 'msg_saved' }]
  assert.deepEqual(await collectLogResponse({ sessionId: 'ses_saved', api: { export: async id => { assert.equal(id, 'ses_saved'); return { messages } } } }), messages)
})
