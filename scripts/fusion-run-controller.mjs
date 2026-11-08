/**
 * Fusion Run Controller
 * 
 * Orchestrates:
 * - Fusion Gateway (loopback proxy)
 * - Lease acquisition (direct/shared routes)
 * - OpenCode HTTP API (model switching, prompt/synthetic)
 * - Route fallback state machine
 * 
 * Architecture:
 * 1. Start gateway before opencode serve
 * 2. Plugin uses FUSION_UPSTREAM (gateway) + FUSION_TOKEN_FILE (generation token)
 * 3. Gateway holds actual credential in memory
 * 4. Control via Unix socket: set_route, clear_route, status
 * 5. Atomic token file rotation clears plugin cache on route change
 */

import { createFusionGateway } from './fusion-gateway.mjs'
import { createOpenCodeClient, createSessionController, TERMINAL_EVENTS } from './opencode-api.mjs'
import { RouteKind, SelectionType, determineSelectionType, buildRouteSequence, freeEgressModel, fusionModel } from './run-with-model-fallback.mjs'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

// Default upstream for Copilot
const COPILOT_UPSTREAM = 'https://api.githubcopilot.com'

// Continuation instruction for synthetic prompts
const CONTINUATION_INSTRUCTION = `Continue the current task. Completed tools should not be re-executed. Verify any ambiguous side effects before proceeding.`

/**
 * Create a run controller for a single OpenCode build.
 */
export function createRunController({
  binary,
  port,
  projectDir,
  logFile,
  sessionId,
  selected,
  env = process.env,
  leaseClient,  // { acquireDirect, acquireShared, release }
  now = Date.now
}) {
  const runDir = dirname(logFile)
  mkdirSync(runDir, { recursive: true })
  
  const log = msg => appendFileSync(logFile, `${new Date(now()).toISOString()} ${msg}\n`)
  
  // Gateway paths
  const tokenFile = join(runDir, 'fusion-token')
  const socketPath = join(runDir, 'fusion-control.sock')
  
  // State
  let gateway = null
  let opencode = null
  let client = null
  let controller = null
  let currentRoute = null
  let triedRoutes = new Set()
  let promptSent = false
  let originalPromptId = null
  
  // Build route sequence
  const selectionType = determineSelectionType(selected, env.FUSION_ROUTE)
  const hasFusionCredentials = Boolean(env.FUSION_ACCESS_TOKEN)
  const queue = buildRouteSequence({
    selectionType,
    selected,
    fusionRoute: env.FUSION_ROUTE || 'none',
    backupModel: env.OMG_BACKUP_MODEL,
    hasFusionCredentials
  })
  
  log(`[controller] Selection type: ${selectionType}, routes: ${queue.map(r => r.route).join(' → ')}`)
  
  /**
   * Start the gateway and opencode serve
   */
  async function start() {
    // Start gateway
    gateway = createFusionGateway({
      tokenFile,
      socketPath,
      log
    })
    
    const { port: gatewayPort } = await gateway.start()
    log(`[controller] Gateway started on port ${gatewayPort}`)
    
    // Build serve environment
    const serveEnv = { ...env }
    
    // UNSET raw tokens (env wins over file otherwise)
    delete serveEnv.FUSION_ACCESS_TOKEN
    delete serveEnv.COPILOT_TOKEN
    
    // Point plugin to gateway
    serveEnv.FUSION_UPSTREAM = `http://127.0.0.1:${gatewayPort}`
    serveEnv.FUSION_TOKEN_FILE = tokenFile
    
    // Start opencode serve
    opencode = spawn(binary, ['serve', '--port', String(port)], {
      cwd: projectDir,
      env: serveEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    
    // Wait for serve to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('serve startup timeout')), 30000)
      
      const onData = chunk => {
        const text = chunk.toString()
        log(`[serve] ${text.trim()}`)
        if (text.includes('listening') || text.includes('ready')) {
          clearTimeout(timeout)
          opencode.stdout.off('data', onData)
          opencode.stderr.off('data', onData)
          resolve()
        }
      }
      
      opencode.stdout.on('data', onData)
      opencode.stderr.on('data', onData)
      opencode.on('error', err => { clearTimeout(timeout); reject(err) })
      opencode.on('exit', code => { clearTimeout(timeout); reject(new Error(`serve exited: ${code}`)) })
    })
    
    log(`[controller] OpenCode serve ready on port ${port}`)
    
    // Create API client
    client = createOpenCodeClient({
      base: `http://127.0.0.1:${port}`,
      password: env.OPENCODE_PASSWORD
    })
    
    // Create session controller
    controller = createSessionController({
      client,
      sessionId,
      idleTimeoutMs: 180000,
      toolTimeoutMs: 300000,
      now
    })
  }
  
  /**
   * Acquire a lease for the given route
   */
  async function acquireRoute(route) {
    log(`[controller] Acquiring route: ${route}`)
    
    if (route === RouteKind.FUSION_DIRECT) {
      const result = await leaseClient.acquireDirect()
      if (!result.success) {
        log(`[controller] Direct lease failed: ${result.cause}`)
        return null
      }
      return {
        route: RouteKind.FUSION_DIRECT,
        credential: env.FUSION_ACCESS_TOKEN || result.credential,
        upstream: result.upstream || COPILOT_UPSTREAM,
        expires: now() + (result.expires_in_ms || 180000)
      }
    }
    
    if (route === RouteKind.FUSION_SHARED) {
      const result = await leaseClient.acquireShared()
      if (!result.success) {
        log(`[controller] Shared lease failed: ${result.cause}`)
        return null
      }
      return {
        route: RouteKind.FUSION_SHARED,
        credential: result.credential,
        upstream: result.upstream,
        expires: now() + (result.expires_in_ms || 180000)
      }
    }
    
    // Non-Fusion routes (DeepSeek WARP/ondev) don't need gateway lease
    return { route, credential: null, upstream: null, expires: null }
  }
  
  /**
   * Set the gateway route
   */
  function setGatewayRoute(lease) {
    if (!lease.credential || !lease.upstream) {
      log(`[controller] Clearing gateway route (non-Fusion model)`)
      gateway.clearRoute('non_fusion')
      return
    }
    
    const result = gateway.setRoute({
      credential: lease.credential,
      upstream: lease.upstream,
      expires: lease.expires
    })
    
    if (!result.success) {
      log(`[controller] Failed to set gateway route: ${result.error}`)
      throw new Error(`Gateway route failed: ${result.error}`)
    }
    
    log(`[controller] Gateway route set: ${new URL(lease.upstream).host}`)
  }
  
  /**
   * Get model config for a route
   */
  function modelForRoute(routeItem) {
    const { model, route } = routeItem
    
    if (route === RouteKind.FUSION_DIRECT || route === RouteKind.FUSION_SHARED) {
      return { providerID: 'copilot-fusion', id: model }
    }
    
    if (route === RouteKind.DEEPSEEK_WARP || route === RouteKind.DEEPSEEK_ONDEV) {
      return { providerID: 'opencode', id: model }
    }
    
    // Connected provider
    const [provider, modelId] = model.split('/')
    return { providerID: provider, id: modelId || model }
  }
  
  /**
   * Execute the prompt with fallback
   */
  async function execute(prompt) {
    if (promptSent) {
      throw new Error('Prompt already executed. Use continue() for recovery.')
    }
    
    originalPromptId = `prompt-${randomBytes(8).toString('hex')}`
    let routeIndex = 0
    
    // Start event subscription
    controller.startEvents()
    
    while (routeIndex < queue.length) {
      const routeItem = queue[routeIndex]
      const { model, route } = routeItem
      
      // Skip already tried routes
      if (triedRoutes.has(route)) {
        log(`[controller] Skipping already tried route: ${route}`)
        routeIndex++
        continue
      }
      
      triedRoutes.add(route)
      log(`[controller] Trying route ${routeIndex + 1}/${queue.length}: ${route} (${model})`)
      
      // Acquire lease for Fusion routes
      let lease = null
      if (route === RouteKind.FUSION_DIRECT || route === RouteKind.FUSION_SHARED) {
        lease = await acquireRoute(route)
        if (!lease) {
          log(`[controller] Lease acquisition failed for ${route}`)
          routeIndex++
          continue
        }
        setGatewayRoute(lease)
        currentRoute = lease
      }
      
      // Set model
      const modelConfig = modelForRoute(routeItem)
      await client.setModel(sessionId, modelConfig)
      log(`[controller] Model set: ${modelConfig.providerID}/${modelConfig.id}`)
      
      // Send prompt (EXACTLY ONCE)
      if (!promptSent) {
        await controller.sendOriginalPrompt(prompt, { turnId: originalPromptId })
        promptSent = true
        log(`[controller] Original prompt sent: ${originalPromptId}`)
      } else {
        // Model switch - send synthetic continuation
        const syntheticId = `synthetic-${routeIndex}-${randomBytes(4).toString('hex')}`
        await controller.sendContinuation(CONTINUATION_INSTRUCTION, { turnId: syntheticId })
        log(`[controller] Synthetic continuation sent: ${syntheticId}`)
      }
      
      // Wait for completion or failure
      const result = await controller.waitForCompletion()
      
      if (result.completed) {
        log(`[controller] Turn completed: ${result.reason}`)
        
        if (result.reason === 'session.execution.succeeded') {
          return { success: true, route, model }
        }
        
        // Execution failed - try next route
        if (result.reason === 'session.execution.failed' || result.reason === 'session.step.failed') {
          log(`[controller] Execution failed, trying next route`)
          
          // For Fusion routes, check if it's a donor failure
          if (lease && (route === RouteKind.FUSION_SHARED)) {
            // Could retry with different donor, but for now just try next route
            log(`[controller] Shared donor failure, releasing lease`)
            gateway.clearRoute('donor_failure')
          }
          
          routeIndex++
          continue
        }
      }
      
      // Timeout - interrupt and try next route
      if (result.reason === 'idle_timeout' || result.reason === 'tool_timeout') {
        log(`[controller] Timeout: ${result.reason}, interrupting`)
        
        try {
          await client.interruptAndWait(sessionId, { resume: true, timeoutMs: 10000 })
        } catch (err) {
          log(`[controller] Interrupt failed: ${err.message}`)
        }
        
        routeIndex++
        continue
      }
      
      // Unknown state - try next route
      routeIndex++
    }
    
    // All routes exhausted
    log(`[controller] All routes exhausted`)
    return { success: false, reason: 'routes_exhausted' }
  }
  
  /**
   * Stop the controller
   */
  async function stop(reason = 'shutdown') {
    log(`[controller] Stopping: ${reason}`)
    
    // Interrupt any running turn
    if (controller && !controller.terminated) {
      try {
        await client.interruptAndWait(sessionId, { resume: false, timeoutMs: 5000 })
      } catch {}
    }
    
    controller?.close()
    
    // Release lease
    if (currentRoute) {
      try {
        await leaseClient.release(reason)
      } catch {}
    }
    
    // Stop gateway
    await gateway?.stop()
    
    // Stop serve
    if (opencode && !opencode.killed) {
      opencode.kill('SIGTERM')
      await new Promise(resolve => {
        const timeout = setTimeout(() => {
          opencode.kill('SIGKILL')
          resolve()
        }, 5000)
        opencode.on('exit', () => { clearTimeout(timeout); resolve() })
      })
    }
    
    log(`[controller] Stopped`)
  }
  
  // Handle signals
  const cleanup = async () => { await stop('signal'); process.exit(1) }
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)
  
  return {
    start,
    execute,
    stop,
    get sessionId() { return sessionId },
    get selectionType() { return selectionType },
    get currentRoute() { return currentRoute?.route },
    get promptSent() { return promptSent }
  }
}
