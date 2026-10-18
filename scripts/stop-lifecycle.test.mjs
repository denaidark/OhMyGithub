import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stopLifecycle } from './stop-lifecycle.mjs'

async function fixture(script, detached = false) {
  const directory = mkdtempSync(join(tmpdir(), 'lifecycle-stop-'))
  const proc = spawn(process.execPath, ['-e', script], { detached, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LIFECYCLE_TEST_DIR: directory } })
  await once(proc.stdout, 'data')
  const exited = once(proc, 'exit')
  const pidFile = join(directory, 'lifecycle.pid')
  writeFileSync(pidFile, String(proc.pid))
  return { proc, directory, pidFile, exited, clean: () => { proc.kill('SIGKILL'); rmSync(directory, { recursive: true, force: true }) } }
}
test('stop waits for graceful save completion before runtime cleanup', async () => {
  const f = await fixture(`process.on('SIGTERM', () => setTimeout(() => { require('node:fs').writeFileSync(require('node:path').join(process.env.LIFECYCLE_TEST_DIR, 'lifecycle-shutdown.json'), JSON.stringify({ exitCode: 0 })); process.exit() }, 30)); console.log('ready'); setInterval(() => {}, 1000)`)
  try { await stopLifecycle(f.pidFile, { waitMs: 500, pollMs: 10 }); await f.exited }
  finally { f.clean() }
})
test('stop force-kills stuck controller and its recorded worker group but preserves failure', async () => {
  const script = `process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)`
  const controller = await fixture(script), worker = await fixture(script, true)
  try {
    writeFileSync(join(controller.directory, 'lifecycle-children.json'), JSON.stringify([worker.proc.pid]))
    await assert.rejects(stopLifecycle(controller.pidFile, { waitMs: 20, pollMs: 10, log: () => {} }), /shutdown timed out/)
    assert.equal((await controller.exited)[1], 'SIGKILL')
    assert.equal((await worker.exited)[1], 'SIGKILL')
  } finally { controller.clean(); worker.clean() }
})
test('stop kills controller even when its child registry is missing', async () => {
  const f = await fixture(`process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)`)
  try {
    await assert.rejects(stopLifecycle(f.pidFile, { waitMs: 20, pollMs: 10, log: () => {} }), /shutdown timed out/)
    assert.equal((await f.exited)[1], 'SIGKILL')
  } finally { f.clean() }
})
test('stop retains checkpoint failure recorded by the controller', async () => {
  const f = await fixture(`console.log('ready'); setInterval(() => {}, 1000)`)
  try {
    writeFileSync(join(f.directory, 'lifecycle-shutdown.json'), JSON.stringify({ exitCode: 1 }))
    await assert.rejects(stopLifecycle(f.pidFile, { waitMs: 500, pollMs: 10 }), /shutdown failed/)
  } finally { f.clean() }
})
test('both workflow cleanup paths wait on the shared stop helper before deleting state', () => {
  const workflow = readFileSync(new URL('../.github/workflows/opencode-reusable.yml', import.meta.url), 'utf8')
  assert.equal(workflow.match(/node "\$RUNTIME_DIR\/scripts\/stop-lifecycle.mjs"/g).length, 2)
  assert.ok(workflow.lastIndexOf('node "$RUNTIME_DIR/scripts/stop-lifecycle.mjs"') < workflow.indexOf('rm -rf "$OPENCODE_WEB_DIR"'))
})

test('an already dead controller without a success marker remains a failure and cleans workers', async () => {
  const controller = await fixture(`console.log('ready'); setInterval(() => {}, 1000)`)
  const worker = await fixture(`console.log('ready'); setInterval(() => {}, 1000)`, true)
  try {
    writeFileSync(join(controller.directory, 'lifecycle-children.json'), JSON.stringify([worker.proc.pid]))
    controller.proc.kill('SIGKILL'); await controller.exited
    await assert.rejects(stopLifecycle(controller.pidFile, { log: () => {} }), /without a shutdown result/)
    assert.equal((await worker.exited)[1], 'SIGKILL')
  } finally { controller.clean(); worker.clean() }
})
