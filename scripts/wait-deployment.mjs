import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
const directory = process.env.OPENCODE_WEB_DIR
const deadline = Date.now() + 10 * 60_000
while (Date.now() < deadline) {
  let status
  try { status = JSON.parse(readFileSync(join(directory, 'deployment-status.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (status?.state === 'failed') throw new Error(status.error || 'Production delivery failed')
  if (status?.state === 'ready') {
    const result = JSON.parse(readFileSync(join(directory, 'deployment-result.json'), 'utf8'))
    if (!result.preview_url || result.generation !== String(status.generation) || !Array.isArray(result.screenshots) || result.screenshots.length < 2) throw new Error('Incomplete production delivery')
    console.log('Synthetic generation passed production checkpoint, capture, and deployment.')
    process.exit(0)
  }
  await setTimeout(1000)
}
throw new Error('Production delivery timed out')
