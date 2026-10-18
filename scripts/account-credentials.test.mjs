import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCredentialClient, writeEnv, escapeCommand } from './account-credentials.mjs'
const initial = { openai: { type: 'oauth', access: 'initial-access', refresh: 'initial-refresh', expires: 123 } }
function fixture(t, extra = {}, account = initial) {
  const dir = mkdtempSync(join(tmpdir(), 'credential-client-')); t.after(() => rmSync(dir, { force: true, recursive: true }))
  const env = { RUNNER_TEMP: dir, HOME: dir, GITHUB_ENV: join(dir, 'env'), GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', TRIGGER_ISSUE_NUMBER: '5', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://identity.test/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token', ...extra }
  const calls = [], masks = []
  const client = createCredentialClient({ env, mask: v => masks.push(v), request: async (url, options) => {
    if (String(url).startsWith('https://identity.test')) return Response.json({ value: 'signed-oidc' })
    assert.equal(options.headers.authorization, 'Bearer signed-oidc')
    const body = JSON.parse(options.body); calls.push(body)
    return Response.json(body.operation === 'refresh' ? { revision: 'revision-2' } : { revision: 'revision-1', auth: body.use_auth ? account : null, secrets: { CUSTOM_SERVICE: 'secret\nmultiline', EXISTING_KEY: 'account-value' } })
  } })
  return { dir, env, calls, masks, client, file: join(dir, '.local/share/opencode/auth.json') }
}
test('load account credentials, mask multiline values, preserve repository overrides, sync refresh and release', async t => {
  const f = fixture(t, { EXISTING_KEY: 'repository-value' })
  assert.deepEqual(await f.client.load(), { customSecrets: 1, accountAuth: true })
  assert.deepEqual(JSON.parse(readFileSync(f.file)), initial)
  const env = readFileSync(f.env.GITHUB_ENV, 'utf8')
  assert.match(env, /CUSTOM_SERVICE<</); assert.doesNotMatch(env, /EXISTING_KEY<</)
  assert.ok(f.masks.includes('initial-refresh')); assert.ok(f.masks.includes('secret\nmultiline'))
  writeFileSync(f.file, JSON.stringify({ openai: { ...initial.openai, access: 'updated-access' } }))
  await f.client.sync()
  assert.equal(f.calls.at(-1).auth.openai.access, 'updated-access')
  assert.equal(f.calls.at(-1).revision, 'revision-1')
  await f.client.sync(true)
  assert.equal(f.calls.at(-1).revision, 'revision-2'); assert.equal(f.calls.at(-1).release, true)
  assert.equal(existsSync(f.file), false)
})
test('repository credentials override matching account providers', async t => {
  const f = fixture(t, { OPENCODE_AUTH_CONTENT: JSON.stringify(initial) })
  assert.equal((await f.client.load()).accountAuth, false)
  assert.equal(f.calls[0].use_auth, true); assert.equal(existsSync(f.file), false)
})
test('environment file delimiters and workflow masking escape command characters', t => {
  const { dir } = fixture(t), file = join(dir, 'delimiter')
  writeEnv(file, 'CUSTOM_KEY', 'value\nEOF\n::error::hello')
  assert.match(readFileSync(file, 'utf8'), /^CUSTOM_KEY<<omgithub_/)
  assert.equal(escapeCommand('a%\r\nb'), 'a%25%0D%0Ab')
})
test('High models set CLI reasoning variant in all OpenCode invocation modes', () => {
  const workflow = readFileSync(new URL('../.github/workflows/opencode-reusable.yml', import.meta.url), 'utf8')
  assert.match(workflow, /\['openai\/gpt-6.1-sol', 'openai\/gpt-6-astra'\].includes\(model\) \? 'high'/)
  assert.match(workflow, /variant_args=\(--variant "\$OPENCODE_VARIANT"\)/)
  const invocations = workflow.split('\n').filter(line => line.includes('"$1" run'))
  assert.equal(invocations.length, 5)
  for (const line of invocations) assert.ok(line.includes('"${variant_args[@]}"'))
})


test('cleanup removes account auth even when a revision conflict already stopped sync', async t => {
  const f = fixture(t)
  await f.client.load()
  f.env.OMGITHUB_ACCOUNT_AUTH_FILE = f.file
  rmSync(f.client.stateFile)
  await f.client.sync(true)
  assert.equal(existsSync(f.file), false)
})

test('release only after main execution and validation settle, and before debug hold', async t => {
  const { credentialWorkSettled } = await import('./account-credentials.mjs')
  const { dir, env } = fixture(t); env.OPENCODE_WEB_DIR = dir
  assert.equal(credentialWorkSettled(env), true)
  writeFileSync(join(dir, 'main-model'), 'openai/gpt-6-astra')
  assert.equal(credentialWorkSettled(env), false)
  writeFileSync(join(dir, 'opencode-run.exit'), '0')
  writeFileSync(join(dir, 'deployment-status.json'), JSON.stringify({ state: 'deploying' }))
  assert.equal(credentialWorkSettled(env), false)
  writeFileSync(join(dir, 'deployment-status.json'), JSON.stringify({ state: 'failed' }))
  assert.equal(credentialWorkSettled(env), true)
  writeFileSync(join(dir, 'active-validation.json'), '{}')
  assert.equal(credentialWorkSettled(env), false)
  const workflow = readFileSync(new URL('../.github/workflows/opencode-reusable.yml', import.meta.url), 'utf8')
  assert.ok(workflow.indexOf('- name: Release account credentials before debug hold') < workflow.indexOf('- name: Keep temporary access available'))
})


test('two independent runners load identical account auth concurrently and clean up independently', async t => {
  const a = fixture(t), b = fixture(t, { GITHUB_RUN_ID: '43', TRIGGER_ISSUE_NUMBER: '6' })
  const results = await Promise.all([a.client.load(), b.client.load()])
  assert.ok(results.every(result => result.accountAuth))
  assert.notEqual(a.file, b.file)
  assert.deepEqual(JSON.parse(readFileSync(a.file)), JSON.parse(readFileSync(b.file)))
  await a.client.sync(true)
  assert.equal(existsSync(a.file), false)
  assert.equal(existsSync(b.file), true)
  await b.client.sync(true)
  assert.equal(existsSync(b.file), false)
})

test('MCP-only accounts configure OpenCode outside the checkout, mask run credentials and revoke on cleanup', async t => {
  const f = fixture(t, { OPENCODE_AUTH_CONTENT: JSON.stringify({}), OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'test/model', mcp: { repository_server: { type: 'remote', url: 'https://repo.test/mcp' } } }) })
  const mcp = { account_composio: { type: 'remote', url: 'https://omgithub.com/api/mcp/gateway/test', enabled: true, oauth: false, headers: { Authorization: 'Bearer run-scoped-credential' } } }
  const client = createCredentialClient({ env: f.env, mask: value => f.masks.push(value), request: async (url, options) => {
    if (String(url).startsWith('https://identity.test')) return Response.json({ value: 'signed-oidc' })
    const body = JSON.parse(options.body); f.calls.push(body)
    return Response.json(body.operation === 'release_mcp' ? { released: true } : { auth: null, secrets: {}, mcp })
  } })
  await client.load()
  const output = readFileSync(f.env.GITHUB_ENV, 'utf8'), match = output.match(/OPENCODE_CONFIG_CONTENT<<[^\n]+\n([^\n]+)/)
  const config = JSON.parse(match[1])
  assert.equal(config.model, 'test/model'); assert.deepEqual(config.mcp.account_composio, mcp.account_composio)
  assert.ok(config.mcp.repository_server)
  assert.ok(f.masks.includes('Bearer run-scoped-credential'))
  assert.equal(existsSync(f.file), false)
  await client.sync(true)
  assert.equal(f.calls.at(-1).operation, 'release_mcp')
  assert.equal(existsSync(join(f.dir, 'omgithub-account-credentials/mcp.json')), false)
})


test('import missing Go providers beside repository OpenAI auth without syncing repository overrides', async t => {
  const repository = { openai: { type: 'api', key: 'repository-openai' } }
  const account = { ...initial, 'opencode-go': { type: 'api', key: 'account-go' } }
  const f = fixture(t, { OPENCODE_AUTH_CONTENT: JSON.stringify(repository) }, account)
  assert.equal((await f.client.load()).accountAuth, true)
  assert.deepEqual(JSON.parse(readFileSync(f.file)), { ...account, ...repository })
  const env = readFileSync(f.env.GITHUB_ENV, 'utf8')
  assert.match(env, /OPENCODE_AUTH_CONTENT<<[^\n]+\n\n/)
  assert.ok(f.masks.includes('repository-openai')); assert.ok(f.masks.includes('account-go'))
  await f.client.sync()
  assert.equal(Object.hasOwn(f.calls.at(-1), 'auth'), false)
  writeFileSync(f.file, JSON.stringify({ ...repository, 'opencode-go': { type: 'api', key: 'updated-go' } }))
  await f.client.sync()
  assert.deepEqual(f.calls.at(-1).auth.openai, initial.openai)
  assert.equal(f.calls.at(-1).auth['opencode-go'].key, 'updated-go')
  await f.client.sync(true); assert.equal(existsSync(f.file), false)
})
