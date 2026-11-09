import { createV2Client, finishedV2Message } from './opencode-v2-api.mjs'
import { collectSessionStats, finishStats } from './opencode-stats.mjs'
import { spawn } from 'node:child_process'
import { appendFileSync, openSync, writeSync, closeSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Single source of truth for the default order: scripts/model-chain.json.
const modelChain = JSON.parse(readFileSync(new URL('./model-chain.json', import.meta.url), 'utf8'))
export const fusionModel = modelChain.fusion
export const fullModelChain = modelChain.chain
export const preferredFreeModels = fullModelChain.filter(model => model !== fusionModel)
export function defaultModelChain(fusionEnabled = false) {
  return fullModelChain.filter(model => fusionEnabled || model !== fusionModel)
}
// Picked model first, then the whole default chain (Fusion in its slot when on), deduplicated.
// Retired free models (absent from the live catalog) are skipped unless none are left.
export function modelCandidates(selected, live = null, chain = defaultModelChain(false)) {
  const ordered = [...new Set(chain)]
  const liveOnly = ordered.filter(model => !live || !preferredFreeModels.includes(model) || live.includes(model))
  const rest = liveOnly.some(model => preferredFreeModels.includes(model)) ? liveOnly : ordered
  return [...new Set([selected, ...rest].filter(Boolean))]
}
// Admin force mode is an explicit test contract, not a normal user model preference.
// Continuations copy model/* labels, so both label resolution and execution enforce it.
// adminChain (ordered model ids from the site's admin settings) replaces the default order for Default builds.
// Fusion keeps its leading slot when enabled; requireShared and route handling are unchanged.
export function adminModelChain(adminChain, fusionEnabled = false) {
  const free = Array.isArray(adminChain) ? adminChain.filter(id => typeof id === 'string' && id && id !== fusionModel) : []
  return free.length ? [...(fusionEnabled ? [fusionModel] : []), ...new Set(free)] : null
}
export function resolveRunModels({ selected, live = null, fusionEnabled = false, requireShared = false, forceSharedTest = false, route = 'none', adminChain = null }) {
  if (requireShared) {
    if (!fusionEnabled) throw new Error('Required shared Fusion plugin unavailable; refusing free-model fallback')
    // Preserve an explicit connected paid-provider choice outside admin test mode.
    if (selected && selected !== fusionModel && !freeEgressModel(selected) && !forceSharedTest) return { model: selected, models: [selected, fusionModel] }
    return { model: fusionModel, models: [fusionModel] }
  }
  const chain = (!selected && adminModelChain(adminChain, fusionEnabled)) || defaultModelChain(fusionEnabled)
  const fallback = chain.find(id => !live || !id.startsWith('opencode/') || live.includes(id)) || chain[0]
  const usable = id => !live || !id.startsWith('opencode/') || !id.endsWith('-free') || live.includes(id)
  const model = selected && usable(selected) ? selected : fallback
  return { model, models: route === 'own' && model === fusionModel ? [fusionModel] : modelCandidates(model, live, chain) }
}
export function retryableProviderError(error) {
  if (!error || typeof error !== 'object') return false
  const type = String(error.type || ''), message = String(error.message || '')
  return [429, 500, 502, 503, 504].includes(Number(error.status)) || ['provider.free-limit', 'provider.rate-limit', 'provider.overloaded', 'provider.model-not-found'].includes(type) ||
    /FreeUsageLimit|ModelDeprecated|model.*(?:not found|unavailable|deprecated)|free usage limit|rate.limit/i.test(message) ||
    // A dropped upstream stream is worth another model, not a failed build.
    /upstream connection lost|connection (?:lost|reset|closed)|ECONNRESET|fetch failed|socket hang up|terminated/i.test(message)
}
// The local proxy relay (WARP wireproxy or DataImpulse) could not open a tunnel,
// e.g. DataImpulse 407 TRAFFIC_EXHAUSTED surfaced as `502 Upstream Proxy Error`.
export function proxyTunnelError(error) {
  return !!error && typeof error === 'object' && /ERR_PROXY_TUNNEL|Proxy refused to open a tunnel|Upstream Proxy Error|TRAFFIC_EXHAUSTED/i.test(String(error.message || ''))
}
// Coarse class for admin stats; null when the attempt reported no error.
export function attemptErrorClass(error) {
  if (!error || typeof error !== 'object') return null
  const status = Number(error.status), type = String(error.type || ''), message = String(error.message || '')
  if (proxyTunnelError(error)) return 'proxy'
  if (type === 'provider.free-limit' || /FreeUsageLimit|free usage limit/i.test(message)) return 'free-limit'
  if (status === 429 || type === 'provider.rate-limit' || /rate.limit|\b429\b/i.test(message)) return 'rate-limit'
  if ([401, 403].includes(status) || /^provider\.auth|unauthori[sz]ed|forbidden|invalid api key/i.test(type + ' ' + message)) return 'auth'
  return 'other'
}
// One numbers-only read of the session (and subagents) after each attempt; saved for
// build stats and posted to /telemetry in the v1 `stats` shape. Never throws.
export async function reportSessionStats({ api, sessionID, directory, env = process.env, attempts = [], request = fetch }) {
  if (!api || !/^ses_[A-Za-z0-9]+$/.test(sessionID || '')) return null
  try {
    const opencode_ms = attempts.reduce((sum, a) => sum + (Number.isFinite(a?.duration_ms) ? a.duration_ms : 0), 0)
    const stats = finishStats(await collectSessionStats(api, sessionID), { chat_runtime_seconds: Math.round(opencode_ms / 1000) })
    writeFileSync(join(directory, 'opencode-stats.json'), JSON.stringify(stats))
    if (env.OMGITHUB_CALLBACK_TOKEN && env.GITHUB_REPOSITORY && env.TRIGGER_ISSUE_NUMBER && env.GITHUB_RUN_ID) {
      await request(`${env.OMGITHUB_ORIGIN || 'https://omgithub.com'}/api/github/${env.GITHUB_REPOSITORY}/issues/${env.TRIGGER_ISSUE_NUMBER}/telemetry`, {
        method: 'POST', headers: { authorization: `Bearer ${env.OMGITHUB_CALLBACK_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ run: env.GITHUB_RUN_ID, attempt: Number(env.GITHUB_RUN_ATTEMPT || 1), observed_at: new Date().toISOString(), stats }),
        signal: AbortSignal.timeout(10000) }).catch(() => {})
    }
    return stats
  } catch { return null }
}
// Best-effort nudge so the lifecycle posts build stats now, not at the next 30 s tick.
export function pingHeartbeat(env = process.env) {
  const port = Number(env.OPENCODE_CONTROL_PORT)
  if (!Number.isInteger(port) || port < 1) return Promise.resolve()
  return fetch(`http://127.0.0.1:${port}/omgithub/heartbeat`, { signal: AbortSignal.timeout(3000) }).then(() => {}, () => {})
}
export function fusionFallbackError(model, error) {
  if (model !== fusionModel || !error || typeof error !== 'object') return false
  const status = Number(error.status), type = String(error.type || ''), message = String(error.message || '')
  return [401, 403, 404, 429, 500, 502, 503, 504].includes(status) ||
    /Copilot \/auto|Fusion|Refuse fallback|Unexpected server error|quota|usage limit|chat limit|model.*not found/i.test(`${type} ${message}`)
}
/** Host of the configured Fusion endpoint. Never includes credentials or query text. */
export function fusionUpstreamHost(env = process.env) {
  try { return new URL(String(env.FUSION_UPSTREAM || '')).host || 'unknown' } catch { return 'unknown' }
}
/** One sanitized line naming the Fusion endpoint behind a failed attempt. */
export function fusionFailureLine(failure, env = process.env) {
  const message = String(failure?.message || failure?.type || 'unknown error').replace(/\s+/g, ' ').slice(0, 160)
  const status = Number(failure?.status) || 0
  return `[model-fallback] fusion upstream ${fusionUpstreamHost(env)} reported ${message}${status ? ` (status ${status})` : ''}\n`
}
export async function terminalAttemptOutcome({ api, sessionID, started, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!api || !/^ses_[A-Za-z0-9]+$/.test(sessionID)) return null
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const snapshot = await api.snapshot(sessionID)
      const terminal = snapshot.messages?.find(message => ['idle', 'assistant', 'user'].includes(message.type))
      // Reject an earlier turn's successful idle marker while projections catch up.
      if (!snapshot.busy && terminal?.type === 'idle' && Number(terminal.time?.created) >= started) {
        if (terminal.outcome === 'succeeded' && finishedV2Message(snapshot)) return { outcome: 'succeeded', message_id: finishedV2Message(snapshot), finished_at: terminal.time.created }
        if (['failed', 'interrupted'].includes(terminal.outcome)) return { outcome: terminal.outcome }
      }
    } catch { /* Retry short projection/transport gaps, without trusting stale success. */ }
    if (attempt < 3) await pause(250)
  }
  return null
}

// Anonymous free models (FreeUsageLimit is per egress block): the ones a proxy switch can help.
export function freeEgressModel(model) {
  return model !== fusionModel && (preferredFreeModels.includes(model) || /^opencode\/[\w.-]+-free$/.test(String(model)))
}
/**
 * Place the admin-configured backup endpoint after every model but before Fusion.
 * Fusion moves to the very end so a free-model failure never jumps straight to a shared donor.
 */
export function appendBackupModel(candidates, env = process.env) {
  const backup = String(env.OMG_BACKUP_MODEL || '').trim()
  if (!backup || !/^[\w.-]+\/[\w./:-]+$/.test(backup)) return candidates
  const queue = candidates.filter(model => model !== backup && model !== fusionModel)
  const fusion = candidates.includes(fusionModel) ? [fusionModel] : []
  return [...queue, backup, ...fusion]
}

/**
 * Apply admin "skip direct OpenCode" routing: remove free OpenCode models from the chain.
 * Route order with SKIP_DIRECT_OC=1:
 * - WARP on: try through WARP proxy → backup → Fusion
 * - WARP off: backup → Fusion only (no free model calls)
 * Fusion is kept because it's not a "direct OpenCode" call.
 */
export function applySkipDirectRouting(candidates, env = process.env) {
  if (env.SKIP_DIRECT_OC !== '1') return candidates
  const backup = String(env.OMG_BACKUP_MODEL || '').trim()
  // Without the ondev backup endpoint configured, skipping would leave nothing but Fusion; keep today's chain.
  if (!backup || !candidates.includes(backup)) return candidates
  return candidates.filter(model => !freeEgressModel(model))
}
// Runtime egress switch: when WARP passed its startup probe (WARP_RUNTIME_SWITCH=1) but a free
// model still hits FreeUsageLimit mid-build, move `opencode serve` to the DataImpulse relay once.
// The script's stdout only carries ::add-mask:: lines and is discarded; its stderr (no secrets) goes to the run log.
export function runtimeProxySwitch({ env = process.env, binary, logFile }) {
  if (env.WARP_RUNTIME_SWITCH !== '1' || env.PROXY_REQUEST !== 'true') return null // proxy toggle off by default
  const script = join(dirname(fileURLToPath(import.meta.url)), 'runtime-proxy-switch.sh')
  return () => new Promise(done => {
    const fd = openSync(logFile, 'a')
    const child = spawn('bash', [script], { cwd: env.PROJECT_DIR, env: { ...env, OPENCODE_BIN: binary }, stdio: ['ignore', 'ignore', fd] })
    child.on('error', () => { closeSync(fd); done(false) })
    child.on('close', status => { closeSync(fd); done(status === 0) })
  })
}
// Lazy egress: WARP was skipped because Default starts with Fusion (WARP_LAZY=1). Before the
// first free model runs, set WARP up (DataImpulse if WARP fails) and restart `opencode serve`
// behind it. Exit 0 = WARP, 3 = DataImpulse, other = runner network. Runs at most once.
export function lazyProxySetup({ env = process.env, binary, logFile }) {
  if (env.WARP_LAZY !== '1') return null
  const script = join(dirname(fileURLToPath(import.meta.url)), 'lazy-proxy-setup.sh')
  return () => new Promise(done => {
    const fd = openSync(logFile, 'a')
    const child = spawn('bash', [script], { cwd: env.PROJECT_DIR, env: { ...env, OPENCODE_BIN: binary }, stdio: ['ignore', 'ignore', fd] })
    child.on('error', () => { closeSync(fd); done('none') })
    child.on('close', status => { closeSync(fd); done(status === 0 ? 'warp' : status === 3 ? 'dataimpulse' : 'none') })
  })
}
// Dead proxy: restart `opencode serve` without it (back to WARP after a runtime switch,
// otherwise the runner network) instead of letting every model fail through it.
export function proxyDrop({ env = process.env, binary, logFile }) {
  const web = env.OPENCODE_WEB_DIR
  let current = ''
  try { current = readFileSync(join(web, 'opencode-proxy'), 'utf8').trim() } catch {}
  if (!web || !current) return null
  const script = join(dirname(fileURLToPath(import.meta.url)), 'drop-proxy.sh')
  return () => new Promise(done => {
    const fd = openSync(logFile, 'a')
    const child = spawn('bash', [script], { cwd: env.PROJECT_DIR, env: { ...env, OPENCODE_BIN: binary }, stdio: ['ignore', 'ignore', fd] })
    child.on('error', () => { closeSync(fd); done(false) })
    child.on('close', status => { closeSync(fd); done(status === 0) })
  })
}
export async function runModels({ binary, port, promptFile, logFile, exitFile, selected, models = modelCandidates(selected), env = process.env, api = env.OPENCODE_PASSWORD ? createV2Client({ base: `http://127.0.0.1:${port}`, password: env.OPENCODE_PASSWORD }) : null, switchProxy = runtimeProxySwitch({ env, binary, logFile }), dropProxy, lazyProxy = lazyProxySetup({ env, binary, logFile }) }) {
  const directory = dirname(logFile), prompt = readFileSync(promptFile, 'utf8')
  const requiredShared = env.FUSION_REQUIRE_SHARED === 'true'
  if (requiredShared && env.FUSION_ROUTE !== 'shared') throw new Error('Required shared Fusion route unavailable')
  const strictFusion = requiredShared && (env.FUSION_FORCE_SHARED_TEST === 'true' || !selected || selected === fusionModel || freeEgressModel(selected)) || env.FUSION_ROUTE === 'own' && selected === fusionModel
  const candidates = strictFusion ? [fusionModel] : [...new Set(models)].filter(model => !requiredShared || !freeEgressModel(model))
  if (!candidates.length || candidates.some(model => typeof model !== 'string' || !/^[\w.-]+\/[\w./:-]+$/.test(model))) throw new Error('Invalid model fallback candidates')
  // Last resort: the site-wide backup endpoint, only after every chain model failed.
  // Apply admin skip_direct_opencode routing: remove free models if SKIP_DIRECT_OC=1.
  const queue = applySkipDirectRouting(appendBackupModel(candidates, env), env)
  let sessionID = env.RESUME_SESSION_ID || '', child, interrupted = false, code = 1
  const attempts = []
  let switched = false, dropped = false
  const stop = signal => { interrupted = true; child?.kill(signal) }
  const onTerm = () => stop('SIGTERM'), onInt = () => stop('SIGINT')
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt)
  try {
    for (let index = 0; index < queue.length; index++) {
      const model = queue[index]
      if (interrupted) break
      if (lazyProxy && freeEgressModel(model)) {
        const setup = lazyProxy; lazyProxy = null
        appendFileSync(logFile, '[model-fallback] Leaving Fusion for a free model; setting up the WARP proxy now.\n')
        const mode = await setup().catch(() => 'none')
        appendFileSync(logFile, `[model-fallback] Lazy proxy: ${mode}.\n`)
        // WARP passed its probe: the one-time DataImpulse switch on FreeUsageLimit applies as usual.
        if (mode === 'warp' && !switchProxy) switchProxy = runtimeProxySwitch({ env: { ...env, WARP_RUNTIME_SWITCH: '1' }, binary, logFile })
        if (mode === 'dataimpulse') switched = true
      }
      const started = Date.now()
      writeFileSync(join(directory, 'main-model'), model + '\n')
      void pingHeartbeat(env)
      appendFileSync(logFile, `[model-fallback] Trying ${model}\n`)
      const fd = openSync(logFile, 'a')
      let failure, observedSession = false, pending = { out: '', err: '' }
      const inspect = (name, chunk, finish = false) => {
        pending[name] += chunk
        const lines = pending[name].split('\n'); pending[name] = finish ? '' : lines.pop()
        for (const line of lines) {
          try {
            const row = JSON.parse(line)
            if (/^ses_[A-Za-z0-9]+$/.test(row.sessionID || '')) { sessionID = row.sessionID; observedSession = true }
            if (row.type === 'error') failure = row.error
          } catch {}
        }
        if (pending[name].length > 1024 * 1024) pending[name] = ''
      }
      try {
        code = await new Promise(resolve => {
          child = spawn(binary, ['run', ...(sessionID ? ['--session', sessionID] : []), '--auto', '--server', `http://127.0.0.1:${port}`, '--model', model, '--format', 'json', prompt], { cwd: env.PROJECT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] })
          for (const [name, stream] of [['out', child.stdout], ['err', child.stderr]]) stream.on('data', chunk => { writeSync(fd, chunk); inspect(name, chunk.toString()) })
          child.on('error', () => resolve(1))
          child.on('close', (status, signal) => { inspect('out', '', true); inspect('err', '', true); resolve(signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : status ?? 1) })
        })
      } finally { closeSync(fd); child = null }
      const cliCode = code
      const terminal = observedSession && !interrupted && cliCode < 128 ? await terminalAttemptOutcome({ api, sessionID, started }) : null
      const outcome = terminal?.outcome
      // Providers can emit recoverable errors before the same turn succeeds.
      // Trust only a fresh terminal session outcome, not the presence of old errors.
      if (outcome === 'succeeded') {
        code = 0; failure = undefined
        writeFileSync(join(directory, 'main-completion.json'), JSON.stringify({ ...terminal, session_id: sessionID }))
      }
      else if (outcome === 'failed' || outcome === 'interrupted' || code === 0 && (failure || api)) code = 1
      const retryable = outcome !== 'interrupted' && (retryableProviderError(failure) || fusionFallbackError(model, failure))
      attempts.push({ model, cli_code: cliCode, outcome: outcome || 'unverified', code, retryable, error_class: code === 0 ? null : attemptErrorClass(failure) || (outcome === 'interrupted' ? null : 'other'), duration_ms: Date.now() - started })
      writeFileSync(join(directory, 'model-attempts.json'), JSON.stringify(attempts))
      await reportSessionStats({ api, sessionID, directory, env, attempts })
      await pingHeartbeat(env)
      appendFileSync(logFile, `[timing] model ${model}: ${Date.now() - started} ms; cli exit ${cliCode}; terminal ${outcome || 'unverified'}; exit ${code}\n`)
      if (code !== 0 && model === fusionModel && failure) appendFileSync(logFile, fusionFailureLine(failure, env))
      if (code !== 0 && !interrupted && !dropped && proxyTunnelError(failure)) {
        dropped = true; switched = true
        const drop = dropProxy === undefined ? proxyDrop({ env, binary, logFile }) : dropProxy
        appendFileSync(logFile, '[model-fallback] The proxy refused to open tunnels; restarting OpenCode without it.\n')
        const ok = drop ? await drop().catch(() => false) : false
        attempts.at(-1).proxy_drop = ok ? 'ok' : 'failed'
        writeFileSync(join(directory, 'model-attempts.json'), JSON.stringify(attempts))
        if (ok) { appendFileSync(logFile, `[model-fallback] Proxy dropped; retrying ${model}.\n`); index--; continue }
      }
      if (code === 0 || interrupted || !retryable) break
      if (!switched && switchProxy && freeEgressModel(model) && attempts.at(-1).error_class === 'free-limit') {
        switched = true
        appendFileSync(logFile, '[model-fallback] Free usage limit on the WARP exit; switching OpenCode to the DataImpulse proxy.\n')
        const ok = await switchProxy().catch(() => false)
        attempts.at(-1).proxy_switch = ok ? 'ok' : 'failed'
        writeFileSync(join(directory, 'model-attempts.json'), JSON.stringify(attempts))
        if (ok) { appendFileSync(logFile, `[model-fallback] DataImpulse proxy ready; retrying ${model}.\n`); index--; continue }
        appendFileSync(logFile, '[model-fallback] DataImpulse proxy unavailable; keeping the current network.\n')
      }
      if (model !== candidates.at(-1)) appendFileSync(logFile, '[model-fallback] Provider/model unavailable; advancing to the next candidate in the same session.\n')
    }
    if (interrupted && code === 0) code = 143
    return { code, attempts, sessionID }
  } finally {
    process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onInt)
    writeFileSync(exitFile + '.tmp', String(code) + '\n'); renameSync(exitFile + '.tmp', exitFile)
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [binary, port, promptFile, logFile, exitFile, selected] = process.argv.slice(2)
  try {
    const result = await runModels({ binary, port, promptFile, logFile, exitFile, selected,
      models: process.env.OPENCODE_MODELS_JSON ? JSON.parse(process.env.OPENCODE_MODELS_JSON) : modelCandidates(selected, null, defaultModelChain(Boolean(process.env.FUSION_ACCESS_TOKEN))) })
    process.exitCode = result.code
  } catch {
    appendFileSync(logFile, '[model-fallback] Model execution setup failed. Inspect the workflow configuration.\n')
    writeFileSync(exitFile + '.tmp', '1\n'); renameSync(exitFile + '.tmp', exitFile)
    process.exitCode = 1
  }
}
