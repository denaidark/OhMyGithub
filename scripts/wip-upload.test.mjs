import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { uploadScreenshots } from './wip-upload.mjs'
test('upload progress image bytes with run identity and clear the local queue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wip-upload-')), web = join(root, 'web'), dir = join(web, 'wip-queue'), hash = 'a'.repeat(64)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, hash + '.json'), JSON.stringify({ hash, type: 'image/png', captured_at: 10, page_url: 'http://localhost:3000' }))
    writeFileSync(join(dir, hash + '.image'), 'png')
    let request
    await uploadScreenshots({ ...process.env, OPENCODE_WEB_DIR: web, OMGITHUB_CALLBACK_TOKEN: 'token', GITHUB_REPOSITORY: 'alice/game', TRIGGER_ISSUE_NUMBER: '6', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }, async (url, options) => { request = { url, options }; return new Response('{}') })
    assert.match(request.url, /\/progress-screenshots$/)
    assert.equal(request.options.headers['content-type'], 'image/png')
    assert.equal(request.options.body.toString(), 'png')
    assert.equal(request.options.headers['x-omgithub-run'], '123')
    assert.equal(existsSync(join(dir, hash + '.json')), false)
    assert.equal(existsSync(join(dir, hash + '.done')), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
