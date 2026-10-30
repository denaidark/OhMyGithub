// Keep V2's API contract separate from the production V1 lifecycle.
const idPattern = /^ses_[A-Za-z0-9]+$/
const messagePattern = /^msg_[A-Za-z0-9]+$/

export function normalizeV2Version(output) {
  const match = /^opencode v(2\.\d+\.\d+)$/.exec(String(output).trim())
  if (!match) throw new Error('Expected a stable OpenCode 2 version')
  return match[1]
}

export function classifyV2Event(event, sessionID) {
  if (!idPattern.test(sessionID) || event?.data?.sessionID !== sessionID) return null
  switch (event.type) {
    case 'session.execution.started': return 'busy'
    case 'session.execution.succeeded': return 'completed'
    case 'session.execution.interrupted': return 'interrupted'
    case 'session.execution.failed': return 'failed'
    default: return null
  }
}

export function createV2Client({ base, password, request = fetch }) {
  const origin = new URL(base)
  if (!['http:', 'https:'].includes(origin.protocol) || !password) throw new Error('Require an OpenCode V2 server and password')
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  const pathFor = (id, suffix = '') => {
    if (!idPattern.test(id)) throw new Error('Invalid session ID')
    return `/api/session/${id}${suffix}`
  }
  async function call(path, { method = 'GET', body, signal } = {}) {
    const response = await request(new URL(path, origin), {
      method, headers: { authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal || AbortSignal.timeout(30000)
    })
    if (!response.ok) throw new Error(`OpenCode V2 ${method} ${path} returned HTTP ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }
  return {
    info: () => call('/api/info'),
    async session(id) { return (await call(pathFor(id))).data },
    async messages(id) { return (await call(pathFor(id, '/message'))).data },
    async active() { return (await call('/api/session/active')).data },
    async prompt(id, text) {
      if (typeof text !== 'string' || !text.trim()) throw new Error('Require a prompt')
      return (await call(pathFor(id, '/prompt'), { method: 'POST', body: { text } })).data
    },
    async fork(id, before) {
      if (before !== undefined && !messagePattern.test(before)) throw new Error('Invalid fork boundary')
      return (await call(pathFor(id, '/fork'), { method: 'POST', body: before ? { before } : {} })).data
    },
    interrupt(id) { return call(pathFor(id, '/interrupt'), { method: 'POST' }) },
    async snapshot(id) {
      const [active, messages] = await Promise.all([this.active(), this.messages(id)])
      if (!active || typeof active !== 'object' || !Array.isArray(messages)) throw new Error('Invalid V2 session snapshot')
      return { id, busy: Object.hasOwn(active, id), messages }
    },
    async *events({ signal } = {}) {
      const response = await request(new URL('/api/event', origin), {
        headers: { authorization, accept: 'text/event-stream' }, signal
      })
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        throw new Error(`OpenCode V2 event stream returned HTTP ${response.status}`)
      }
      const decoder = new TextDecoder()
      let buffer = ''
      for await (const chunk of response.body) {
        buffer = (buffer + decoder.decode(chunk, { stream: true })).replaceAll('\r\n', '\n')
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
          if (data) yield JSON.parse(data)
        }
        if (buffer.length > 1024 * 1024) throw new Error('OpenCode V2 event frame exceeds the limit')
      }
    }
  }
}

export function finishedV2Message(snapshot) {
  if (snapshot.busy || !Array.isArray(snapshot.messages)) return null
  const latest = snapshot.messages.find(message => message.type === 'assistant' || message.type === 'user')
  return latest?.type === 'assistant' && !latest.error && messagePattern.test(latest.id || '') ? latest.id : null
}

export function validateV2Session(session) {
  if (!idPattern.test(session?.info?.id || '') || session.info.fork || session.info.parentID ||
      !Array.isArray(session.messages) || !session.messages.length ||
      session.messages.some(message => typeof message?.type !== 'string')) throw new Error('Invalid V2 main-session transcript')
  return session
}
