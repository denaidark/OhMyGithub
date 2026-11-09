/**
 * Gateway Control Client
 * 
 * Sets routes on the Fusion Gateway via Unix socket control channel.
 * Used by the run controller to configure credential injection.
 */

import { createConnection } from 'node:net'
import { appendFileSync } from 'node:fs'

/**
 * Create a gateway control client.
 * 
 * @param {Object} options
 * @param {string} options.socketPath - Path to gateway control socket
 * @param {string} [options.logFile] - Log file path
 */
export function createGatewayControl({ socketPath, logFile, now = Date.now }) {
  const log = msg => {
    if (logFile) {
      try { appendFileSync(logFile, `${new Date(now()).toISOString()} ${msg}\n`) } catch {}
    }
  }
  
  /**
   * Send command to gateway and wait for response.
   */
  function sendCommand(command, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const client = createConnection(socketPath)
      let response = ''
      
      const timeout = setTimeout(() => {
        client.destroy()
        reject(new Error('Gateway control timeout'))
      }, timeoutMs)
      
      client.on('connect', () => {
        client.write(JSON.stringify(command) + '\n')
      })
      
      client.on('data', data => {
        response += data.toString()
        // Try to parse complete JSON response
        try {
          const result = JSON.parse(response)
          clearTimeout(timeout)
          client.end()
          resolve(result)
        } catch {
          // Wait for more data
        }
      })
      
      client.on('error', err => {
        clearTimeout(timeout)
        reject(err)
      })
      
      client.on('end', () => {
        clearTimeout(timeout)
        if (response) {
          try {
            resolve(JSON.parse(response))
          } catch {
            reject(new Error(`Invalid gateway response: ${response}`))
          }
        } else {
          reject(new Error('Gateway closed connection without response'))
        }
      })
    })
  }
  
  /**
   * Set the active route on the gateway.
   * 
   * @param {Object} options
   * @param {string} options.credential - Credential to inject (Copilot token)
   * @param {string} options.upstream - Upstream URL
   * @param {number} options.expires - Expiry timestamp (ms)
   * @param {string} options.routeType - 'direct' or 'shared'
   */
  async function setRoute({ credential, upstream, expires, routeType }) {
    log(`[gateway-control] Setting ${routeType} route (upstream=${new URL(upstream).host})`)
    
    try {
      const result = await sendCommand({
        action: 'set_route',
        credential,
        upstream,
        expires,
        routeType
      })
      
      if (result.success) {
        log(`[gateway-control] Route set (expires=${new Date(result.expires).toISOString()})`)
        return { success: true, expires: result.expires }
      }
      
      log(`[gateway-control] Route set failed: ${result.error}`)
      return { success: false, error: result.error }
    } catch (error) {
      log(`[gateway-control] Route set error: ${error.message}`)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Clear the active route.
   */
  async function clearRoute(reason = 'manual') {
    log(`[gateway-control] Clearing route (reason=${reason})`)
    
    try {
      const result = await sendCommand({
        action: 'clear_route',
        reason
      })
      
      log(`[gateway-control] Route cleared`)
      return { success: true }
    } catch (error) {
      log(`[gateway-control] Route clear error: ${error.message}`)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Get gateway status.
   */
  async function getStatus() {
    try {
      return await sendCommand({ action: 'status' })
    } catch (error) {
      return { error: error.message }
    }
  }
  
  /**
   * Add a host to the allowed shared upstreams list.
   */
  async function allowSharedUpstream(host) {
    log(`[gateway-control] Allowing shared upstream: ${host}`)
    
    try {
      const result = await sendCommand({
        action: 'allow_shared_upstream',
        host
      })
      
      return { success: result.success !== false }
    } catch (error) {
      log(`[gateway-control] Allow shared upstream error: ${error.message}`)
      return { success: false, error: error.message }
    }
  }
  
  return {
    setRoute,
    clearRoute,
    getStatus,
    allowSharedUpstream
  }
}
