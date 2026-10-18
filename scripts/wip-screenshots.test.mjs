import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import captures from './wip-screenshots.cjs'
import { uploadScreenshots } from './wip-upload.mjs'

const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('fixture')])
test('accept only registered project origins, preserve capture time, retry uploads, and deduplicate', async () => {
  const web = mkdtempSync(join(tmpdir(), 'wip-queue-'))
  const env = { OPENCODE_WEB_DIR: web, APP_PORT: '3000', GITHUB_REPOSITORY: 'alice/game', TRIGGER_ISSUE_NUMBER: '4', GITHUB_RUN_ID: '123', OMGITHUB_CALLBACK_TOKEN: 'fixture' }
  try {
    writeFileSync(join(web, 'app-url'), 'https://project.trycloudflare.com')
    writeFileSync(join(web, 'project-preview-origins.json'), JSON.stringify(['http://localhost:4000']))
    for (const url of ['http://localhost:3000/play', 'http://127.0.0.1:3000', 'https://project.trycloudflare.com/play', 'http://localhost:4000']) assert.equal(captures.isProjectPage(url, env), true)
    for (const url of ['https://reference.example', 'https://other.trycloudflare.com', 'http://localhost:5555', 'data:image/png,x', 'http://localhost:3000.evil.test']) assert.equal(captures.isProjectPage(url, env), false)
    assert.equal(captures.queueScreenshot(png, { page_url: 'https://reference.example' }, env), null)
    const hash = captures.queueScreenshot(png, { page_url: 'http://localhost:3000/game?token=hidden', captured_at: 123 }, env)
    assert.equal(captures.queueScreenshot(png, { page_url: 'http://localhost:3000/game', captured_at: 456 }, env), hash)
    const metadata = JSON.parse(readFileSync(join(web, 'wip-queue', `${hash}.json`)))
    assert.equal(metadata.captured_at, 123)
    assert.equal(metadata.page_url, 'http://localhost:3000/game')
    await assert.rejects(uploadScreenshots(env, async () => new Response('retry', { status: 503 })), /503/)
    assert.equal(readdirSync(join(web, 'wip-queue')).filter(name => name.endsWith('.image')).length, 1)
    await uploadScreenshots(env, async (_, request) => {
      assert.equal(request.headers['x-omgithub-captured-at'], '123')
      assert.deepEqual(request.body, png)
      return Response.json({ ok: true })
    })
    assert.deepEqual(readdirSync(join(web, 'wip-queue')), [`${hash}.done`])
    captures.queueScreenshot(png, { page_url: 'http://localhost:3000/game' }, env)
    assert.deepEqual(readdirSync(join(web, 'wip-queue')), [`${hash}.done`])
  } finally { rmSync(web, { recursive: true, force: true }) }
})

test('instrument page and locator capture APIs without changing buffers or failed screenshots', async () => {
  const web = mkdtempSync(join(tmpdir(), 'wip-instrument-'))
  const env = { OPENCODE_WEB_DIR: web }
  class Locator { constructor(page) { this.p = page }; page() { return this.p }; async screenshot() { return png } }
  class Page { url() { return 'http://localhost:3000/game' }; locator() { return new Locator(this) }; async screenshot() { return png } }
  const page = new Page(), context = { pages: () => [page], on() {} }
  const browser = { contexts: () => [context], newContext: async () => context }
  const chromium = { launch: async () => browser, launchPersistentContext: async () => context }
  try {
    captures.instrument({ chromium }, env)
    await chromium.launch()
    assert.deepEqual(await page.screenshot(), png)
    assert.deepEqual(await page.locator().screenshot(), png)
    assert.equal(readdirSync(join(web, 'wip-queue')).filter(name => name.endsWith('.json')).length, 1)
  } finally { rmSync(web, { recursive: true, force: true }) }
})
