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
   * @returns {{ success: boolean, lease?: { token, upstream, expires }, error?: string }}
   */
  async function acquireDirect() {
    log('[lease-client] Acquiring direct lease...')
    
    try {
      const response = await request(`${baseUrl}/fusion/lease/direct`, {
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
      if (data.lease) {
        activeLease = {
          type: 'direct',
          token: data.lease.token,
          upstream: data.lease.upstream,
          expires: data.lease.expires,
          leaseId: data.lease.id
        }
        log(`[lease-client] Direct lease acquired (expires=${new Date(activeLease.expires).toISOString()})`)
        scheduleRenewal()
        return { success: true, lease: activeLease }
      }
      
      log(`[lease-client] Direct lease denied: ${data.error || 'unknown'}`)
      return { success: false, error: data.error || 'denied' }
    } catch (error) {
      log(`[lease-client] Direct lease error: ${error.message}`)
      return { success: false, error: 'request_error', message: error.message }
    }
  }
  
  /**
   * Acquire a shared route lease from the donor pool.
   * 
   * @param {Object} options
   * @param {string} [options.excludeDonor] - Donor token to exclude (for 402 retry)
   * @returns {{ success: boolean, lease?: { token, upstream, expires }, error?: string }}
   */
  async function acquireShared({ excludeDonor } = {}) {
    log(`[lease-client] Acquiring shared lease${excludeDonor ? ' (excluding previous donor)' : ''}...`)
    
    const body = {
      run: runId,
      attempt: runAttempt
    }
    
    // Request different donor on retry
    if (excludeDonor) {
      body.exclude_donor_hash = createHash('sha256').update(excludeDonor).digest('hex').slice(0, 16)
    }
    
    try {
      const response = await request(`${baseUrl}/fusion/lease/shared`, {
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
      if (data.lease) {
        activeLease = {
          type: 'shared',
          token: data.lease.token,
          upstream: data.lease.upstream,
          expires: data.lease.expires,
          leaseId: data.lease.id,
          donorId: data.lease.donor_id
        }
        log(`[lease-client] Shared lease acquired (expires=${new Date(activeLease.expires).toISOString()})`)
        scheduleRenewal()
        return { success: true, lease: activeLease }
      }
      
      log(`[lease-client] Shared lease denied: ${data.error || 'unknown'}`)
      return { success: false, error: data.error || 'denied' }
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
      const response = await request(`${baseUrl}/fusion/lease`, {
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
      const endpoint = activeLease.type === 'direct' 
        ? `${baseUrl}/fusion/lease/direct/renew`
        : `${baseUrl}/fusion/lease/shared/renew`
      
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
