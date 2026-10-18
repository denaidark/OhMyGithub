import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Reuse only an export whose session revision is still current.
export async function collectLogResponse({ directory, sessionId, api }) {
  const info = await api(`/session/${sessionId}`)
  try {
    const saved = JSON.parse(readFileSync(join(directory, 'log-session-export.json'), 'utf8'))
    if (Number.isFinite(info.time?.updated) && saved.info?.id === sessionId && saved.info.time?.updated === info.time.updated &&
        Array.isArray(saved.messages) && saved.messages.length) return saved.messages
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  return api(`/session/${sessionId}/message`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  const sessionId = readFileSync(join(env.OPENCODE_WEB_DIR, 'checkpoint-session-id'), 'utf8').trim()
  const messages = await collectLogResponse({ directory: env.OPENCODE_WEB_DIR, sessionId, api: async path => {
    const response = await fetch(`http://127.0.0.1:${env.OPENCODE_WEB_PORT}${path}`, { headers: { 'x-opencode-directory': env.PROJECT_DIR }, signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`OpenCode HTTP ${response.status}`)
    return response.json()
  } })
  if (!Array.isArray(messages) || !messages.length) throw new Error('No diagnostic response available')
  writeFileSync(process.argv[2], JSON.stringify(messages))
}
