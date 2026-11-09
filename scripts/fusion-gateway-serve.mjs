#!/usr/bin/env node
/**
 * Fusion Gateway Server
 * 
 * Long-running process that proxies plugin requests to Copilot upstreams
 * with credential injection. Routes are set via control socket.
 * 
 * Usage: node fusion-gateway-serve.mjs --run-dir <dir> [options]
 * 
 * Options:
 *   --run-dir <dir>         Working directory for state files
 *   --token-file <path>     Generation token file path
 *   --socket-path <path>    Control socket path  
 *   --shared-upstreams <hosts>  Comma-separated allowed shared upstream hosts
 *   --port <port>           HTTP port (default: 0 = random)
 */

import { createFusionGateway } from './fusion-gateway.mjs'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    'run-dir': { type: 'string' },
    'token-file': { type: 'string' },
    'socket-path': { type: 'string' },
    'shared-upstreams': { type: 'string', default: '' },
    'port': { type: 'string', default: '0' }
  }
})

const runDir = args['run-dir']
if (!runDir) {
  console.error('Usage: fusion-gateway-serve.mjs --run-dir <dir>')
  process.exit(1)
}

mkdirSync(runDir, { recursive: true })

const tokenFile = args['token-file'] || join(runDir, 'fusion-token')
const socketPath = args['socket-path'] || join(runDir, 'fusion-control.sock')
const sharedUpstreams = (args['shared-upstreams'] || '').split(',').filter(Boolean)
const port = parseInt(args['port'] || '0', 10)

const logFile = join(runDir, 'fusion-gateway.log')
const log = msg => {
  const line = `${new Date().toISOString()} ${msg}\n`
  appendFileSync(logFile, line)
}

log('[fusion-gateway-serve] Starting...')
log(`[fusion-gateway-serve] Token file: ${tokenFile}`)
log(`[fusion-gateway-serve] Socket path: ${socketPath}`)
log(`[fusion-gateway-serve] Shared upstreams: ${sharedUpstreams.join(', ') || 'none'}`)

// Create gateway
const gateway = createFusionGateway({
  tokenFile,
  socketPath,
  log,
  allowedSharedUpstreams: sharedUpstreams
})

// Start gateway
gateway.start()
  .then(result => {
    log(`[fusion-gateway-serve] Gateway ready on port ${result.port}`)
    console.log(`Gateway listening on port ${result.port}`)
  })
  .catch(err => {
    log(`[fusion-gateway-serve] Failed to start: ${err.message}`)
    process.exit(1)
  })

// Handle shutdown
const shutdown = signal => {
  log(`[fusion-gateway-serve] Received ${signal}, shutting down...`)
  gateway.stop()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', err => {
  log(`[fusion-gateway-serve] Uncaught exception: ${err.message}`)
  log(err.stack)
  process.exit(1)
})
