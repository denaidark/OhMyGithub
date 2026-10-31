import test from 'node:test'
import assert from 'node:assert/strict'
import { createConsoleCredentialBridge } from './console-credentials.mjs'
const value = { type: 'oauth', access: 'access', refresh: 'refresh', expires: 12345, metadata: { orgID: 'org', server: 'https://opencode.ai/console' } }
test('Console imports workspace metadata through V2 API, removes only matching legacy duplicates and reads rotations', async () => {
  const calls = [], masks = []
  const bridge = createConsoleCredentialBridge({ env: { OPENCODE_WEB_PORT: '1234', OPENCODE_PASSWORD: 'password' }, remember: v => masks.push(v), request: async (url, options) => {
    calls.push({ url, options, body: options.body && JSON.parse(options.body) })
    if (options.method === 'DELETE') return new Response(null, { status: 204 })
    if (options.method === 'POST') return Response.json({ data: { id: 'cred_native', value: { ...value, methodID: 'device' } } })
    return Response.json({ data: [{ id: 'cred_old', integrationID: 'opencode', value }, { id: 'cred_other', integrationID: 'opencode', value: { ...value, access: 'other' } }, { id: 'cred_native', integrationID: 'opencode', value: { ...value, access: 'rotated', methodID: 'device' } }] })
  } })
  assert.equal(await bridge.install({ opencode: value }), 'cred_native')
  assert.equal(calls[1].body.value.metadata.orgID, 'org'); assert.equal(calls[1].body.value.methodID, 'device')
  assert.ok(calls[2].url.endsWith('/cred_old'))
  assert.equal((await bridge.read('cred_native')).access, 'rotated')
  await bridge.remove('cred_native')
  assert.equal(masks.length, 2)
  assert.equal(await bridge.install({ openai: value }), null)
})
test('Console refuses missing native credentials and server configuration', async () => {
  const bridge = createConsoleCredentialBridge({ env: { OPENCODE_WEB_PORT: '1234', OPENCODE_PASSWORD: 'pw' }, request: async () => Response.json({ data: [] }) })
  await assert.rejects(bridge.read('missing'), /disappeared/)
  await assert.rejects(createConsoleCredentialBridge({ env: {} }).install({ opencode: value }), /running V2/)
})
