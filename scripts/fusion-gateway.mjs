#!/usr/bin/env node
/**
 * Fusion Gateway - Fixed loopback proxy for OpenCode Copilot Fusion plugin.
 * 
 * Architecture:
 * - Listens on 127.0.0.1:random_port for plugin HTTP requests
 * - Control channel via Unix socket (0600) for route/credential management
 * - Holds actual route credential in memory (not exposed to plugin)
 * - Plugin uses FUSION_TOKEN_FILE (generation token) + FUSION_UPSTREAM (gateway)
 * - Atomic token file rotation clears plugin session cache
 * 
 * Security:
 * - Strip incoming Authorization/copilot-session-token before upstream
 * - Inject real credential only at gateway
 * - Path allowlist: /auto, /models, /responses (plugin paths only)
 * - Upstream allowlist (no SSRF)
 * - Per-run random generation token authentication
 */

import { createServer } from 'node:http'
import { createServer as createUnixServer, createConnection } from 'node:net'
import { randomBytes, createHash } from 'node:crypto'
import { writeFileSync, unlinkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

// Allowed upstream hosts (no SSRF)
const ALLOWED_UPSTREAMS = new Set([
  'api.githubcopilot.com',
  'api.individual.githubcopilot.com',
  'api.business.githubcopilot.com'
])

// Allowed plugin paths
const ALLOWED_PATHS = new Set(['/auto', '/models', '/responses', '/chat/completions'])

// Headers to strip from incoming requests (plugin shouldn't control these)
const STRIP_HEADERS = new Set([
  'authorization',
  'copilot-session-token',
  'x-github-token',
  'cookie'
])

// Sensitive headers to never forward
const SENSITIVE_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'
])

export function createFusionGateway({ 
  tokenFile,
  socketPath,
  now = Date.now,
  request = fetch,
  log = console.error
}) {
  // Gateway state
  let route = null  // { credential, upstream, expires }
  let generationToken = randomBytes(32).toString('base64url')
  let server = null
  let controlServer = null
  let port = 0
  
  // Write initial generation token to file
  function writeGenerationToken() {
    writeFileSync(tokenFile, generationToken, { mode: 0o600 })
    log(`[fusion-gateway] Generation token written to ${tokenFile}`)
  }
  
  // Rotate generation token (clears plugin cache)
  function rotateGenerationToken() {
    generationToken = randomBytes(32).toString('base64url')
    writeFileSync(tokenFile, generationToken, { mode: 0o600 })
    log(`[fusion-gateway] Generation token rotated`)
  }
  
  // Validate upstream URL
  function validateUpstream(url) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:') return false
      if (!ALLOWED_UPSTREAMS.has(parsed.host)) return false
      return true
    } catch { return false }
  }
  
  // Set route (called via control socket)
  function setRoute({ credential, upstream, expires }) {
    if (!credential || !upstream) {
      return { success: false, error: 'Missing credential or upstream' }
    }
    if (!validateUpstream(upstream)) {
      return { success: false, error: 'Invalid upstream URL' }
    }
    if (expires && expires < now()) {
      return { success: false, error: 'Route already expired' }
    }
    
    route = { credential, upstream, expires: expires || now() + 180000 }
    rotateGenerationToken()  // Clear plugin cache on route change
    log(`[fusion-gateway] Route set: upstream=${new URL(upstream).host} expires=${new Date(route.expires).toISOString()}`)
    return { success: true, expires: route.expires }
  }
  
  // Clear route
  function clearRoute(reason = 'cleared') {
    if (route) {
      log(`[fusion-gateway] Route cleared: reason=${reason}`)
      route = null
      rotateGenerationToken()
    }
    return { success: true }
  }
  
  // Get status
  function getStatus() {
    return {
      hasRoute: route !== null,
      expires: route?.expires,
      expired: route && route.expires < now(),
      port,
      generationTokenHash: createHash('sha256').update(generationToken).digest('hex').slice(0, 8)
    }
  }
  
  // Validate generation token from plugin
  function validateGenerationToken(authHeader) {
    const token = String(authHeader || '').replace(/^Bearer /i, '')
    return token === generationToken
  }
  
  // Handle HTTP request from plugin
  async function handleRequest(req, res) {
    const requestId = randomBytes(8).toString('hex')
    
    // Validate generation token
    if (!validateGenerationToken(req.headers.authorization)) {
      log(`[fusion-gateway] ${requestId} rejected: invalid generation token`)
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid gateway token' }))
      return
    }
    
    // Validate path
    const path = req.url.split('?')[0]
    if (!ALLOWED_PATHS.has(path)) {
      log(`[fusion-gateway] ${requestId} rejected: invalid path ${path}`)
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Path not allowed' }))
      return
    }
    
    // Check route availability
    if (!route) {
      log(`[fusion-gateway] ${requestId} rejected: no route configured`)
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'fusion_unavailable', code: 'no_route' }))
      return
    }
    
    // Check expiry
    if (route.expires < now()) {
      log(`[fusion-gateway] ${requestId} rejected: route expired`)
      clearRoute('expired')
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'fusion_unavailable', code: 'route_expired' }))
      return
    }
    
    // Build upstream headers (strip sensitive, inject real credential)
    const upstreamHeaders = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase()
      if (STRIP_HEADERS.has(lower) || SENSITIVE_HOP_HEADERS.has(lower)) continue
      upstreamHeaders[key] = value
    }
    
    // Inject real credential
    upstreamHeaders['authorization'] = `Bearer ${route.credential}`
    upstreamHeaders['host'] = new URL(route.upstream).host
    
    // Collect body for non-GET
    let body = null
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = []
      for await (const chunk of req) {
        chunks.push(chunk)
        // Body cap: 16MB
        if (chunks.reduce((s, c) => s + c.length, 0) > 16 * 1024 * 1024) {
          log(`[fusion-gateway] ${requestId} rejected: body too large`)
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Request body too large' }))
          return
        }
      }
      body = Buffer.concat(chunks)
    }
    
    // Proxy to upstream
    const upstreamUrl = `${route.upstream}${req.url}`
    log(`[fusion-gateway] ${requestId} ${req.method} ${path} -> ${new URL(route.upstream).host}`)
    
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 300000)  // 5min timeout
    
    // Cancel on client disconnect
    req.on('close', () => {
      if (!res.writableFinished) controller.abort()
    })
    
    try {
      const upstreamResponse = await request(upstreamUrl, {
        method: req.method,
        headers: upstreamHeaders,
        body,
        signal: controller.signal,
        redirect: 'error'
      })
      
      clearTimeout(timeout)
      
      // Forward response headers (strip sensitive)
      const responseHeaders = {}
      for (const [key, value] of upstreamResponse.headers.entries()) {
        const lower = key.toLowerCase()
        if (SENSITIVE_HOP_HEADERS.has(lower)) continue
        responseHeaders[key] = value
      }
      
      res.writeHead(upstreamResponse.status, responseHeaders)
      
      // Stream response body
      if (upstreamResponse.body) {
        const reader = upstreamResponse.body.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (!res.write(value)) {
              // Backpressure
              await new Promise(resolve => res.once('drain', resolve))
            }
          }
        } finally {
          reader.releaseLock()
        }
      }
      
      res.end()
      log(`[fusion-gateway] ${requestId} completed: status=${upstreamResponse.status}`)
      
    } catch (error) {
      clearTimeout(timeout)
      if (!res.headersSent) {
        const status = error.name === 'AbortError' ? 504 : 502
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Upstream error', code: error.name }))
      }
      log(`[fusion-gateway] ${requestId} error: ${error.name}`)
    }
  }
  
  // Handle control socket command
  function handleControl(line) {
    try {
      const cmd = JSON.parse(line)
      switch (cmd.action) {
        case 'set_route':
          return setRoute(cmd)
        case 'clear_route':
          return clearRoute(cmd.reason)
        case 'status':
          return getStatus()
        default:
          return { error: 'Unknown action' }
      }
    } catch (error) {
      return { error: 'Invalid command', details: error.message }
    }
  }
  
  // Start gateway
  async function start() {
    // Write initial generation token
    writeGenerationToken()
    
    // Start HTTP server
    server = createServer(handleRequest)
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port
        log(`[fusion-gateway] HTTP listening on 127.0.0.1:${port}`)
        resolve()
      })
      server.once('error', reject)
    })
    
    // Start control socket
    try { unlinkSync(socketPath) } catch {}
    controlServer = createUnixServer(socket => {
      let buffer = ''
      socket.on('data', chunk => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop()
        for (const line of lines) {
          if (line.trim()) {
            const result = handleControl(line)
            socket.write(JSON.stringify(result) + '\n')
          }
        }
      })
    })
    
    await new Promise((resolve, reject) => {
      controlServer.listen(socketPath, () => {
        chmodSync(socketPath, 0o600)
        log(`[fusion-gateway] Control socket at ${socketPath}`)
        resolve()
      })
      controlServer.once('error', reject)
    })
    
    return { port, socketPath, tokenFile }
  }
  
  // Stop gateway
  async function stop() {
    // Just clear state, don't try to rotate token (file may be deleted)
    route = null
    
    if (server) {
      await new Promise(resolve => server.close(resolve))
      server = null
    }
    
    if (controlServer) {
      await new Promise(resolve => controlServer.close(resolve))
      try { unlinkSync(socketPath) } catch {}
      controlServer = null
    }
    
    try { unlinkSync(tokenFile) } catch {}
    
    log('[fusion-gateway] Stopped')
  }
  
  return { start, stop, setRoute, clearRoute, getStatus, getPort: () => port }
}

// Control client helper
export function createGatewayControl(socketPath) {
  async function send(command) {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath)
      let response = ''
      
      socket.on('data', chunk => {
        response += chunk.toString()
        const lines = response.split('\n')
        if (lines.length > 1) {
          socket.end()
          try {
            resolve(JSON.parse(lines[0]))
          } catch (error) {
            reject(new Error('Invalid response'))
          }
        }
      })
      
      socket.on('error', reject)
      socket.write(JSON.stringify(command) + '\n')
      
      setTimeout(() => {
        socket.destroy()
        reject(new Error('Control timeout'))
      }, 5000)
    })
  }
  
  return {
    setRoute: (credential, upstream, expires) => send({ action: 'set_route', credential, upstream, expires }),
    clearRoute: (reason) => send({ action: 'clear_route', reason }),
    status: () => send({ action: 'status' })
  }
}

// CLI for standalone testing
if (process.argv[1] && process.argv[1].endsWith('fusion-gateway.mjs')) {
  const tokenFile = process.argv[2] || join(tmpdir(), `fusion-token-${process.pid}`)
  const socketPath = process.argv[3] || join(tmpdir(), `fusion-control-${process.pid}.sock`)
  
  const gateway = createFusionGateway({ tokenFile, socketPath })
  
  gateway.start().then(({ port }) => {
    console.log(`FUSION_UPSTREAM=http://127.0.0.1:${port}`)
    console.log(`FUSION_TOKEN_FILE=${tokenFile}`)
    console.log(`FUSION_CONTROL_SOCKET=${socketPath}`)
  })
  
  process.on('SIGINT', () => gateway.stop().then(() => process.exit(0)))
  process.on('SIGTERM', () => gateway.stop().then(() => process.exit(0)))
}
