import test from 'node:test'
import assert from 'node:assert/strict'
import { retry, uploadDeployment } from './deployment-retry.mjs'
import { findRelease } from './session-checkpoint.mjs'

test('direct release lookup treats only 404 as absent', () => {
  assert.deepEqual(findRelease('tag', () => '{"id":12}'), { id: 12 })
  assert.equal(findRelease('tag', () => { throw { status: 404 } }), null)
  for (const status of [401, 403, 429, 500, undefined])
    assert.throws(() => findRelease('tag', () => { throw Object.assign(new Error('failure'), { status }) }))
})
test('upload retries reuse archive and return success', async () => {
  const body = Buffer.from('archive'), calls = []
  const result = await uploadDeployment('https://example.test', { method: 'POST', body }, {
    wait: async () => {}, request: async (url, options) => {
      calls.push(options.body)
      if (calls.length === 1) throw new TypeError('network lost')
      return calls.length === 2 ? new Response('busy', { status: 503 }) : Response.json({ id: 'done' })
    }
  })
  assert.equal(result.id, 'done')
  assert.deepEqual(calls, [body, body, body])
})
test('permanent and stale upload failures are not retried', async () => {
  for (const status of [400, 401, 403, 409]) {
    let count = 0
    await assert.rejects(uploadDeployment('url', {}, { wait: async () => {}, request: async () => {
      count++; return new Response('failed', { status })
    } }))
    assert.equal(count, 1)
  }
})
test('retry stops on cancellation and limits failures', async () => {
  let count = 0
  await assert.rejects(retry(async () => { count++; throw new Error('failed') }, { wait: async () => {} }))
  assert.equal(count, 3)
  const controller = new AbortController()
  count = 0
  await assert.rejects(retry(async () => { count++; controller.abort(); throw new Error('failed') }, { signal: controller.signal }))
  assert.equal(count, 1)
})
test('retries rate-limit responses but bounds repeated failures', async () => {
  for (const status of [429, 403]) {
    let count = 0
    await assert.rejects(uploadDeployment('url', {}, { wait: async () => {}, request: async () => {
      count++; return new Response('rate limited', { status, headers: { 'retry-after': '1' } })
    } }))
    assert.equal(count, 3)
  }
})
