import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

for (const os of ['macOS', 'Linux']) for (const installed of [true, false]) for (const fail of [false, true]) {
  if (installed && fail) continue
  test(`preview tmux: ${os}, installed=${installed}, install fails=${fail}`, t => {
    const root = mkdtempSync(join(tmpdir(), 'preview-runtime-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const log = join(root, 'calls')
    writeFileSync(log, '')
    const stub = (name, body) => writeFileSync(join(root, name), '#!/bin/bash\n' + body, { mode: 0o755 })
    stub('tmux-source', 'echo "tmux $*" >> "$CALL_LOG"\n')
    symlinkSync('/bin/cp', join(root, 'cp'))
    if (installed) symlinkSync(join(root, 'tmux-source'), join(root, 'tmux'))
    stub('sudo', 'exec "$@"\n')
    for (const name of ['brew', 'apt-get']) stub(name, `echo "${name} $*" >> "$CALL_LOG"
${fail ? 'exit 9' : 'if [[ "$1" == install ]]; then cp "$PATH/tmux-source" "$PATH/tmux"; fi'}
`)
    const result = spawnSync('/bin/bash', [new URL('./setup-preview-runtime.sh', import.meta.url).pathname], {
      env: { ...process.env, PATH: root, RUNNER_OS: os, CALL_LOG: log }, encoding: 'utf8'
    })
    assert.equal(result.status, fail ? 9 : 0, result.stderr)
    const calls = readFileSync(log, 'utf8').trim().split('\n')
    assert.deepEqual(calls, installed ? ['tmux -V'] : os === 'macOS'
      ? ['brew install tmux', ...(fail ? [] : ['tmux -V'])]
      : ['apt-get update', ...(fail ? [] : ['apt-get install -y tmux', 'tmux -V'])])
  })
}
test('install preview dependencies independently of optional SSH and before startup', () => {
  const workflow = readFileSync(new URL('../.github/workflows/opencode-reusable.yml', import.meta.url), 'utf8')
  const step = workflow.split('      - name: Install preview process manager\n')[1].split('      - name:')[0]
  assert.match(step, /if: env.SSH_ONLY_REQUEST != 'true'/)
  assert.doesNotMatch(step, /AGENTSWEB_SSH_ENABLED|continue-on-error/)
  assert.match(step, /setup-preview-runtime.sh/)
  assert.ok(workflow.indexOf('name: Install preview process manager') < workflow.indexOf('name: Start OpenCode web UI'))
})
