#!/usr/bin/env node
/**
 * Start Fusion Gateway before opencode serve.
 * 
 * Usage: node start-fusion-gateway.mjs <run-dir>
 * 
 * Creates:
 * - fusion-gateway.pid - Gateway PID
 * - fusion-token - Generation token file for plugin
 * - fusion-control.sock - Control socket for route management
 * - fusion-gateway.env - Environment exports for serve
 * 
 * Environment:
 * - FUSION_GATEWAY_PORT: Port for gateway (default: 0 = random)
 * - OMGITHUB_URL: OmGithub API base URL (for lease acquisition)
 */

import { createFusionGateway } from './fusion-gateway.mjs'
import { appendFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const runDir = process.argv[2]
if (!runDir) {
  console.error('Usage: start-fusion-gateway.mjs <run-dir>')
  process.exit(1)
}

mkdirSync(runDir, { recursive: true })

const logFile = join(runDir, 'fusion-gateway.log')
const tokenFile = join(runDir, 'fusion-token')
const socketPath = join(runDir, 'fusion-control.sock')
const pidFile = join(runDir, 'fusion-gateway.pid')
const envFile = join(runDir, 'fusion-gateway.env')

const log = msg => {
  const line = `${new Date().toISOString()} ${msg}\n`
  appendFileSync(logFile, line)
  process.stdout.write(line)
}

log('[start-fusion-gateway] Starting gateway...')

// Create gateway
const gateway = createFusionGateway({
  tokenFile,
  socketPath,
  log,
  allowedSharedUpstreams: (process.env.FUSION_SHARED_UPSTREAMS || '').split(',').filter(Boolean)
})

// Start HTTP server
const requestedPort = parseInt(process.env.FUSION_GATEWAY_PORT || '0', 10)

gateway.start(requestedPort)
  .then(actualPort => {
    log(`[start-fusion-gateway] Gateway listening on port ${actualPort}`)
    
    // Write PID
    writeFileSync(pidFile, String(process.pid))
    
    // Write environment exports for shell
    const envExports = [
      `export FUSION_UPSTREAM="http://127.0.0.1:${actualPort}"`,
      `export FUSION_TOKEN_FILE="${tokenFile}"`,
      `export FUSION_CONTROL_SOCKET="${socketPath}"`,
      `export FUSION_GATEWAY_PID="${process.pid}"`,
      ''
    ].join('\n')
    writeFileSync(envFile, envExports)
    
    log(`[start-fusion-gateway] Environment written to ${envFile}`)
    log('[start-fusion-gateway] Gateway ready')
    
    // Output port for caller
    console.log(`GATEWAY_PORT=${actualPort}`)
  })
  .catch(err => {
    log(`[start-fusion-gateway] Failed to start: ${err.message}`)
    process.exit(1)
  })

// Handle shutdown
const shutdown = signal => {
  log(`[start-fusion-gateway] Received ${signal}, shutting down...`)
  gateway.stop()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
