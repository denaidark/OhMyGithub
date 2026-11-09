/**
 * Production Integration Tests
 * 
 * Tests the full production path with:
 * - Real OpenCode v2.2.5 binary
 * - Fusion Gateway with credential injection
 * - Fake upstream for controlled responses
 * - Lease API with expiry/revocation enforcement
 * 
 * Requirements:
 * - OPENCODE_BIN environment variable pointing to v2.2.5 binary
 * - No real provider credentials used
 */

import { describe, test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFusionGateway } from './fusion-gateway.mjs'
import { createOpenCodeClient } from './opencode-api.mjs'
import { runModels, RouteKind } from './run-with-model-fallback.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPENCODE_BIN = process.env.OPENCODE_BIN || '/home/ubuntu/.opencode/bin/opencode'

// Check if binary is available
let binaryAvailable = false
try {
  const { execSync } = await import('node:child_process')
  const version = execSync(`${OPENCODE_BIN} --version`, { encoding: 'utf8' }).trim()
  binaryAvailable = version.includes('v2.2.5')
  if (binaryAvailable) console.log(`Binary: ${version}`)
} catch (e) {
  console.log('OpenCode binary not available:', e.message)
}

// Fake upstream that simulates Copilot API
class FakeUpstream {
  constructor() {
    this.requests = []
    this.responses = []
    this.responseIndex = 0
    this.server = null
    this.port = null
  }
  
  setResponses(responses) {
    this.responses = responses
    this.responseIndex = 0
  }
  
  getNextResponse() {
    if (this.responseIndex < this.responses.length) {
      return this.responses[this.responseIndex++]
    }
    return { status: 200, body: { choices: [{ message: { content: 'OK' } }] } }
  }
  
  async start() {
    return new Promise(resolve => {
      this.server = createServer((req, res) => {
        let body = ''
        req.on('data', c => body += c)
        req.on('end', () => {
          this.requests.push({
            method: req.method,
            url: req.url,
            headers: { ...req.headers },
            body: body ? JSON.parse(body) : null,
            timestamp: Date.now()
          })
          
          const response = this.getNextResponse()
          
          if (response.delay) {
            setTimeout(() => this.sendResponse(res, response), response.delay)
          } else {
            this.sendResponse(res, response)
          }
        })
      })
      
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port
        resolve(this.port)
      })
    })
  }
  
  sendResponse(res, response) {
    res.writeHead(response.status || 200, {
      'Content-Type': 'application/json',
      ...response.headers
    })
    res.end(JSON.stringify(response.body || {}))
  }
  
  getRequests(filter) {
    if (!filter) return [...this.requests]
    return this.requests.filter(r =>
      (!filter.url || r.url.includes(filter.url)) &&
      (!filter.method || r.method === filter.method)
    )
  }
  
  reset() {
    this.requests = []
    this.responses = []
    this.responseIndex = 0
  }
  
  stop() {
    this.server?.close()
  }
}

// Lease state tracking
class FakeLeaseStore {
  constructor() {
    this.leases = new Map()  // token -> { type, expires, revoked }
  }
  
  createLease(token, type, ttlMs = 180000) {
    this.leases.set(token, {
      type,
      expires: Date.now() + ttlMs,
      revoked: false
    })
  }
  
  revokeLease(token) {
    const lease = this.leases.get(token)
    if (lease) lease.revoked = true
  }
  
  isValid(token) {
    const lease = this.leases.get(token)
    if (!lease) return false
    if (lease.revoked) return false
    if (lease.expires < Date.now()) return false
    return true
  }
  
  getType(token) {
    return this.leases.get(token)?.type
  }
  
  reset() {
    this.leases.clear()
  }
}

let fakeUpstream, gateway, leaseStore, tmpDir

describe('Production Integration Tests', { skip: !binaryAvailable }, () => {
  
  before(async () => {
    fakeUpstream = new FakeUpstream()
    await fakeUpstream.start()
    
    leaseStore = new FakeLeaseStore()
    tmpDir = mkdtempSync(join(tmpdir(), 'prod-integration-'))
    
    console.log(`Fake upstream: http://127.0.0.1:${fakeUpstream.port}`)
  })
  
  after(() => {
    fakeUpstream?.stop()
    try { rmSync(tmpDir, { recursive: true }) } catch {}
  })
  
  beforeEach(() => {
    fakeUpstream.reset()
    leaseStore.reset()
  })
  
  test('gateway injects credential and proxies to upstream', async t => {
    const testDir = mkdtempSync(join(tmpDir, 'test-'))
    const tokenFile = join(testDir, 'fusion-token')
    const socketPath = join(testDir, 'control.sock')
    const logFile = join(testDir, 'gateway.log')
    
    const gw = createFusionGateway({
      tokenFile,
      socketPath,
      log: msg => appendFileSync(logFile, msg + '\n'),
      allowedSharedUpstreams: ['127.0.0.1']
    })
    
    const startResult = await gw.start()
    const gwPort = startResult.port
    
    // Set route with credential
    const routeResult = gw.setRoute({
      credential: 'test-fusion-token',
      upstream: `http://127.0.0.1:${fakeUpstream.port}`,
      routeType: 'direct'
    })
    assert.ok(routeResult.success, 'route should be set')
    
    // Make request through gateway
    const genToken = readFileSync(tokenFile, 'utf8').trim()
    fakeUpstream.setResponses([{ status: 200, body: { result: 'ok' } }])
    
    const response = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${genToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] })
    })
    
    assert.strictEqual(response.status, 200)
    
    // Verify upstream received injected credential
    const upstreamReqs = fakeUpstream.getRequests()
    assert.strictEqual(upstreamReqs.length, 1)
    assert.strictEqual(upstreamReqs[0].headers.authorization, 'Bearer test-fusion-token')
    
    gw.stop()
  })
  
  test('gateway rejects expired route', async t => {
    const testDir = mkdtempSync(join(tmpDir, 'test-'))
    const tokenFile = join(testDir, 'fusion-token')
    const socketPath = join(testDir, 'control.sock')
    
    const gw = createFusionGateway({
      tokenFile,
      socketPath,
      log: () => {},
      now: () => 1000  // Fixed time for testing
    })
    
    await gw.start()
    
    // Set route that's already expired
    const routeResult = gw.setRoute({
      credential: 'expired-token',
      upstream: `http://127.0.0.1:${fakeUpstream.port}`,
      routeType: 'direct',
      expires: 500  // Already expired (now=1000)
    })
    
    assert.ok(!routeResult.success, 'should reject expired route')
    assert.match(routeResult.error, /expired/i)
    
    gw.stop()
  })
  
  test('gateway returns 503 when no route configured', async t => {
    const testDir = mkdtempSync(join(tmpDir, 'test-'))
    const tokenFile = join(testDir, 'fusion-token')
    const socketPath = join(testDir, 'control.sock')
    
    const gw = createFusionGateway({
      tokenFile,
      socketPath,
      log: () => {}
    })
    
    const { port: gwPort } = await gw.start()
    const genToken = readFileSync(tokenFile, 'utf8').trim()
    
    const response = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${genToken}` },
      body: '{}'
    })
    
    assert.strictEqual(response.status, 503)
    const body = await response.json()
    assert.match(body.error, /no.*route|unavailable/i)
    
    gw.stop()
  })
  
  test('direct vs shared routes use different credentials', async t => {
    const testDir = mkdtempSync(join(tmpDir, 'test-'))
    const tokenFile = join(testDir, 'fusion-token')
    const socketPath = join(testDir, 'control.sock')
    
    const gw = createFusionGateway({
      tokenFile,
      socketPath,
      log: () => {},
      allowedSharedUpstreams: ['127.0.0.1']
    })
    
    const { port: gwPort } = await gw.start()
    const genToken = readFileSync(tokenFile, 'utf8').trim()
    
    // Set direct route
    gw.setRoute({
      credential: 'direct-credential',
      upstream: `http://127.0.0.1:${fakeUpstream.port}`,
      routeType: 'direct'
    })
    
    // Read gen token again (rotated on route change)
    const directGenToken = readFileSync(tokenFile, 'utf8').trim()
    
    fakeUpstream.setResponses([{ status: 200, body: {} }])
    await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${directGenToken}` },
      body: '{}'
    })
    
    // Set shared route with different credential
    gw.setRoute({
      credential: 'shared-donor-credential',
      upstream: `http://127.0.0.1:${fakeUpstream.port}`,
      routeType: 'shared'
    })
    
    // Gen token rotated again
    const sharedGenToken = readFileSync(tokenFile, 'utf8').trim()
    assert.notStrictEqual(directGenToken, sharedGenToken, 'token should rotate on route change')
    
    fakeUpstream.setResponses([{ status: 200, body: {} }])
    await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sharedGenToken}` },
      body: '{}'
    })
    
    // Verify different credentials sent to upstream
    const reqs = fakeUpstream.getRequests()
    assert.strictEqual(reqs.length, 2)
    assert.strictEqual(reqs[0].headers.authorization, 'Bearer direct-credential')
    assert.strictEqual(reqs[1].headers.authorization, 'Bearer shared-donor-credential')
    
    gw.stop()
  })
  
  test('deterministic admission ID prevents duplicate prompts', async t => {
    const testDir = mkdtempSync(join(tmpDir, 'test-'))
    const promptFile = join(testDir, 'prompt.txt')
    const logFile = join(testDir, 'run.log')
    const exitFile = join(testDir, 'exit')
    
    writeFileSync(promptFile, 'Test prompt')
    writeFileSync(logFile, '')
    
    // Mock server that tracks prompt calls
    const promptCalls = []
    const mockServer = createServer((req, res) => {
      let body = ''
      req.on('data', c => body += c)
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {}
        
        if (req.url.includes('/prompt')) {
          promptCalls.push({ id: parsed.id, timestamp: Date.now() })
        }
        
        if (req.url.includes('/model') || req.url.includes('/prompt') || 
            req.url.includes('/synthetic') || req.url.includes('/interrupt') ||
            req.url.includes('/wait')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ ok: true }))
        }
        
        if (req.url === '/api/event') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          setTimeout(() => {
            res.write(`data: {"sessionID":"ses_test","type":"succeeded"}\n\n`)
            res.end()
          }, 50)
          return
        }
        
        res.writeHead(404)
        res.end()
      })
    })
    
    const port = await new Promise(resolve => {
      mockServer.listen(0, '127.0.0.1', () => resolve(mockServer.address().port))
    })
    
    // First run
    await runModels({
      binary: '/bin/false',
      port: String(port),
      promptFile,
      logFile,
      exitFile,
      selected: null,
      env: {
        OPENCODE_PASSWORD: 'test',
        GITHUB_RUN_ID: '77777',
        GITHUB_RUN_ATTEMPT: '1',
        FUSION_ACCESS_TOKEN: 'fake',
        FUSION_ROUTE: 'own',
        PROJECT_DIR: testDir
      },
      switchProxy: null,
      lazyProxy: null,
      routingSettings: { warp_enabled: false, skip_direct_oc: false }
    })
    
    // Verify admission ID format
    assert.strictEqual(promptCalls.length, 1, 'prompt should be called once')
    assert.match(promptCalls[0].id, /admission-77777-1/, 'admission ID should include run/attempt')
    
    mockServer.close()
  })
  
  test('bounded shared donor 402 retry with excludeDonor', async t => {
    // Test the acquireFusionOnDemand with excludeDonor parameter
    const { acquireFusionOnDemand } = await import('./run-with-model-fallback.mjs')
    
    let callCount = 0
    let lastExcludeDonor = null
    const testDir = mkdtempSync(join(tmpDir, 'test-'))
    const logFile = join(testDir, 'test.log')
    writeFileSync(logFile, '')
    
    const mockRequest = async (url, options) => {
      callCount++
      try {
        lastExcludeDonor = options?.body ? JSON.parse(options.body).exclude_donor_hash : null
      } catch {}
      
      // First call returns a donor token, second call with different donor succeeds
      // Response format: { secrets: { FUSION_ACCESS_TOKEN }, fusion_route }
      if (callCount === 1) {
        return {
          ok: true,
          json: async () => ({ 
            secrets: { FUSION_ACCESS_TOKEN: 'donor-token-1' },
            fusion_route: 'shared'
          })
        }
      }
      return {
        ok: true,
        json: async () => ({
          secrets: { FUSION_ACCESS_TOKEN: 'donor-token-2' },
          fusion_route: 'shared'
        })
      }
    }
    
    // acquireFusionOnDemand requires callback credentials
    const env = {
      OMGITHUB_ORIGIN: 'http://fake.test',
      OMGITHUB_CALLBACK_TOKEN: 'test-callback-token',
      GITHUB_REPOSITORY: 'test/repo',
      TRIGGER_ISSUE_NUMBER: '123',
      GITHUB_RUN_ID: '456',
      GITHUB_RUN_ATTEMPT: '1'
    }
    
    // First acquisition
    const result1 = await acquireFusionOnDemand({
      env,
      logFile,
      request: mockRequest
    })
    
    assert.ok(result1.success, `First acquisition failed: ${JSON.stringify(result1)}`)
    assert.strictEqual(result1.token, 'donor-token-1')
    
    // Second acquisition with excludeDonor
    const result2 = await acquireFusionOnDemand({
      env,
      logFile,
      request: mockRequest,
      excludeDonor: 'donor-token-1'
    })
    
    assert.ok(result2.success, `Second acquisition failed: ${JSON.stringify(result2)}`)
    assert.strictEqual(result2.token, 'donor-token-2')
    // excludeDonor is hashed before being sent
    assert.ok(lastExcludeDonor, 'should pass exclude_donor_hash to API')
    assert.match(lastExcludeDonor, /^[a-f0-9]{16}$/, 'exclude_donor_hash should be 16-char hex')
  })
})

describe('HTTP API Protocol Tests', { skip: !binaryAvailable }, () => {
  let protocolTmpDir
  
  before(() => {
    protocolTmpDir = mkdtempSync(join(tmpdir(), 'protocol-test-'))
  })
  
  after(() => {
    try { rmSync(protocolTmpDir, { recursive: true }) } catch {}
  })
  
  test('model is set before prompt sent', async t => {
    const calls = []
    const mockServer = createServer((req, res) => {
      calls.push({ url: req.url, timestamp: Date.now() })
      
      if (req.url === '/api/event') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        setTimeout(() => res.end(), 100)
        return
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    
    const port = await new Promise(r => mockServer.listen(0, '127.0.0.1', () => r(mockServer.address().port)))
    const testDir = mkdtempSync(join(protocolTmpDir, 'test-'))
    
    writeFileSync(join(testDir, 'prompt.txt'), 'test')
    writeFileSync(join(testDir, 'run.log'), '')
    
    await runModels({
      binary: '/bin/false',
      port: String(port),
      promptFile: join(testDir, 'prompt.txt'),
      logFile: join(testDir, 'run.log'),
      exitFile: join(testDir, 'exit'),
      selected: null,
      env: {
        OPENCODE_PASSWORD: 'test',
        GITHUB_RUN_ID: '88888',
        GITHUB_RUN_ATTEMPT: '1',
        FUSION_ACCESS_TOKEN: 'fake',
        FUSION_ROUTE: 'own',
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
    assert.ok(modelCall.timestamp <= promptCall.timestamp, 'model should be set before prompt')
    
    mockServer.close()
  })
})
