// Decides whether OpenCode goes through Cloudflare WARP for this run.
// 
// Gate hierarchy (t248u):
// 1. Admin setting warp_enabled=false → WARP completely disabled (no setup/download)
// 2. Issue label `warp` not present → WARP off for this run
// 3. Default selection + Fusion enabled → WARP skipped (Fusion goes direct)
// 4. Otherwise → WARP on
//
// Fusion is known only here: it is on when this run resolved the Fusion plugin commit.
import { pathToFileURL } from 'node:url'

/**
 * Fetch admin routing settings from OmGithub API.
 * Returns { warp_enabled, skip_direct_oc } or defaults on failure.
 */
export async function fetchRoutingSettings({ origin = 'https://omgithub.com', request = fetch } = {}) {
  const defaults = { warp_enabled: false, skip_direct_oc: false }
  try {
    const response = await request(`${origin}/api/routing-settings`, {
      signal: AbortSignal.timeout(5000)
    })
    if (response.ok) {
      const data = await response.json()
      return {
        warp_enabled: data.warp_enabled === true,
        skip_direct_oc: data.skip_direct_oc === true
      }
    }
  } catch {}
  return defaults
}

export function warpDecision({ requested, fusionEnabled, labels = [], adminWarpEnabled = true }) {
  // Gate 1: Admin setting warp_enabled=false disables WARP completely
  if (adminWarpEnabled === false) return 'admin_disabled'
  
  // Gate 2: Label-based request (legacy compatibility)
  if (!requested) return 'off'
  
  // Gate 3: Default selection with Fusion skips WARP
  const picked = labels.some(name => String(name).startsWith('model/'))
  if (!picked && fusionEnabled) return 'skip'
  
  // Gate 4: WARP enabled
  return 'on'
}

export function labelNames(json) {
  try { const value = JSON.parse(json || '[]'); return Array.isArray(value) ? value.map(item => typeof item === 'string' ? item : item?.name).filter(Boolean) : [] } catch { return [] }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [requested, fusion, labelsJson] = process.argv.slice(2)
  const origin = process.env.OMGITHUB_ORIGIN || 'https://omgithub.com'
  
  // Fetch admin settings before making decision
  const settings = await fetchRoutingSettings({ origin })
  const decision = warpDecision({ 
    requested: requested === 'true', 
    fusionEnabled: fusion === 'true', 
    labels: labelNames(labelsJson),
    adminWarpEnabled: settings.warp_enabled
  })
  
  // Output decision for workflow
  console.log(decision)
  
  // Exit codes for workflow gating
  // 0 = proceed with decision
  // 5 = admin_disabled (skip WARP setup entirely)
  if (decision === 'admin_disabled') process.exit(5)
}
