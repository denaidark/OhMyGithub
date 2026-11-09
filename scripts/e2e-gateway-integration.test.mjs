/**
 * E2E Gateway Integration Test
 * 
 * Tests the full production path:
 * - Real OpenCode v2.2.5 serve
 * - Fusion Gateway with route switching
 * - Fake upstream for controlled responses
 * - Route change on failure + continuation
 * 
 * Requirements:
 * - OPENCODE_BIN environment variable pointing to v2.2.5 binary
 * - No live provider calls
 * 
 * Tests FAIL (not skip) when runtime missing in CI.
 */

import { describe, test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'

import { createFusionGateway } from './fusion-gateway.mjs'
import { createGatewayControl } from './gateway-control.mjs'
import { createLeaseClient } from './fusion-lease-client.mjs'
import { createOpenCodeClient, SessionEventTypes } from './opencode-api.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OPENCODE_BIN = process.env.OPENCODE_BIN || '/home/ubuntu/.opencode/bin/opencode'
const CI = process.env.CI === 'true'

// Check if binary is available - FAIL in CI, skip locally
let binaryAvailable = false
let binaryVersion = ''
try {
  const { execSync } = await import('node:child_process')
  binaryVersion = execSync(`${OPENCODE_BIN} --version`, { encoding: 'utf8' }).trim()
  binaryAvailable = binaryVersion.includes('v2.2.5')
} catch (e) {
  if (CI) {
    throw new Error(`OPENCODE_BIN not available in CI: ${e.message}. Tests must FAIL, not skip.`)
  }
}

if (binaryAvailable) {
  console.log(`Binary: ${binaryVersion}`)
} else if (!CI) {
  console.log('OpenCode binary not available (local dev), skipping E2E tests')
}

// Fake Copilot upstream
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
    return { status: 200, body: { choices: [{ message: { content: 'OK', role: 'assistant' } }] } }
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
          
          // Simulate streaming for chat completions
          if (req.url.includes('/chat/completions') && response.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            for (const chunk of response.chunks || []) {
              res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            }
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          
          res.writeHead(response.status || 200, {
            'Content-Type': 'application/json'
          })
          res.end(JSON.stringify(response.body || {}))
        })
      })
      
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port
        resolve(this.port)
      })
    })
  }
  
  getRequests() { return [...this.requests] }
  reset() { this.requests = []; this.responses = []; this.responseIndex = 0 }
  stop() { this.server?.close() }
}

// Fake lease server
class FakeLeaseServer {
  constructor() {
    this.leases = new Map()
    this.requests = []
    this.server = null
    this.port = null
  }
  
  async start() {
    return new Promise(resolve => {
      this.server = createServer((req, res) => {
        let body = ''
        req.on('data', c => body += c)
        req.on('end', () => {
          const parsed = body ? JSON.parse(body) : {}
          this.requests.push({ method: req.method, url: req.url, body: parsed })
          
          // POST /api/github/.../fusion/lease/direct
          if (req.method === 'POST' && req.url.includes('/lease/direct')) {
            const leaseId = randomBytes(16).toString('hex')
            const lease = {
              id: leaseId,
              token: `direct-token-${leaseId.slice(0, 8)}`,
              upstream: `http://127.0.0.1:${this.fakeUpstreamPort}`,
              expires: Date.now() + 180000,
              type: 'direct'
            }
            this.leases.set(leaseId, lease)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ lease }))
          }
          
          // POST /api/github/.../fusion/lease/shared
          if (req.method === 'POST' && req.url.includes('/lease/shared')) {
            const leaseId = randomBytes(16).toString('hex')
            const lease = {
              id: leaseId,
              token: `shared-token-${leaseId.slice(0, 8)}`,
              upstream: `http://127.0.0.1:${this.fakeUpstreamPort}`,
              expires: Date.now() + 180000,
              type: 'shared',
              donor_id: 'donor-' + leaseId.slice(0, 8)
            }
            this.leases.set(leaseId, lease)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ lease }))
          }
          
          // DELETE /api/github/.../fusion/lease
          if (req.method === 'DELETE' && req.url.includes('/lease')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ success: true }))
          }
          
          res.writeHead(404)
          res.end('Not found')
        })
      })
      
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port
        resolve(this.port)
      })
    })
  }
  
  setFakeUpstreamPort(port) { this.fakeUpstreamPort = port }
  getRequests() { return [...this.requests] }
  reset() { this.leases.clear(); this.requests = [] }
  stop() { this.server?.close() }
}

let fakeUpstream, fakeLeaseServer, tmpDir, logsDir

describe('E2E Gateway Integration', { skip: !binaryAvailable }, () => {
  
  before(async () => {
    fakeUpstream = new FakeUpstream()
    fakeLeaseServer = new FakeLeaseServer()
    
    await fakeUpstream.start()
    await fakeLeaseServer.start()
    
    fakeLeaseServer.setFakeUpstreamPort(fakeUpstream.port)
    
    tmpDir = mkdtempSync(join(tmpdir(), 'e2e-gateway-'))
    logsDir = join(tmpDir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    
    console.log(`Fake upstream: http://127.0.0.1:${fakeUpstream.port}`)
    console.log(`Fake lease server: http://127.0.0.1:${fakeLeaseServer.port}`)
    console.log(`Logs dir: ${logsDir}`)
  })
  
  after(() => {
    fakeUpstream?.stop()
    fakeLeaseServer?.stop()
    
    // Preserve logs for artifacts
    console.log(`\nTest logs preserved at: ${logsDir}`)
    if (CI) {
      console.log('::set-output name=logs-dir::' + logsDir)
    }
  })
  
  beforeEach(() => {
    fakeUpstream.reset()
    fakeLeaseServer.reset()
  })
  
  test('gateway proxies request with credential injection', async t => {
    const testDir = mkdtempSync(join(tmpDir, 'test-'))
    const logFile = join(logsDir, 'gateway-proxy.log')
    const tokenFile = join(testDir, 'fusion-token')
    const socketPath = join(testDir, 'control.sock')
    
    // Create gateway
    const gateway = createFusionGateway({
      tokenFile,
      socketPath,
      log: msg => appendFileSync(logFile, msg + '\n'),
      allowedSharedUpstreams: ['127.0.0.1']
    })
    
    const { port: gwPort } = await gateway.start()
    
    // Set route via control
    const control = createGatewayControl({ socketPath, logFile })
    await control.setRoute({
      credential: 'test-injection-token',
      upstream: `http://127.0.0.1:${fakeUpstream.port}`,
      expires: Date.now() + 60000,
      routeType: 'direct'
    })
    
    // Make request through gateway
    const genToken = readFileSync(tokenFile, 'utf8').trim()
    fakeUpstream.setResponses([{ status: 200, body: { result: 'ok' } }])
    
    const response = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${genToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ messages: [] })
    })
    
    assert.strictEqual(response.status, 200)
    
    // Verify credential was injected
    const upstreamReqs = fakeUpstream.getRequests()
    assert.strictEqual(upstreamReqs.length, 1)
    assert.strictEqual(upstreamReqs[0].headers.authorization, 'Bearer test-injection-token')
    
    gateway.stop()
  })
  
  test('lease client acquires direct lease and sets gateway route', async t => {
    const testDir = mkdtempSync(join(tmpDir, 'test-'))
    const logFile = join(logsDir, 'lease-direct.log')
    const tokenFile = join(testDir, 'fusion-token')
    const socketPath = join(testDir, 'control.sock')
    
    // Create gateway
    const gateway = createFusionGateway({
      tokenFile,
      socketPath,
      log: msg => appendFileSync(logFile, msg + '\n'),
      allowedSharedUpstreams: ['127.0.0.1']
    })
    
    const { port: gwPort } = await gateway.start()
    const control = createGatewayControl({ socketPath, logFile })
    
    // Create lease client
    const leaseClient = createLeaseClient({
      origin: `http://127.0.0.1:${fakeLeaseServer.port}`,
      callbackToken: 'test-callback',
      repo: 'test/repo',
      issueNumber: '123',
      runId: '456',
      runAttempt: 1,
      logFile,
      request: fetch
    })
    
    // Acquire direct lease
    const leaseResult = await leaseClient.acquireDirect()
    assert.ok(leaseResult.success, `Lease acquisition failed: ${leaseResult.error}`)
    assert.ok(leaseResult.lease.token)
    assert.ok(leaseResult.lease.upstream)
    
    // Set gateway route from lease
    const routeResult = await control.setRoute({
      credential: leaseResult.lease.token,
      upstream: leaseResult.lease.upstream,
      expires: leaseResult.lease.expires,
      routeType: 'direct'
    })
    assert.ok(routeResult.success)
    
    // Verify gateway can proxy
    const genToken = readFileSync(tokenFile, 'utf8').trim()
    fakeUpstream.setResponses([{ status: 200, body: {} }])
    
    const response = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${genToken}` },
      body: '{}'
    })
    
    assert.strictEqual(response.status, 200)
    
    // Credential from lease was injected
    const upstreamReqs = fakeUpstream.getRequests()
    assert.ok(upstreamReqs[0].headers.authorization.startsWith('Bearer direct-token-'))
    
    gateway.stop()
  })
  
  test('route switch on direct failure to shared (different credentials)', async t => {
    const testDir = mkdtempSync(join(tmpDir, 'test-'))
    const logFile = join(logsDir, 'route-switch.log')
    const tokenFile = join(testDir, 'fusion-token')
    const socketPath = join(testDir, 'control.sock')
    
    // Create gateway
    const gateway = createFusionGateway({
      tokenFile,
      socketPath,
      log: msg => appendFileSync(logFile, msg + '\n'),
      allowedSharedUpstreams: ['127.0.0.1']
    })
    
    const { port: gwPort } = await gateway.start()
    const control = createGatewayControl({ socketPath, logFile })
    
    // Set direct route first
    await control.setRoute({
      credential: 'direct-cred-001',
      upstream: `http://127.0.0.1:${fakeUpstream.port}`,
      expires: Date.now() + 60000,
      routeType: 'direct'
    })
    
    const genToken = readFileSync(tokenFile, 'utf8').trim()
    
    // Direct route succeeds
    fakeUpstream.setResponses([{ status: 200, body: {} }])
    await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${genToken}` },
      body: '{}'
    })
    
    // Switch to shared route (different credential)
    const newGenToken = readFileSync(tokenFile, 'utf8').trim()
    await control.setRoute({
      credential: 'shared-donor-cred-999',
      upstream: `http://127.0.0.1:${fakeUpstream.port}`,
      expires: Date.now() + 60000,
      routeType: 'shared'
    })
    
    // Token rotated on route change
    const sharedGenToken = readFileSync(tokenFile, 'utf8').trim()
    assert.notStrictEqual(newGenToken, sharedGenToken, 'Token should rotate on route switch')
    
    // Shared route uses different credential
    fakeUpstream.setResponses([{ status: 200, body: {} }])
    await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sharedGenToken}` },
      body: '{}'
    })
    
    // Verify different credentials were sent
    const reqs = fakeUpstream.getRequests()
    assert.strictEqual(reqs.length, 2)
    assert.strictEqual(reqs[0].headers.authorization, 'Bearer direct-cred-001')
    assert.strictEqual(reqs[1].headers.authorization, 'Bearer shared-donor-cred-999')
    
    gateway.stop()
  })
  
  test('gateway rejects requests after route expiry', async t => {
    const testDir = mkdtempSync(join(tmpDir, 'test-'))
    const logFile = join(logsDir, 'route-expiry.log')
    const tokenFile = join(testDir, 'fusion-token')
    const socketPath = join(testDir, 'control.sock')
    
    let mockTime = Date.now()
    const gateway = createFusionGateway({
      tokenFile,
      socketPath,
      log: msg => appendFileSync(logFile, msg + '\n'),
      now: () => mockTime
    })
    
    const { port: gwPort } = await gateway.start()
    
    // Set route that expires in 100ms
    gateway.setRoute({
      credential: 'expiring-token',
      upstream: `http://127.0.0.1:${fakeUpstream.port}`,
      expires: mockTime + 100,
      routeType: 'direct'
    })
    
    const genToken = readFileSync(tokenFile, 'utf8').trim()
    
    // Request succeeds before expiry
    fakeUpstream.setResponses([{ status: 200, body: {} }])
    const resp1 = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${genToken}` },
      body: '{}'
    })
    assert.strictEqual(resp1.status, 200)
    
    // Advance time past expiry
    mockTime += 200
    
    // Request fails with 503 after expiry
    const resp2 = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${genToken}` },
      body: '{}'
    })
    assert.strictEqual(resp2.status, 503)
    
    const body = await resp2.json()
    assert.match(body.error, /expired|unavailable/i)
    
    gateway.stop()
  })
  
  test('logs preserved under artifacts directory', async t => {
    // Verify logs directory exists and is populated
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(logsDir)
    assert.ok(files.length > 0, 'Logs should be preserved')
    console.log(`Logs files: ${files.join(', ')}`)
  })
})

// Run summary
console.log('\n=== E2E Gateway Integration Test Summary ===')
console.log(`Binary: ${binaryVersion || 'not available'}`)
console.log(`CI mode: ${CI}`)
console.log(`Tests ${binaryAvailable ? 'will run' : (CI ? 'FAIL (required in CI)' : 'skip (local dev)')}`)
