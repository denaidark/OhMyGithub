import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyV2Event, createV2Client, finishedV2Message, normalizeV2Version, validateV2Session } from './opencode-v2-api.mjs'

test('normalize the V2 CLI version and reject incompatible versions', () => {
  assert.equal(normalizeV2Version('opencode v2.2.2\n'), '2.2.2')
  for (const value of ['1.19.5', 'opencode v1.19.5', 'opencode v2.2.2-beta']) assert.throws(() => normalizeV2Version(value))
})

test('classify lifecycle events only for the main session', () => {
  const sid = 'ses_abc123'
  for (const [type, expected] of [['started', 'busy'], ['succeeded', 'completed'], ['interrupted', 'interrupted'], ['failed', 'failed']]) {
    assert.equal(classifyV2Event({ type: `session.execution.${type}`, data: { sessionID: sid } }, sid), expected)
    assert.equal(classifyV2Event({ type: `session.execution.${type}`, data: { sessionID: 'ses_other' } }, sid), null)
  }
  assert.equal(classifyV2Event({ type: 'session.idle', data: { sessionID: sid } }, sid), null)
})

test('send V2 requests with the documented paths, payloads and wrapped responses', async () => {
  const calls = []
  const request = async (url, options) => {
    calls.push({ path: url.pathname, ...options })
    const data = url.pathname.endsWith('/message') ? [{ type: 'idle', outcome: 'succeeded' }, { id: 'msg_new', type: 'assistant' }] :
      url.pathname.endsWith('/active') ? {} : { id: 'ses_child' }
    return new Response(JSON.stringify({ data }), { status: 200 })
  }
  const client = createV2Client({ base: 'http://localhost:4096', password: 'local', request })
  assert.equal((await client.prompt('ses_main', '  exact prompt  ')).id, 'ses_child')
  assert.equal(JSON.parse(calls.at(-1).body).text, '  exact prompt  ')
  assert.equal((await client.fork('ses_main', 'msg_123')).id, 'ses_child')
  assert.deepEqual(JSON.parse(calls.at(-1).body), { before: 'msg_123' })
  await client.interrupt('ses_main')
  assert.equal(calls.at(-1).path, '/api/session/ses_main/interrupt')
  const snapshot = await client.snapshot('ses_main')
  assert.equal(snapshot.busy, false)
  assert.equal(finishedV2Message(snapshot), 'msg_new')
  assert.ok(calls.every(call => call.headers.authorization.startsWith('Basic ')))
  await assert.rejects(client.fork('ses_main', '../bad'), /boundary/)
  await assert.rejects(client.prompt('../bad', 'hello'), /session ID/)
})

test('handle busy sessions and validate V2 transcript structure', () => {
  assert.equal(finishedV2Message({ busy: true, messages: [{ id: 'msg_1', type: 'assistant' }] }), null)
  assert.equal(finishedV2Message({ busy: false, messages: [{ id: 'msg_user', type: 'user' }, { id: 'msg_old', type: 'assistant' }] }), null)
  assert.equal(finishedV2Message({ busy: false, messages: [{ type: 'idle', outcome: 'failed' }, { id: 'msg_old', type: 'assistant' }] }), null)
  assert.equal(finishedV2Message({ busy: false, messages: [{ type: 'idle', outcome: 'succeeded' }, { id: 'msg_new', type: 'assistant' }, { id: 'msg_old', type: 'assistant' }] }), 'msg_new')
  const stopped = { busy: false, messages: [{ type: 'idle', outcome: 'interrupted' }, { type: 'assistant', id: 'msg_stop', error: { type: 'aborted' } }] }
  assert.equal(finishedV2Message(stopped), null)
  assert.equal(finishedV2Message(stopped, { allowInterrupted: true }), 'msg_stop')
  assert.equal(finishedV2Message({ ...stopped, messages: [stopped.messages[0], { ...stopped.messages[1], error: { type: 'other' } }] }, { allowInterrupted: true }), null)
  const transcript = { info: { id: 'ses_123' }, messages: [{ type: 'user' }, { type: 'assistant' }, { type: 'idle' }] }
  assert.equal(validateV2Session(transcript), transcript)
  assert.throws(() => validateV2Session({ ...transcript, info: { id: 'ses_123', fork: { sessionID: 'ses_parent' } } }), /main-session/)
})

test('parse fragmented V2 server-sent events without confusing heartbeats', async () => {
  const encoder = new TextEncoder()
  const request = async () => new Response(new ReadableStream({
    start(controller) {
      for (const chunk of ['data: {"type":"server.', 'connected"}\r', '\n\r\n: heartbeat\n\n', 'data: {"type":"session.execution.succeeded",', '"data":{"sessionID":"ses_123"}}\n\n']) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  }), { headers: { 'content-type': 'text/event-stream' } })
  const api = createV2Client({ base: 'http://localhost', password: 'local', request })
  const events = []
  for await (const event of api.events()) events.push(event)
  assert.deepEqual(events.map(event => event.type), ['server.connected', 'session.execution.succeeded'])
  assert.equal(classifyV2Event(events[1], 'ses_123'), 'completed')
})
