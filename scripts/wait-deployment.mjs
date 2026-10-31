import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export async function waitForDeployment({ directory, now = Date.now, pause = setTimeout, timeoutMs = 10 * 60_000, reconcile = async () => {} }) {
  const read = name => {
    try { return JSON.parse(readFileSync(join(directory, name), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error }
  }
  const completion = read('main-completion.json')
  const deadline = now() + timeoutMs
  let reconciliationError
  while (now() < deadline) {
    try { await reconcile(); reconciliationError = null }
    catch (error) { reconciliationError = error.message }
    const status = read('deployment-status.json')
    // An earlier turn may still be ready while the final completion is queued.
    const current = status && (!completion || status.message_id === completion.message_id)
    if (current && status.state === 'failed') throw new Error(status.error || 'Production delivery failed')
    if (current && status.state === 'ready') {
      const result = read('deployment-result.json')
      if (!result?.preview_url || String(result.generation) !== String(status.generation) || !Array.isArray(result.screenshots) || result.screenshots.length < 2) throw new Error('Incomplete production delivery')
      return result
    }
    await pause(1000)
  }
  throw new Error(`Production delivery timed out${reconciliationError ? `: ${reconciliationError}` : ''}`)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env
  await waitForDeployment({ directory: env.OPENCODE_WEB_DIR, reconcile: async () => {
    if (!env.OPENCODE_CONTROL_PORT) return
    const response = await fetch(`http://127.0.0.1:${env.OPENCODE_CONTROL_PORT}/omgithub/reconcile`, { signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error(`Deployment reconciliation HTTP ${response.status}`)
  } })
  console.log('Production delivery completed checkpoint, capture, and deployment.')
}
