/**
 * Transport adapter for route-based model fallback (t248u).
 * 
 * Handles actual transport switching based on RouteKind:
 * - DEEPSEEK_DIRECT: No proxy, direct connection to DeepSeek API
 * - DEEPSEEK_WARP: Via Cloudflare WARP proxy (requires setup)
 * - DEEPSEEK_ONDEV: Via llm.ondev.store backup endpoint
 * - FUSION_DIRECT: Direct Fusion with own credentials
 * - FUSION_SHARED: Shared Fusion pool
 */

import { spawn, execSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const RouteKind = Object.freeze({
  DEEPSEEK_DIRECT: 'deepseek-direct',
  DEEPSEEK_WARP: 'deepseek-warp',
  DEEPSEEK_ONDEV: 'deepseek-ondev',
  FUSION_DIRECT: 'fusion-direct',
  FUSION_SHARED: 'fusion-shared'
})

/**
 * Transport state for a build session.
 * Tracks which transports have been set up and their status.
 */
export class TransportState {
  constructor({ workDir, logFile, env = process.env }) {
    this.workDir = workDir
    this.logFile = logFile
    this.env = env
    this.warpReady = false
    this.warpProxy = null
    this.directReady = true  // Direct always available (no setup needed)
    this.ondevReady = true   // Ondev always available (backup endpoint)
    this.fusionToken = env.FUSION_ACCESS_TOKEN || null
    this.fusionUpstream = env.FUSION_UPSTREAM || null
  }

  log(message) {
    if (this.logFile) {
      appendFileSync(this.logFile, `[transport] ${message}\n`)
    }
  }

  /**
   * Check if WARP is already set up (from workflow).
   */
  checkWarpStatus() {
    const statusFile = join(this.env.RUNNER_TEMP || '/tmp', 'warp', 'status.json')
    try {
      const status = JSON.parse(readFileSync(statusFile, 'utf8'))
      if (status.result === 'ok' || status.result === 'proxy_ok') {
        this.warpReady = true
        // Read proxy URL from the setup
        const proxyFile = join(this.env.OPENCODE_WEB_DIR || this.workDir, 'opencode-proxy')
        try {
          this.warpProxy = readFileSync(proxyFile, 'utf8').trim()
        } catch {}
        this.log(`WARP already set up: proxy=${this.warpProxy || 'unknown'}`)
        return true
      }
    } catch {}
    return false
  }

  /**
   * Set up WARP proxy on demand.
   * Only called when warpEnabled=true and hitting a free model route.
   */
  async setupWarp() {
    if (this.warpReady) return true
    
    // Check if already set up by workflow
    if (this.checkWarpStatus()) return true
    
    this.log('Setting up WARP proxy on demand...')
    const script = join(__dirname, 'warp-proxy.sh')
    if (!existsSync(script)) {
      this.log('WARP setup script not found')
      return false
    }

    const warpDir = join(this.env.RUNNER_TEMP || '/tmp', 'warp')
    mkdirSync(warpDir, { recursive: true })

    return new Promise(resolve => {
      const child = spawn('bash', [script, warpDir, this.env.OPENCODE_BIN || 'opencode'], {
        cwd: this.env.PROJECT_DIR || process.cwd(),
        env: this.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk.toString() })
      child.stderr.on('data', chunk => { stderr += chunk.toString() })

      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        this.log('WARP setup timed out')
        resolve(false)
      }, 120000)  // 2 minute timeout

      child.on('close', code => {
        clearTimeout(timeout)
        if (code === 0) {
          // Parse proxy URL from stdout (last line should be http://127.0.0.1:port)
          const lines = stdout.trim().split('\n')
          const proxyLine = lines.find(line => line.startsWith('http://127.0.0.1:'))
          if (proxyLine) {
            this.warpProxy = proxyLine.trim()
            this.warpReady = true
            this.log(`WARP setup succeeded: ${this.warpProxy}`)
            resolve(true)
            return
          }
        }
        this.log(`WARP setup failed (code=${code}): ${stderr.slice(0, 200)}`)
        resolve(false)
      })
    })
  }

  /**
   * Get environment variables for a specific route.
   * Returns modified env with appropriate proxy settings.
   */
  getEnvForRoute(route, baseEnv = this.env) {
    const env = { ...baseEnv }

    switch (route) {
      case RouteKind.DEEPSEEK_DIRECT:
        // Direct connection: remove any proxy settings
        delete env.HTTPS_PROXY
        delete env.HTTP_PROXY
        delete env.https_proxy
        delete env.http_proxy
        this.log('Transport: direct (no proxy)')
        break

      case RouteKind.DEEPSEEK_WARP:
        // WARP proxy
        if (this.warpProxy) {
          env.HTTPS_PROXY = this.warpProxy
          env.HTTP_PROXY = this.warpProxy
          this.log(`Transport: WARP proxy (${this.warpProxy})`)
        } else {
          this.log('Transport: WARP requested but not available, falling through')
        }
        break

      case RouteKind.DEEPSEEK_ONDEV:
        // Backup endpoint via llm.ondev.store
        // The model ID already encodes the endpoint; no transport change needed
        delete env.HTTPS_PROXY
        delete env.HTTP_PROXY
        this.log('Transport: ondev.store backup endpoint')
        break

      case RouteKind.FUSION_DIRECT:
      case RouteKind.FUSION_SHARED:
        // Fusion routes use their own credential transport
        if (this.fusionToken) {
          env.FUSION_ACCESS_TOKEN = this.fusionToken
        }
        if (this.fusionUpstream) {
          env.FUSION_UPSTREAM = this.fusionUpstream
        }
        // Keep any existing proxy for Fusion (it may need it)
        this.log(`Transport: Fusion (route=${route})`)
        break

      default:
        this.log(`Transport: unknown route ${route}, using base env`)
    }

    return env
  }

  /**
   * Prepare transport for a route.
   * May trigger lazy setup for routes like WARP.
   */
  async prepareRoute(route) {
    switch (route) {
      case RouteKind.DEEPSEEK_WARP:
        if (!this.warpReady) {
          return await this.setupWarp()
        }
        return true

      case RouteKind.DEEPSEEK_DIRECT:
      case RouteKind.DEEPSEEK_ONDEV:
      case RouteKind.FUSION_DIRECT:
      case RouteKind.FUSION_SHARED:
        return true

      default:
        return true
    }
  }

  /**
   * Check if a route is available (can be tried).
   */
  isRouteAvailable(route) {
    switch (route) {
      case RouteKind.DEEPSEEK_DIRECT:
        return this.directReady

      case RouteKind.DEEPSEEK_WARP:
        // WARP is available if setup succeeded or can be set up
        return this.warpReady || this.env.WARP_LAZY === '1'

      case RouteKind.DEEPSEEK_ONDEV:
        return this.ondevReady

      case RouteKind.FUSION_DIRECT:
        return Boolean(this.fusionToken)

      case RouteKind.FUSION_SHARED:
        // Shared is always potentially available (on-demand acquisition)
        return true

      default:
        return false
    }
  }

  /**
   * Update Fusion credentials (from on-demand acquisition).
   */
  updateFusionCredentials(token, upstream) {
    this.fusionToken = token
    this.fusionUpstream = upstream
    this.log(`Fusion credentials updated (upstream=${upstream || 'default'})`)
  }
}

/**
 * Create a transport adapter for the current build session.
 */
export function createTransportAdapter({ workDir, logFile, env = process.env }) {
  return new TransportState({ workDir, logFile, env })
}

export default { RouteKind, TransportState, createTransportAdapter }
