import { createV2Client, finishedV2Message } from './opencode-v2-api.mjs'
import { collectSessionStats, finishStats } from './opencode-stats.mjs'
import { spawn } from 'node:child_process'
import { appendFileSync, openSync, writeSync, closeSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Single source of truth for the default order: scripts/model-chain.json.
const modelChain = JSON.parse(readFileSync(new URL('./model-chain.json', import.meta.url), 'utf8'))
export const fusionModel = modelChain.fusion
export const defaultFreeModel = modelChain.default_free || 'opencode/deepseek-v4.1-flash-free'
export const fullModelChain = modelChain.chain
export const preferredFreeModels = fullModelChain.filter(model => model !== fusionModel)

/**
 * Route identity for the fallback state machine.
 * Each route is a unique identity that can only be tried once per build.
 */
export const RouteKind = Object.freeze({
  DEEPSEEK_WARP: 'deepseek-warp',
  DEEPSEEK_ONDEV: 'deepseek-ondev',
  FUSION_DIRECT: 'fusion-direct',
  FUSION_SHARED: 'fusion-shared'
})

/**
 * Selection type: determines the fallback chain.
 * - DEFAULT: User selected "Default" or no selection → Fusion first
 * - EXPLICIT_DEEPSEEK: User explicitly selected DeepSeek → DeepSeek first with Fusion fallback
 * - EXPLICIT_OTHER: User explicitly selected another model → That model with Fusion fallback
 * - EXPLICIT_FUSION_ONLY: User explicitly selected Fusion → Fusion only, no other fallback
 */
export const SelectionType = Object.freeze({
  DEFAULT: 'default',
  EXPLICIT_DEEPSEEK: 'explicit-deepseek',
  EXPLICIT_OTHER: 'explicit-other',
  EXPLICIT_FUSION_ONLY: 'explicit-fusion-only'
})

/**
 * Determine the selection type based on user's choice.
 */
export function determineSelectionType(selected, fusionRoute = 'none') {
  // No selection or "Default" selection → Default behavior (Fusion first)
  if (!selected || selected === 'default' || selected === fusionModel && fusionRoute !== 'own') {
    return SelectionType.DEFAULT
  }
  // Explicit Fusion-only (user explicitly selected Fusion with own route)
  if (selected === fusionModel && fusionRoute === 'own') {
    return SelectionType.EXPLICIT_FUSION_ONLY
  }
  // Explicit DeepSeek selection
  if (selected === defaultFreeModel || preferredFreeModels.includes(selected)) {
    return SelectionType.EXPLICIT_DEEPSEEK
  }
  // Explicit other model selection
  return SelectionType.EXPLICIT_OTHER
}

/**
 * Build the route sequence based on selection type.
 * 
 * - DEFAULT: Fusion direct → Fusion shared
 * - EXPLICIT_DEEPSEEK: DeepSeek WARP → DeepSeek ondev → Direct Fusion → Shared Fusion
 * - EXPLICIT_OTHER: (handled in runModels, selected model first) → Direct Fusion → Shared Fusion
 * - EXPLICIT_FUSION_ONLY: Fusion direct → Fusion shared (strict, no other fallback)
 */
export function buildRouteSequence({ selectionType, selected, fusionRoute, backupModel, hasFusionCredentials }) {
  const routes = []
  
  switch (selectionType) {
    case SelectionType.DEFAULT:
      // Default: Fusion first (direct → shared)
      if (hasFusionCredentials && fusionRoute === 'own') {
        routes.push({ model: fusionModel, route: RouteKind.FUSION_DIRECT })
      }
      routes.push({ model: fusionModel, route: RouteKind.FUSION_SHARED })
      break
      
    case SelectionType.EXPLICIT_DEEPSEEK:
      // Explicit DeepSeek: DeepSeek WARP → ondev → Fusion direct → Fusion shared
      routes.push({ model: defaultFreeModel, route: RouteKind.DEEPSEEK_WARP })
      if (backupModel && /^[\w.-]+\/[\w./:-]+$/.test(backupModel)) {
        routes.push({ model: backupModel, route: RouteKind.DEEPSEEK_ONDEV })
      }
      if (hasFusionCredentials && fusionRoute === 'own') {
        routes.push({ model: fusionModel, route: RouteKind.FUSION_DIRECT })
      }
      routes.push({ model: fusionModel, route: RouteKind.FUSION_SHARED })
      break
      
    case SelectionType.EXPLICIT_OTHER:
      // Explicit other model: selected → Fusion direct → Fusion shared
      // (selected model is prepended in runModels)
      if (hasFusionCredentials && fusionRoute === 'own') {
        routes.push({ model: fusionModel, route: RouteKind.FUSION_DIRECT })
      }
      routes.push({ model: fusionModel, route: RouteKind.FUSION_SHARED })
      break
      
    case SelectionType.EXPLICIT_FUSION_ONLY:
      // Explicit Fusion-only: strict Fusion routes only, NO other fallback
      routes.push({ model: fusionModel, route: RouteKind.FUSION_DIRECT })
      routes.push({ model: fusionModel, route: RouteKind.FUSION_SHARED })
      break
      
    default:
      throw new Error(`Unknown selection type: ${selectionType}`)
  }
  
  return routes
}

// Legacy compatibility exports
export function defaultModelChain(fusionEnabled = false) {
  return fusionEnabled ? fullModelChain : preferredFreeModels
}

export function modelCandidates(selected, live = null, chain = defaultModelChain(false)) {
  const ordered = [...new Set(chain)]
  const liveOnly = ordered.filter(model => !live || !preferredFreeModels.includes(model) || live.includes(model))
  const rest = liveOnly.some(model => preferredFreeModels.includes(model)) ? liveOnly : ordered
  return [...new Set([selected, ...rest].filter(Boolean))]
}

export function resolveRunModels({ selected, live = null, fusionEnabled = false, requireShared = false, forceSharedTest = false, route = 'none' }) {
  if (requireShared) {
    if (!fusionEnabled) throw new Error('Required shared Fusion plugin unavailable; refusing free-model fallback')
    if (selected && selected !== fusionModel && !freeEgressModel(selected) && !forceSharedTest) return { model: selected, models: [selected, fusionModel] }
    return { model: fusionModel, models: [fusionModel] }
  }
  const chain = defaultModelChain(fusionEnabled)
  const fallback = chain.find(id => !live || !id.startsWith('opencode/') || live.includes(id)) || chain[0]
  const usable = id => !live || !id.startsWith('opencode/') || !id.endsWith('-free') || live.includes(id)
  const model = selected && usable(selected) ? selected : fallback
  const selectionType = determineSelectionType(selected, route)
  return { model, models: modelCandidates(model, live, chain), selectionType }
}

export function retryableProviderError(error) {
  if (!error || typeof error !== 'object') return false
  const type = String(error.type || ''), message = String(error.message || ''), status = Number(error.status)
  // 402 Payment Required from donor is terminal - don't retry
  if (status === 402) return false
  return [429, 500, 502, 503, 504].includes(status) || ['provider.free-limit', 'provider.rate-limit', 'provider.overloaded', 'provider.model-not-found'].includes(type) ||
    /FreeUsageLimit|ModelDeprecated|model.*(?:not found|unavailable|deprecated)|free usage limit|rate.limit/i.test(message) ||
    /upstream connection lost|connection (?:lost|reset|closed)|ECONNRESET|fetch failed|socket hang up|terminated/i.test(message)
}

export function proxyTunnelError(error) {
  return !!error && typeof error === 'object' && /ERR_PROXY_TUNNEL|Proxy refused to open a tunnel|Upstream Proxy Error|TRAFFIC_EXHAUSTED/i.test(String(error.message || ''))
}

export function attemptErrorClass(error) {
  if (!error || typeof error !== 'object') return null
  const status = Number(error.status), type = String(error.type || ''), message = String(error.message || '')
  if (proxyTunnelError(error)) return 'proxy'
  if (status === 402) return 'donor-402'
  if (type === 'provider.free-limit' || /FreeUsageLimit|free usage limit/i.test(message)) return 'free-limit'
  if (status === 429 || type === 'provider.rate-limit' || /rate.limit|\b429\b/i.test(message)) return 'rate-limit'
  if ([401, 403].includes(status) || /^provider\.auth|unauthori[sz]ed|forbidden|invalid api key/i.test(type + ' ' + message)) return 'auth'
  return 'other'
}

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

export function pingHeartbeat(env = process.env) {
  const port = Number(env.OPENCODE_CONTROL_PORT)
  if (!Number.isInteger(port) || port < 1) return Promise.resolve()
  return fetch(`http://127.0.0.1:${port}/omgithub/heartbeat`, { signal: AbortSignal.timeout(3000) }).then(() => {}, () => {})
}

export function fusionFallbackError(model, error) {
  if (model !== fusionModel || !error || typeof error !== 'object') return false
  const status = Number(error.status), type = String(error.type || ''), message = String(error.message || '')
  if (status === 402) return true
  return [401, 403, 404, 429, 500, 502, 503, 504].includes(status) ||
    /Copilot \/auto|Fusion|Refuse fallback|Unexpected server error|quota|usage limit|chat limit|model.*not found/i.test(`${type} ${message}`)
}

export function fusionUpstreamHost(env = process.env) {
  try { return new URL(String(env.FUSION_UPSTREAM || '')).host || 'unknown' } catch { return 'unknown' }
}

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
      if (!snapshot.busy && terminal?.type === 'idle' && Number(terminal.time?.created) >= started) {
        if (terminal.outcome === 'succeeded' && finishedV2Message(snapshot)) return { outcome: 'succeeded', message_id: finishedV2Message(snapshot), finished_at: terminal.time.created }
        if (['failed', 'interrupted'].includes(terminal.outcome)) return { outcome: terminal.outcome }
      }
    } catch {}
    if (attempt < 3) await pause(250)
  }
  return null
}

export function freeEgressModel(model) {
  return model !== fusionModel && (preferredFreeModels.includes(model) || /^opencode\/[\w.-]+-free$/.test(String(model)))
}

// NOT used for explicit Fusion-only chains
export function appendBackupModel(candidates, env = process.env) {
  const backup = String(env.OMG_BACKUP_MODEL || '').trim()
  if (!backup || !/^[\w.-]+\/[\w./:-]+$/.test(backup)) return candidates
  const nonFusion = candidates.filter(model => model !== fusionModel)
  if (nonFusion.length === 0) return candidates
  const queue = nonFusion.filter(model => model !== backup)
  const fusion = candidates.includes(fusionModel) ? [fusionModel] : []
  return [...queue, backup, ...fusion]
}

export function runtimeProxySwitch({ env = process.env, binary, logFile }) {
  if (env.WARP_RUNTIME_SWITCH !== '1' || env.PROXY_REQUEST !== 'true') return null
  const script = join(dirname(fileURLToPath(import.meta.url)), 'runtime-proxy-switch.sh')
  return () => new Promise(done => {
    const fd = openSync(logFile, 'a')
    const child = spawn('bash', [script], { cwd: env.PROJECT_DIR, env: { ...env, OPENCODE_BIN: binary }, stdio: ['ignore', 'ignore', fd] })
    child.on('error', () => { closeSync(fd); done(false) })
    child.on('close', status => { closeSync(fd); done(status === 0) })
  })
}

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

/**
 * On-demand Fusion acquisition.
 * Called when reaching Fusion routes without a startup lease.
 * Returns: { success: true, token, upstream, route } or { success: false, cause }
 */
export async function acquireFusionOnDemand({ env = process.env, request = fetch, logFile }) {
  const callbackToken = env.OMGITHUB_CALLBACK_TOKEN
  const repo = env.GITHUB_REPOSITORY
  const issueNumber = env.TRIGGER_ISSUE_NUMBER
  const runId = env.GITHUB_RUN_ID
  const runAttempt = env.GITHUB_RUN_ATTEMPT || '1'
  const origin = env.OMGITHUB_ORIGIN || 'https://omgithub.com'
  
  if (!callbackToken || !repo || !issueNumber || !runId) {
    appendFileSync(logFile, '[model-fallback] On-demand Fusion: missing callback credentials, cannot acquire.\n')
    return { success: false, cause: 'missing_callback' }
  }
  
  try {
    appendFileSync(logFile, '[model-fallback] Attempting on-demand Fusion acquisition...\n')
    const response = await request(`${origin}/api/github/${repo}/issues/${issueNumber}/credentials`, {
      method: 'POST',
      headers: { 
        authorization: `Bearer ${callbackToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ 
        run: runId, 
        attempt: Number(runAttempt),
        use_auth: true
      }),
      signal: AbortSignal.timeout(15000)
    })
    
    if (!response.ok) {
      appendFileSync(logFile, `[model-fallback] On-demand Fusion: request failed (${response.status})\n`)
      return { success: false, cause: `http_${response.status}`, status: response.status }
    }
    
    const data = await response.json()
    if (data.secrets?.FUSION_ACCESS_TOKEN) {
      appendFileSync(logFile, `[model-fallback] On-demand Fusion: acquired (route=${data.fusion_route || 'shared'})\n`)
      return { 
        success: true, 
        token: data.secrets.FUSION_ACCESS_TOKEN, 
        upstream: data.secrets.FUSION_UPSTREAM,
        route: data.fusion_route || 'shared'
      }
    }
    
    const cause = data.fusion_skip_cause || 'unknown'
    appendFileSync(logFile, `[model-fallback] On-demand Fusion: not available (${cause})\n`)
    return { success: false, cause }
  } catch (error) {
    appendFileSync(logFile, `[model-fallback] On-demand Fusion: error (${error.message})\n`)
    return { success: false, cause: 'request_error', error: error.message }
  }
}

export const DEFAULT_IDLE_TIMEOUT_MS = 180000

/**
 * Route-based fallback state machine.
 * 
 * Selection types determine fallback chains:
 * - DEFAULT: Fusion direct → Fusion shared
 * - EXPLICIT_DEEPSEEK: DeepSeek WARP → ondev → direct Fusion → shared Fusion
 * - EXPLICIT_OTHER: selected → direct Fusion → shared Fusion
 * - EXPLICIT_FUSION_ONLY: Fusion direct → Fusion shared (strict, no other fallback)
 * 
 * Invariants:
 * - Each route is tried at most once (dedup)
 * - Donor 402 is terminal for all Fusion routes
 * - Session is preserved across route switches
 * - Completed tools are not replayed
 */
export async function runModels({ 
  binary, port, promptFile, logFile, exitFile, selected, 
  models = modelCandidates(selected), 
  env = process.env, 
  api = env.OPENCODE_PASSWORD ? createV2Client({ base: `http://127.0.0.1:${port}`, password: env.OPENCODE_PASSWORD }) : null, 
  switchProxy = runtimeProxySwitch({ env, binary, logFile }), 
  dropProxy, 
  lazyProxy = lazyProxySetup({ env, binary, logFile }),
  acquireFusion = acquireFusionOnDemand,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS
}) {
  const directory = dirname(logFile), prompt = readFileSync(promptFile, 'utf8')
  const requiredShared = env.FUSION_REQUIRE_SHARED === 'true'
  if (requiredShared && env.FUSION_ROUTE !== 'shared') throw new Error('Required shared Fusion route unavailable')
  
  // Determine selection type based on user's choice
  const selectionType = determineSelectionType(selected, env.FUSION_ROUTE)
  const hasFusionCredentials = Boolean(env.FUSION_ACCESS_TOKEN)
  
  appendFileSync(logFile, `[model-fallback] Selection type: ${selectionType}, selected: ${selected || 'none'}, fusionRoute: ${env.FUSION_ROUTE || 'none'}\n`)
  
  // Build the route sequence
  let queue = buildRouteSequence({
    selectionType,
    selected,
    fusionRoute: env.FUSION_ROUTE || 'none',
    backupModel: env.OMG_BACKUP_MODEL,
    hasFusionCredentials
  })
  
  // For EXPLICIT_OTHER, prepend the selected model (not a standard route)
  if (selectionType === SelectionType.EXPLICIT_OTHER && selected) {
    queue = [{ model: selected, route: 'selected-other' }, ...queue]
  }
  
  let sessionID = env.RESUME_SESSION_ID || '', child, interrupted = false, code = 1
  const attempts = []
  const triedRoutes = new Set()
  let switched = false, dropped = false
  let fusionAcquired = false
  let fusionEnv = { ...env }
  
  const stop = signal => { interrupted = true; child?.kill(signal) }
  const onTerm = () => stop('SIGTERM'), onInt = () => stop('SIGINT')
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt)
  
  try {
    for (let index = 0; index < queue.length; index++) {
      const { model, route } = queue[index]
      if (interrupted) break
      
      // Skip if this route was already tried (bounded state machine, no loops)
      if (triedRoutes.has(route)) {
        appendFileSync(logFile, `[model-fallback] Skipping ${model} (route ${route} already tried)\n`)
        continue
      }
      
      // For Fusion routes without credentials, try on-demand acquisition
      if (model === fusionModel && !fusionEnv.FUSION_ACCESS_TOKEN && !fusionAcquired) {
        fusionAcquired = true
        const acquisition = await acquireFusion({ env: fusionEnv, request: fetch, logFile })
        if (acquisition.success) {
          fusionEnv = { ...fusionEnv, FUSION_ACCESS_TOKEN: acquisition.token, FUSION_UPSTREAM: acquisition.upstream, FUSION_ROUTE: acquisition.route }
        } else if (acquisition.cause === 'consumer_limit') {
          appendFileSync(logFile, '[model-fallback] On-demand Fusion: consumer limit reached, skipping Fusion routes.\n')
          triedRoutes.add(RouteKind.FUSION_DIRECT)
          triedRoutes.add(RouteKind.FUSION_SHARED)
          continue
        } else if (!fusionEnv.FUSION_ACCESS_TOKEN) {
          appendFileSync(logFile, '[model-fallback] On-demand Fusion: unavailable, skipping Fusion route.\n')
          triedRoutes.add(route)
          continue
        }
      }
      
      // Skip Fusion if no credentials available
      if (model === fusionModel && !fusionEnv.FUSION_ACCESS_TOKEN) {
        appendFileSync(logFile, `[model-fallback] Skipping ${model} (no Fusion credentials)\n`)
        triedRoutes.add(route)
        continue
      }
      
      triedRoutes.add(route)
      
      const runEnv = model === fusionModel ? fusionEnv : env
      
      // Lazy proxy setup when leaving Fusion for free models
      if (lazyProxy && freeEgressModel(model)) {
        const setup = lazyProxy; lazyProxy = null
        appendFileSync(logFile, '[model-fallback] Setting up the WARP proxy for free model.\n')
        const mode = await setup().catch(() => 'none')
        appendFileSync(logFile, `[model-fallback] Lazy proxy: ${mode}.\n`)
        if (mode === 'warp' && !switchProxy) switchProxy = runtimeProxySwitch({ env: { ...env, WARP_RUNTIME_SWITCH: '1' }, binary, logFile })
        if (mode === 'dataimpulse') switched = true
      }
      
      const started = Date.now()
      writeFileSync(join(directory, 'main-model'), model + '\n')
      void pingHeartbeat(env)
      appendFileSync(logFile, `[model-fallback] Trying ${model} (route: ${route})\n`)
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
          child = spawn(binary, ['run', ...(sessionID ? ['--session', sessionID] : []), '--auto', '--server', `http://127.0.0.1:${port}`, '--model', model, '--format', 'json', prompt], { cwd: runEnv.PROJECT_DIR, env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] })
          for (const [name, stream] of [['out', child.stdout], ['err', child.stderr]]) stream.on('data', chunk => { writeSync(fd, chunk); inspect(name, chunk.toString()) })
          child.on('error', () => resolve(1))
          child.on('close', (status, signal) => { inspect('out', '', true); inspect('err', '', true); resolve(signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : status ?? 1) })
        })
      } finally { closeSync(fd); child = null }
      
      const cliCode = code
      const terminal = observedSession && !interrupted && cliCode < 128 ? await terminalAttemptOutcome({ api, sessionID, started }) : null
      const outcome = terminal?.outcome
      
      if (outcome === 'succeeded') {
        code = 0; failure = undefined
        writeFileSync(join(directory, 'main-completion.json'), JSON.stringify({ ...terminal, session_id: sessionID }))
      }
      else if (outcome === 'failed' || outcome === 'interrupted' || code === 0 && (failure || api)) code = 1
      
      const errorClass = code === 0 ? null : attemptErrorClass(failure) || (outcome === 'interrupted' ? null : 'other')
      const retryable = outcome !== 'interrupted' && (retryableProviderError(failure) || fusionFallbackError(model, failure))
      
      const attemptRecord = { 
        model, 
        route,
        selection_type: selectionType,
        cli_code: cliCode, 
        outcome: outcome || 'unverified', 
        code, 
        retryable, 
        error_class: errorClass,
        duration_ms: Date.now() - started,
        timestamp: new Date().toISOString()
      }
      
      attempts.push(attemptRecord)
      writeFileSync(join(directory, 'model-attempts.json'), JSON.stringify(attempts))
      await reportSessionStats({ api, sessionID, directory, env, attempts })
      await pingHeartbeat(env)
      appendFileSync(logFile, `[timing] model ${model}: ${Date.now() - started} ms; cli exit ${cliCode}; terminal ${outcome || 'unverified'}; exit ${code}\n`)
      
      if (code !== 0 && model === fusionModel && failure) appendFileSync(logFile, fusionFailureLine(failure, env))
      
      // Donor 402 is terminal for all Fusion routes
      if (errorClass === 'donor-402' && model === fusionModel) {
        appendFileSync(logFile, '[model-fallback] Donor 402 Payment Required; marking all Fusion routes as tried.\n')
        triedRoutes.add(RouteKind.FUSION_DIRECT)
        triedRoutes.add(RouteKind.FUSION_SHARED)
      }
      
      // Proxy tunnel error handling
      if (code !== 0 && !interrupted && !dropped && proxyTunnelError(failure)) {
        dropped = true; switched = true
        const drop = dropProxy === undefined ? proxyDrop({ env, binary, logFile }) : dropProxy
        appendFileSync(logFile, '[model-fallback] The proxy refused to open tunnels; restarting OpenCode without it.\n')
        const ok = drop ? await drop().catch(() => false) : false
        attempts.at(-1).proxy_drop = ok ? 'ok' : 'failed'
        writeFileSync(join(directory, 'model-attempts.json'), JSON.stringify(attempts))
        if (ok) { 
          appendFileSync(logFile, `[model-fallback] Proxy dropped; retrying ${model}.\n`)
          triedRoutes.delete(route)
          index--
          continue 
        }
      }
      
      if (code === 0 || interrupted || !retryable) break
      
      // Runtime proxy switch for free model free-limit
      if (!switched && switchProxy && freeEgressModel(model) && errorClass === 'free-limit') {
        switched = true
        appendFileSync(logFile, '[model-fallback] Free usage limit on the WARP exit; switching OpenCode to the DataImpulse proxy.\n')
        const ok = await switchProxy().catch(() => false)
        attempts.at(-1).proxy_switch = ok ? 'ok' : 'failed'
        writeFileSync(join(directory, 'model-attempts.json'), JSON.stringify(attempts))
        if (ok) { 
          appendFileSync(logFile, `[model-fallback] DataImpulse proxy ready; retrying ${model}.\n`)
          triedRoutes.delete(route)
          index--
          continue 
        }
        appendFileSync(logFile, '[model-fallback] DataImpulse proxy unavailable; keeping the current network.\n')
      }
      
      if (index < queue.length - 1) appendFileSync(logFile, '[model-fallback] Provider/model unavailable; advancing to the next candidate in the same session.\n')
    }
    
    if (interrupted && code === 0) code = 143
    return { code, attempts, sessionID, selectionType }
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
