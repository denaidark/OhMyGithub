/**
 * Gateway and API Client Tests
 * 
 * Tests gateway route switching and API client methods with:
 * - Pinned OpenCode v2.2.5 binary (serve only, no plugin)
 * - Fake Copilot upstream for gateway proxy testing
 * 
 * LIMITATIONS (honest):
 * - plugin: [] = no Fusion plugin loaded (cannot test real plugin execution)
 * - setModel tests only verify API call succeeds, not model switching behavior
 * - Session IDs are fake (ses_test*) not from real model interaction
 * - Prompt tests use in-memory flag + try/catch, not actual model response
 * 
 * What IS tested:
 * - Gateway proxy: routes requests to upstream with credential injection
 * - Gateway token rotation: clears plugin cache on route change
 * - Gateway 503: returns fusion_unavailable when no route
 * - API client: getActiveSession() works with serve
 * - SessionController: in-memory prompt tracking (not persistence)
 */

import test, { describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createFusionGateway } from './fusion-gateway.mjs'
import { createOpenCodeClient, createSessionController, TERMINAL_EVENTS } from './opencode-api.mjs'
import { createRunController } from './fusion-run-controller.mjs'
import { RouteKind } from './run-with-model-fallback.mjs'

const OPENCODE_BIN = process.env.OPENCODE_BIN || `${process.env.HOME}/.opencode/bin/opencode`
const OPENCODE_VERSION = '2.2.5'

// Check if opencode is available
let opencodeAvailable = false
try {
  const version = execSync(`${OPENCODE_BIN} --version`, { encoding: 'utf8', timeout: 5000 }).trim()
  opencodeAvailable = version === `opencode v${OPENCODE_VERSION}`
  if (!opencodeAvailable) {
    console.log(`OpenCode version mismatch: expected v${OPENCODE_VERSION}, got ${version}`)
  }
} catch (err) {
  console.log(`OpenCode not available: ${err.message}`)
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'controller-int-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function getPort() {
  const server = createServer()
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

/**
 * Create a fake Copilot upstream that tracks requests
 */
function createFakeUpstream(t) {
  const requests = []
  let responseDelay = 0
  let failNext = false
  let failCount = 0
  
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const record = {
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: body || null,
        timestamp: Date.now()
      }
      requests.push(record)
      
      // Handle /auto endpoint
      if (req.url === '/auto' && req.method === 'POST') {
        const data = JSON.parse(body)
        const sessionToken = `tok_${Date.now()}`
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          session_token: sessionToken,
          model: data.model || 'gpt-4',
          expires: new Date(Date.now() + 3600000).toISOString()
        }))
        return
      }
      
      // Handle /responses endpoint (streaming)
      if (req.url === '/responses' && req.method === 'POST') {
        if (failNext) {
          failCount++
          failNext = false
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Donor unavailable' }))
          return
        }
        
        res.writeHead(200, { 
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache'
        })
        
        setTimeout(() => {
          const responseId = `resp_${Date.now()}`
          res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: responseId } })}\n\n`)
          res.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_item: { type: 'message', content: [{ type: 'output_text', text: 'Hello from fake upstream' }] } })}\n\n`)
          res.write(`data: ${JSON.stringify({ type: 'response.completed' })}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
        }, responseDelay)
        return
      }
      
      // Handle /models
      if (req.url === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ models: [{ id: 'gpt-4' }] }))
        return
      }
      
      res.writeHead(404)
      res.end('Not found')
    })
  })
  
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      t.after(() => server.close())
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        getRequests: () => [...requests],
        clearRequests: () => { requests.length = 0 },
        setDelay: ms => { responseDelay = ms },
        failNextRequest: () => { failNext = true },
        getFailCount: () => failCount
      })
    })
  })
}

// Skip tests if OpenCode not available
const testFn = opencodeAvailable ? test : test.skip

describe('Gateway and API Client Tests (no plugin)', { skip: !opencodeAvailable }, () => {
  
  testFn('gateway: route changes are reflected in upstream requests', async t => {
    const dir = tempDir(t)
    const upstream = await createFakeUpstream(t)
    
    const tokenFile = join(dir, 'fusion-token')
    const socketPath = join(dir, 'fusion.sock')
    const logFile = join(dir, 'gateway.log')
    
    const gateway = createFusionGateway({
      tokenFile,
      socketPath,
      log: msg => { try { writeFileSync(logFile, msg + '\n', { flag: 'a' }) } catch {} }
    })
    
    const { port: gatewayPort } = await gateway.start()
    t.after(async () => { try { await gateway.stop() } catch {} })
    
    // Set route to fake upstream
    gateway.setRoute({
      credential: 'test-credential-1',
      upstream: upstream.url,
      expires: Date.now() + 60000
    })
    
    // Read generation token from file
    const genToken1 = JSON.parse(readFileSync(tokenFile, 'utf8')).access_token
    
    // Make request through gateway WITH generation token
    const res1 = await fetch(`http://127.0.0.1:${gatewayPort}/auto`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${genToken1}`
      },
      body: JSON.stringify({ model: 'test-model' })
    })
    assert.equal(res1.status, 200)
    
    // Verify upstream received request with credential
    let requests = upstream.getRequests()
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, '/auto')
    assert.ok(requests[0].headers['authorization']?.includes('test-credential-1'))
    
    // Change route to different credential
    upstream.clearRequests()
    gateway.setRoute({
      credential: 'test-credential-2',
      upstream: upstream.url,
      expires: Date.now() + 60000
    })
    
    // Read new generation token
    const genToken2 = JSON.parse(readFileSync(tokenFile, 'utf8')).access_token
    assert.notEqual(genToken1, genToken2, 'Token should rotate on route change')
    
    // Make another request with new token
    const res2 = await fetch(`http://127.0.0.1:${gatewayPort}/auto`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${genToken2}`
      },
      body: JSON.stringify({ model: 'test-model-2' })
    })
    assert.equal(res2.status, 200)
    
    // Verify new credential used
    requests = upstream.getRequests()
    assert.equal(requests.length, 1)
    assert.ok(requests[0].headers['authorization']?.includes('test-credential-2'))
  })
  
  testFn('gateway: clear route returns 503 fusion_unavailable', async t => {
    const dir = tempDir(t)
    const upstream = await createFakeUpstream(t)
    
    const tokenFile = join(dir, 'fusion-token')
    const socketPath = join(dir, 'fusion.sock')
    
    const gateway = createFusionGateway({
      tokenFile,
      socketPath
    })
    
    const { port: gatewayPort } = await gateway.start()
    t.after(() => gateway.stop())
    
    // Read generation token (still written even without route)
    const genToken = JSON.parse(readFileSync(tokenFile, 'utf8')).access_token
    
    // No route set - should get 503
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/auto`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${genToken}`
      },
      body: JSON.stringify({})
    })
    
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.equal(body.error, 'fusion_unavailable')
  })
  
  testFn('gateway: token file rotates on route change', async t => {
    const dir = tempDir(t)
    const upstream = await createFakeUpstream(t)
    
    const tokenFile = join(dir, 'fusion-token')
    const socketPath = join(dir, 'fusion.sock')
    
    const gateway = createFusionGateway({
      tokenFile,
      socketPath
    })
    
    const { port: gatewayPort } = await gateway.start()
    t.after(() => gateway.stop())
    
    // Set first route
    gateway.setRoute({
      credential: 'cred-1',
      upstream: upstream.url,
      expires: Date.now() + 60000
    })
    
    const token1 = JSON.parse(readFileSync(tokenFile, 'utf8')).access_token
    assert.ok(token1.length > 0)
    
    // Set second route
    gateway.setRoute({
      credential: 'cred-2',
      upstream: upstream.url,
      expires: Date.now() + 60000
    })
    
    const token2 = JSON.parse(readFileSync(tokenFile, 'utf8')).access_token
    assert.ok(token2.length > 0)
    assert.notEqual(token1, token2, 'Token should change on route change')
  })
  
  testFn('API client: getActiveSession works with serve (no plugin)', async t => {
    const dir = tempDir(t)
    const servePort = await getPort()
    const password = 'test-password'
    
    // Create minimal config
    const configDir = join(dir, '.config', 'opencode')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'opencode.json'), JSON.stringify({
      plugin: [],
      permission: { '*': 'allow' }
    }))
    
    // Start opencode serve
    const serve = spawn(OPENCODE_BIN, ['serve', '--port', String(servePort)], {
      cwd: dir,
      env: { 
        ...process.env, 
        OPENCODE_PASSWORD: password,
        HOME: dir,
        XDG_CONFIG_HOME: join(dir, '.config')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    
    let ready = false
    const readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('serve timeout')), 30000)
      const onData = chunk => {
        const text = chunk.toString()
        if (text.includes('listening') || text.includes('ready') || text.includes('Started')) {
          ready = true
          clearTimeout(timeout)
          resolve()
        }
      }
      serve.stdout.on('data', onData)
      serve.stderr.on('data', onData)
      serve.on('error', err => { clearTimeout(timeout); reject(err) })
      serve.on('exit', code => { if (!ready) { clearTimeout(timeout); reject(new Error(`serve exited: ${code}`)) } })
    })
    
    t.after(async () => {
      serve.kill('SIGTERM')
      await new Promise(resolve => {
        const timeout = setTimeout(() => { serve.kill('SIGKILL'); resolve() }, 3000)
        serve.on('exit', () => { clearTimeout(timeout); resolve() })
      })
    })
    
    await readyPromise
    
    // Create API client
    const client = createOpenCodeClient({
      base: `http://127.0.0.1:${servePort}`,
      password
    })
    
    // Get active sessions (should be none initially)
    const active = await client.getActiveSession()
    assert.ok(active && typeof active === 'object')
  })

  testFn('SessionController: in-memory prompt flag prevents duplicate (not persistent)', async t => {
    const dir = tempDir(t)
    const servePort = await getPort()
    const password = 'test-password'
    
    // Create minimal config
    const configDir = join(dir, '.config', 'opencode')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'opencode.json'), JSON.stringify({
      plugin: [],
      permission: { '*': 'allow' }
    }))
    
    // Start opencode serve
    const serve = spawn(OPENCODE_BIN, ['serve', '--port', String(servePort)], {
      cwd: dir,
      env: { 
        ...process.env, 
        OPENCODE_PASSWORD: password,
        HOME: dir,
        XDG_CONFIG_HOME: join(dir, '.config')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    
    let ready = false
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('serve timeout')), 30000)
      const onData = chunk => {
        const text = chunk.toString()
        if (text.includes('listening') || text.includes('ready') || text.includes('Started')) {
          ready = true
          clearTimeout(timeout)
          resolve()
        }
      }
      serve.stdout.on('data', onData)
      serve.stderr.on('data', onData)
      serve.on('error', err => { clearTimeout(timeout); reject(err) })
      serve.on('exit', code => { if (!ready) { clearTimeout(timeout); reject(new Error(`serve exited: ${code}`)) } })
    })
    
    t.after(async () => {
      serve.kill('SIGTERM')
      await new Promise(resolve => {
        const timeout = setTimeout(() => { serve.kill('SIGKILL'); resolve() }, 3000)
        serve.on('exit', () => { clearTimeout(timeout); resolve() })
      })
    })
    
    // Create API client and session controller
    const client = createOpenCodeClient({
      base: `http://127.0.0.1:${servePort}`,
      password
    })
    
    const sessionId = `ses_test${Date.now()}`
    const controller = createSessionController({
      client,
      sessionId,
      idleTimeoutMs: 5000
    })
    
    // Track prompt calls
    let originalPromptCalls = 0
    let syntheticCalls = 0
    
    const origSendPrompt = client.sendPrompt.bind(client)
    client.sendPrompt = async (...args) => {
      originalPromptCalls++
      return origSendPrompt(...args)
    }
    
    const origSendSynthetic = client.sendSynthetic.bind(client)
    client.sendSynthetic = async (...args) => {
      syntheticCalls++
      return origSendSynthetic(...args)
    }
    
    // First prompt - should be original
    try {
      await controller.sendOriginalPrompt('Test prompt', { turnId: 'turn-1' })
    } catch (err) {
      // Expected - no actual model to respond
    }
    
    assert.equal(originalPromptCalls, 1, 'Original prompt should be sent exactly once')
    assert.equal(controller.promptSent, true)
    
    // Second call should throw
    await assert.rejects(
      () => controller.sendOriginalPrompt('Another prompt', { turnId: 'turn-2' }),
      /Original prompt already sent/
    )
    assert.equal(originalPromptCalls, 1, 'Should still be exactly 1 original prompt')
    
    // Continuation should use synthetic
    try {
      await controller.sendContinuation('Continue task', { turnId: 'turn-3' })
    } catch (err) {
      // Expected - no actual model
    }
    assert.equal(syntheticCalls, 1, 'Synthetic should be sent for continuation')
    assert.equal(originalPromptCalls, 1, 'Original prompt count unchanged')
  })

  testFn('SessionController: session ID in memory (not tested across restart)', async t => {
    const dir = tempDir(t)
    const servePort = await getPort()
    const password = 'test-password'
    
    const configDir = join(dir, '.config', 'opencode')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'opencode.json'), JSON.stringify({
      plugin: [],
      permission: { '*': 'allow' }
    }))
    
    const serve = spawn(OPENCODE_BIN, ['serve', '--port', String(servePort)], {
      cwd: dir,
      env: { 
        ...process.env, 
        OPENCODE_PASSWORD: password,
        HOME: dir,
        XDG_CONFIG_HOME: join(dir, '.config')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    
    let ready = false
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('serve timeout')), 30000)
      const onData = chunk => {
        const text = chunk.toString()
        if (text.includes('listening') || text.includes('ready') || text.includes('Started')) {
          ready = true
          clearTimeout(timeout)
          resolve()
        }
      }
      serve.stdout.on('data', onData)
      serve.stderr.on('data', onData)
      serve.on('error', err => { clearTimeout(timeout); reject(err) })
      serve.on('exit', code => { if (!ready) { clearTimeout(timeout); reject(new Error(`serve exited: ${code}`)) } })
    })
    
    t.after(async () => {
      serve.kill('SIGTERM')
      await new Promise(resolve => {
        const timeout = setTimeout(() => { serve.kill('SIGKILL'); resolve() }, 3000)
        serve.on('exit', () => { clearTimeout(timeout); resolve() })
      })
    })
    
    const client = createOpenCodeClient({
      base: `http://127.0.0.1:${servePort}`,
      password
    })
    
    // Create controller with specific session ID
    const sessionId = `ses_persistent_${Date.now()}`
    const controller = createSessionController({
      client,
      sessionId,
      idleTimeoutMs: 5000
    })
    
    // Session ID should be preserved throughout
    assert.equal(controller.sessionId, sessionId)
    
    // After operations, session ID unchanged
    try { await controller.sendOriginalPrompt('Test', { turnId: 'test-1' }) } catch {}
    assert.equal(controller.sessionId, sessionId)
    
    try { await controller.sendContinuation('Continue', { turnId: 'test-2' }) } catch {}
    assert.equal(controller.sessionId, sessionId, 'Session ID preserved after continuation')
  })
})

// Summary tests (always run)
describe('Controller Integration Summary', () => {
  test('fake upstream tracks request count', async t => {
    const upstream = await createFakeUpstream(t)
    
    // Make requests
    await fetch(`${upstream.url}/auto`, { method: 'POST', body: '{}' })
    await fetch(`${upstream.url}/auto`, { method: 'POST', body: '{}' })
    
    const requests = upstream.getRequests()
    assert.equal(requests.length, 2)
  })
  
  test('fake upstream can simulate failures', async t => {
    const upstream = await createFakeUpstream(t)
    
    upstream.failNextRequest()
    const res = await fetch(`${upstream.url}/responses`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 503)
    assert.equal(upstream.getFailCount(), 1)
  })
})
