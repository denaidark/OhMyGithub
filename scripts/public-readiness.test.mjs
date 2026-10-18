import test from 'node:test'
import assert from 'node:assert/strict'
import { publicUrlReady, readyPublicUrls } from './public-readiness.mjs'

test('require normal DNS and successful HTTPS; reject errors, redirects and HTTP', async () => {
  assert.equal(await publicUrlReady(''), false)
  assert.equal(await publicUrlReady('http://example.com'), false)
  assert.equal(await publicUrlReady('https://example.com', async () => { throw new Error('ENOTFOUND') }), false)
  assert.equal(await publicUrlReady('https://example.com', async () => new Response('', { status: 503 })), false)
  assert.equal(await publicUrlReady('https://example.com', async () => new Response('', { status: 302 })), false)
  let cancelled = false
  assert.equal(await publicUrlReady('https://example.com', async (url, options) => {
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal)
    return { ok: true, body: { cancel: async () => { cancelled = true } } }
  }), true)
  assert.equal(cancelled, true)
})

test('gate each endpoint independently and retry failures on subsequent polls', async () => {
  const urls = { opencode: 'https://chat.test/session/1', files: 'https://chat.test/files/', preview: 'https://preview.test', branch: 'https://github.com/a/b' }
  assert.deepEqual(await readyPublicUrls(urls, async () => false), { opencode: '', files: '', preview: '', branch: urls.branch })
  assert.deepEqual(await readyPublicUrls(urls, async url => url === urls.files), { ...urls, opencode: '', preview: '' })
  assert.deepEqual(await readyPublicUrls(urls, async () => true), urls)
})
