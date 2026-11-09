// Decides whether OpenCode goes through Cloudflare WARP for this run.
// The omsite toggle (on by default) adds the `warp` label. WARP is skipped only for
// Default (no model/* label) when Fusion is installed on this run, because Default
// then reaches Fusion through GitHub Copilot instead of rate-limited free models.
// Fusion is known only here: it is on when this run resolved the Fusion plugin commit.
import { pathToFileURL } from 'node:url'

export function warpDecision({ requested, fusionEnabled, labels = [] }) {
  if (!requested) return 'off'
  const picked = labels.some(name => String(name).startsWith('model/'))
  if (!picked && fusionEnabled) return 'skip'
  return 'on'
}

export function labelNames(json) {
  try { const value = JSON.parse(json || '[]'); return Array.isArray(value) ? value.map(item => typeof item === 'string' ? item : item?.name).filter(Boolean) : [] } catch { return [] }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [requested, fusion, labelsJson] = process.argv.slice(2)
  // Admin routing toggles (omsite Free model routing); unreachable or unset = both off = old behavior.
  const { fetchRoutingSettings, resolveRouting } = await import('./fetch-routing-settings.mjs')
  const adminSettings = await fetchRoutingSettings({ origin: process.env.OMGITHUB_ORIGIN || 'https://omgithub.com' })
  const result = resolveRouting({ userWarpRequested: requested === 'true', adminSettings, fusionEnabled: fusion === 'true', labels: labelNames(labelsJson) })
  if (result.skipDirect && process.env.GITHUB_ENV) (await import('node:fs')).appendFileSync(process.env.GITHUB_ENV, 'SKIP_DIRECT_OC=1\n')
  console.error(`Admin routing: enable_warp=${adminSettings.enable_warp} skip_direct_opencode=${adminSettings.skip_direct_opencode} skipDirect=${result.skipDirect}`)
  console.log(result.warp)
}
