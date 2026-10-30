import { writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { classifyV2Event, createV2Client, finishedV2Message } from './opencode-v2-api.mjs'
import { V2LifecycleBridge } from './session-lifecycle-v2.mjs'
import { createV2Proxy } from './opencode-v2-proxy.mjs'
import { Lifecycle } from './session-lifecycle.mjs'

const [sessionID, output] = process.argv.slice(2)
const api = createV2Client({ base: 'http://127.0.0.1:4096', password: process.env.OPENCODE_PASSWORD })
let completedMessage = '', failure = '', stateName = ''
const lifecycle = new Lifecycle({
  save: async () => {
    const session = await api.export(sessionID)
    writeFileSync(`${output}.checkpoint.json`, JSON.stringify(session), { mode: 0o600 })
    return { sessionID: session.info.id }
  },
  deploy: async ({ checkpoint, messageID }) => {
    if (checkpoint.sessionID !== sessionID) throw new Error('V2 lifecycle saved the wrong main session')
    const fork = await api.fork(sessionID)
    if (!fork.id?.startsWith('ses_') || fork.fork?.sessionID !== sessionID) throw new Error('V2 fork was not linked to the main session')
    if ((await api.interrupt(fork.id)).interrupted !== false) throw new Error('An idle V2 fork was unexpectedly interrupted')
    writeFileSync(output, `${fork.id}\n`)
    completedMessage = messageID
  },
  status: async (state, generation, error) => { stateName = state; if (state === 'failed') failure = error || 'lifecycle failed' }
})
const bridge = new V2LifecycleBridge({ api, sessionID, lifecycle, onError: error => { failure = error.message } })
async function waitReady(messageID) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure) throw new Error(failure)
    if (stateName === 'ready' && completedMessage === messageID) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('V2 lifecycle did not save and validate the session')
}
const proxy = createV2Proxy({ upstream: 'http://127.0.0.1:4096', bridge, sessionID })
proxy.listen(0, '127.0.0.1')
await once(proxy, 'listening')
const proxied = createV2Client({ base: `http://127.0.0.1:${proxy.address().port}`, password: process.env.OPENCODE_PASSWORD })
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 90000)
try {
  const events = proxied.events({ signal: controller.signal })[Symbol.asyncIterator]()
  const initial = await events.next()
  if (initial.value?.type !== 'server.connected') throw new Error('V2 event stream did not connect')
  await proxied.prompt(sessionID, 'Reply exactly API_V2_OK. Do not use tools.')
  let sawStarted = false, sawComplete = false
  while (!sawComplete) {
    const next = await events.next()
    if (next.done) throw new Error('V2 event stream ended before completion')
    const kind = classifyV2Event(next.value, sessionID)
    await bridge.observe(next.value)
    if (kind === 'busy') sawStarted = true
    if (kind === 'failed' || kind === 'interrupted') throw new Error(`V2 session ${kind}`)
    if (kind === 'completed') sawComplete = true
  }
  if (!sawStarted) throw new Error('V2 session start event was not observed')
  let state
  for (let attempt = 0; attempt < 20; attempt++) {
    state = await api.snapshot(sessionID)
    if (!state.busy && finishedV2Message(state)) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const assistant = state?.messages?.find(row => row.id === finishedV2Message(state))
  if (!JSON.stringify(assistant?.content || []).includes('API_V2_OK')) throw new Error('V2 API prompt did not return the expected response')
  await bridge.reconcile()
  await waitReady(assistant.id)
  const priorMessage = completedMessage
  await proxied.prompt(sessionID, 'Write a very long tutorial on game design, at least 5000 words. Do not use tools.')
  let stopSent = false, stopped = false
  while (!stopped) {
    const next = await events.next()
    if (next.done) throw new Error('V2 event stream ended before interrupt')
    const kind = classifyV2Event(next.value, sessionID)
    await bridge.observe(next.value)
    if (kind === 'busy' && !stopSent) {
      stopSent = true
      if (!(await proxied.interrupt(sessionID)).interrupted) throw new Error('V2 active session did not interrupt')
    }
    if (kind === 'failed' || (kind === 'completed' && !stopSent)) throw new Error(`V2 stop test unexpectedly ${kind}`)
    if (kind === 'interrupted') stopped = true
  }
  const stoppedState = await api.snapshot(sessionID)
  const stoppedMessage = finishedV2Message(stoppedState, { allowInterrupted: true })
  if (!stopSent || !stoppedMessage || stoppedMessage === priorMessage) throw new Error('V2 stopped session was not checkpointable')
  await waitReady(stoppedMessage)
  console.log('V2 proxy prompt, lifecycle save, execution events, active stop, fork and idle interrupt passed')
} finally {
  clearTimeout(timeout)
  controller.abort()
  proxy.closeAllConnections()
  proxy.close()
}
