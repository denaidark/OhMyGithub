import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerRun } from './run-record.mjs'

test('registers connectivity without duplicating publication state', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'run-register-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const [name, value] of Object.entries({ 'web-url': 'https://control.test', 'files-url': 'https://files.test/', 'ready-preview-url': 'https://app.test', 'checkpoint-session-id': 'ses_main', 'checkpoint-state.json': '{"commit":"abc"}', 'deployment-result.json': '{"sync":"failed"}' })) writeFileSync(join(dir, name), value)
  let payload
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/api/github/alice/game/issues/2/run')
    let text = ''; for await (const chunk of req) text += chunk
    payload = JSON.parse(text); res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  await registerRun({ OPENCODE_WEB_DIR: dir, PROJECT_DIR: dir, GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '2', GITHUB_REPOSITORY: 'alice/game', TRIGGER_ISSUE_NUMBER: '2', GH_TOKEN: 'fixture', OMGITHUB_ORIGIN: `http://127.0.0.1:${server.address().port}` }, undefined, async () => true)
  assert.equal(payload.state, 'live')
  assert.equal(payload.urls.files, 'https://files.test/')
  assert.match(payload.urls.opencode, /session\/ses_main$/)
  assert.equal(payload.deployment, undefined)
  assert.equal(payload.checkpoint, undefined)
  assert.equal(payload.attempt, 2)
  assert.equal(payload.urls.preview, 'https://app.test')
  rmSync(join(dir, 'ready-preview-url'))
  writeFileSync(join(dir, 'app-url'), 'https://allocated-but-not-ready.test')
  await registerRun({ OPENCODE_WEB_DIR: dir, PROJECT_DIR: dir, GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '2', GITHUB_REPOSITORY: 'alice/game', TRIGGER_ISSUE_NUMBER: '2', GH_TOKEN: 'fixture', OMGITHUB_ORIGIN: `http://127.0.0.1:${server.address().port}` }, undefined, async () => true)
  assert.equal(payload.urls.preview, '')
  await registerRun({ OPENCODE_WEB_DIR: dir, PROJECT_DIR: dir, GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '2', GITHUB_REPOSITORY: 'alice/game', TRIGGER_ISSUE_NUMBER: '2', GH_TOKEN: 'fixture', OMGITHUB_ORIGIN: `http://127.0.0.1:${server.address().port}` }, undefined, async () => false)
  assert.equal(payload.state, 'starting')
  assert.equal(payload.urls.opencode, '')
  assert.equal(payload.urls.files, '')
})
