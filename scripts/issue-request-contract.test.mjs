import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseIssueRequest } from './issue-request.mjs'
test('implements the shared metadata-only request contract', () => {
  for (const fixture of JSON.parse(readFileSync(new URL('./fixtures/issue-request.json', import.meta.url)))) {
    const result = parseIssueRequest(fixture.issue)
    if (fixture.error) assert.ok(result.branchError)
    else for (const key of ['title', 'targetRef', 'branchSpecified']) assert.equal(result[key], fixture[key])
  }
})
