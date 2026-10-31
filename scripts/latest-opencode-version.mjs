import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export async function latestOpenCodeVersion(request = fetch) {
  const response = await request('https://opencode.ai/update/api/latest/cli/npm', { signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error(`OpenCode latest-version lookup HTTP ${response.status}`)
  const metadata = await response.json()
  if (metadata.channel !== 'latest' || metadata.active !== true || !/^2\.\d+\.\d+$/.test(metadata.version || '')) throw new Error('OpenCode latest channel did not return a stable v2 release')
  return metadata.version
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await latestOpenCodeVersion())
