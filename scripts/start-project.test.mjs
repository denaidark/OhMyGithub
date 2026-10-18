import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

function run(t, mode, script = 'exit 0\n', restart = false, repeat = 1, timeout = '600') {
  const root = mkdtempSync(join(tmpdir(), 'startup-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  if (script !== null) writeFileSync(join(root, 'start.sh'), script)
  writeFileSync(join(root, 'calls'), '')
  const stub = (name, body) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
  stub('node', 'echo reclaim-port >> "$PROJECT_DIR/calls"')
  stub('sleep', 'exit 0')
  stub('tmux', `echo "$1" >> "$PROJECT_DIR/calls"; if [[ "$1" == new-session ]]; then touch "$PROJECT_DIR/started"; elif [[ "$1" == kill-session ]]; then rm -f "$PROJECT_DIR/started"; elif [[ "$1" == has-session && "$TEST_MODE" == exited ]]; then exit 1; fi`)
  stub('curl', `
    url="\${!#}"
    if [[ "$url" == https://public.test ]]; then if [[ "$TEST_MODE" == public-rejected ]]; then echo 403; elif [[ "$TEST_MODE" == public-failure ]]; then echo 502; else echo 200; fi; exit 0; fi
    count=0; [[ ! -f "$PROJECT_DIR/checks" ]] || read -r count < "$PROJECT_DIR/checks"
    count=$((count + 1)); echo "$count" > "$PROJECT_DIR/checks"
    if [[ "$TEST_MODE" == slow-build ]]; then [[ "$count" -gt 40 ]]; exit; fi
    if [[ "$TEST_MODE" == pending-build ]]; then [[ "$count" -gt 4 ]]; exit; fi
    [[ "$TEST_MODE" != local-failure ]] || exit 1
    [[ "$TEST_MODE" == running || -f "$PROJECT_DIR/started" ]]
  `)
  let result
  for (let i = 0; i < repeat; i++) result = spawnSync('bash', [fileURLToPath(new URL('./start-project.sh', import.meta.url))], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROJECT_DIR: root, RUNTIME_DIR: root, OPENCODE_WEB_DIR: root, APP_URL: 'https://public.test', APP_PORT: '3000', STARTUP_TIMEOUT_SECONDS: timeout, CHECKPOINT_COMMIT: repeat > 1 ? 'same-checkpoint' : '', TEST_MODE: mode, RESTART_APP: String(restart) }
  })
  return { ...result, calls: readFileSync(join(root, 'calls'), 'utf8') }
}
test('starts a stopped app and checks local and public readiness', t => {
  const result = run(t, 'stopped')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.calls, /new-session/)
})
test('reuses an already running app', t => {
  const result = run(t, 'running')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.calls, 'has-session\n')
})
test('rejects missing or malformed startup scripts', t => {
  assert.notEqual(run(t, 'running', null).status, 0)
  assert.notEqual(run(t, 'running', 'if then\n').status, 0)
})
test('fails closed for local and public startup failures', t => {
  assert.match(run(t, 'local-failure').stderr, /Local startup failed/)
  assert.match(run(t, 'public-failure').stderr, /Public preview did not become ready/)
})

test('restart current server after completion to rebuild the latest source', t => {
  const result = run(t, 'running', 'exit 0\n', true)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.calls, /kill-session/)
  assert.match(result.calls, /new-session/)
})

test('public retry across launcher invocations preserves the healthy checkpoint server', t => {
  const result = run(t, 'public-failure', 'exit 0\n', false, 3)
  assert.equal(result.status, 75)
  assert.equal((result.calls.match(/new-session/g) || []).length, 1)
})

test('classifies public host rejection as repairable instead of transient', t => {
  const result = run(t, 'public-rejected')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /HTTP 403/)
})
test('reclaims a project-owned listener before starting the managed server', t => {
  const result = run(t, 'running', 'exit 0\n', true)
  assert.ok(result.calls.indexOf('reclaim-port') < result.calls.indexOf('new-session'))
})

test('waits for a build longer than the former sixty-second startup window', t => {
  const result = run(t, 'slow-build')
  assert.equal(result.status, 0, result.stderr)
  assert.equal((result.calls.match(/new-session/g) || []).length, 1)
})
test('continues an in-flight checkpoint build across local readiness retries', t => {
  const result = run(t, 'pending-build', 'exit 0\n', false, 3, '4')
  assert.equal(result.status, 0, result.stderr)
  assert.equal((result.calls.match(/new-session/g) || []).length, 1)
})
test('fails immediately when the startup process exits', t => {
  const result = run(t, 'exited')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Startup process exited/)
})
test('rejects invalid startup timeout configuration', t => {
  const result = run(t, 'stopped', 'exit 0\n', false, 1, 'no')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /positive integer/)
})
