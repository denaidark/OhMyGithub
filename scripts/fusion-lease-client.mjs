/**
 * Fusion Lease Client
 * 
 * Acquires run-bound leases via dedicated OmGithub API endpoints.
 * Does NOT use full /credentials endpoint - uses /api/fusion/lease/* instead.
 * 
 * Direct route: /api/fusion/lease/direct
 * Shared route: /api/fusion/lease/shared
 * Release: DELETE /api/fusion/lease
 */

import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/**
 * Create a lease client for a specific run.
 * 
 * @param {Object} options
 * @param {string} options.origin - OmGithub API origin (e.g. https://omgithub.com)
 * @param {string} options.callbackToken - Callback token for authentication
 * @param {string} options.repo - Repository (owner/repo)
 * @param {string} options.issueNumber - Issue number
 * @param {string} options.runId - GitHub run ID
 * @param {number} options.runAttempt - GitHub run attempt
 * @param {string} options.logFile - Log file path
 * @param {Function} [options.request] - Fetch function (for testing)
 */
export function createLeaseClient({
  origin,
  callbackToken,
  repo,
  issueNumber,
  runId,
  runAttempt,
  logFile,
  request = fetch,
  now = Date.now
}) {
  const log = msg => {
    try { appendFileSync(logFile, `${new Date(now()).toISOString()} ${msg}\n`) } catch {}
  }
  
  const baseUrl = `${origin}/api/github/${repo}/issues/${issueNumber}`
  const auth = `Bearer ${callbackToken}`
  
  // Track active lease
  let activeLease = null
  let renewTimer = null
  
  /**
   * Acquire a direct route lease.
   * Validates that the run's owner has Copilot access.
   * 
   * Issue #6: Server returns user's actual Copilot credential - NEVER use GITHUB_TOKEN.
   * Server response: { success, route: 'direct', scope, credential, expires_in_ms, upstream }
   * 
   * @returns {{ success: boolean, lease?: { token, upstream, expires, route }, error?: string }}
   */
  async function acquireDirect() {
    log('[lease-client] Acquiring direct lease...')
    
    try {
      // Issue #3: URL must match server mount: /api/github/:owner/:repo/issues/:number/api/fusion/lease/direct
      const response = await request(`${baseUrl}/api/fusion/lease/direct`, {
        method: 'POST',
        headers: {
          'Authorization': auth,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          run: runId,
          attempt: runAttempt
        }),
        signal: AbortSignal.timeout(15000)
      })
      
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        log(`[lease-client] Direct lease failed: ${response.status} ${text}`)
        return { success: false, error: `http_${response.status}`, status: response.status }
      }
      
      const data = await response.json()
      // Issue #6: Server returns credential - never fall back to GITHUB_TOKEN
      // Server response: { success, route: 'direct', scope, credential, expires_in_ms, upstream }
      if (data.success && data.credential) {
        activeLease = {
          route: 'direct',
          token: data.credential,  // User's actual Copilot credential from server
          upstream: data.upstream,
          expires: now() + (data.expires_in_ms || 180000),
          scope: data.scope
        }
        log(`[lease-client] Direct lease acquired (expires=${new Date(activeLease.expires).toISOString()})`)
        scheduleRenewal()
        return { success: true, lease: activeLease }
      }
      
      const cause = data.cause || data.error || (data.success ? 'no_credential' : 'denied')
      log(`[lease-client] Direct lease denied: ${cause}`)
      return { success: false, error: cause }
    } catch (error) {
      log(`[lease-client] Direct lease error: ${error.message}`)
      return { success: false, error: 'request_error', message: error.message }
    }
  }
  
  /**
   * Acquire a shared route lease from the donor pool.
   * 
   * Server response: { success, route: 'shared', scope, credential, lease_id, expires_in_ms, upstream }
   * 
   * @param {Object} options
   * @param {string} [options.excludeLeaseId] - Lease ID to exclude (for 402 retry)
   * @returns {{ success: boolean, lease?: { token, upstream, expires, route, leaseId }, error?: string }}
   */
  async function acquireShared({ excludeLeaseId } = {}) {
    log(`[lease-client] Acquiring shared lease${excludeLeaseId ? ' (excluding previous lease)' : ''}...`)
    
    const body = {
      run: runId,
      attempt: runAttempt
    }
    
    // Server doesn't support exclude_donor_hash yet - will be added
    // For now, just log the exclusion request
    if (excludeLeaseId) {
      log(`[lease-client] Excluding previous lease: ${excludeLeaseId}`)
    }
    
    try {
      // Issue #3: URL must match server mount
      const response = await request(`${baseUrl}/api/fusion/lease/shared`, {
        method: 'POST',
        headers: {
          'Authorization': auth,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      })
      
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        log(`[lease-client] Shared lease failed: ${response.status} ${text}`)
        return { success: false, error: `http_${response.status}`, status: response.status }
      }
      
      const data = await response.json()
      // Server returns: { success, route: 'shared', scope, credential, lease_id, expires_in_ms, upstream }
      if (data.success && data.credential) {
        activeLease = {
          route: 'shared',
          token: data.credential,  // Server returns 'credential' not 'lease.token'
          upstream: data.upstream,
          expires: now() + (data.expires_in_ms || 180000),
          leaseId: data.lease_id,
          scope: data.scope
        }
        log(`[lease-client] Shared lease acquired (leaseId=${data.lease_id}, expires=${new Date(activeLease.expires).toISOString()})`)
        scheduleRenewal()
        return { success: true, lease: activeLease }
      }
      
      log(`[lease-client] Shared lease denied: ${data.cause || data.error || 'unknown'}`)
      return { success: false, error: data.cause || data.error || 'denied' }
    } catch (error) {
      log(`[lease-client] Shared lease error: ${error.message}`)
      return { success: false, error: 'request_error', message: error.message }
    }
  }
  
  /**
   * Release the active lease.
   */
  async function release() {
    if (!activeLease) return { success: true }
    
    log(`[lease-client] Releasing ${activeLease.type} lease...`)
    clearRenewalTimer()
    
    try {
      const response = await request(`${baseUrl}/api/fusion/lease`, {
        method: 'DELETE',
        headers: {
          'Authorization': auth,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          run: runId,
          attempt: runAttempt,
          lease_id: activeLease.leaseId
        }),
        signal: AbortSignal.timeout(5000)
      })
      
      activeLease = null
      log(`[lease-client] Lease released`)
      return { success: true }
    } catch (error) {
      log(`[lease-client] Lease release error: ${error.message}`)
      activeLease = null
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Renew the active lease.
   */
  async function renew() {
    if (!activeLease) return { success: false, error: 'no_active_lease' }
    
    log(`[lease-client] Renewing ${activeLease.type} lease...`)
    
    try {
      const endpoint = activeLease.route === 'direct' 
        ? `${baseUrl}/api/fusion/lease/direct/renew`
        : `${baseUrl}/api/fusion/lease/shared/renew`
      
      const response = await request(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': auth,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          run: runId,
          attempt: runAttempt,
          lease_id: activeLease.leaseId
        }),
        signal: AbortSignal.timeout(10000)
      })
      
      if (!response.ok) {
        log(`[lease-client] Lease renewal failed: ${response.status}`)
        return { success: false, error: `http_${response.status}` }
      }
      
      const data = await response.json()
      if (data.lease?.expires) {
        activeLease.expires = data.lease.expires
        log(`[lease-client] Lease renewed (expires=${new Date(activeLease.expires).toISOString()})`)
        scheduleRenewal()
        return { success: true, lease: activeLease }
      }
      
      return { success: false, error: data.error || 'renewal_failed' }
    } catch (error) {
      log(`[lease-client] Lease renewal error: ${error.message}`)
      return { success: false, error: error.message }
    }
  }
  
  function scheduleRenewal() {
    clearRenewalTimer()
    if (!activeLease) return
    
    // Renew 30s before expiry
    const renewAt = activeLease.expires - 30000
    const delay = renewAt - now()
    
    if (delay > 0) {
      renewTimer = setTimeout(async () => {
        const result = await renew()
        if (!result.success) {
          log(`[lease-client] Auto-renewal failed: ${result.error}`)
        }
      }, delay)
      renewTimer.unref?.()
    }
  }
  
  function clearRenewalTimer() {
    if (renewTimer) {
      clearTimeout(renewTimer)
      renewTimer = null
    }
  }
  
  /**
   * Get the active lease.
   */
  function getActiveLease() {
    if (!activeLease) return null
    if (activeLease.expires < now()) {
      log(`[lease-client] Active lease expired`)
      activeLease = null
      return null
    }
    return { ...activeLease }
  }
  
  /**
   * Check if we have a valid active lease.
   */
  function hasValidLease() {
    return getActiveLease() !== null
  }
  
  return {
    acquireDirect,
    acquireShared,
    release,
    renew,
    getActiveLease,
    hasValidLease
  }
}
