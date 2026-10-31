import test from 'node:test'
import assert from 'node:assert/strict'
import { latestOpenCodeVersion } from './latest-opencode-version.mjs'
test('resolve the active stable v2 latest channel for every invocation', async () => {
  let calls = 0
  const request = async url => {
    assert.equal(url, 'https://opencode.ai/update/api/latest/cli/npm')
    return Response.json({ channel: 'latest', active: true, version: ++calls === 1 ? '2.2.5' : '2.2.6' })
  }
  assert.equal(await latestOpenCodeVersion(request), '2.2.5')
  assert.equal(await latestOpenCodeVersion(request), '2.2.6')
})
test('reject unavailable, inactive, prerelease, and other-major versions', async () => {
  await assert.rejects(latestOpenCodeVersion(async () => new Response(null, { status: 503 })), /HTTP 503/)
  for (const metadata of [{ version: '1.9.0' }, { version: '3.0.0' }, { version: '2.3.0-beta' }, { version: '2.3.0', active: false }, { version: '2.3.0', channel: 'preview' }]) {
    await assert.rejects(latestOpenCodeVersion(async () => Response.json({ channel: 'latest', active: true, ...metadata })), /stable v2/)
  }
})
