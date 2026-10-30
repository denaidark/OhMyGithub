import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { isV2MainInterrupt, isV2MainPrompt } from './session-lifecycle-v2.mjs'

// Proxy the V2 web client while draining validation before main-session input.
export function createV2Proxy({ upstream, bridge, sessionID }) {
  const target = new URL(upstream)
  if (target.protocol !== 'http:') throw new Error('Require a local HTTP V2 server')
  let messageGate = Promise.resolve()
  const server = createServer(async (req, res) => {
    try {
      if (isV2MainPrompt(req.method, req.url, sessionID)) {
        const gate = messageGate.then(() => bridge.beforePrompt())
        messageGate = gate.catch(() => {})
        await gate
      } else if (isV2MainInterrupt(req.method, req.url, sessionID)) {
        bridge.beforeInterrupt()
      }
      const remote = httpRequest(new URL(req.url, target), { method: req.method, headers: req.headers }, reply => {
        res.writeHead(reply.statusCode, reply.headers)
        reply.pipe(res)
      })
      remote.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
      req.on('aborted', () => remote.destroy())
      res.on('close', () => remote.destroy())
      req.pipe(remote)
    } catch {
      if (!res.headersSent) res.writeHead(503)
      res.end('V2 lifecycle controller unavailable')
    }
  })
  server.on('upgrade', (req, socket, head) => {
    const remote = connect(Number(target.port || 80), target.hostname, () => {
      remote.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
      remote.write(head)
      socket.pipe(remote); remote.pipe(socket)
    })
    remote.on('error', () => socket.destroy())
    socket.on('error', () => remote.destroy())
  })
  return server
}
