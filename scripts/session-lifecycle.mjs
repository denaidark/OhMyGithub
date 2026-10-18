import { SessionRecovery } from './session-recovery.mjs'
import { registerRun } from './run-record.mjs'
import { uploadScreenshots } from './wip-upload.mjs'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Serialize checkpoint/validation workers. Invalidate before aborting: a late
// child result must never become current while a new main message is starting.
export function bounded(operation, milliseconds, label) {
  const controller = new AbortController()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${milliseconds} ms`))
      controller.abort()
    }, milliseconds)
  })
  return Promise.race([Promise.resolve().then(() => operation(controller.signal)), deadline]).finally(() => clearTimeout(timer))
}

const children = new Set()
let recordChildren = () => {}
export function terminateChildren() {
  for (const proc of children) signalChild(proc, 'SIGKILL')
}
function signalChild(proc, signal) {
  try { process.kill(-proc.pid, signal) } catch { try { proc.kill(signal) } catch {} }
}

export async function registerDeployment(env, state, generation, error = '', requestFetch = fetch) {
  const context = `run=${env.GITHUB_RUN_ID} attempt=${env.GITHUB_RUN_ATTEMPT || 1} state=${state} generation=${generation}`
  try {
    const response = await requestFetch(`${env.OMGITHUB_ORIGIN || 'https://omgithub.com'}/api/github/${env.GITHUB_REPOSITORY}/issues/${env.TRIGGER_ISSUE_NUMBER}/deployment`, {
      method: 'POST', headers: { authorization: `Bearer ${env.OMGITHUB_CALLBACK_TOKEN || ''}`, 'x-omgithub-run': env.GITHUB_RUN_ID, 'x-omgithub-attempt': env.GITHUB_RUN_ATTEMPT || '1', 'x-omgithub-generation': String(generation), 'x-omgithub-state': state, 'x-omgithub-error': encodeURIComponent(error).slice(0, 1000) }, signal: AbortSignal.timeout(30000)
    })
    if (!response.ok) {
      const body = (await response.text()).slice(0, 2000).replace(/\s+/g, ' ').trim()
      throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ''}`)
    }
  } catch (error) { throw new Error(`Deployment registration ${context}: ${error.message}`, { cause: error }) }
}

export class Lifecycle {
  constructor({ save, deploy, status = () => {} }) { Object.assign(this, { save, deploy, status }); this.generation = 0; this.active = null; this.lastMessage = ''; this.stopping = false }
  async busy() {
    const generation = ++this.generation
    const active = this.active
    active?.controller.abort()
    if (generation === this.generation) await this.status('working', generation)
    if (active) await active.promise.catch(() => {})
    return generation
  }
  async complete(messageID) {
    if (this.stopping || !messageID || messageID === this.lastMessage) return
    this.lastMessage = messageID
    let generation
    try { generation = await this.busy() }
    catch (error) {
      if (this.lastMessage === messageID) this.lastMessage = ''
      await Promise.resolve(this.status('failed', this.generation, error.message)).catch(() => {})
      throw error
    }
    if (generation !== this.generation || this.stopping) return
    const controller = new AbortController()
    const current = () => !controller.signal.aborted && generation === this.generation && !this.stopping
    const promise = (async () => {
      await this.status('saving', generation)
      const checkpoint = await this.save(controller.signal)
      if (!current() || !checkpoint) return
      await this.status('deploying', generation)
      await this.deploy({ checkpoint, messageID, generation, signal: controller.signal, current })
      if (current()) await this.status('ready', generation)
    })().catch(async error => { if (current()) await Promise.resolve(this.status('failed', generation, error.message)).catch(() => {}) })
    this.active = { controller, promise }
    await promise
    if (this.active?.promise === promise) this.active = null
  }
  shutdown({ drainMs = 10000, saveMs = 150000, log = message => process.stderr.write(`${message}\n`) } = {}) {
    if (this.shutdownPromise) return this.shutdownPromise
    this.stopping = true
    ++this.generation
    const active = this.active
    active?.controller.abort()
    this.shutdownPromise = (async () => {
      if (active) {
        try { await bounded(() => active.promise.catch(() => {}), drainMs, 'Shutdown worker drain') }
        catch (error) { log(error.message); terminateChildren() }
      }
      await bounded(signal => this.save(signal, true), saveMs, 'Shutdown checkpoint save')
    })()
    return this.shutdownPromise
  }
}

export function child(file, args, { signal, killGraceMs = 5000, settleGraceMs = 1000, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const proc = spawn(file, args, { stdio: ['ignore', 'inherit', 'pipe'], detached: process.platform !== 'win32', ...options })
    if (proc.pid) { children.add(proc); recordChildren() }
    let stderr = '', forced, deadline, settled = false
    proc.stderr?.on('data', chunk => { process.stderr.write(chunk); stderr = (stderr + chunk.toString()).slice(-4000) })
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(forced); clearTimeout(deadline); signal?.removeEventListener('abort', abort)
      // Even if the leader exits first, terminate descendants in its detached group.
      if (signal?.aborted) signalChild(proc, 'SIGKILL')
      children.delete(proc); recordChildren()
      proc.stderr?.destroy()
      process.stderr.write(`[timing] ${file}: ${Date.now() - started} ms\n`)
      if (error) reject(error)
      else resolve()
    }
    const abort = () => {
      signalChild(proc, 'SIGTERM')
      forced = setTimeout(() => signalChild(proc, 'SIGKILL'), killGraceMs)
      // Do not depend on close: a descendant can retain the inherited stderr pipe.
      deadline = setTimeout(() => finish(new Error('Cancelled')), killGraceMs + settleGraceMs)
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    proc.once('error', finish)
    proc.once('close', code => {
      if (signal?.aborted) finish(new Error('Cancelled'))
      else if (code !== 0) finish(Object.assign(new Error(`${file} exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(-1500)}` : ''}`), { exitCode: code }))
      else finish()
    })
  })
}

export function finishedMessage(current) {
  const last = current.messages?.at(-1)?.info
  if (current.busy || last?.role !== 'assistant' || !last.time?.completed) return null
  if (last.error?.name === 'MessageAbortedError') return last.id
  if (last.error || last.finish === 'tool-calls') return null
  return last.id
}

async function serve() {
  const env = process.env, directory = env.OPENCODE_WEB_DIR
  recordChildren = () => {
    const path = join(directory, 'lifecycle-children.json')
    writeFileSync(`${path}.tmp`, JSON.stringify([...children].map(proc => proc.pid)))
    renameSync(`${path}.tmp`, path)
  }
  recordChildren()
  const upstream = `http://127.0.0.1:${env.OPENCODE_WEB_PORT}`
  const mainID = () => { try { return readFileSync(join(directory, 'checkpoint-session-id'), 'utf8').trim() } catch { return '' } }
  const api = async (path, options = {}) => {
    const response = await fetch(`${upstream}${path}`, { ...options, headers: { 'x-opencode-directory': env.PROJECT_DIR, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`OpenCode HTTP ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }
  const lifecycle = new Lifecycle({
    save: async (signal, interrupted) => {
      if (!mainID()) return null
      await child(process.execPath, [join(env.RUNTIME_DIR, 'scripts/session-checkpoint.mjs'), interrupted ? 'shutdown' : 'save'], { signal })
      return JSON.parse(readFileSync(join(directory, 'checkpoint-state.json'), 'utf8'))
    },
    deploy: async ({ checkpoint, messageID, generation, signal }) => {
      const appURL = readFileSync(join(directory, 'app-url'), 'utf8').trim()
      if (!appURL) throw new Error('Preview failed: app tunnel unavailable')
      await child(process.execPath, [join(env.RUNTIME_DIR, 'scripts/session-deploy.mjs')], { signal, env: { ...env, APP_URL: appURL, CHECKPOINT_COMMIT: checkpoint.commit, CHECKPOINT_GENERATION: checkpoint.generation, MAIN_MESSAGE_ID: messageID, DEPLOYMENT_GENERATION: String(generation) } })
    },
    status: async (state, generation, error = '') => {
      writeFileSync(join(directory, 'deployment-status.json'), JSON.stringify({ state, generation, error, updated_at: new Date().toISOString() }))
      if (state === 'working' && existsSync(join(directory, 'active-validation.json'))) {
        const active = JSON.parse(readFileSync(join(directory, 'active-validation.json'), 'utf8'))
        const response = await fetch(`${upstream}/session/${active.id}/abort`, { method: 'POST', headers: { 'x-opencode-directory': active.directory }, signal: AbortSignal.timeout(30000) })
        if (!response.ok) throw new Error('Could not stop validation. Retry the message.')
        rmSync(join(directory, 'active-validation.json'), { force: true })
      }
      if (!lifecycle.stopping) {
        try {
        await registerDeployment(env, state, generation, error)
        await heartbeat()
        } catch (error) { process.stderr.write(`Status callback deferred: ${error.message}\n`) }
      }
    }
  })
  try { lifecycle.generation = Number(JSON.parse(readFileSync(join(directory, 'deployment-status.json'), 'utf8')).generation) || 0 } catch {}
  const snapshot = async id => {
    const states = await api('/session/status')
    return { id, busy: Boolean(states[id]?.type && states[id].type !== 'idle'), messages: await api(`/session/${id}/message`) }
  }
  const recovery = new SessionRecovery({ snapshot, send: (id, body) => api(`/session/${id}/prompt_async`, { method: 'POST', body: JSON.stringify(body) }) })
  let messageGate = Promise.resolve()
  const proxy = createServer(async (req, res) => {
    try {
      if (req.url === '/omgithub/heartbeat') { await heartbeat(); res.end('ok'); return }
      if (req.url === '/omgithub/reconcile') { await reconcile(); res.end('ok'); return }
      if (req.url === '/omgithub/deployment') { res.setHeader('content-type', 'application/json'); res.end(readFileSync(join(directory, 'deployment-status.json'), 'utf8')); return }
      if (req.method === 'POST' && req.url.split('?')[0] === `/session/${mainID()}/abort`) recovery.cancel()
      const match = req.url.match(/^\/session\/([^/?]+)\/(message|prompt_async|command)(?:\?|$)/)
      if (req.method === 'POST' && match?.[1] === mainID()) {
        recovery.cancel(true)
        const gate = messageGate.then(() => lifecycle.busy())
        messageGate = gate.catch(() => {})
        await gate
      }
      const targetURL = `${upstream}${req.url}`
      const target = httpRequest(targetURL, { method: req.method, headers: req.headers }, reply => {
        if (req.method === 'POST' && req.url.split('?')[0] === `/session/${mainID()}/abort` && reply.statusCode < 300)
          reply.on('end', () => { void reconcile().catch(console.error) })
        res.writeHead(reply.statusCode, reply.headers); reply.pipe(res)
      })
      target.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
      req.pipe(target)
    } catch { res.writeHead(503); res.end('Deployment controller unavailable') }
  })
  proxy.on('upgrade', (req, socket, head) => {
    const remote = connect(Number(env.OPENCODE_WEB_PORT), '127.0.0.1', () => {
      remote.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${Object.entries(req.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
      remote.write(head); socket.pipe(remote); remote.pipe(socket)
    })
    remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy())
  })
  let registration = Promise.resolve()
  const heartbeat = state => {
    registration = registration.then(() => registerRun(env, state)).catch(error => console.error(error.message))
    return registration
  }
  await new Promise(resolve => proxy.listen(Number(env.OPENCODE_CONTROL_PORT), '127.0.0.1', resolve))
  await heartbeat()
  const heartbeatTimer = setInterval(() => void heartbeat(), 30000)
  let uploading = false
  const upload = async () => {
    if (uploading) return
    uploading = true
    try { await uploadScreenshots(env) } catch (error) { console.error('WIP upload deferred:', error.message) }
    finally { uploading = false }
  }
  const screenshotTimer = setInterval(() => void upload(), 2000)
  void upload()
  let stopping = false
  const events = new AbortController()
  for (const name of ['SIGTERM', 'SIGINT']) process.once(name, () => {
    stopping = true
    events.abort()
    proxy.close()
    proxy.closeAllConnections()
    recovery.cancel()
    clearInterval(heartbeatTimer)
    clearInterval(screenshotTimer)
    // Leave room for worker drain, the 120-second upload, and an ended callback.
    const deadline = setTimeout(() => {
      console.error('Lifecycle shutdown exceeded 180000 ms; terminating owned child groups')
      terminateChildren(); writeFileSync(join(directory, 'lifecycle-shutdown.json'), JSON.stringify({ exitCode: 1 })); process.exit(1)
    }, 180000)
    void lifecycle.shutdown().catch(error => { console.error(error.message); process.exitCode = 1 }).finally(async () => {
      try { await bounded(() => heartbeat('ended'), 15000, 'Shutdown ended callback') }
      catch (error) { console.error(error.message); process.exitCode = 1 }
      finally { clearTimeout(deadline); terminateChildren(); writeFileSync(join(directory, 'lifecycle-shutdown.json'), JSON.stringify({ exitCode: process.exitCode || 0 })); process.exit(process.exitCode || 0) }
    })
  })
  async function reconcile() {
    const id = mainID()
    if (!id || lifecycle.stopping) return
    const current = await snapshot(id)
    recovery.observe(current)
    if (current.busy) return
    const messageID = finishedMessage(current)
    if (messageID) void lifecycle.complete(messageID).catch(console.error)
  }
  // Reconnect the event stream, not a checkpoint timer. Reconcile missed idle
  // events after reconnecting so the first quick response is not lost.
  while (!stopping) {
    try {
      const response = await fetch(`${upstream}/event`, { headers: { 'x-opencode-directory': env.PROJECT_DIR }, signal: events.signal })
      if (!response.ok || !response.body) throw new Error('Event stream unavailable')
      await reconcile()
      let buffer = ''
      for await (const chunk of response.body) {
        buffer += Buffer.from(chunk).toString('utf8')
        let end
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
          const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
          if (!data) continue
          const event = JSON.parse(data), id = event.properties?.sessionID
          if (id !== mainID()) continue
          if (event.type === 'session.status' && event.properties.status?.type === 'busy') { recovery.cancel(); void lifecycle.busy().catch(console.error) }
          if (event.type === 'session.idle' || (event.type === 'session.status' && event.properties.status?.type === 'idle')) await reconcile()
        }
      }
    } catch (error) { if (!stopping) console.error(error.message) }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 1000))
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await serve()
