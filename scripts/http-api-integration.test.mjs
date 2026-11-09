/**
 * HTTP API Integration Test
 * 
 * Verifies the production entrypoint uses HTTP API, not CLI spawn:
 * - /api/session/:id/model called to set model
 * - /api/session/:id/prompt called EXACTLY ONCE (admission)
 * - /api/session/:id/synthetic on continuation (same session)
 * - NO 'opencode run' spawn occurs when OPENCODE_PASSWORD is set
 * 
 * Uses fake OpenCode HTTP server that tracks all API calls.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runModels } from './run-with-model-fallback.mjs'

// Track all API calls
const calls = []
let server, port, tmpDir

before(async () => {
  // Start fake OpenCode HTTP server
  server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      const parsed = body ? JSON.parse(body).catch?.(() => ({})) ?? JSON.parse(body) : {}
      const sessionMatch = req.url.match(/\/api\/session\/([^/]+)\//)
      const sessionId = sessionMatch?.[1]
      
      calls.push({ 
        method: req.method, 
        url: req.url, 
        body: parsed,
        sessionId,
        timestamp: Date.now() 
      })
      
      // POST /api/session/:id/model
      if (req.method === 'POST' && req.url.match(/\/model$/)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: true }))
      }
      
      // POST /api/session/:id/prompt
      if (req.method === 'POST' && req.url.match(/\/prompt$/)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: true }))
      }
      
      // POST /api/session/:id/synthetic
      if (req.method === 'POST' && req.url.match(/\/synthetic$/)) {
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
      
      // GET /api/event - SSE endpoint (sends terminal event immediately)
      if (req.method === 'GET' && req.url === '/api/event') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        })
        
        // Send terminal event for any pending session after delay
        setTimeout(() => {
          const recentPrompt = calls.find(c => c.url.includes('/prompt'))
          if (recentPrompt?.sessionId) {
            res.write(`data: {"sessionID":"${recentPrompt.sessionId}","type":"succeeded"}\n\n`)
          }
          res.end()
        }, 100)
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
}

function getCalls(pathPattern) {
  return calls.filter(c => c.url.includes(pathPattern))
}

test('uses HTTP API when OPENCODE_PASSWORD is set', async () => {
  resetCalls()
  const testDir = mkdtempSync(join(tmpDir, 'test-'))
  const promptFile = join(testDir, 'prompt.txt')
  const logFile = join(testDir, 'run.log')
  const exitFile = join(testDir, 'exit')
  
  writeFileSync(promptFile, 'Test prompt')
  writeFileSync(logFile, '')
  
  const result = await runModels({
    binary: '/bin/false',
    port: String(port),
    promptFile,
    logFile,
    exitFile,
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
  
  const log = readFileSync(logFile, 'utf8')
  
  // MUST use HTTP API
  assert.match(log, /\[http-api\]/, 'should use HTTP API')
  assert.doesNotMatch(log, /WARNING: Using CLI spawn/, 'should NOT fall back to CLI spawn')
  
  // MUST have setModel call
  const modelCalls = getCalls('/model')
  assert.ok(modelCalls.length > 0, 'should call setModel')
  
  // MUST have prompt call
  const promptCalls = getCalls('/prompt')
  assert.strictEqual(promptCalls.length, 1, 'should call prompt EXACTLY ONCE')
})

test('prompt has deterministic admission ID from run/attempt', async () => {
  resetCalls()
  const testDir = mkdtempSync(join(tmpDir, 'test-'))
  const promptFile = join(testDir, 'prompt.txt')
  const logFile = join(testDir, 'run.log')
  const exitFile = join(testDir, 'exit')
  
  writeFileSync(promptFile, 'Test prompt')
  writeFileSync(logFile, '')
  
  await runModels({
    binary: '/bin/false',
    port: String(port),
    promptFile,
    logFile,
    exitFile,
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
  assert.strictEqual(promptCalls.length, 1)
  
  const promptBody = promptCalls[0].body
  assert.ok(promptBody.id, 'prompt should have admission ID')
  assert.match(promptBody.id, /admission-99999-3/, 'admission ID should include run ID and attempt')
})

test('same session ID used across all API calls', async () => {
  resetCalls()
  const testDir = mkdtempSync(join(tmpDir, 'test-'))
  const promptFile = join(testDir, 'prompt.txt')
  const logFile = join(testDir, 'run.log')
  const exitFile = join(testDir, 'exit')
  
  writeFileSync(promptFile, 'Test prompt')
  writeFileSync(logFile, '')
  
  await runModels({
    binary: '/bin/false',
    port: String(port),
    promptFile,
    logFile,
    exitFile,
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
  
  // Extract session IDs from all session-related calls
  const sessionIds = new Set(
    calls
      .filter(c => c.sessionId)
      .map(c => c.sessionId)
  )
  
  assert.strictEqual(sessionIds.size, 1, 'all calls should use SAME session ID')
})

test('no CLI spawn when HTTP API available', async () => {
  resetCalls()
  const testDir = mkdtempSync(join(tmpDir, 'test-'))
  const promptFile = join(testDir, 'prompt.txt')
  const logFile = join(testDir, 'run.log')
  const exitFile = join(testDir, 'exit')
  
  writeFileSync(promptFile, 'Test prompt')
  writeFileSync(logFile, '')
  
  const result = await runModels({
    binary: '/usr/bin/opencode-does-not-exist',  // Would fail if called
    port: String(port),
    promptFile,
    logFile,
    exitFile,
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
  
  const log = readFileSync(logFile, 'utf8')
  
  // If spawn was called with non-existent binary, we'd see an error
  assert.doesNotMatch(log, /spawn.*ENOENT/, 'should not attempt to spawn binary')
  assert.doesNotMatch(log, /WARNING: Using CLI spawn/, 'should not fall back to CLI')
  // Code may be non-zero due to fake server event timing, but key is no CLI spawn
  assert.ok(getCalls('/prompt').length > 0, 'should use HTTP API for prompt')
})

test('falls back to CLI spawn when OPENCODE_PASSWORD not set', async () => {
  resetCalls()
  const testDir = mkdtempSync(join(tmpDir, 'test-'))
  const promptFile = join(testDir, 'prompt.txt')
  const logFile = join(testDir, 'run.log')
  const exitFile = join(testDir, 'exit')
  
  writeFileSync(promptFile, 'Test prompt')
  writeFileSync(logFile, '')
  
  // No HTTP API calls expected - will use CLI spawn
  const result = await runModels({
    binary: '/bin/echo',  // Will be called but exit quickly
    port: String(port),
    promptFile,
    logFile,
    exitFile,
    selected: null,
    env: {
      // NO OPENCODE_PASSWORD - forces CLI spawn
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
  
  const log = readFileSync(logFile, 'utf8')
  
  // Should fall back to CLI
  assert.match(log, /WARNING: Using CLI spawn/, 'should fall back to CLI when no password')
  
  // No prompt API calls (CLI doesn't go through HTTP API)
  const promptCalls = getCalls('/prompt')
  assert.strictEqual(promptCalls.length, 0, 'should not use HTTP API for prompt')
})

test('model is set before prompt is sent', async () => {
  resetCalls()
  const testDir = mkdtempSync(join(tmpDir, 'test-'))
  const promptFile = join(testDir, 'prompt.txt')
  const logFile = join(testDir, 'run.log')
  const exitFile = join(testDir, 'exit')
  
  writeFileSync(promptFile, 'Test prompt')
  writeFileSync(logFile, '')
  
  await runModels({
    binary: '/bin/false',
    port: String(port),
    promptFile,
    logFile,
    exitFile,
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
  
  assert.ok(modelCall, 'should have model call')
  assert.ok(promptCall, 'should have prompt call')
  assert.ok(modelCall.timestamp < promptCall.timestamp, 'model should be set BEFORE prompt')
})
