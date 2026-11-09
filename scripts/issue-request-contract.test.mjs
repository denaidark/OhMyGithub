import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseIssueRequest, parseModelChain } from './issue-request.mjs'
test('implements the shared metadata-only request contract', () => {
  for (const fixture of JSON.parse(readFileSync(new URL('./fixtures/issue-request.json', import.meta.url)))) {
    const result = parseIssueRequest(fixture.issue)
    if (fixture.error) assert.ok(result.branchError)
    else for (const key of ['title', 'targetRef', 'branchSpecified']) assert.equal(result[key], fixture[key])
  }
})

test('extracts model_chain from issue metadata', () => {
  const chain = ['opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free']
  const body = `Build it\n\n<!-- omgithub-request:v1 ${JSON.stringify({ model_chain: chain })} -->`
  const result = parseIssueRequest({ title: 'Game', body })
  assert.deepEqual(result.modelChain, chain)
})

test('returns null modelChain when no chain in metadata', () => {
  const result = parseIssueRequest({ title: 'Game', body: 'Build it' })
  assert.equal(result.modelChain, null)
})

test('parseModelChain validates and filters entries', () => {
  assert.equal(parseModelChain(null), null)
  assert.equal(parseModelChain([]), null)
  assert.equal(parseModelChain(['invalid']), null)
  assert.deepEqual(parseModelChain(['opencode/model', 'invalid', 'openai/gpt']), ['opencode/model', 'openai/gpt'])
  assert.equal(parseModelChain(Array(30).fill('opencode/m')).length, 20)
})
