import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { uploadScreenshots } from './wip-upload.mjs'
test('progress images go to Git and callbacks carry immutable references only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wip-git-')), web = join(root, '.opencode-web'), dir = join(web, 'wip-queue')
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const hash = 'a'.repeat(64)
  try {
    mkdirSync(dir, { recursive: true });git('init');git('config', 'user.name', 'Test');git('config', 'user.email', 'test@example.test');git('init', '--bare', join(root, 'remote.git'));git('remote', 'add', 'origin', join(root, 'remote.git'))
    writeFileSync(join(dir, hash + '.json'), JSON.stringify({ hash, type: 'image/png', captured_at: Date.now(), page_url: 'http://localhost:3000' }))
    writeFileSync(join(dir, hash + '.image'), 'png-bytes')
    let callback
    await uploadScreenshots({ ...process.env, GITHUB_WORKSPACE: root, OPENCODE_WEB_DIR: web, GITHUB_REPOSITORY: 'alice/game', TRIGGER_ISSUE_NUMBER: '6', GITHUB_RUN_ID: '123', OMGITHUB_CALLBACK_TOKEN: 'callback' }, async (url, options) => {
      callback = JSON.parse(options.body);assert.equal(options.headers['content-type'], 'application/json');return new Response('{}')
    })
    assert.match(callback.url, /^https:\/\/f.ondev.store\/alice\/game\/blob\/[a-f0-9]{40}\/[a-f0-9]{64}\.png$/)
    const commit = git('ls-remote', 'origin', 'refs/heads/opencode-progress/6').split(/\s/)[0]
    assert.equal(git('show', `${commit}:${hash}.png`), 'png-bytes')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
