import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
test('main prompt contains only the user request', () => {
  assert.equal(read('../.github/prompts/01-build.md'), '@COMMENT_BODY@\n')
})
test('script preparation precedes checkpoint replacement and publication', () => {
  const source = read('./session-deploy.mjs')
  const setup = source.indexOf('await preparePreview(')
  const save = source.indexOf("'scripts/session-checkpoint.mjs'")
  assert.ok(setup > 0 && setup < save)
  assert.ok(source.indexOf('const deployed =') > save)
  assert.doesNotMatch(source, /assertSource|validation\.json.*passed|RESTART_APP/)
  assert.doesNotMatch(read('./session-lifecycle.mjs'), /--session.*mainID\(\)/)
})
test('second checkpoint is conditional on repair', () => {
  const source = read('./session-deploy.mjs')
  assert.match(source, /const \{ repaired \} = await preparePreview/)
  assert.match(source, /if \(repaired\) \{\s*await child\(process.execPath/)
  const block = source.slice(source.indexOf('  if (repaired)'), source.indexOf('  const marker'))
  assert.match(block, /CHECKPOINT_COMMIT = updated.commit/)
  assert.match(block, /CHECKPOINT_GENERATION = updated.generation/)
})
test('checkpoint path does not paginate or delete legacy releases', () => {
  const source = read('./session-checkpoint.mjs')
  assert.match(source, /releases\/tags\//)
  assert.doesNotMatch(source, /--paginate|release', 'delete'/)
})
test('packages declared output and isolates reporting failure from deployment success', () => {
  const source = read('./session-deploy.mjs')
  assert.match(source, /deployment-output.json/)
  assert.doesNotMatch(source, /root=os.path.join\(root,'dist'\)/)
  assert.match(source, /Result reporting failed/)
  assert.match(source, /deployment-result.json/)
  assert.match(source, /sync: 'failed'/)
})

test('checkpoint releases contain restore data, not deployment evidence', () => {
  for (const path of ['./session-deploy.mjs', './session-checkpoint.mjs']) assert.doesNotMatch(read(path), /deployment:v1/)
  assert.doesNotMatch(read('./session-deploy.mjs'), /release.*upload|releases.assets/)
})
