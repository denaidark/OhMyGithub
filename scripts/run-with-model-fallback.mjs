import { createV2Client, finishedV2Message } from './opencode-v2-api.mjs'
import { createOpenCodeClient, createSessionController } from './opencode-api.mjs'
import { collectSessionStats, finishStats } from './opencode-stats.mjs'
import { spawn } from 'node:child_process'
import { appendFileSync, openSync, writeSync, closeSync, readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

// Use HTTP API for production execution (eliminating CLI spawn)
const USE_HTTP_API = process.env.OPENCODE_USE_HTTP_API !== '0'

/**
 * Execute a prompt via OpenCode HTTP API (replaces CLI spawn).
 * 
 * Protocol:
 * - First attempt: sendPrompt with deterministic admission ID (EXACTLY ONCE)
 * - Continuation after failure: sendSynthetic with same session (no prompt replay)
 * - Model switch: setModel + continuation
 * - Timeout fallback: interruptAndWait before switching
 * 
 * @returns {{ code: number, sessionID: string, failure: string|undefined, outcome: string }}
 */
async function executeViaHTTP({
  client,
  sessionId,
  model,
  promptText,
  admissionId,
  isFirstAttempt,
  idleTimeoutMs,
  logFile,
  directory,
  env
}) {
  const log = msg => appendFileSync(logFile, msg)
  let failure, outcome = 'unverified'
  
  try {
    // Set the model for this session
    log(`[http-api] Setting model: ${model}\n`)
    const modelResult = await client.setModel(sessionId, model)
    if (!modelResult?.ok) {
      log(`[http-api] setModel failed: ${JSON.stringify(modelResult)}\n`)
      return { code: 1, sessionID: sessionId, failure: `setModel failed: ${modelResult?.status || 'unknown'}`, outcome: 'api_error' }
    }
    
    // Send prompt or synthetic
    let promptResult
    if (isFirstAttempt) {
      log(`[http-api] Sending original prompt (admission=${admissionId})\n`)
      promptResult = await client.sendPrompt(sessionId, {
        id: admissionId,
        text: promptText,
        delivery: 'queue',
        resume: false
      })
    } else {
      const syntheticId = `${admissionId}-cont-${Date.now()}`
      log(`[http-api] Sending synthetic continuation (id=${syntheticId})\n`)
      promptResult = await client.sendSynthetic(sessionId, {
        id: syntheticId,
        text: 'Continue the current task. Completed tools should not be re-executed.',
        resume: true
      })
    }
    
    if (!promptResult?.ok) {
      const errorBody = await promptResult?.text?.().catch(() => '') || ''
      log(`[http-api] prompt/synthetic failed: ${promptResult?.status} ${errorBody}\n`)
      
      // Check for provider errors in response
      if (errorBody.includes('402') || errorBody.includes('quota')) {
        return { code: 1, sessionID: sessionId, failure: errorBody, outcome: 'provider_error' }
      }
      return { code: 1, sessionID: sessionId, failure: `prompt failed: ${promptResult?.status}`, outcome: 'api_error' }
    }
    
    // Subscribe to events and wait for completion
    log(`[http-api] Subscribed to session events, waiting for completion...\n`)
    const events = client.subscribeEvents(sessionId)
    let lastProgressTime = Date.now()
    let completed = false
    let interrupted = false
    
    const result = await new Promise((resolve) => {
      // Overall timeout to prevent hanging (2x idle timeout)
      const maxTimeout = setTimeout(() => {
        if (!completed) {
          log(`[http-api] Max timeout reached; treating as success\n`)
          events.close()
          resolve({ code: 0, outcome: 'timeout_assumed_success' })
        }
      }, idleTimeoutMs * 2)
      maxTimeout.unref?.()
      
      const idleCheck = setInterval(() => {
        const idleMs = Date.now() - lastProgressTime
        if (idleMs > idleTimeoutMs && !completed) {
          log(`[http-api] Idle timeout (${Math.round(idleMs / 1000)}s); interrupting...\n`)
          interrupted = true
          completed = true
          clearTimeout(maxTimeout)
          clearInterval(idleCheck)
          events.close()
          client.interruptAndWait(sessionId, { resume: true, timeoutMs: 10000 })
            .then(() => resolve({ code: 143, outcome: 'interrupted' }))
            .catch(() => resolve({ code: 143, outcome: 'interrupted' }))
        }
      }, 10000)
      idleCheck.unref?.()
      
      events.on('tool_progress', () => { lastProgressTime = Date.now() })
      events.on('assistant', () => { lastProgressTime = Date.now() })
      
      events.on('terminal', event => {
        if (completed) return
        completed = true
        clearTimeout(maxTimeout)
        clearInterval(idleCheck)
        events.close()
        
        if (event.type === 'succeeded') {
          resolve({ code: 0, outcome: 'succeeded' })
        } else if (event.type === 'failed') {
          failure = event.error || event.message || 'unknown error'
          resolve({ code: 1, outcome: 'failed', failure })
        } else if (event.type === 'interrupted') {
          resolve({ code: 143, outcome: 'interrupted' })
        } else {
          resolve({ code: 1, outcome: event.type || 'unknown' })
        }
      })
      
      events.on('error', event => {
        failure = event.message || event.error || 'unknown error'
        log(`[http-api] Event stream error: ${failure}\n`)
        // Check for provider-specific errors
        if (failure.includes('402') || failure.includes('quota') || failure.includes('rate')) {
          if (completed) return
          completed = true
          clearTimeout(maxTimeout)
          clearInterval(idleCheck)
          events.close()
          resolve({ code: 1, outcome: 'provider_error', failure })
        }
      })
      
      events.on('close', () => {
        if (!completed) {
          clearTimeout(maxTimeout)
          clearInterval(idleCheck)
          // Connection closed without terminal event - assume success (server ended normally)
          resolve({ code: 0, outcome: 'connection_closed_success' })
        }
      })
    })
    
    log(`[http-api] Execution completed: code=${result.code}, outcome=${result.outcome}\n`)
    return { code: result.code, sessionID: sessionId, failure: result.failure || failure, outcome: result.outcome }
    
  } catch (error) {
    log(`[http-api] Execution error: ${error.message}\n`)
    return { code: 1, sessionID: sessionId, failure: error.message, outcome: 'exception' }
  }
}

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
  DEEPSEEK_DIRECT: 'deepseek-direct',  // Direct to DeepSeek API (no proxy)
  DEEPSEEK_WARP: 'deepseek-warp',      // Via Cloudflare WARP proxy
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
 * Selection intent is INDEPENDENT of FUSION_ROUTE availability.
 * Fix #7: Don't tie explicitFusionOnly to FUSION_ROUTE=own; user intent matters.
 */
export function determineSelectionType(selected, fusionRoute = 'none') {
  // No selection or "Default" label → Default behavior (Fusion first)
  if (!selected || selected === 'default') {
    return SelectionType.DEFAULT
  }
  // Fix #7 (corrected): Selection type is INTENT-based, independent of FUSION_ROUTE availability
  // User explicitly selected Fusion model → EXPLICIT_FUSION_ONLY (strict Fusion, no DeepSeek fallback)
  // Route availability determines which Fusion routes are in the queue, not the selection type
  if (selected === fusionModel) {
    return SelectionType.EXPLICIT_FUSION_ONLY
  }
  // Explicit DeepSeek or other free model selection
  if (freeEgressModel(selected)) {
    return SelectionType.EXPLICIT_DEEPSEEK
  }
  // Explicit other model selection (paid/connected providers)
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
/**
 * Build route sequence based on selection type and admin settings.
 * 
 * Admin toggles (t248u):
 * - warpEnabled (default false): enable Cloudflare WARP proxy for free models
 * - skipDirectOC (default false): skip direct OpenCode (DeepSeek) route
 * 
 * Route order for EXPLICIT_DEEPSEEK with toggle combinations:
 *   skipDirectOC=false, warpEnabled=false: directOC → ondev → Fusion
 *   skipDirectOC=false, warpEnabled=true:  directOC → WARP → ondev → Fusion
 *   skipDirectOC=true,  warpEnabled=false: ondev → Fusion
 *   skipDirectOC=true,  warpEnabled=true:  WARP → ondev → Fusion
 * 
 * DEFAULT selection always uses Fusion direct → shared (owner confirmed).
 */
export function buildRouteSequence({ 
  selectionType, 
  selected, 
  fusionRoute, 
  backupModel, 
  hasFusionCredentials,
  warpEnabled = false,
  skipDirectOC = false
}) {
  const routes = []
  
  switch (selectionType) {
    case SelectionType.DEFAULT:
      // Default: Fusion first (direct → shared) - NO free model fallback per owner
      if (hasFusionCredentials && fusionRoute === 'own') {
        routes.push({ model: fusionModel, route: RouteKind.FUSION_DIRECT })
      }
      routes.push({ model: fusionModel, route: RouteKind.FUSION_SHARED })
      break
      
    case SelectionType.EXPLICIT_DEEPSEEK:
      // Explicit free model: route order depends on admin toggles
      const freeModel = selected || defaultFreeModel
      
      // 1. Direct OC (unless skipped)
      if (!skipDirectOC) {
        routes.push({ model: freeModel, route: RouteKind.DEEPSEEK_DIRECT })
      }
      
      // 2. WARP (only if enabled)
      if (warpEnabled) {
        routes.push({ model: freeModel, route: RouteKind.DEEPSEEK_WARP })
      }
      
      // 3. ondev (backup model via llm.ondev.store)
      if (backupModel && /^[\w.-]+\/[\w./:-]+$/.test(backupModel)) {
        routes.push({ model: backupModel, route: RouteKind.DEEPSEEK_ONDEV })
      }
      
      // 4. Fusion fallback
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
 * 
 * @param excludeDonor - Token to exclude (for bounded 402 retry with different donor)
 */
export async function acquireFusionOnDemand({ env = process.env, request = fetch, logFile, excludeDonor = null }) {
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
    appendFileSync(logFile, `[model-fallback] Attempting on-demand Fusion acquisition${excludeDonor ? ' (excluding previous donor)' : ''}...\n`)
    const body = { 
      run: runId, 
      attempt: Number(runAttempt),
      use_auth: true
    }
    // Request different donor on retry
    if (excludeDonor) {
      body.exclude_donor_hash = createHash('sha256').update(excludeDonor).digest('hex').slice(0, 16)
    }
    
    const response = await request(`${origin}/api/github/${repo}/issues/${issueNumber}/credentials`, {
      method: 'POST',
      headers: { 
        authorization: `Bearer ${callbackToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
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
 * Fetch admin routing settings from OmGithub API.
 * Returns { warp_enabled, skip_direct_oc } or defaults on failure.
 */
export async function fetchRoutingSettings({ env = process.env, request = fetch, logFile }) {
  const origin = env.OMGITHUB_ORIGIN || 'https://omgithub.com'
  const defaults = { warp_enabled: false, skip_direct_oc: false }
  
  try {
    const response = await request(`${origin}/api/routing-settings`, {
      signal: AbortSignal.timeout(5000)
    })
    if (response.ok) {
      const data = await response.json()
      const settings = {
        warp_enabled: data.warp_enabled === true,
        skip_direct_oc: data.skip_direct_oc === true
      }
      if (logFile) {
        appendFileSync(logFile, `[model-fallback] Routing settings: warp=${settings.warp_enabled}, skipDirectOC=${settings.skip_direct_oc}\n`)
      }
      return settings
    }
  } catch (error) {
    if (logFile) {
      appendFileSync(logFile, `[model-fallback] Routing settings fetch failed (${error.message}), using defaults.\n`)
    }
  }
  return defaults
}

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
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  routingSettings = null  // { warp_enabled, skip_direct_oc } - fetched if null
}) {
  const directory = dirname(logFile), prompt = readFileSync(promptFile, 'utf8')
  const requiredShared = env.FUSION_REQUIRE_SHARED === 'true'
  if (requiredShared && env.FUSION_ROUTE !== 'shared') throw new Error('Required shared Fusion route unavailable')
  
  // Fetch routing settings if not provided (t248u)
  const settings = routingSettings ?? await fetchRoutingSettings({ env, logFile })
  const warpEnabled = settings.warp_enabled === true
  const skipDirectOC = settings.skip_direct_oc === true
  
  // Determine selection type based on user's choice
  const selectionType = determineSelectionType(selected, env.FUSION_ROUTE)
  const hasFusionCredentials = Boolean(env.FUSION_ACCESS_TOKEN)
  const backupModel = env.OMG_BACKUP_MODEL
  
  appendFileSync(logFile, `[model-fallback] Selection type: ${selectionType}, selected: ${selected || 'none'}, fusionRoute: ${env.FUSION_ROUTE || 'none'}, models: ${models.length}, warp=${warpEnabled}, skipDirectOC=${skipDirectOC}\n`)
  
  // Fix #1: Wire workflow-resolved models to route state machine
  // Convert selection type to proper route queue with bounded semantics
  let queue = buildRouteSequence({
    selectionType,
    selected,
    fusionRoute: env.FUSION_ROUTE || 'none',
    backupModel,
    hasFusionCredentials,
    warpEnabled,
    skipDirectOC
  })
  
  // For EXPLICIT_OTHER, prepend the selected model (not a standard route)
  if (selectionType === SelectionType.EXPLICIT_OTHER && selected) {
    queue = [{ model: selected, route: 'selected-other' }, ...queue]
  }
  
  // Deterministic session ID: persist/adopt from disk or env
  // Allows session preservation across restart
  const sessionFile = join(directory, 'session-id')
  let sessionID = env.RESUME_SESSION_ID || ''
  if (!sessionID && existsSync(sessionFile)) {
    try { sessionID = readFileSync(sessionFile, 'utf8').trim() } catch {}
  }
  
  // Deterministic admission ID based on run/attempt (prevents duplicate prompts)
  const runId = env.GITHUB_RUN_ID || `local-${Date.now()}`
  const runAttempt = env.GITHUB_RUN_ATTEMPT || '1'
  const admissionId = `admission-${runId}-${runAttempt}`
  const admissionFile = join(directory, 'admission-state.json')
  
  // Check if prompt already admitted (idempotent across restart)
  let promptAlreadyAdmitted = false
  if (existsSync(admissionFile)) {
    try {
      const state = JSON.parse(readFileSync(admissionFile, 'utf8'))
      if (state.admissionId === admissionId && state.promptSent === true) {
        promptAlreadyAdmitted = true
        sessionID = state.sessionId || sessionID
        appendFileSync(logFile, `[model-fallback] Resuming: admission=${admissionId} session=${sessionID}\n`)
      }
    } catch {}
  }
  
  // Create HTTP API client for production execution
  // Requires OPENCODE_PASSWORD to be set (workflow exports it)
  const httpClient = USE_HTTP_API && env.OPENCODE_PASSWORD 
    ? createOpenCodeClient({ base: `http://127.0.0.1:${port}`, password: env.OPENCODE_PASSWORD })
    : null
  
  // Generate session ID if none exists (HTTP API requires explicit session)
  if (!sessionID) {
    sessionID = `ses_${createHash('sha256').update(`${runId}-${runAttempt}-${Date.now()}`).digest('hex').slice(0, 24)}`
    appendFileSync(logFile, `[model-fallback] Generated session: ${sessionID}\n`)
  }
  
  // Track whether this is the first attempt for HTTP API
  let httpFirstAttempt = !promptAlreadyAdmitted
  
  let child, interrupted = false, code = 1
  const attempts = []
  const triedRoutes = new Set()
  let switched = false, dropped = false
  let fusionAcquired = false
  let fusionEnv = { ...env }
  
  // Fix #8: Bound transport retries to prevent infinite loops
  const MAX_TRANSPORT_RETRIES = 2  // Max retries per route for proxy issues
  const transportRetries = new Map()  // route → retry count
  
  // Bounded donor 402 retry for shared pool
  const MAX_DONOR_RETRIES = 2  // Max different donors to try on 402
  let sharedDonorRetries = 0
  let lastDonorToken = null  // Track donor token to request different one
  
  const stop = signal => { 
    interrupted = true
    child?.kill(signal)
    // For HTTP API, interrupt current turn
    if (httpClient && sessionID) {
      httpClient.interrupt(sessionID, { resume: false }).catch(() => {})
    }
  }
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
      // Fix #6: consumer_limit only affects SHARED route, not direct (which uses own credentials)
      // Fix #6: Track acquisition attempts per route, not globally
      const needsAcquisition = model === fusionModel && !fusionEnv.FUSION_ACCESS_TOKEN
      const isSharedRoute = route === RouteKind.FUSION_SHARED
      const isDirectRoute = route === RouteKind.FUSION_DIRECT
      
      if (needsAcquisition) {
        // Direct route requires own credentials - if missing, skip (user doesn't have Copilot)
        if (isDirectRoute) {
          appendFileSync(logFile, '[model-fallback] Direct Fusion: no own credentials, skipping.\n')
          triedRoutes.add(route)
          continue
        }
        
        // Shared route can attempt on-demand acquisition
        // Supports bounded retry with different donor on 402
        if (isSharedRoute) {
          const acquisition = await acquireFusion({ 
            env: fusionEnv, 
            request: fetch, 
            logFile,
            excludeDonor: lastDonorToken  // Request different donor on retry
          })
          if (acquisition.success) {
            fusionEnv = { ...fusionEnv, FUSION_ACCESS_TOKEN: acquisition.token, FUSION_UPSTREAM: acquisition.upstream, FUSION_ROUTE: acquisition.route }
            lastDonorToken = acquisition.token  // Track for potential retry
            fusionAcquired = true
          } else if (acquisition.cause === 'consumer_limit') {
            // consumer_limit only affects shared pool, not direct credentials
            appendFileSync(logFile, '[model-fallback] On-demand Fusion: consumer limit reached for shared pool.\n')
            triedRoutes.add(RouteKind.FUSION_SHARED)
            continue
          } else if (acquisition.cause === 'no_donors') {
            appendFileSync(logFile, '[model-fallback] On-demand Fusion: no donors available in pool.\n')
            triedRoutes.add(RouteKind.FUSION_SHARED)
            continue
          } else {
            appendFileSync(logFile, `[model-fallback] On-demand Fusion: unavailable (${acquisition.cause}).\n`)
            triedRoutes.add(route)
            continue
          }
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
      // GATED by warpEnabled (t248u): if WARP disabled, skip all proxy setup
      if (lazyProxy && freeEgressModel(model) && warpEnabled) {
        const setup = lazyProxy; lazyProxy = null
        appendFileSync(logFile, '[model-fallback] Setting up the WARP proxy for free model.\n')
        const mode = await setup().catch(() => 'none')
        appendFileSync(logFile, `[model-fallback] Lazy proxy: ${mode}.\n`)
        if (mode === 'warp' && !switchProxy) switchProxy = runtimeProxySwitch({ env: { ...env, WARP_RUNTIME_SWITCH: '1' }, binary, logFile })
        if (mode === 'dataimpulse') switched = true
      } else if (lazyProxy && freeEgressModel(model) && !warpEnabled) {
        lazyProxy = null  // Clear but don't execute - WARP disabled by admin
        appendFileSync(logFile, '[model-fallback] WARP proxy setup skipped (admin disabled).\n')
      }
      
      const started = Date.now()
      writeFileSync(join(directory, 'main-model'), model + '\n')
      void pingHeartbeat(env)
      appendFileSync(logFile, `[model-fallback] Trying ${model} (route: ${route})\n`)
      const fd = openSync(logFile, 'a')
      let failure, observedSession = false, pending = { out: '', err: '' }
      
      // Fix #4: Track actual progress (tool events, assistant output) not just heartbeats
      let lastProgressTime = Date.now()
      const updateProgress = () => { lastProgressTime = Date.now() }
      
      const inspect = (name, chunk, finish = false) => {
        pending[name] += chunk
        const lines = pending[name].split('\n'); pending[name] = finish ? '' : lines.pop()
        for (const line of lines) {
          try {
            const row = JSON.parse(line)
            if (/^ses_[A-Za-z0-9]+$/.test(row.sessionID || '')) { 
              sessionID = row.sessionID
              observedSession = true
              // Persist session ID for potential restart
              try { writeFileSync(sessionFile, sessionID + '\n') } catch {}
              // Persist admission state (prompt sent)
              if (!promptAlreadyAdmitted) {
                promptAlreadyAdmitted = true
                try {
                  writeFileSync(admissionFile, JSON.stringify({
                    admissionId,
                    sessionId: sessionID,
                    promptSent: true,
                    model,
                    route,
                    timestamp: new Date().toISOString()
                  }))
                } catch {}
              }
            }
            if (row.type === 'error') failure = row.error
            // Track progress: tool calls, assistant output, step events
            if (['tool_call', 'tool_result', 'assistant', 'step_start', 'step_end'].includes(row.type)) {
              updateProgress()
            }
          } catch {}
        }
        if (pending[name].length > 1024 * 1024) pending[name] = ''
      }
      
      // Execute via HTTP API (production) or CLI spawn (fallback)
      if (httpClient) {
        // HTTP API execution - no CLI spawn
        closeSync(fd)  // Don't need stdout logging for HTTP API
        const httpResult = await executeViaHTTP({
          client: httpClient,
          sessionId: sessionID,
          model,
          promptText: prompt,
          admissionId,
          isFirstAttempt: httpFirstAttempt,
          idleTimeoutMs,
          logFile,
          directory,
          env: runEnv
        })
        
        code = httpResult.code
        failure = httpResult.failure
        observedSession = true  // HTTP API always has session
        
        // Mark first attempt done after successful send
        if (httpFirstAttempt && code !== 1) {
          httpFirstAttempt = false
          promptAlreadyAdmitted = true
          try { writeFileSync(sessionFile, sessionID + '\n') } catch {}
          try {
            writeFileSync(admissionFile, JSON.stringify({
              admissionId,
              sessionId: sessionID,
              promptSent: true,
              model,
              route,
              timestamp: new Date().toISOString()
            }))
          } catch {}
        }
        
        appendFileSync(logFile, `[http-api] Result: code=${code}, failure=${failure || 'none'}\n`)
      } else {
        // CLI spawn fallback (legacy path, removed in future)
        appendFileSync(logFile, '[model-fallback] WARNING: Using CLI spawn (HTTP API unavailable)\n')
        try {
          code = await new Promise(resolve => {
            child = spawn(binary, ['run', ...(sessionID ? ['--session', sessionID] : []), '--auto', '--server', `http://127.0.0.1:${port}`, '--model', model, '--format', 'json', prompt], { cwd: runEnv.PROJECT_DIR, env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] })
            for (const [name, stream] of [['out', child.stdout], ['err', child.stderr]]) stream.on('data', chunk => { writeSync(fd, chunk); inspect(name, chunk.toString()) })
            child.on('error', () => resolve(1))
            child.on('close', (status, signal) => { inspect('out', '', true); inspect('err', '', true); resolve(signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : status ?? 1) })
            
            // Fix #4: Implement real idle timeout with progress tracking
            const idleCheck = setInterval(() => {
              const idleMs = Date.now() - lastProgressTime
              if (idleMs > idleTimeoutMs) {
                appendFileSync(logFile, `[model-fallback] Idle timeout (${Math.round(idleMs / 1000)}s without progress); terminating.\n`)
                child?.kill('SIGTERM')
                clearInterval(idleCheck)
              }
            }, 10000)  // Check every 10s
            idleCheck.unref?.()  // Don't keep process alive for this timer
            child.on('close', () => clearInterval(idleCheck))
          })
        } finally { closeSync(fd); child = null }
      }
      
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
      
      // Fix #5: Donor 402 handling with bounded retry for shared pool
      if (errorClass === 'donor-402' && model === fusionModel) {
        if (route === RouteKind.FUSION_SHARED && sharedDonorRetries < MAX_DONOR_RETRIES) {
          // Bounded retry: try different donor
          sharedDonorRetries++
          appendFileSync(logFile, `[model-fallback] Donor 402 on shared route; retrying with different donor (attempt ${sharedDonorRetries}/${MAX_DONOR_RETRIES}).\n`)
          
          // Clear fusionAcquired to allow re-acquisition with different donor
          fusionAcquired = false
          triedRoutes.delete(route)  // Allow retry of shared route
          // lastDonorToken is already set, acquireFusion will exclude it
          continue
        } else {
          appendFileSync(logFile, `[model-fallback] Donor 402 Payment Required on route ${route}; ${route === RouteKind.FUSION_SHARED ? 'donor retry limit reached' : 'direct route terminal'}.\n`)
        }
      }
      
      // Proxy tunnel error handling
      // Fix #8: Bound transport retries to prevent infinite loops
      if (code !== 0 && !interrupted && !dropped && proxyTunnelError(failure)) {
        const retryCount = transportRetries.get(route) || 0
        if (retryCount < MAX_TRANSPORT_RETRIES) {
          dropped = true; switched = true
          const drop = dropProxy === undefined ? proxyDrop({ env, binary, logFile }) : dropProxy
          appendFileSync(logFile, '[model-fallback] The proxy refused to open tunnels; restarting OpenCode without it.\n')
          const ok = drop ? await drop().catch(() => false) : false
          attempts.at(-1).proxy_drop = ok ? 'ok' : 'failed'
          writeFileSync(join(directory, 'model-attempts.json'), JSON.stringify(attempts))
          if (ok) { 
            transportRetries.set(route, retryCount + 1)
            appendFileSync(logFile, `[model-fallback] Proxy dropped; retrying ${model} (attempt ${retryCount + 2}/${MAX_TRANSPORT_RETRIES + 1}).\n`)
            triedRoutes.delete(route)
            index--
            continue 
          }
        } else {
          appendFileSync(logFile, `[model-fallback] Proxy retry limit reached for route ${route}.\n`)
        }
      }
      
      if (code === 0 || interrupted || !retryable) break
      
      // Runtime proxy switch for free model free-limit
      // Fix #8: Bound proxy switch retries
      // GATED by warpEnabled: skip proxy switch if WARP disabled by admin
      if (!switched && switchProxy && warpEnabled && freeEgressModel(model) && errorClass === 'free-limit') {
        const retryCount = transportRetries.get(route) || 0
        if (retryCount < MAX_TRANSPORT_RETRIES) {
          switched = true
          appendFileSync(logFile, '[model-fallback] Free usage limit on the WARP exit; switching OpenCode to the DataImpulse proxy.\n')
          const ok = await switchProxy().catch(() => false)
          attempts.at(-1).proxy_switch = ok ? 'ok' : 'failed'
          writeFileSync(join(directory, 'model-attempts.json'), JSON.stringify(attempts))
          if (ok) { 
            transportRetries.set(route, retryCount + 1)
            appendFileSync(logFile, `[model-fallback] DataImpulse proxy ready; retrying ${model} (attempt ${retryCount + 2}/${MAX_TRANSPORT_RETRIES + 1}).\n`)
            triedRoutes.delete(route)
            index--
            continue 
          }
          appendFileSync(logFile, '[model-fallback] DataImpulse proxy unavailable; keeping the current network.\n')
        } else {
          appendFileSync(logFile, `[model-fallback] Proxy switch retry limit reached for route ${route}.\n`)
        }
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
