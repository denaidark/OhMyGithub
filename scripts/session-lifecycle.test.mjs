import test from 'node:test'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { Lifecycle, finishedMessage, child, registerDeployment, bounded } from './session-lifecycle.mjs'
const tick = () => new Promise(resolve => setImmediate(resolve))
test('manual Stop finishes a completed idle response; real errors and running responses do not', () => {
  const snapshot = error => ({ busy: false, messages: [{ info: { id: 'm1', role: 'assistant', time: { completed: 1 }, error } }] })
  assert.equal(finishedMessage(snapshot({ name: 'MessageAbortedError' })), 'm1')
  const abortedTools = snapshot({ name: 'MessageAbortedError' }); abortedTools.messages[0].info.finish = 'tool-calls'
  assert.equal(finishedMessage(abortedTools), 'm1')
  assert.equal(finishedMessage(snapshot()), 'm1')
  assert.equal(finishedMessage(snapshot({ name: 'APIError' })), null)
  assert.equal(finishedMessage({ ...snapshot(), busy: true }), null)
  assert.equal(finishedMessage({ busy: false, messages: [] }), null)
  assert.equal(finishedMessage({ busy: false, messages: [{ info: { id: 'm1', role: 'assistant', time: { completed: 1 }, finish: 'tool-calls' } }] }), null)
})
test('surface the child failure instead of hiding it behind node exited 1', async () => {
  await assert.rejects(child(process.execPath, ['-e', 'console.error("git push rejected: workflows permission"); process.exit(1)']), /git push rejected: workflows permission/)
})
test('completion saves before deploying and deduplicates the same response', async () => {
  const calls = []
  const lifecycle = new Lifecycle({ save: async () => { calls.push('save'); return {} }, deploy: async () => calls.push('deploy') })
  await lifecycle.complete('m1'); await lifecycle.complete('m1')
  assert.deepEqual(calls, ['save', 'deploy'])
})
test('new input aborts and drains validation before allowing the main session', async () => {
  const calls = []
  const lifecycle = new Lifecycle({ save: async () => ({}), deploy: ({ signal }) => new Promise(resolve => {
    calls.push('deploy'); signal.addEventListener('abort', async () => { await tick(); calls.push('stopped'); resolve() })
  }), status: state => calls.push(state) })
  const completion = lifecycle.complete('m1'); await tick()
  await lifecycle.busy(); calls.push('main starts'); await completion
  assert.ok(calls.indexOf('stopped') < calls.indexOf('main starts'))
  assert.equal(calls.includes('ready'), false)
})
test('shutdown saves changed state without starting a validation', async () => {
  const calls = []
  const lifecycle = new Lifecycle({ save: async (_, interrupted) => calls.push(interrupted), deploy: async () => calls.push('deploy') })
  await lifecycle.shutdown(); await lifecycle.complete('m2')
  assert.deepEqual(calls, [true])
})
test('new input during asynchronous generation registration prevents stale save', async () => {
  let release
  const calls = []
  const lifecycle = new Lifecycle({ save: async () => { calls.push('save'); return {} }, deploy: async () => calls.push('deploy'),
    status: (state, generation) => generation === 1 ? new Promise(resolve => { release = resolve }) : undefined })
  const completion = lifecycle.complete('m1')
  await tick()
  await lifecycle.busy()
  release(); await completion
  assert.deepEqual(calls, [])
})
test('retry completion after registration failure instead of silently deduplicating it', async () => {
  let broken = true
  const calls = []
  const lifecycle = new Lifecycle({ save: async () => { calls.push('save'); return {} }, deploy: async () => calls.push('deploy'), status: async state => {
    if (state === 'working' && broken) throw new Error('registration unavailable')
  } })
  await assert.rejects(lifecycle.complete('m1'), /registration unavailable/)
  broken = false
  await lifecycle.complete('m1')
  assert.deepEqual(calls, ['save', 'deploy'])
})
test('invalidate remote deployment before waiting for a cancelled worker', async () => {
  const calls = []
  const lifecycle = new Lifecycle({ save: async () => ({}), status: async state => calls.push(state), deploy: ({signal}) => new Promise(resolve => {
    signal.addEventListener('abort', () => setImmediate(() => { calls.push('drained'); resolve() }))
  }) })
  const completion = lifecycle.complete('m1'); await tick()
  calls.length = 0
  await lifecycle.busy(); await completion
  assert.deepEqual(calls, ['working', 'drained'])
})

test('registration failure retains server body and run, attempt, state, generation without auth', async () => {
  const env = { GITHUB_REPOSITORY: 'owner/repo', TRIGGER_ISSUE_NUMBER: '39', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', OMGITHUB_CALLBACK_TOKEN: 'secret-token' }
  await assert.rejects(registerDeployment(env, 'saving', 7, '', async (_, options) => {
    assert.equal(options.headers.authorization, 'Bearer secret-token')
    return new Response('{"error":"This deployment was superseded."}', { status: 409 })
  }), error => {
    assert.match(error.message, /run=123 attempt=2 state=saving generation=7/)
    assert.match(error.message, /HTTP 409.*This deployment was superseded/)
    assert.equal(error.message.includes('secret-token'), false)
    return true
  })
})
test('registration network failure retains callback identity', async () => {
  await assert.rejects(registerDeployment({ GITHUB_RUN_ID: '123' }, 'working', 8, '', async () => { throw new Error('offline') }), /run=123 attempt=1 state=working generation=8: offline/)
})
test('registration success does not read a response body', async () => {
  await registerDeployment({ GITHUB_RUN_ID: '123' }, 'ready', 9, '', async () => ({ ok: true, text: () => { throw new Error('unexpected read') } }))
})
test('shutdown bounds an uncooperative worker and still saves once without registration', async () => {
  const calls = []
  const lifecycle = new Lifecycle({ save: async (_, interrupted) => { calls.push(interrupted); return {} }, deploy: () => new Promise(() => {}), status: state => calls.push(state) })
  void lifecycle.complete('m1'); await tick()
  calls.length = 0
  const stop = lifecycle.shutdown({ drainMs: 20, saveMs: 100, log: message => calls.push(message) })
  assert.equal(lifecycle.shutdown(), stop)
  await stop
  assert.match(calls[0], /Shutdown worker drain timed out/)
  assert.deepEqual(calls.slice(1), [true])
})
test('shutdown deadline aborts the final checkpoint save and reports failure', async () => {
  let aborted = false
  const lifecycle = new Lifecycle({ save: signal => new Promise(() => { signal.addEventListener('abort', () => { aborted = true }) }) })
  await assert.rejects(lifecycle.shutdown({ saveMs: 20 }), /Shutdown checkpoint save timed out/)
  assert.equal(aborted, true)
})
test('successful bounded work cancels its deadline', async () => {
  assert.equal(await bounded(() => 42, 100, 'test'), 42)
})
test('aborted child kills an uncooperative process group and settles', async () => {
  const controller = new AbortController()
  const script = `process.on('SIGTERM', () => {}); console.error('ready'); setInterval(() => {}, 1000)`
  const task = child(process.execPath, ['-e', script], { signal: controller.signal, killGraceMs: 50, settleGraceMs: 50 })
  setTimeout(() => controller.abort(), 200)
  await assert.rejects(task, /Cancelled/)
})

test('abort kills descendants retaining the worker stderr pipe', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lifecycle-descendants-'))
  const marker = join(directory, 'descendant.pid')
  const controller = new AbortController()
  const descendant = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`
  const leader = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'ignore', 'inherit'] }); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`
  const task = child(process.execPath, ['-e', leader], { signal: controller.signal, killGraceMs: 50, settleGraceMs: 50 })
  const rejection = assert.rejects(task, /Cancelled/)
  try {
    const deadline = Date.now() + 2000
    while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(existsSync(marker), 'descendant started')
    const pid = Number(readFileSync(marker, 'utf8'))
    controller.abort(); await rejection
    // Linux can retain an orphan zombie briefly; it is no longer a running worker.
    try {
      process.kill(pid, 0)
      assert.equal(process.platform, 'linux')
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      assert.ok(stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z'))
    } catch (error) { if (!['ESRCH', 'ENOENT'].includes(error.code)) throw error }
  } finally { controller.abort(); await rejection; rmSync(directory, { recursive: true, force: true }) }
})
