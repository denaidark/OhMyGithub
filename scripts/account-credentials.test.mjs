import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCredentialClient, writeEnv, escapeCommand } from './account-credentials.mjs'
const initial = { openai: { type: 'oauth', access: 'initial-access', refresh: 'initial-refresh', expires: 123 } }
function fixture(t, extra = {}, account = initial, debugKey, metadata = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'credential-client-')); t.after(() => rmSync(dir, { force: true, recursive: true }))
  const env = { RUNNER_TEMP: dir, HOME: dir, GITHUB_ENV: join(dir, 'env'), GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', TRIGGER_ISSUE_NUMBER: '5', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://identity.test/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token', ...extra }
  const calls = [], masks = []
  const client = createCredentialClient({ env, mask: v => masks.push(v), request: async (url, options) => {
    if (String(url).startsWith('https://identity.test')) return Response.json({ value: 'signed-oidc' })
    assert.equal(options.headers.authorization, 'Bearer signed-oidc')
    const body = JSON.parse(options.body); calls.push(body)
    return Response.json(body.operation === 'refresh' ? { revision: 'revision-2' } : { ...metadata, debug_ssh_public_key: debugKey, revision: 'revision-1', auth: body.use_auth ? account : null, secrets: { CUSTOM_SERVICE: 'secret\nmultiline', EXISTING_KEY: 'account-value', ...metadata.secrets } })
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
test('workflow exports the selected high reasoning variant to the native v2 runner environment', () => {
  const workflow = readFileSync(new URL('../.github/workflows/opencode-reusable.yml', import.meta.url), 'utf8')
  assert.match(workflow, /\['openai\/gpt-6.1-sol', 'openai\/gpt-6-astra'\].includes\(model\) \? 'high'/)
  assert.ok(workflow.includes('OPENCODE_VARIANT: ${{ steps.opencode_labels.outputs.variant }}'))
  // The old five v1 bash invocations were removed by the native v2 migration.
  assert.ok(workflow.includes('node "$RUNTIME_DIR/scripts/run-with-model-fallback.mjs"'))
})


test('cleanup removes account auth even when a revision conflict already stopped sync', async t => {
  const f = fixture(t)
  await f.client.load()
  f.env.OMGITHUB_ACCOUNT_AUTH_FILE = f.file
  rmSync(f.client.stateFile)
  await f.client.sync(true)
  assert.equal(existsSync(f.file), false)
})

test('release only after main execution and validation settle; keep auth during SSH holds', async t => {
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
  const release = workflow.split('      - name: Release account credentials before debug hold\n')[1].split('      - name:')[0]
  assert.match(release, /if: always\(\) && env\.AGENTSWEB_SSH_ENABLED != 'true'/)
  assert.ok(workflow.indexOf('- name: Keep temporary access available') < workflow.indexOf('- name: Sync and release account credentials'))
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

test('backup endpoint settings survive a missing web directory', async t => {
  const f = fixture(t, {}, initial, undefined, { backup_model: 'omdev/deepseek-v4.1-flash-free', backup_host: 'llm.ondev.store' })
  f.env.OPENCODE_WEB_DIR = join(f.dir, 'missing-web')
  await f.client.load()
  const env = readFileSync(f.env.GITHUB_ENV, 'utf8')
  assert.match(env, /OMG_BACKUP_MODEL<<[^\n]+\nomdev\/deepseek-v4\.1-flash-free\n/)
  assert.match(env, /OMG_BACKUP_HOST<<[^\n]+\nllm\.ondev\.store\n/)
  assert.equal(readFileSync(join(f.dir, 'missing-web', 'backup-host'), 'utf8').trim(), 'llm.ondev.store')
})
test('custom endpoint providers merge into OpenCode config without replacing workflow providers', async t => {
  const providers = { acme: { name: 'Acme', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://llm.acme.test/v1' }, models: { coder: { name: 'Coder' } } } }
  const f = fixture(t, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'test/model', providers: { workflow: { name: 'Workflow' } } }) }, initial, undefined, { providers })
  await f.client.load()
  const output = readFileSync(f.env.GITHUB_ENV, 'utf8'), match = output.match(/OPENCODE_CONFIG_CONTENT<<[^\n]+\n([^\n]+)/)
  const config = JSON.parse(match[1])
  assert.equal(config.model, 'test/model')
  assert.deepEqual(config.providers.workflow, { name: 'Workflow' })
  assert.deepEqual(config.providers.acme, providers.acme)
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

test('native Console installation and rotated tokens synchronize through the V2 API', async t => {
  const consoleAuth = { opencode: { type: 'oauth', access: 'console-access', refresh: 'console-refresh', expires: 123, metadata: { orgID: 'workspace', server: 'https://opencode.ai/console' } } }
  const f = fixture(t, { OPENCODE_WEB_PORT: '12345', OPENCODE_PASSWORD: 'server-password' }, consoleAuth)
  let value = { ...consoleAuth.opencode, methodID: 'device' }, deleted = false
  const client = createCredentialClient({ env: f.env, mask: () => {}, request: async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1')) {
      if (options.method === 'POST') return Response.json({ data: { id: 'cred_console', value } })
      if (options.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }) }
      return Response.json({ data: [{ id: 'cred_console', integrationID: 'opencode', value: { ...value, access: 'rotated-access' } }] })
    }
    if (String(url).startsWith('https://identity.test')) return Response.json({ value: 'oidc' })
    const body = JSON.parse(options.body); f.calls.push(body)
    return Response.json(body.operation === 'refresh' ? { revision: 'r2' } : { revision: 'r1', auth: consoleAuth, secrets: {} })
  } })
  await client.load(); await client.installConsole(); await client.sync()
  assert.equal(f.calls.at(-1).auth.opencode.access, 'rotated-access')
  assert.equal(f.calls.at(-1).auth.opencode.metadata.orgID, 'workspace')
  assert.equal(f.calls.at(-1).auth.opencode.methodID, undefined)
  await client.sync(true); assert.equal(deleted, true); assert.equal(existsSync(f.file), false)
})
test('Console revision conflicts stop uploads without disconnecting active native work', async t => {
  const auth = { opencode: { type: 'oauth', access: 'access', refresh: 'refresh', expires: 123, metadata: { orgID: 'org' } } }
  const f = fixture(t, { OPENCODE_WEB_PORT: '12345', OPENCODE_PASSWORD: 'pw' }, auth)
  let removed = false, refreshes = 0
  const value = { ...auth.opencode, methodID: 'device' }
  const client = createCredentialClient({ env: f.env, mask: () => {}, request: async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1')) {
      if (options.method === 'POST') return Response.json({ data: { id: 'cred_console', value } })
      if (options.method === 'DELETE') { removed = true; return new Response(null, { status: 204 }) }
      return Response.json({ data: [{ id: 'cred_console', integrationID: 'opencode', value }] })
    }
    if (String(url).startsWith('https://identity.test')) return Response.json({ value: 'oidc' })
    const body = JSON.parse(options.body)
    if (body.operation === 'refresh') { refreshes++; return new Response('{}', { status: 409 }) }
    return Response.json({ revision: 'r1', auth, secrets: {} })
  } })
  await client.load(); await client.installConsole(); await client.sync(); assert.equal(removed, false)
  await client.sync(); assert.equal(refreshes, 1)
  await client.sync(true); assert.equal(removed, true); assert.equal(existsSync(f.file), false)
})


test('enable account debug fallback without overriding the repository key', async t => {
  const key = 'ssh-ed25519 AAAATEST default'
  const fallback = fixture(t, {}, null, key)
  await fallback.client.load()
  const output = readFileSync(fallback.env.GITHUB_ENV, 'utf8')
  assert.match(output, /AGENTSWEB_SSH_PUBLIC_KEY<</)
  assert.match(output, /AGENTSWEB_SSH_ENABLED<<[^\n]+\ntrue\n/)
  const configured = fixture(t, { AGENTSWEB_SSH_PUBLIC_KEY: 'repository-key' }, null, key)
  await configured.client.load()
  assert.doesNotMatch(readFileSync(configured.env.GITHUB_ENV, 'utf8'), /AGENTSWEB_SSH_PUBLIC_KEY|AGENTSWEB_SSH_ENABLED/)
  const disabled = fixture(t, {}, null)
  await disabled.client.load()
  assert.doesNotMatch(readFileSync(disabled.env.GITHUB_ENV, 'utf8'), /AGENTSWEB_SSH_PUBLIC_KEY|AGENTSWEB_SSH_ENABLED/)
})
test('load debug authorization before SSH and start SSH before package installation', () => {
  const workflow = readFileSync(new URL('../.github/workflows/opencode-reusable.yml', import.meta.url), 'utf8')
  assert.ok(workflow.indexOf('name: Load account credentials') < workflow.indexOf('name: Start AgentsWeb SSH session'))
  assert.ok(workflow.indexOf('name: Start AgentsWeb SSH session') < workflow.indexOf('name: Configure Linux Playwright'))
  assert.ok(workflow.includes('printf \'%s\\n\' "$AGENTSWEB_SSH_PUBLIC_KEY"'))
})

 test('required shared metadata is exported without treating policy words as secrets, unavailable pool fails closed',async t=>{
 const good=fixture(t,{FUSION_ACCESS_TOKEN:'repository-own',FUSION_UPSTREAM:'https://direct.test'},initial,undefined,{fusion_route:'shared',fusion_required:true,secrets:{FUSION_ACCESS_TOKEN:'test_run_cap',FUSION_UPSTREAM:'https://omgithub.com/api/fusion-pool'}})
 await good.client.load();assert.match(readFileSync(good.env.GITHUB_ENV,'utf8'),/FUSION_REQUIRE_SHARED<<[^\n]+\ntrue\n/);assert.ok(good.masks.includes('test_run_cap'));assert.ok(!good.masks.includes('shared'));assert.match(readFileSync(good.env.GITHUB_ENV,'utf8'),/FUSION_ACCESS_TOKEN<<[^\n]+\ntest_run_cap\n/);assert.match(readFileSync(good.env.GITHUB_ENV,'utf8'),/FUSION_UPSTREAM<<[^\n]+\nhttps:\/\/omgithub.com\/api\/fusion-pool\n/);const bad=fixture(t,{},initial,undefined,{fusion_route:'none',fusion_required:true});await assert.rejects(bad.client.load(),/Required shared Fusion unavailable/)
 const f=fixture(t,{},initial,undefined,{fusion_route:'shared',fusion_required:false});await f.client.load();const text=readFileSync(f.env.GITHUB_ENV,'utf8');assert.match(text,/FUSION_ROUTE<<[^\n]+\nshared\n/);assert.match(text,/FUSION_REQUIRE_SHARED<<[^\n]+\nfalse\n/);assert.ok(!f.masks.includes('shared'))
 })
