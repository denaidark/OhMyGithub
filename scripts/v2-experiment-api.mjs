import { writeFileSync } from 'node:fs'
import { classifyV2Event, createV2Client, finishedV2Message } from './opencode-v2-api.mjs'

const [sessionID, output] = process.argv.slice(2)
const api = createV2Client({ base: 'http://127.0.0.1:4096', password: process.env.OPENCODE_PASSWORD })
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 90000)
try {
  const events = api.events({ signal: controller.signal })[Symbol.asyncIterator]()
  const initial = await events.next()
  if (initial.value?.type !== 'server.connected') throw new Error('V2 event stream did not connect')
  await api.prompt(sessionID, 'Reply exactly API_V2_OK. Do not use tools.')
  let sawStarted = false, sawComplete = false
  while (!sawComplete) {
    const next = await events.next()
    if (next.done) throw new Error('V2 event stream ended before completion')
    const kind = classifyV2Event(next.value, sessionID)
    if (kind === 'busy') sawStarted = true
    if (kind === 'failed' || kind === 'interrupted') throw new Error(`V2 session ${kind}`)
    if (kind === 'completed') sawComplete = true
  }
  if (!sawStarted) throw new Error('V2 session start event was not observed')
  controller.abort()
  let state
  for (let attempt = 0; attempt < 20; attempt++) {
    state = await api.snapshot(sessionID)
    if (!state.busy && finishedV2Message(state)) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const assistant = state?.messages?.find(row => row.id === finishedV2Message(state))
  if (!JSON.stringify(assistant?.content || []).includes('API_V2_OK')) throw new Error('V2 API prompt did not return the expected response')
  const fork = await api.fork(sessionID)
  if (!fork.id?.startsWith('ses_') || fork.fork?.sessionID !== sessionID) throw new Error('V2 fork was not linked to the main session')
  if ((await api.interrupt(fork.id)).interrupted !== false) throw new Error('An idle V2 fork was unexpectedly interrupted')
  writeFileSync(output, `${fork.id}\n`)
  console.log('V2 API prompt, execution events, session snapshot, fork and idle interrupt passed')
} finally {
  clearTimeout(timeout)
  controller.abort()
}
