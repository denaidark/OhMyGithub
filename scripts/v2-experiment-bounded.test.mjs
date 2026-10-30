import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./v2-experiment-bounded.py', import.meta.url))

test('retain successful output and time the command', () => {
  const result = spawnSync('python3', [script, '2', 'python3', '-c', 'print("success")'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /success/)
  assert.match(result.stderr, /\[timing\]/)
})

test('stop a hung command with a bounded nonzero result', () => {
  const result = spawnSync('python3', [script, '0.1', 'python3', '-c', 'import time; time.sleep(5)'], { encoding: 'utf8' })
  assert.equal(result.status, 124)
  assert.match(result.stderr, /exceeded/)
  assert.match(result.stderr, /\[timing\]/)
})
