import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workerTunnel } from './worker-tunnel.mjs'

test('cleanup uses execution callback identity without provisioning ports', async () => {
  const env = { OMGITHUB_ORIGIN: 'https://site.test', GITHUB_REPOSITORY: 'owner/repo', TRIGGER_ISSUE_NUMBER: '3', GITHUB_RUN_ID: '99', GITHUB_RUN_ATTEMPT: '2', OMGITHUB_CALLBACK_TOKEN: 'callback' }
  await workerTunnel(env, 'stop', async (url, options) => {
    assert.equal(url, 'https://site.test/api/github/owner/repo/issues/3/tunnel')
    assert.equal(options.method, 'DELETE')
    assert.deepEqual(JSON.parse(options.body), { run: '99', attempt: 2 })
    assert.equal(options.headers.authorization, 'Bearer callback')
    return new Response(null, { status: 204 })
  })
})
test('failed provisioning never starts a connector', async () => {
  await assert.rejects(workerTunnel({}, 'start', async () => new Response(null, { status: 503 })), /HTTP 503/)
})
