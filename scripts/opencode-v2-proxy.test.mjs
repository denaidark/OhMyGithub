import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createV2Proxy } from './opencode-v2-proxy.mjs'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}

test('gate main prompts before forwarding and distinguish stops and fork prompts', async t => {
  let release
  const order = [], upstream = createServer((req, res) => { order.push(`forward:${req.url}`); res.end('ok') })
  const url = await listen(upstream)
  const bridge = { beforePrompt: () => { order.push('gate'); return new Promise(resolve => { release = resolve }) }, beforeInterrupt: () => order.push('stop') }
  const proxy = createV2Proxy({ upstream: url, bridge, sessionID: 'ses_main' })
  const base = await listen(proxy)
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close() })
  const pending = fetch(`${base}/api/session/ses_main/prompt`, { method: 'POST' })
  while (!release) await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(order, ['gate'])
  release()
  assert.equal(await (await pending).text(), 'ok')
  await fetch(`${base}/api/session/ses_child/prompt`, { method: 'POST' })
  await fetch(`${base}/api/session/ses_main/interrupt`, { method: 'POST' })
  assert.deepEqual(order, ['gate', 'forward:/api/session/ses_main/prompt', 'forward:/api/session/ses_child/prompt', 'stop', 'forward:/api/session/ses_main/interrupt'])
})

test('fail the request when the lifecycle gate cannot drain', async t => {
  const upstream = createServer((req, res) => res.end('unexpected'))
  const url = await listen(upstream)
  const proxy = createV2Proxy({ upstream: url, bridge: { beforePrompt: async () => { throw new Error('drain failed') } }, sessionID: 'ses_main' })
  const base = await listen(proxy)
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close() })
  assert.equal((await fetch(`${base}/api/session/ses_main/prompt`, { method: 'POST' })).status, 503)
})

test('close the upstream event stream when the client disconnects', async t => {
  let resolveClosed
  const closed = new Promise(resolve => { resolveClosed = resolve })
  const upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"type":"server.connected"}\n\n')
    res.on('close', resolveClosed)
  })
  const url = await listen(upstream)
  const proxy = createV2Proxy({ upstream: url, bridge: {}, sessionID: 'ses_main' })
  const base = await listen(proxy)
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close() })
  const response = await fetch(`${base}/api/event`)
  await response.body.cancel()
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream stream was not closed')), 2000))])
})
