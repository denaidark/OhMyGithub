import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createConsoleCredentialBridge } from './console-credentials.mjs'
const env = { OPENCODE_WEB_PORT: process.env.OPENCODE_WEB_PORT || '42987', OPENCODE_PASSWORD: process.env.OPENCODE_PASSWORD || 'omgithub-isolated-test' }
const token = JSON.parse(readFileSync(process.env.CONSOLE_TEST_TOKEN_FILE || '/tmp/omgithub-console-device-token.json', 'utf8'))
assert.ok(token.access_token && token.refresh_token && token.org_id, 'Authorize the test Console device first')
const headers = { authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_PASSWORD}`).toString('base64')}` }
const consoleHeaders = { authorization: `Bearer ${token.access_token}`, 'x-org-id': token.org_id }
const user = await (await fetch('https://opencode.ai/console/api/user', { headers: consoleHeaders })).json()
const orgs = await (await fetch('https://opencode.ai/console/api/orgs', { headers: consoleHeaders })).json()
const org = orgs.find(org => org.id === token.org_id); assert.ok(org)
const bridge = createConsoleCredentialBridge({ env })
let id
try {
  const info = await (await fetch(`http://127.0.0.1:${env.OPENCODE_WEB_PORT}/api/info`, { headers })).json()
  assert.equal(info.version, '2.2.2')
  id = await bridge.install({ opencode: { type: 'oauth', access: token.access_token, refresh: token.refresh_token, expires: Date.now() + token.expires_in * 1000, metadata: { server: 'https://opencode.ai/console', accountID: user.id, email: user.email, orgID: org.id, orgName: org.name } } })
  const read = await bridge.read(id); assert.equal(read.metadata.orgID, org.id)
  const response = await fetch(`http://127.0.0.1:${env.OPENCODE_WEB_PORT}/api/experimental/generate/text`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' }, prompt: 'Reply with exactly OK. Do not call tools.' }), signal: AbortSignal.timeout(90000) })
  const result = await response.json()
  assert.equal(response.status, 200, `Native generation HTTP ${response.status}: ${JSON.stringify(result).slice(0, 500)}`)
  assert.match(JSON.stringify(result), /OK/)
  console.log('PASS: real OpenCode Console device credential imported into OpenCode 2.2.2 with workspace metadata; Go model produced OK through native generation API; credential readback and cleanup verified.')
} finally { if (id) await bridge.remove(id) }
