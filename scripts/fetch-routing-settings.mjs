// Fetch admin routing toggles from OmSite. Falls back to defaults if unreachable.
// The settings control free-model route order (Fusion stays unchanged):
// - enable_warp: adds WARP to the route (combines with per-user WARP setting)
// - skip_direct_opencode: skip direct OpenCode calls, go through proxy/ondev only

export async function fetchRoutingSettings({ origin = 'https://omgithub.com', timeout = 5000 } = {}) {
  const defaults = { enable_warp: false, skip_direct_opencode: false }
  try {
    const url = new URL('/api/routing-settings', origin)
    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(timeout) })
    if (!response.ok) return defaults
    const data = await response.json()
    return {
      enable_warp: data.enable_warp === true,
      skip_direct_opencode: data.skip_direct_opencode === true
    }
  } catch {
    return defaults
  }
}

// Resolve effective WARP decision combining per-user request and admin settings.
// Route order for free models:
// - Both off: directOC → ondev
// - WARP on (admin or user): directOC → WARP → ondev  
// - Skip on: ondev only
// - Both on: WARP → ondev
export function resolveRouting({ userWarpRequested, adminSettings, fusionEnabled, labels = [] }) {
  const { enable_warp, skip_direct_opencode } = adminSettings
  const picked = labels.some(name => String(name).startsWith('model/'))
  
  // Fusion skips WARP for Default (no model/* label) when Fusion plugin is on
  if (!picked && fusionEnabled && !enable_warp) {
    return { warp: 'skip', skipDirect: false }
  }
  
  // Admin skip_direct_opencode forces proxy-only (no direct calls)
  if (skip_direct_opencode) {
    // Both on: WARP → ondev
    // Skip on, WARP off: ondev only
    return {
      warp: (enable_warp || userWarpRequested) ? 'on' : 'off',
      skipDirect: true
    }
  }
  
  // Admin enable_warp OR per-user warp request enables WARP
  const warpEnabled = enable_warp || userWarpRequested
  return {
    warp: warpEnabled ? 'on' : 'off',
    skipDirect: false
  }
}

import { pathToFileURL } from 'node:url'
import { appendFileSync } from 'node:fs'

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const origin = process.env.OMGITHUB_ORIGIN || 'https://omgithub.com'
  const userWarpRequested = process.argv[2] === 'true'
  const fusionEnabled = process.argv[3] === 'true'
  const labelsJson = process.argv[4] || '[]'
  let labels = []
  try { labels = JSON.parse(labelsJson).map(l => typeof l === 'string' ? l : l?.name).filter(Boolean) } catch {}
  
  const settings = await fetchRoutingSettings({ origin })
  const result = resolveRouting({ userWarpRequested, adminSettings: settings, fusionEnabled, labels })
  
  // Export SKIP_DIRECT_OC to GITHUB_ENV if set
  if (result.skipDirect && process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, 'SKIP_DIRECT_OC=1\n')
  }
  
  // Output WARP decision for workflow (on, off, or skip)
  console.log(result.warp)
}
