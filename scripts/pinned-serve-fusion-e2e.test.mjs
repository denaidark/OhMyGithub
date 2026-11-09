#!/usr/bin/env node
/**
 * REAL Pinned OpenCode v2.2.5 + Fusion Plugin E2E Smoke Test
 * 
 * This test ACTUALLY EXECUTES:
 * 1. Installs Fusion plugin from production-verified commit via git clone
 * 2. Starts fusion-gateway with fake upstream
 * 3. Starts OpenCode v2.2.5 serve with plugin loaded
 * 4. Creates actual session via API
 * 5. Sets model
 * 6. Posts prompt
 * 7. Consumes SSE until terminal event
 * 8. Verifies fake upstream received request through gateway/plugin
 * 
 * PINNED VERSIONS (production workflow):
 * - OPENCODE_VERSION: 2.2.5
 * - FUSION_PLUGIN_COMMIT: 8275beda04bbfaa395c073a6b83f89c93801bca2
 * 
 * CI: FAIL not skip when binary unavailable
 * Bounded timeout: 60s per test, clean PID shutdown
 */

import { describe, test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, spawnSync, execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, appendFileSync, chmodSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createConnection } from 'node:net'

const __dirname = dirname(fileURLToPath(import.meta.url))

// === PINNED VERSIONS (from production workflow) ===
const OPENCODE_VERSION = '2.2.5'
const FUSION_PLUGIN_REPO = 'https://github.com/denaidark/opencode-copilot-fusion.git'
const FUSION_PLUGIN_COMMIT = '8275beda04bbfaa395c073a6b83f89c93801bca2'
const OPENCODE_BIN = process.env.OPENCODE_BIN || `${process.env.HOME}/.opencode/bin/opencode`
const CI = process.env.CI === 'true'
const TEST_TIMEOUT_MS = 60000

// === Binary availability check ===
let binaryAvailable = false
let binaryVersion = ''
try {
  binaryVersion = execSync(`${OPENCODE_BIN} --version`, { encoding: 'utf8', timeout: 5000 }).trim()
  binaryAvailable = binaryVersion === `opencode v${OPENCODE_VERSION}`
  if (!binaryAvailable) {
    console.error(`Expected opencode v${OPENCODE_VERSION}, got: ${binaryVersion}`)
  }
} catch (err) {
  console.error(`OpenCode binary check failed: ${err.message}`)
}

if (CI && !binaryAvailable) {
  console.error(`FATAL: OpenCode v${OPENCODE_VERSION} binary not available in CI`)
  console.error(`OPENCODE_BIN=${OPENCODE_BIN}`)
  console.error(`Tests MUST fail, not skip.`)
  process.exit(1)
}

console.log(`\n=== Pinned OpenCode + Fusion Plugin E2E ===`)
console.log(`Binary: ${binaryVersion || 'unavailable'}`)
console.log(`Binary path: ${OPENCODE_BIN}`)
console.log(`Plugin repo: ${FUSION_PLUGIN_REPO}`)
console.log(`Plugin commit: ${FUSION_PLUGIN_COMMIT}`)
console.log(`CI: ${CI}`)
console.log(`Binary available: ${binaryAvailable}`)
console.log(``)

// === Fake Copilot Upstream ===
class FakeCopilotUpstream {
  constructor(logFile) {
    this.requests = []
    this.server = null
    this.port = null
    this.logFile = logFile
  }
  
  log(msg) {
    const line = `[fake-upstream] ${new Date().toISOString()} ${msg}`
    console.log(line)
    if (this.logFile) appendFileSync(this.logFile, line + '\n')
  }
  
  async start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        let body = ''
        req.on('data', c => body += c)
        req.on('end', () => {
          const record = {
            method: req.method,
            url: req.url,
            headers: { ...req.headers },
            body: body || null,
            timestamp: Date.now()
          }
          // Sanitize: remove auth header value for logging
          const sanitized = { ...record, headers: { ...record.headers } }
          if (sanitized.headers.authorization) {
            sanitized.headers.authorization = sanitized.headers.authorization.replace(/Bearer .+/, 'Bearer [REDACTED]')
          }
          this.log(`Request: ${record.method} ${record.url}`)
          this.requests.push(record)
          
          // Handle /auto (session token creation) - Copilot /auto format
          if (req.url === '/auto' || req.url === '/v1/auto') {
            const sessionToken = `tok_fake_${Date.now()}`
            this.log(`/auto: returning session_token=${sessionToken.slice(0, 15)}...`)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({
              session_token: sessionToken,
              // Copilot /auto returns selected_model object (not just model string)
              selected_model: {
                id: 'claude-sonnet-4',
                supported_endpoints: ['/responses', '/chat/completions'],
                capabilities: {
                  limits: { max_output_tokens: 8192 },
                  supports: { vision: true }
                }
              },
              expires_at: Math.floor((Date.now() + 3600000) / 1000)
            }))
          }
          
          // Handle /models
          if (req.url === '/models' || req.url === '/v1/models') {
            this.log(`/models: returning model list`)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({
              models: [{ id: 'copilot-fusion-direct/fusion', name: 'Copilot Fusion' }]
            }))
          }
          
          // Handle /chat/completions (streaming)
          if (req.url === '/chat/completions' || req.url === '/v1/chat/completions') {
            this.log(`/chat/completions: streaming response`)
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache'
            })
            
            // Simulated streaming response
            const chunks = [
              { choices: [{ delta: { role: 'assistant' }, index: 0 }] },
              { choices: [{ delta: { content: 'Hello ' }, index: 0 }] },
              { choices: [{ delta: { content: 'from ' }, index: 0 }] },
              { choices: [{ delta: { content: 'fake upstream!' }, index: 0 }] },
              { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }
            ]
            
            let i = 0
            const sendNext = () => {
              if (i < chunks.length) {
                res.write(`data: ${JSON.stringify(chunks[i])}\n\n`)
                i++
                setTimeout(sendNext, 10)
              } else {
                res.write('data: [DONE]\n\n')
                res.end()
                this.log(`/chat/completions: streaming complete`)
              }
            }
            sendNext()
            return
          }
          
          // Handle /responses (OpenCode OpenAI Responses format)
          // Based on OpenCode's test fixtures: HTTP SSE uses `data:` only with `type` in JSON
          // Event types: response.created, response.output_item.added, response.output_text.delta,
          // response.output_item.done, response.completed
          if (req.url === '/responses' || req.url === '/v1/responses') {
            this.log(`/responses: streaming response (OpenCode Responses format)`)
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache'
            })
            
            const responseId = `resp_${Date.now()}`
            const itemId = `msg_${Date.now()}`
            // OpenCode Responses API format (from OpenCode test fixtures)
            const item = {
              type: 'message',
              id: itemId,
              role: 'assistant',
              content: [{ type: 'output_text', text: 'test passed' }]
            }
            const events = [
              { type: 'response.created', response: { id: responseId } },
              { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
              { type: 'response.output_text.delta', item_id: itemId, delta: 'test passed' },
              { type: 'response.output_item.done', output_index: 0, item },
              { type: 'response.completed', response: { id: responseId, output: [item] } }
            ]
            
            let i = 0
            const sendNext = () => {
              if (i < events.length) {
                // OpenCode HTTP SSE: data: only, no event: line
                res.write(`data: ${JSON.stringify(events[i])}\n\n`)
                i++
                setTimeout(sendNext, 10)
              } else {
                res.end()
                this.log(`/responses: streaming complete`)
              }
            }
            sendNext()
            return
          }
          
          this.log(`404: ${req.url}`)
          res.writeHead(404)
          res.end('Not found')
        })
      })
      
      this.server.on('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port
        this.log(`Started on port ${this.port}`)
        resolve(this.port)
      })
    })
  }
  
  getRequests() { return [...this.requests] }
  getRequestsWithAuth() {
    return this.requests.filter(r => r.headers.authorization)
  }
  reset() { this.requests = [] }
  stop() { 
    this.server?.close()
    this.log(`Stopped`)
  }
}

// === Process management ===
const activeProcesses = new Set()

function registerProcess(proc, name) {
  activeProcesses.add({ proc, name })
  proc.on('exit', () => activeProcesses.delete({ proc, name }))
}

async function killAllProcesses() {
  for (const { proc, name } of activeProcesses) {
    console.log(`Killing process: ${name} (PID ${proc.pid})`)
    proc.kill('SIGTERM')
    await new Promise(r => {
      const timer = setTimeout(() => { proc.kill('SIGKILL'); r() }, 2000)
      proc.on('exit', () => { clearTimeout(timer); r() })
    })
  }
  activeProcesses.clear()
}

// === Test state ===
let testDir, logsDir, fakeUpstream

// === Test Suite ===
describe('REAL Pinned E2E: OpenCode v2.2.5 + Fusion Plugin', { skip: !binaryAvailable, timeout: TEST_TIMEOUT_MS * 3 }, () => {
  
  before(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'real-pinned-e2e-'))
    logsDir = join(testDir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    
    console.log(`Test directory: ${testDir}`)
    console.log(`Logs directory: ${logsDir}`)
    
    // Start fake upstream
    fakeUpstream = new FakeCopilotUpstream(join(logsDir, 'fake-upstream.log'))
    await fakeUpstream.start()
    console.log(`Fake upstream: http://127.0.0.1:${fakeUpstream.port}`)
  })
  
  after(async () => {
    await killAllProcesses()
    fakeUpstream?.stop()
    
    // Print logs location
    console.log(`\n=== Test Logs ===`)
    console.log(`Location: ${logsDir}`)
    try {
      const files = execSync(`ls -la ${logsDir}`, { encoding: 'utf8' })
      console.log(files)
    } catch {}
  })
  
  afterEach(async () => {
    await killAllProcesses()
    fakeUpstream?.reset()
  })
  
  test('EXECUTE: serve + gateway + plugin → fake upstream receives request', async (t) => {
    const runDir = mkdtempSync(join(testDir, 'run-'))
    
    // Initialize as git repo (OpenCode may require this)
    execSync('git init', { cwd: runDir, stdio: 'ignore' })
    execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: runDir, stdio: 'ignore' })
    
    const logFile = join(logsDir, 'full-e2e.log')
    const log = msg => {
      const line = `[test] ${new Date().toISOString()} ${msg}`
      console.log(line)
      appendFileSync(logFile, line + '\n')
    }
    
    writeFileSync(logFile, `=== REAL E2E Test Started ===\n`)
    log(`Run directory: ${runDir}`)
    log(`OpenCode binary: ${OPENCODE_BIN}`)
    log(`OpenCode version: ${OPENCODE_VERSION}`)
    log(`Plugin commit: ${FUSION_PLUGIN_COMMIT}`)
    
    // === Step 1: Create config directory and base config ===
    // With XDG_CONFIG_HOME=runDir, OpenCode looks for config at {runDir}/opencode/opencode.json
    const configDir = join(runDir, 'opencode')
    mkdirSync(configDir, { recursive: true })
    
    // Base config WITHOUT plugin first (will add via jq)
    const baseConfig = {
      permission: { '*': 'allow' }
    }
    writeFileSync(join(configDir, 'opencode.json'), JSON.stringify(baseConfig, null, 2))
    log(`Base config written`)
    
    // === Step 2: Install Fusion plugin (same method as workflow) ===
    const pluginSpec = `git+${FUSION_PLUGIN_REPO}#${FUSION_PLUGIN_COMMIT}`
    log(`Installing plugin: ${pluginSpec}`)
    
    // Use jq to add plugin (same as workflow)
    const configPath = join(configDir, 'opencode.json')
    const configTmp = `${configPath}.tmp`
    
    try {
      execSync(`jq --arg plugin "${pluginSpec}" '.plugins = (((.plugins // []) + [$plugin]) | unique)' "${configPath}" > "${configTmp}" && mv "${configTmp}" "${configPath}"`, {
        encoding: 'utf8',
        timeout: 5000
      })
      log(`Plugin added to config via jq`)
    } catch (err) {
      log(`ERROR: jq failed: ${err.message}`)
      throw err
    }
    
    // Verify config
    const finalConfig = JSON.parse(readFileSync(configPath, 'utf8'))
    log(`Final config: ${JSON.stringify(finalConfig)}`)
    assert.ok(finalConfig.plugins?.includes(pluginSpec), 'Plugin should be in config')
    
    // Install plugin via opencode plugin add
    log(`Installing plugin via opencode plugin add (this may take a moment)...`)
    const installResult = spawnSync(OPENCODE_BIN, ['plugin', 'add', pluginSpec], {
      cwd: runDir,
      env: { ...process.env, HOME: runDir, XDG_DATA_HOME: runDir, XDG_CONFIG_HOME: runDir },
      encoding: 'utf8',
      timeout: 120000  // 2 minute timeout for git clone + npm install
    })
    if (installResult.stdout?.trim()) {
      log(`Plugin install stdout: ${installResult.stdout.trim().slice(0, 500)}`)
    }
    if (installResult.stderr?.trim()) {
      log(`Plugin install stderr: ${installResult.stderr.trim().slice(0, 500)}`)
    }
    if (installResult.status !== 0) {
      log(`WARNING: Plugin installation exited with code ${installResult.status}`)
      // Don't fail - the plugin might already be installed globally
    } else {
      log(`Plugin installed successfully`)
    }
    
    // === Step 3: Setup gateway files ===
    const tokenFile = join(runDir, 'fusion-token')
    const socketPath = join(runDir, 'fusion-control.sock')
    const gatewayLog = join(logsDir, 'gateway.log')
    
    // Generate token (same as start-fusion-gateway.sh)
    // Plugin expects JSON: { access_token: "..." }
    const generationToken = randomBytes(32).toString('hex')
    writeFileSync(tokenFile, JSON.stringify({ access_token: generationToken }))
    chmodSync(tokenFile, 0o600)
    log(`Generation token written to ${tokenFile}`)
    
    // === Step 4: Start gateway ===
    writeFileSync(gatewayLog, '')
    const gatewayProc = spawn('node', [
      join(__dirname, 'fusion-gateway-serve.mjs'),
      '--run-dir', runDir,
      '--token-file', tokenFile,
      '--socket-path', socketPath,
      '--shared-upstreams', '127.0.0.1'
    ], {
      cwd: runDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    
    registerProcess(gatewayProc, 'gateway')
    gatewayProc.stdout.on('data', c => appendFileSync(gatewayLog, `[stdout] ${c}`))
    gatewayProc.stderr.on('data', c => appendFileSync(gatewayLog, `[stderr] ${c}`))
    
    // Wait for socket
    log(`Waiting for gateway socket...`)
    let gatewayPort = null
    for (let i = 0; i < 50; i++) {
      if (existsSync(socketPath)) {
        log(`Gateway socket ready`)
        break
      }
      await new Promise(r => setTimeout(r, 100))
    }
    
    if (!existsSync(socketPath)) {
      const logs = readFileSync(gatewayLog, 'utf8')
      log(`ERROR: Gateway socket not available`)
      log(`Gateway logs:\n${logs}`)
      throw new Error('Gateway socket not available')
    }
    
    // Get gateway port from socket
    try {
      gatewayPort = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout getting gateway port')), 5000)
        const client = createConnection(socketPath)
        let data = ''
        
        client.on('error', err => {
          clearTimeout(timer)
          reject(err)
        })
        
        client.on('data', d => { 
          data += d.toString()
          // Try to parse on each chunk
          const lines = data.split('\n')
          for (const line of lines) {
            if (line.trim()) {
              try {
                const resp = JSON.parse(line)
                clearTimeout(timer)
                client.end()
                resolve(resp.port)
                return
              } catch {}
            }
          }
        })
        
        client.on('connect', () => {
          client.write(JSON.stringify({ action: 'status' }) + '\n')
        })
      })
      log(`Gateway port: ${gatewayPort}`)
    } catch (err) {
      log(`ERROR getting gateway port: ${err.message}`)
      // Try to read port from stdout capture
      const gwLog = readFileSync(join(logsDir, 'gateway.log'), 'utf8')
      const match = gwLog.match(/listening on port (\d+)/)
      if (match) {
        gatewayPort = parseInt(match[1], 10)
        log(`Gateway port from stdout: ${gatewayPort}`)
      } else {
        throw err
      }
    }
    
    // === Step 5: Set gateway route to fake upstream ===
    log(`Setting gateway route to fake upstream port ${fakeUpstream.port}`)
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout setting route')), 5000)
        const client = createConnection(socketPath)
        let data = ''
        
        client.on('error', err => {
          clearTimeout(timer)
          reject(err)
        })
        
        client.on('data', d => { 
          data += d.toString()
          const lines = data.split('\n')
          for (const line of lines) {
            if (line.trim()) {
              try {
                const resp = JSON.parse(line)
                clearTimeout(timer)
                client.end()
                if (resp.success) resolve(resp)
                else reject(new Error(resp.error || 'setRoute failed'))
                return
              } catch {}
            }
          }
        })
        
        client.on('connect', () => {
          client.write(JSON.stringify({
            action: 'set_route',  // Note: underscore
            credential: 'test-copilot-credential-e2e',
            upstream: `http://127.0.0.1:${fakeUpstream.port}`,
            expires: Date.now() + 300000,
            routeType: 'direct'
          }) + '\n')
        })
      })
      log(`Gateway route set successfully`)
      
      // Check gateway status after setting route
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout getting status')), 5000)
        const client = createConnection(socketPath)
        let data = ''
        
        client.on('error', err => {
          clearTimeout(timer)
          reject(err)
        })
        
        client.on('data', d => { 
          data += d.toString()
          const lines = data.split('\n')
          for (const line of lines) {
            if (line.trim()) {
              try {
                const resp = JSON.parse(line)
                clearTimeout(timer)
                client.end()
                log(`Gateway status: ${JSON.stringify(resp).slice(0, 200)}`)
                resolve(resp)
                return
              } catch {}
            }
          }
        })
        
        client.on('connect', () => {
          client.write(JSON.stringify({ action: 'status' }) + '\n')
        })
      })
    } catch (err) {
      log(`ERROR setting route: ${err.message}`)
      throw err
    }
    
    // Verify token file updated (now JSON format)
    const newTokenJson = readFileSync(tokenFile, 'utf8').trim()
    const newTokenData = JSON.parse(newTokenJson)
    const newToken = newTokenData.access_token
    log(`Token file after route set: ${newTokenJson.slice(0, 20)}...`)
    
    // === Diagnostic: Test gateway directly with allowed path ===
    log(`Testing gateway routing directly (using /v1/models)...`)
    try {
      const testResp = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${newToken}`
        },
        signal: AbortSignal.timeout(5000)
      })
      log(`Direct gateway test: ${testResp.status}`)
      const upstreamAfterTest = fakeUpstream.getRequests()
      log(`Fake upstream has ${upstreamAfterTest.length} requests after direct gateway test`)
      if (upstreamAfterTest.length > 0) {
        const lastReq = upstreamAfterTest[upstreamAfterTest.length - 1]
        log(`Last upstream request: ${lastReq.method} ${lastReq.url} auth=${lastReq.headers.authorization?.slice(0, 30)}...`)
      }
    } catch (err) {
      log(`Direct gateway test error: ${err.message}`)
    }
    
    // Clear request count - we only want to count requests from OpenCode serve
    fakeUpstream.reset()
    log(`Cleared fake upstream requests - starting fresh for serve phase`)

    // === Step 6: Start OpenCode serve ===
    const password = 'test-password-' + randomBytes(8).toString('hex')
    const serveLog = join(logsDir, 'serve.log')
    writeFileSync(serveLog, '')
    
    // Find free port for serve
    const servePort = await new Promise((resolve, reject) => {
      const s = createServer()
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port
        s.close(() => resolve(p))
      })
      s.on('error', reject)
    })
    
    log(`Starting OpenCode serve on port ${servePort}`)
    log(`Environment: FUSION_UPSTREAM=http://127.0.0.1:${gatewayPort}, FUSION_TOKEN_FILE=${tokenFile}`)
    
    // Run with --print-logs to see plugin loading
    const serveProc = spawn(OPENCODE_BIN, ['serve', '--port', String(servePort), '--print-logs', '--log-level', 'debug'], {
      cwd: runDir,
      env: {
        ...process.env,
        HOME: runDir,
        XDG_CONFIG_HOME: runDir,  // Config at {runDir}/opencode/opencode.json
        XDG_DATA_HOME: runDir,    // Data at {runDir}/opencode/...
        XDG_CACHE_HOME: runDir,   // Cache at {runDir}/.cache/... (where plugin was installed)
        OPENCODE_PASSWORD: password,
        FUSION_UPSTREAM: `http://127.0.0.1:${gatewayPort}`,
        FUSION_TOKEN_FILE: tokenFile
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    
    registerProcess(serveProc, 'serve')
    serveProc.stdout.on('data', c => {
      const text = c.toString()
      appendFileSync(serveLog, `[stdout] ${text}`)
    })
    serveProc.stderr.on('data', c => {
      const text = c.toString()
      appendFileSync(serveLog, `[stderr] ${text}`)
    })
    
    // Wait for serve to be ready
    log(`Waiting for serve to be ready...`)
    let serveReady = false
    const auth = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')
    
    for (let i = 0; i < 60; i++) {
      try {
        const resp = await fetch(`http://127.0.0.1:${servePort}/api/session`, {
          headers: { 'Authorization': auth },
          signal: AbortSignal.timeout(2000)
        })
        if (resp.ok) {
          serveReady = true
          log(`Serve ready after ${i * 500}ms`)
          break
        }
      } catch {}
      await new Promise(r => setTimeout(r, 500))
    }
    
    if (!serveReady) {
      const logs = readFileSync(serveLog, 'utf8')
      log(`ERROR: Serve not ready after 30s`)
      log(`Serve logs:\n${logs}`)
      throw new Error('Serve not ready')
    }
    
    // Wait for plugin to load (check for copilot-fusion-direct provider)
    log(`Waiting for plugin to register copilot-fusion-direct provider...`)
    let providerFound = false
    for (let i = 0; i < 20; i++) {
      try {
        const resp = await fetch(`http://127.0.0.1:${servePort}/api/provider`, {
          headers: { 'Authorization': auth },
          signal: AbortSignal.timeout(2000)
        })
        if (resp.ok) {
          const data = await resp.json()
          const providers = data.data || data
          const fusionProvider = (Array.isArray(providers) ? providers : [])
            .find(p => p.id === 'copilot-fusion-direct')
          if (fusionProvider) {
            providerFound = true
            log(`Plugin provider registered after ${i * 500}ms`)
            break
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 500))
    }
    
    if (!providerFound) {
      log(`WARNING: copilot-fusion-direct provider not found after 10s, proceeding anyway`)
      // Try listing available providers
      try {
        const resp = await fetch(`http://127.0.0.1:${servePort}/api/provider`, {
          headers: { 'Authorization': auth },
          signal: AbortSignal.timeout(2000)
        })
        const data = await resp.json()
        log(`Available providers: ${JSON.stringify(data).slice(0, 300)}`)
      } catch {}
    }
    
    // === Step 7: Create session ===
    log(`Creating session...`)
    let sessionId
    try {
      const resp = await fetch(`http://127.0.0.1:${servePort}/api/session`, {
        method: 'POST',
        headers: { 
          'Authorization': auth,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      })
      const data = await resp.json()
      // OpenCode v2 wraps response in { data: { id: ... } }
      sessionId = data.data?.id || data.id || data.sessionId || data.session_id
      if (!sessionId) {
        log(`Session response: ${JSON.stringify(data)}`)
        throw new Error('No session ID in response')
      }
      log(`Session created: ${sessionId}`)
    } catch (err) {
      log(`ERROR creating session: ${err.message}`)
      throw err
    }
    
    // === Step 8: Set model ===
    // OpenCode v2 expects model as { providerID, id } object
    const modelRef = { providerID: 'copilot-fusion-direct', id: 'fusion' }
    log(`Setting model to ${JSON.stringify(modelRef)}...`)
    let modelSetOk = false
    const modelResp = await fetch(`http://127.0.0.1:${servePort}/api/session/${sessionId}/model`, {
      method: 'POST',
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: modelRef })
    })
    if (!modelResp.ok) {
      const text = await modelResp.text()
      log(`Set model FAILED: ${modelResp.status} ${text}`)
      throw new Error(`setModel failed: ${modelResp.status} ${text}`)
    } else {
      modelSetOk = true
      log(`Model set successfully`)
    }
    
    // === Step 9: Execute prompt via opencode run --server ===
    // The HTTP API only queues prompts; actual execution requires `opencode run`
    const modelArg = 'copilot-fusion-direct/fusion'
    const promptText = 'Say "test passed" and nothing else.'
    
    log(`Executing via opencode run --server (model=${modelArg})...`)
    
    let terminalReceived = false
    let runExitCode = null
    let responseContent = null
    let runError = null
    
    // Start opencode run and wait for completion (with bounded timeout)
    const runResult = await new Promise((resolve, reject) => {
      const runLogLines = []
      const runLog = join(logsDir, 'opencode-run.log')
      
      const runProc = spawn(OPENCODE_BIN, [
        'run',
        '--server', `http://127.0.0.1:${servePort}`,
        '--session', sessionId,
        '--model', modelArg,
        '--format', 'json',
        '--auto',
        promptText
      ], {
        cwd: runDir,
        env: {
          ...process.env,
          HOME: runDir,
          XDG_CONFIG_HOME: runDir,
          XDG_DATA_HOME: runDir,
          XDG_CACHE_HOME: runDir,
          OPENCODE_PASSWORD: password,
          FUSION_UPSTREAM: `http://127.0.0.1:${gatewayPort}`,
          FUSION_TOKEN_FILE: tokenFile
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      
      const timeout = setTimeout(() => {
        runProc.kill('SIGTERM')
        reject(new Error('opencode run timeout (30s)'))
      }, 30000)
      
      runProc.stdout.on('data', c => {
        const text = c.toString()
        runLogLines.push(`[stdout] ${text}`)
        appendFileSync(runLog, `[stdout] ${text}`)
        
        // Check for JSON output indicating completion
        // OpenCode CLI JSON output includes various message types
        try {
          for (const line of text.split('\n').filter(l => l.trim())) {
            const json = JSON.parse(line.trim())
            // Track terminal event types (OpenCode CLI JSON format)
            // step_finish with reason "stop" indicates successful completion
            if (json.type === 'step_finish' && json.part?.reason === 'stop') {
              terminalReceived = true
              log(`Run output (terminal): step_finish reason=stop`)
            }
            // Extract actual content from text events
            if (json.type === 'text' && json.part?.text) {
              responseContent = json.part.text
              log(`Run output (content): ${responseContent}`)
            }
            // Legacy terminal types for backward compatibility
            if (json.type === 'assistant' || json.type === 'result' || 
                json.type === 'done' || json.type === 'complete') {
              terminalReceived = true
              if (json.content) responseContent = json.content
              if (json.text) responseContent = json.text
              log(`Run output (terminal): type=${json.type}`)
            }
            // Check for errors in the output
            if (json.type === 'error' || json.error) {
              runError = json.error || json.message || 'Unknown run error'
              log(`Run ERROR: ${runError}`)
            }
          }
        } catch {}
      })
      
      runProc.stderr.on('data', c => {
        const text = c.toString()
        runLogLines.push(`[stderr] ${text}`)
        appendFileSync(runLog, `[stderr] ${text}`)
        // Track stderr errors
        if (text.includes('error') || text.includes('Error') || text.includes('ERROR')) {
          log(`Run stderr: ${text.slice(0, 200)}`)
        }
      })
      
      runProc.on('close', code => {
        clearTimeout(timeout)
        runExitCode = code  // Don't mask with || 0
        log(`opencode run exited with code ${code}`)
        if (runLogLines.length > 0) {
          log(`Run log excerpt: ${runLogLines.slice(-3).join('').slice(0, 200)}`)
        }
        resolve({ code, log: runLogLines, error: runError })
      })
      
      runProc.on('error', err => {
        clearTimeout(timeout)
        reject(err)
      })
    })
    
    log(`opencode run completed: code=${runResult.code}, error=${runResult.error || 'none'}`)
    
    // === Step 11: Verify fake upstream received request ===
    log(`\n=== Verification ===`)
    const upstreamRequests = fakeUpstream.getRequests()
    log(`Fake upstream received ${upstreamRequests.length} requests`)
    
    for (const req of upstreamRequests) {
      log(`  ${req.method} ${req.url} (auth: ${req.headers.authorization ? 'yes' : 'no'})`)
    }
    
    // Check for any request with our credential - MUST have at least one
    const authRequests = upstreamRequests.filter(r => 
      r.headers.authorization?.includes('test-copilot-credential-e2e')
    )
    log(`Requests with injected credential: ${authRequests.length}`)
    
    // === Final Summary ===
    log(`\n=== Summary ===`)
    log(`OpenCode version: ${binaryVersion}`)
    log(`Plugin commit: ${FUSION_PLUGIN_COMMIT}`)
    log(`Session ID: ${sessionId}`)
    log(`Model set OK: ${modelSetOk}`)
    log(`Run exit code: ${runExitCode}`)
    log(`Run error: ${runError || 'none'}`)
    log(`Terminal event received: ${terminalReceived}`)
    log(`Response content: ${responseContent ? responseContent.slice(0, 100) : 'none'}`)
    log(`Upstream requests: ${upstreamRequests.length}`)
    log(`Auth requests: ${authRequests.length}`)
    
    // Write receipts
    const receipts = {
      timestamp: new Date().toISOString(),
      opencode_version: OPENCODE_VERSION,
      opencode_binary: OPENCODE_BIN,
      binary_check: binaryVersion,
      fusion_plugin_commit: FUSION_PLUGIN_COMMIT,
      session_id: sessionId,
      model_set_ok: modelSetOk,
      run_exit_code: runExitCode,
      run_error: runError,
      terminal_received: terminalReceived,
      response_content: responseContent ? responseContent.slice(0, 500) : null,
      upstream_requests: upstreamRequests.length,
      auth_requests: authRequests.length,
      gateway_port: gatewayPort,
      serve_port: servePort
    }
    writeFileSync(join(logsDir, 'receipts.json'), JSON.stringify(receipts, null, 2))
    log(`Receipts written to ${join(logsDir, 'receipts.json')}`)
    
    // === FAIL-CLOSED ASSERTIONS ===
    // Every assertion must pass - no soft OR conditions
    
    // 1. Session must be created
    assert.ok(sessionId, 'Session MUST be created')
    
    // 2. Model must be set successfully
    assert.ok(modelSetOk, 'Model MUST be set successfully')
    
    // 3. opencode run must exit with code 0
    assert.strictEqual(runExitCode, 0, `opencode run MUST exit 0, got ${runExitCode}`)
    
    // 4. No run errors
    assert.ok(!runError, `opencode run MUST NOT have errors: ${runError}`)
    
    // 5. Upstream MUST receive at least one request with injected credential
    assert.ok(authRequests.length > 0, 
      `Upstream MUST receive request with injected credential (got ${authRequests.length})`)
    
    // 6. Terminal event MUST be received (proof of completion)
    assert.ok(terminalReceived, 'Terminal event MUST be received')
    
    log(`\n=== TEST PASSED (all fail-closed assertions satisfied) ===`)
  })
})

// === Summary test (always runs) ===
describe('E2E Summary', () => {
  test('version and SHA report', () => {
    console.log(`\n=== Version Report ===`)
    console.log(`OPENCODE_VERSION=${OPENCODE_VERSION}`)
    console.log(`OPENCODE_BIN=${OPENCODE_BIN}`)
    console.log(`FUSION_PLUGIN_REPO=${FUSION_PLUGIN_REPO}`)
    console.log(`FUSION_PLUGIN_COMMIT=${FUSION_PLUGIN_COMMIT}`)
    console.log(`BINARY_AVAILABLE=${binaryAvailable}`)
    console.log(`BINARY_VERSION=${binaryVersion}`)
    console.log(`CI=${CI}`)
  })
})
