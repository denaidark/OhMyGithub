/**
 * OpenCode v2.2.5 HTTP API Client
 * 
 * Protocol: packages/protocol/src/groups/session.ts, event.ts, credential.ts
 * Specs: specs/v2/session.md
 * 
 * Key behaviors:
 * - Basic auth: opencode:$OPENCODE_PASSWORD
 * - POST /api/session/:id/model - set model for subsequent turns
 * - POST /api/session/:id/prompt - original prompt (EXACTLY ONCE per build)
 * - POST /api/session/:id/synthetic - recovery continuation (no original replay)
 * - POST /api/session/:id/interrupt?resume= + POST /api/experimental/session/:id/wait
 * - SSE GET /api/event - session events with exact sessionID filter
 */

import { EventEmitter } from 'node:events'

// Session event types (from protocol/src/groups/event.ts)
export const SessionEventTypes = Object.freeze({
  STEP_STARTED: 'session.step.started',
  STEP_ENDED: 'session.step.ended',
  STEP_FAILED: 'session.step.failed',
  TEXT_STARTED: 'session.text.started',
  TEXT_ENDED: 'session.text.ended',
  REASONING_STARTED: 'session.reasoning.started',
  REASONING_ENDED: 'session.reasoning.ended',
  TOOL_INPUT_STARTED: 'session.tool.input.started',
  TOOL_INPUT_DELTA: 'session.tool.input.delta',
  TOOL_INPUT_ENDED: 'session.tool.input.ended',
  TOOL_CALLED: 'session.tool.called',
  TOOL_PROGRESS: 'session.tool.progress',
  TOOL_SUCCESS: 'session.tool.success',
  TOOL_FAILED: 'session.tool.failed',
  EXECUTION_SUCCEEDED: 'session.execution.succeeded',
  EXECUTION_FAILED: 'session.execution.failed',
  EXECUTION_INTERRUPTED: 'session.execution.interrupted'
})

// Terminal events that end a turn
export const TERMINAL_EVENTS = new Set([
  SessionEventTypes.EXECUTION_SUCCEEDED,
  SessionEventTypes.EXECUTION_FAILED,
  SessionEventTypes.EXECUTION_INTERRUPTED,
  SessionEventTypes.STEP_FAILED
])

// Tool execution events (for progress tracking separate from heartbeat)
export const TOOL_EVENTS = new Set([
  SessionEventTypes.TOOL_INPUT_STARTED,
  SessionEventTypes.TOOL_INPUT_DELTA,
  SessionEventTypes.TOOL_INPUT_ENDED,
  SessionEventTypes.TOOL_CALLED,
  SessionEventTypes.TOOL_PROGRESS,
  SessionEventTypes.TOOL_SUCCESS,
  SessionEventTypes.TOOL_FAILED
])

export function createOpenCodeClient({ base, password, request = fetch, now = Date.now }) {
  const auth = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')
  
  async function api(path, options = {}) {
    const url = `${base}${path}`
    const headers = {
      'Authorization': auth,
      'Content-Type': 'application/json',
      ...options.headers
    }
    
    const response = await request(url, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    })
    
    if (!response.ok) {
      const error = new Error(`OpenCode API error: ${response.status}`)
      error.status = response.status
      try { error.body = await response.json() } catch {}
      throw error
    }
    
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      return response.json()
    }
    return response.text()
  }
  
  // POST /api/session/:id/model - set model for subsequent turns
  async function setModel(sessionId, model) {
    return api(`/api/session/${sessionId}/model`, {
      method: 'POST',
      body: { model: { providerID: model.providerID, id: model.id, variant: model.variant } }
    })
  }
  
  // POST /api/session/:id/prompt - original prompt (EXACTLY ONCE)
  // deterministic id for first admission idempotency
  async function sendPrompt(sessionId, { id, text, delivery = 'queue', resume = false }) {
    return api(`/api/session/${sessionId}/prompt`, {
      method: 'POST',
      body: { id, text, delivery, resume }
    })
  }
  
  // POST /api/session/:id/synthetic - recovery continuation
  // No original prompt replay, deterministic id, resume:true
  async function sendSynthetic(sessionId, { id, text, resume = true }) {
    return api(`/api/session/${sessionId}/synthetic`, {
      method: 'POST',
      body: { id, text, resume }
    })
  }
  
  // POST /api/session/:id/interrupt?resume= - interrupt current turn
  async function interrupt(sessionId, { resume = false } = {}) {
    return api(`/api/session/${sessionId}/interrupt?resume=${resume}`, {
      method: 'POST'
    })
  }
  
  // POST /api/experimental/session/:id/wait - wait for turn to settle
  async function waitForSettle(sessionId, { timeoutMs = 30000 } = {}) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    
    try {
      return await api(`/api/experimental/session/${sessionId}/wait`, {
        method: 'POST',
        signal: controller.signal
      })
    } finally {
      clearTimeout(timeout)
    }
  }
  
  // GET /api/session/active - check if session has active turn
  async function getActiveSession() {
    return api('/api/session/active')
  }
  
  // Interrupt and wait for settle (combined operation)
  async function interruptAndWait(sessionId, { resume = false, timeoutMs = 30000 } = {}) {
    await interrupt(sessionId, { resume })
    return waitForSettle(sessionId, { timeoutMs })
  }
  
  // SSE GET /api/event - subscribe to session events
  function subscribeEvents(sessionId, { signal } = {}) {
    const emitter = new EventEmitter()
    let controller = new AbortController()
    
    if (signal) {
      signal.addEventListener('abort', () => controller.abort())
    }
    
    async function connect() {
      try {
        const response = await request(`${base}/api/event`, {
          headers: { 'Authorization': auth, 'Accept': 'text/event-stream' },
          signal: controller.signal
        })
        
        if (!response.ok) {
          emitter.emit('error', new Error(`SSE connect failed: ${response.status}`))
          return
        }
        
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop()
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const event = JSON.parse(line.slice(6))
                // Filter by sessionID
                if (event.sessionID === sessionId || event.session_id === sessionId) {
                  emitter.emit('event', event)
                  
                  // Emit specific event types
                  if (event.type) {
                    emitter.emit(event.type, event)
                  }
                  
                  // Check for terminal events
                  if (TERMINAL_EVENTS.has(event.type)) {
                    emitter.emit('terminal', event)
                  }
                  
                  // Track tool progress (separate from heartbeat)
                  if (TOOL_EVENTS.has(event.type)) {
                    emitter.emit('tool_progress', event)
                  }
                }
              } catch {}
            }
          }
        }
        
        emitter.emit('close')
      } catch (error) {
        if (error.name !== 'AbortError') {
          emitter.emit('error', error)
        }
      }
    }
    
    connect()
    
    return {
      on: (event, handler) => emitter.on(event, handler),
      off: (event, handler) => emitter.off(event, handler),
      once: (event, handler) => emitter.once(event, handler),
      close: () => controller.abort()
    }
  }
  
  // GET /api/experimental/session/:id/log?after=&follow=true - durable catchup
  async function getSessionLog(sessionId, { after, follow = false, signal } = {}) {
    const params = new URLSearchParams()
    if (after) params.set('after', after)
    if (follow) params.set('follow', 'true')
    
    return api(`/api/experimental/session/${sessionId}/log?${params}`, { signal })
  }
  
  return {
    setModel,
    sendPrompt,
    sendSynthetic,
    interrupt,
    waitForSettle,
    interruptAndWait,
    getActiveSession,
    subscribeEvents,
    getSessionLog
  }
}

/**
 * Session controller - manages a single session with proper turn handling
 */
export function createSessionController({
  client,
  sessionId,
  idleTimeoutMs = 180000,
  toolTimeoutMs = 300000,
  now = Date.now
}) {
  let promptSent = false
  let currentTurnId = null
  let lastProgressTime = now()
  let lastToolProgressTime = now()
  let eventSubscription = null
  let terminated = false
  let terminationReason = null
  
  function updateProgress() {
    lastProgressTime = now()
  }
  
  function updateToolProgress() {
    lastToolProgressTime = now()
    updateProgress()
  }
  
  // Check if idle (no progress, separate from heartbeat)
  function isIdle() {
    const idleMs = now() - lastProgressTime
    return idleMs > idleTimeoutMs
  }
  
  // Check if tool timeout (running tool with no progress)
  function isToolTimeout() {
    // Only applies when a tool is running
    const toolIdleMs = now() - lastToolProgressTime
    return toolIdleMs > toolTimeoutMs
  }
  
  // Start event subscription
  function startEvents(signal) {
    if (eventSubscription) return
    
    eventSubscription = client.subscribeEvents(sessionId, { signal })
    
    eventSubscription.on('event', event => {
      updateProgress()
    })
    
    eventSubscription.on('tool_progress', event => {
      updateToolProgress()
    })
    
    eventSubscription.on('terminal', event => {
      terminated = true
      terminationReason = event.type
    })
  }
  
  // Send original prompt (EXACTLY ONCE per build)
  async function sendOriginalPrompt(text, { turnId } = {}) {
    if (promptSent) {
      throw new Error('Original prompt already sent. Use sendSynthetic for continuation.')
    }
    
    currentTurnId = turnId || `turn-${now()}`
    promptSent = true
    terminated = false
    terminationReason = null
    lastProgressTime = now()
    
    return client.sendPrompt(sessionId, {
      id: currentTurnId,
      text,
      delivery: 'queue',
      resume: false
    })
  }
  
  // Send synthetic continuation (for recovery/model switch)
  async function sendContinuation(text, { turnId } = {}) {
    if (!promptSent) {
      throw new Error('Must send original prompt first.')
    }
    
    currentTurnId = turnId || `synthetic-${now()}`
    terminated = false
    terminationReason = null
    lastProgressTime = now()
    
    return client.sendSynthetic(sessionId, {
      id: currentTurnId,
      text,
      resume: true
    })
  }
  
  // Switch model (interrupt current, wait, set new model)
  async function switchModel(model) {
    // Interrupt and wait for current turn to settle
    await client.interruptAndWait(sessionId, { resume: true })
    
    // Set new model
    await client.setModel(sessionId, model)
    
    terminated = false
    terminationReason = null
  }
  
  // Wait for turn to complete or timeout
  async function waitForCompletion({ signal, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (signal?.aborted) {
          clearInterval(checkInterval)
          reject(new Error('Cancelled'))
          return
        }
        
        if (terminated) {
          clearInterval(checkInterval)
          resolve({ completed: true, reason: terminationReason })
          return
        }
        
        if (isIdle()) {
          clearInterval(checkInterval)
          resolve({ completed: false, reason: 'idle_timeout' })
          return
        }
        
        if (isToolTimeout()) {
          clearInterval(checkInterval)
          resolve({ completed: false, reason: 'tool_timeout' })
          return
        }
        
        onProgress?.({ lastProgressTime, lastToolProgressTime })
      }, 1000)
      
      if (signal) {
        signal.addEventListener('abort', () => {
          clearInterval(checkInterval)
          reject(new Error('Cancelled'))
        })
      }
    })
  }
  
  // Cleanup
  function close() {
    eventSubscription?.close()
    eventSubscription = null
  }
  
  return {
    get sessionId() { return sessionId },
    get promptSent() { return promptSent },
    get terminated() { return terminated },
    get terminationReason() { return terminationReason },
    startEvents,
    sendOriginalPrompt,
    sendContinuation,
    switchModel,
    waitForCompletion,
    isIdle,
    isToolTimeout,
    close
  }
}
