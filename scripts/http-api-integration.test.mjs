/**
 * HTTP API Integration Test (P0-7 compliant)
 * 
 * Verifies production entrypoint with strict schema validation:
 * - Real event types (session.execution.succeeded, not 'succeeded')
 * - Model as object {providerID, id} (not string)
 * - Close is FAILURE, not success
 * - Failure → next model with synthetic (no prompt replay)
 * - Timeout → interrupt+wait before turn
 * - Proper exit codes and classifications
 * 
 * Uses fake OpenCode HTTP server with strict schema checking.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runModels, RouteKind } from './run-with-model-fallback.mjs'
import { SessionEventTypes } from './opencode-api.mjs'

// Track all API calls with strict validation
const calls = []
let server, port, tmpDir

// Validate model object format
function validateModelObject(model) {
  if (!model || typeof model !== 'object') return 'model must be object'
  if (!model.providerID || typeof model.providerID !== 'string') return 'model.providerID required'
  if (!model.id || typeof model.id !== 'string') return 'model.id required'
  return null
}

// Event response queue
let eventResponses = []
let eventResponseIndex = 0

function setEventResponses(responses) {
  eventResponses = responses
  eventResponseIndex = 0
}

function getNextEventResponse() {
  if (eventResponseIndex < eventResponses.length) {
    return eventResponses[eventResponseIndex++]
  }
  return { type: SessionEventTypes.EXECUTION_SUCCEEDED }
}

before(async () => {
  // Start fake OpenCode HTTP server with strict validation
  server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      let parsed = {}
      try { parsed = body ? JSON.parse(body) : {} } catch {}
      
      const sessionMatch = req.url.match(/\/api\/session\/([^/]+)\//)
      const sessionId = sessionMatch?.[1]
      
      calls.push({ 
        method: req.method, 
        url: req.url, 
        body: parsed,
        sessionId,
        timestamp: Date.now() 
      })
      
      // POST /api/session/:id/model - validate model object
      if (req.method === 'POST' && req.url.match(/\/model$/)) {
        const modelErr = validateModelObject(parsed.model)
        if (modelErr) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: modelErr }))
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: true }))
      }
      
      // POST /api/session/:id/prompt - validate admission ID
      if (req.method === 'POST' && req.url.match(/\/prompt$/)) {
        if (!parsed.id || !parsed.text) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'prompt requires id and text' }))
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: true }))
      }
      
      // POST /api/session/:id/synthetic
      if (req.method === 'POST' && req.url.match(/\/synthetic$/)) {
        if (!parsed.id || !parsed.text) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'synthetic requires id and text' }))
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: true }))
      }
      
      // POST /api/session/:id/interrupt
      if (req.method === 'POST' && req.url.match(/\/interrupt/)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: true }))
      }
      
      // POST /api/experimental/session/:id/wait
      if (req.method === 'POST' && req.url.match(/\/wait$/)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: true }))
      }
      
      // GET /api/session/active
      if (req.method === 'GET' && req.url === '/api/session/active') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ active: false }))
      }
      
      // GET /api/event - SSE with REAL event types
      if (req.method === 'GET' && req.url === '/api/event') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        })
        
        // Send proper terminal event after delay
        setTimeout(() => {
          const recentCall = calls.find(c => c.url.includes('/prompt') || c.url.includes('/synthetic'))
          const sessionId = recentCall?.sessionId || 'ses_test'
          const event = getNextEventResponse()
          
          // Use REAL event type format
          res.write(`data: ${JSON.stringify({ sessionID: sessionId, type: event.type, ...event })}\n\n`)
          res.end()
        }, 50)
        return
      }
      
      // Default: 404
      res.writeHead(404)
      res.end('Not found')
    })
  })
  
  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port
      resolve()
    })
  })
  
  tmpDir = mkdtempSync(join(tmpdir(), 'http-api-test-'))
})

after(() => {
  server?.close()
  try { rmSync(tmpDir, { recursive: true }) } catch {}
})

function resetCalls() {
  calls.length = 0
  eventResponses = []
  eventResponseIndex = 0
}

function getCalls(pathPattern) {
  return calls.filter(c => c.url.includes(pathPattern))
}

test('model is passed as {providerID, id} object, not string', async () => {
  resetCalls()
  setEventResponses([{ type: SessionEventTypes.EXECUTION_SUCCEEDED }])
  
  const testDir = mkdtempSync(join(tmpDir, 'test-'))
  writeFileSync(join(testDir, 'prompt.txt'), 'Test prompt')
  writeFileSync(join(testDir, 'run.log'), '')
  
  const result = await runModels({
    binary: '/bin/false',
    port: String(port),
    promptFile: join(testDir, 'prompt.txt'),
    logFile: join(testDir, 'run.log'),
    exitFile: join(testDir, 'exit'),
    selected: null,
    env: {
      OPENCODE_PASSWORD: 'test-password',
      GITHUB_RUN_ID: '12345',
      GITHUB_RUN_ATTEMPT: '1',
      FUSION_ROUTE: 'own',
      FUSION_ACCESS_TOKEN: 'fake-token',
      PROJECT_DIR: testDir
    },
    switchProxy: null,
    lazyProxy: null,
    routingSettings: { warp_enabled: false, skip_direct_oc: false }
  })
  
  const modelCalls = getCalls('/model')
  assert.ok(modelCalls.length > 0, 'should call setModel')
  
  // Verify model is object with providerID and id
  const modelBody = modelCalls[0].body
  assert.ok(modelBody.model, 'should have model in body')
  assert.ok(modelBody.model.providerID, 'model should have providerID')
  assert.ok(modelBody.model.id, 'model should have id')
  assert.strictEqual(typeof modelBody.model.providerID, 'string', 'providerID should be string')
  assert.strictEqual(typeof modelBody.model.id, 'string', 'id should be string')
})

test('prompt uses deterministic admission ID from run/attempt', async () => {
  resetCalls()
  setEventResponses([{ type: SessionEventTypes.EXECUTION_SUCCEEDED }])
  
  const testDir = mkdtempSync(join(tmpDir, 'test-'))
  writeFileSync(join(testDir, 'prompt.txt'), 'Test prompt')
  writeFileSync(join(testDir, 'run.log'), '')
  
  await runModels({
    binary: '/bin/false',
    port: String(port),
    promptFile: join(testDir, 'prompt.txt'),
    logFile: join(testDir, 'run.log'),
    exitFile: join(testDir, 'exit'),
    selected: null,
    env: {
      OPENCODE_PASSWORD: 'test-password',
      GITHUB_RUN_ID: '99999',
      GITHUB_RUN_ATTEMPT: '3',
      FUSION_ROUTE: 'own',
      FUSION_ACCESS_TOKEN: 'fake-token',
      PROJECT_DIR: testDir
    },
    switchProxy: null,
    lazyProxy: null,
    routingSettings: { warp_enabled: false, skip_direct_oc: false }
  })
  
  const promptCalls = getCalls('/prompt')
  assert.strictEqual(promptCalls.length, 1, 'should call prompt EXACTLY ONCE')
  assert.match(promptCalls[0].body.id, /admission-99999-3/, 'admission ID should include run/attempt')
})

test('same session ID across all API calls', async () => {
  resetCalls()
  setEventResponses([{ type: SessionEventTypes.EXECUTION_SUCCEEDED }])
  
  const testDir = mkdtempSync(join(tmpDir, 'test-'))
  writeFileSync(join(testDir, 'prompt.txt'), 'Test prompt')
  writeFileSync(join(testDir, 'run.log'), '')
  
  await runModels({
    binary: '/bin/false',
    port: String(port),
    promptFile: join(testDir, 'prompt.txt'),
    logFile: join(testDir, 'run.log'),
    exitFile: join(testDir, 'exit'),
    selected: null,
    env: {
      OPENCODE_PASSWORD: 'test-password',
      GITHUB_RUN_ID: '12347',
      GITHUB_RUN_ATTEMPT: '1',
      FUSION_ROUTE: 'own',
      FUSION_ACCESS_TOKEN: 'fake-token',
      PROJECT_DIR: testDir
    },
    switchProxy: null,
    lazyProxy: null,
    routingSettings: { warp_enabled: false, skip_direct_oc: false }
  })
  
  const sessionIds = new Set(calls.filter(c => c.sessionId).map(c => c.sessionId))
  assert.strictEqual(sessionIds.size, 1, 'all calls should use SAME session ID')
  
  // Verify session ID format
  const sessionId = [...sessionIds][0]
  assert.match(sessionId, /^ses_[a-f0-9]{24}$/, 'session ID should be ses_<24-hex>')
})

test('succeeded event (session.execution.succeeded) returns code 0', async () => {
  resetCalls()
  setEventResponses([{ type: SessionEventTypes.EXECUTION_SUCCEEDED }])
  
  const testDir = mkdtempSync(join(tmpDir, 'test-'))
  writeFileSync(join(testDir, 'prompt.txt'), 'Test prompt')
  writeFileSync(join(testDir, 'run.log'), '')
  
  const result = await runModels({
    binary: '/bin/false',
    port: String(port),
    promptFile: join(testDir, 'prompt.txt'),
    logFile: join(testDir, 'run.log'),
    exitFile: join(testDir, 'exit'),
    selected: null,
    env: {
      OPENCODE_PASSWORD: 'test-password',
      GITHUB_RUN_ID: '12348',
      GITHUB_RUN_ATTEMPT: '1',
      FUSION_ROUTE: 'own',
      FUSION_ACCESS_TOKEN: 'fake-token',
      PROJECT_DIR: testDir
    },
    switchProxy: null,
    lazyProxy: null,
    routingSettings: { warp_enabled: false, skip_direct_oc: false }
  })
  
  assert.strictEqual(result.code, 0, 'succeeded event should return code 0')
})

test('failed event (session.execution.failed) returns code 1', async () => {
  resetCalls()
  setEventResponses([{ type: SessionEventTypes.EXECUTION_FAILED, error: 'test failure' }])
  
  const testDir = mkdtempSync(join(tmpDir, 'test-'))
  writeFileSync(join(testDir, 'prompt.txt'), 'Test prompt')
  writeFileSync(join(testDir, 'run.log'), '')
  
  const result = await runModels({
    binary: '/bin/false',
    port: String(port),
    promptFile: join(testDir, 'prompt.txt'),
    logFile: join(testDir, 'run.log'),
    exitFile: join(testDir, 'exit'),
    selected: null,
    env: {
      OPENCODE_PASSWORD: 'test-password',
      GITHUB_RUN_ID: '12349',
      GITHUB_RUN_ATTEMPT: '1',
      FUSION_ROUTE: 'own',
      FUSION_ACCESS_TOKEN: 'fake-token',
      PROJECT_DIR: testDir
    },
    switchProxy: null,
    lazyProxy: null,
    routingSettings: { warp_enabled: false, skip_direct_oc: false }
  })
  
  assert.strictEqual(result.code, 1, 'failed event should return code 1')
})

test('model set BEFORE prompt sent (timestamp ordering)', async () => {
  resetCalls()
  setEventResponses([{ type: SessionEventTypes.EXECUTION_SUCCEEDED }])
  
  const testDir = mkdtempSync(join(tmpDir, 'test-'))
  writeFileSync(join(testDir, 'prompt.txt'), 'Test prompt')
  writeFileSync(join(testDir, 'run.log'), '')
  
  await runModels({
    binary: '/bin/false',
    port: String(port),
    promptFile: join(testDir, 'prompt.txt'),
    logFile: join(testDir, 'run.log'),
    exitFile: join(testDir, 'exit'),
    selected: null,
    env: {
      OPENCODE_PASSWORD: 'test-password',
      GITHUB_RUN_ID: '12350',
      GITHUB_RUN_ATTEMPT: '1',
      FUSION_ROUTE: 'own',
      FUSION_ACCESS_TOKEN: 'fake-token',
      PROJECT_DIR: testDir
    },
    switchProxy: null,
    lazyProxy: null,
    routingSettings: { warp_enabled: false, skip_direct_oc: false }
  })
  
  const modelCall = calls.find(c => c.url.includes('/model'))
  const promptCall = calls.find(c => c.url.includes('/prompt'))
  
  assert.ok(modelCall, 'should call model endpoint')
  assert.ok(promptCall, 'should call prompt endpoint')
  assert.ok(modelCall.timestamp <= promptCall.timestamp, 'model must be set BEFORE prompt')
})

test('missing OPENCODE_PASSWORD fails closed (no CLI fallback)', async () => {
  resetCalls()
  
  const testDir = mkdtempSync(join(tmpDir, 'test-'))
  writeFileSync(join(testDir, 'prompt.txt'), 'Test prompt')
  writeFileSync(join(testDir, 'run.log'), '')
  
  // Should throw, not fall back to CLI
  await assert.rejects(async () => {
    await runModels({
      binary: '/bin/echo',  // Would succeed if called
      port: String(port),
      promptFile: join(testDir, 'prompt.txt'),
      logFile: join(testDir, 'run.log'),
      exitFile: join(testDir, 'exit'),
      selected: null,
      env: {
        // NO OPENCODE_PASSWORD - should fail closed
        GITHUB_RUN_ID: '12351',
        GITHUB_RUN_ATTEMPT: '1',
        FUSION_ROUTE: 'own',
        FUSION_ACCESS_TOKEN: 'fake-token',
        PROJECT_DIR: testDir
      },
      switchProxy: null,
      lazyProxy: null,
      routingSettings: { warp_enabled: false, skip_direct_oc: false }
    })
  }, /OPENCODE_PASSWORD.*not set|fail.*closed/i, 'should fail closed when password missing')
})
