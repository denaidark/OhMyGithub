import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
test('use callback credentials only for OmGithub callbacks; install the latest stable v2 runtime without GitHub REST', () => {
  const workflow = read('.github/workflows/opencode-reusable.yml')
  assert.doesNotMatch(workflow, /api\.github\.com\/repos\/anomalyco\/opencode\/releases/)
  assert.match(workflow, /https:\/\/opencode\.ai\/v2\/install/)
  assert.match(workflow, /latest-opencode-version\.mjs/)
  assert.match(workflow, /name: Register Actions progress\n        continue-on-error: true/)
  for (const name of ['run-record.mjs', 'session-deploy.mjs', 'session-lifecycle.mjs']) {
    const code = read(`scripts/${name}`)
    assert.match(code, /authorization: `Bearer \$\{env.OMGITHUB_CALLBACK_TOKEN/)
    assert.doesNotMatch(code, /authorization: `Bearer \$\{env.GH_TOKEN/)
  }
})
test('grant OIDC permission and bootstrap before checkout in both jobs', () => {
  for (const name of ['opencode-prepare.yml', 'opencode-reusable.yml']) {
    const workflow = read(`.github/workflows/${name}`)
    assert.match(workflow, /id-token: write/)
    assert.ok(workflow.indexOf('name: Authenticate status callbacks') < workflow.indexOf('uses: actions/checkout'))
    assert.match(workflow, /ACTIONS_ID_TOKEN_REQUEST_URL/)
  }
})
test('report failed execution before the debug hold keeps Actions running', () => {
  const workflow = read('.github/workflows/opencode-reusable.yml')
  const early = workflow.indexOf('name: Report failed build before debug hold')
  const hold = workflow.indexOf('name: Keep temporary access available')
  const final = workflow.indexOf('name: Report terminal build status')
  assert.ok(early > 0 && early < hold && hold < final)
  const step = workflow.slice(early, hold)
  assert.match(step, /if: failure\(\)/)
  assert.match(step, /run-failure\.mjs" --payload/)
  assert.match(step, /if \[\[ -f "\$RUNTIME_DIR\/scripts\/run-failure\.mjs" \]\]/)
  assert.match(step, /failed before model diagnostics were available/)
  assert.match(step, /issues\/\$TRIGGER_ISSUE_NUMBER\/run/)
})

test('all shell status callbacks use millisecond sequences like lifecycle heartbeats', () => {
  for (const name of ['opencode-prepare.yml', 'opencode-reusable.yml']) {
    const workflow = read(`.github/workflows/${name}`)
    const sequences = workflow.match(/^          sequence=.*$/gm)
    assert.equal(sequences?.length, 2, name)
    for (const sequence of sequences) {
      assert.equal(sequence.trim(), "sequence=$(/usr/bin/time -p node -p 'Date.now()')", name)
      const before = Date.now()
      const value = Number(execFileSync('bash', ['-c', `${sequence.trim()}; printf '%s' "$sequence"`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
      assert.ok(Number.isSafeInteger(value) && value >= before && value <= Date.now(), name)
    }
  }
})
