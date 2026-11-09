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
  const requested = Boolean(userWarpRequested || enable_warp)
  // Same order as the old warp-decision.mjs: not requested -> off; Default with Fusion -> skip (lazy); else on.
  const warp = !requested ? 'off' : (!picked && fusionEnabled ? 'skip' : 'on')
  // Skip direct OpenCode only matters when WARP is not carrying free models: then free calls go to ondev (backup endpoint).
  return { warp, skipDirect: Boolean(skip_direct_opencode) && warp === 'off' }
}
