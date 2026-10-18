import { randomBytes } from 'node:crypto'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { command, exportSession } from './session-checkpoint.mjs'

const env = process.env
const binary = env.OPENCODE_BIN || join(env.HOME, '.opencode/bin/opencode')
const url = `http://127.0.0.1:${env.OPENCODE_WEB_PORT}`
const response = await fetch(url + '/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-opencode-directory': env.PROJECT_DIR }, body: JSON.stringify({ title: 'Synthetic generation; real deployment' }) })
if (!response.ok) throw new Error(`Create test session HTTP ${response.status}`)
const info = await response.json()
// OpenCode orders messages by their sortable IDs, not insertion order.
const stamp = Date.now().toString(16)
let sequence = 0
const id = prefix => prefix + '_' + stamp + String(sequence++).padStart(4, '0') + randomBytes(6).toString('hex')
const now = Date.now(), user = id('msg'), assistant = id('msg')
const messages = [
  { info: { id: user, sessionID: info.id, role: 'user', time: { created: now }, agent: 'build', model: { providerID: 'fixture', modelID: 'fixture' } },
    parts: [{ id: id('prt'), sessionID: info.id, messageID: user, type: 'text', text: env.COMMENT_BODY || 'Build a fixture' }] },
  { info: { id: assistant, sessionID: info.id, role: 'assistant', parentID: user, time: { created: now, completed: now + 1 }, modelID: 'fixture', providerID: 'fixture', mode: 'build', agent: 'build', path: { cwd: env.PROJECT_DIR, root: env.GITHUB_WORKSPACE }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'stop' },
    parts: [{ id: id('prt'), sessionID: info.id, messageID: assistant, type: 'text', text: 'Copied the fixture project. Run the production checkpoint, startup, capture, and deployment pipeline.' }] }
]
const file = join(env.OPENCODE_WEB_DIR, 'synthetic-session.json')
writeFileSync(file, JSON.stringify({ info, messages }))
try {
  command(binary, ['import', file], { cwd: env.PROJECT_DIR })
  const saved = exportSession(binary, info.id, env.PROJECT_DIR, env.RUNNER_TEMP)
  if (saved.messages?.at(-1)?.info?.id !== assistant) throw new Error('Synthetic response import failed')
  writeFileSync(join(env.OPENCODE_WEB_DIR, 'synthetic-session-id'), info.id)
  writeFileSync(join(env.OPENCODE_WEB_DIR, 'opencode-run.exit'), '0')
} finally { rmSync(file, { force: true }) }
