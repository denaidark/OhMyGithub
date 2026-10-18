import test from 'node:test'
import assert from 'node:assert/strict'
import { recoverMacDns } from './mac-dns-recovery.mjs'
import { publicUrlReady } from './public-readiness.mjs'
const host = 'fresh-test.trycloudflare.com'
const error = { cause: { code: 'ENOTFOUND' } }
test('repair only published Quick Tunnel DNS failures on Actions Macs', async () => {
  let flushed = 0
  const options = { enabled: true, resolve: async () => ['104.16.230.132'], flush: async () => { flushed++ } }
  assert.equal(await recoverMacDns(host, error, { ...options, enabled: false }), false)
  assert.equal(await recoverMacDns('example.com', error, options), false)
  assert.equal(await recoverMacDns(host, { code: 'ECONNREFUSED' }, options), false)
  assert.equal(await recoverMacDns(host, error, { ...options, resolve: async () => { throw error } }), false)
  assert.equal(flushed, 0)
  assert.equal(await recoverMacDns(host, error, options), true)
  assert.equal(flushed, 1)
})
test('retry normal HTTPS exactly once after confirmed cache repair', async () => {
  let calls = 0
  assert.equal(await publicUrlReady(`https://${host}`, async () => {
    if (++calls === 1) throw error
    return new Response('ok')
  }, async () => true), true)
  assert.equal(calls, 2)
  calls = 0
  assert.equal(await publicUrlReady(`https://${host}`, async () => { calls++; throw error }, async () => true), false)
  assert.equal(calls, 2)
})
