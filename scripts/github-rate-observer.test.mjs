import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { attach, observation } = require('../.github/scripts/github-rate-observer.cjs')
const headers = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-used': '5000', 'x-ratelimit-reset': '1790058908', 'x-ratelimit-resource': 'core' }
test('capture all rate fields on successful and failed Octokit responses', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'github-rate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const hooks = {}
  attach({ hook: { after: (name, handler) => { hooks.after = handler }, error: (name, handler) => { hooks.error = handler } } }, dir)
  await hooks.after({ headers, status: 200 })
  assert.equal(JSON.parse(readFileSync(join(dir, 'github-rate.json'))).remaining, 0)
  const failure = Object.assign(new Error('rate limit'), { status: 403, response: { headers } })
  await assert.rejects(() => hooks.error(failure), /rate limit/)
  const saved = JSON.parse(readFileSync(join(dir, 'github-rate.json')))
  assert.equal(saved.status, 403)
  assert.deepEqual([saved.limit, saved.remaining, saved.used, saved.reset, saved.resource], [5000, 0, 5000, 1790058908, 'core'])
  assert.equal(observation({}, 200), null)
})
