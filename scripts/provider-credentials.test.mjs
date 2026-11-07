import test from 'node:test'
import assert from 'node:assert/strict'
import { createProviderCredentialBridge } from './provider-credentials.mjs'

const auth = {
  openai: { type: 'oauth', access: 'openai-access', refresh: 'openai-refresh', expires: 123, accountId: 'acct-1' },
  openrouter: { type: 'api', key: 'router-key' },
  opencode: { type: 'oauth', access: 'console-access', refresh: 'console-refresh', expires: 456, metadata: { orgID: 'org' } },
}

test('install account credentials through the V2 API and read them back', async () => {
  const created = [], deleted = [], activated = []
  let rows = []
  const bridge = createProviderCredentialBridge({ env: { OPENCODE_WEB_PORT: '1234', OPENCODE_PASSWORD: 'pw' }, request: async (url, options) => {
    assert.equal(options.headers.authorization, 'Basic ' + Buffer.from('opencode:pw').toString('base64'))
    if (options.method === 'GET') return Response.json({ data: rows })
    if (options.method === 'DELETE') { deleted.push(String(url).split('/').pop()); return new Response(null, { status: 204 }) }
    if (String(url).endsWith('/activate')) { activated.push(String(url).split('/').at(-2)); return new Response(null, { status: 204 }) }
    const body = JSON.parse(options.body); created.push(body); return Response.json({ data: { id: 'cred_' + body.integrationID, value: body.value } })
  } })
  const installed = await bridge.install(auth, { skip: new Set(['opencode']) })
  assert.deepEqual(installed, { openai: 'cred_openai', openrouter: 'cred_openrouter' })
  assert.equal(created.length, 2)
  assert.deepEqual(created.find(row => row.integrationID === 'openai').value, { type: 'oauth', methodID: 'chatgpt-browser', access: 'openai-access', refresh: 'openai-refresh', expires: 123, metadata: { accountID: 'acct-1' } })
  assert.deepEqual(created.find(row => row.integrationID === 'openrouter').value, { type: 'key', key: 'router-key' })
  assert.equal(created.some(row => row.integrationID === 'opencode'), false)
  rows = [{ id: 'cred_openai', integrationID: 'openai', label: 'OmGithub', active: true, value: created[0].value }, { id: 'cred_openrouter', integrationID: 'openrouter', label: 'OmGithub', active: true, value: created[1].value }]
  assert.deepEqual(await bridge.read('openai', 'cred_openai'), { type: 'oauth', access: 'openai-access', refresh: 'openai-refresh', expires: 123, accountId: 'acct-1' })
  assert.deepEqual(await bridge.read('openrouter', 'cred_openrouter'), { type: 'api', key: 'router-key' })
  await bridge.remove('cred_openai'); assert.deepEqual(deleted, ['cred_openai'])
})

test('reuse and activate matching credentials instead of duplicating them', async () => {
  const value = { type: 'key', key: 'router-key' }
  const bridge = createProviderCredentialBridge({ env: { OPENCODE_WEB_PORT: '1234', OPENCODE_PASSWORD: 'pw' }, request: async (url, options) => {
    if (options.method === 'GET') return Response.json({ data: [{ id: 'cred_router', integrationID: 'openrouter', label: 'OmGithub', active: false, value }] })
    if (options.method === 'POST' && String(url).endsWith('/activate')) return new Response(null, { status: 204 })
    throw new Error('unexpected ' + options.method + ' ' + url)
  } })
  assert.deepEqual(await bridge.install({ openrouter: { type: 'api', key: 'router-key' } }), { openrouter: 'cred_router' })
})
