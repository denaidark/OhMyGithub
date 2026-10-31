#!/usr/bin/env node
// Minimal dependency-free static file server for the built preview output.
import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'

const rootArg = process.argv[2] || process.env.SERVE_DIR
const port = Number(process.argv[3] || process.env.PORT || 3000)

if (!rootArg) {
  console.error('Usage: serve-static.mjs <directory> [port]')
  process.exit(1)
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid port: ${process.argv[3] || process.env.PORT}`)
  process.exit(1)
}

const root = resolve(rootArg)
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    send(res, 405, 'Method Not Allowed')
    return
  }
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  } catch {
    send(res, 400, 'Bad Request')
    return
  }
  if (pathname.includes('\0')) { send(res, 400, 'Bad Request'); return }

  let file = resolve(root, '.' + pathname)
  if (file !== root && !file.startsWith(root + sep)) { send(res, 404, 'Not Found'); return }

  try {
    let stats = statSync(file)
    if (stats.isDirectory()) {
      file = resolve(file, 'index.html')
      stats = statSync(file)
    }
    if (!stats.isFile()) { send(res, 404, 'Not Found'); return }
    res.writeHead(200, {
      'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': extname(file) === '.html' ? 'no-store' : 'public, max-age=60',
      'X-Content-Type-Options': 'nosniff',
    })
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(file).on('error', () => res.destroy()).pipe(res)
  } catch {
    send(res, 404, 'Not Found')
  }
})

server.on('error', (error) => {
  console.error(`[serve] ${error.code === 'EADDRINUSE' ? `port ${port} is already in use` : error.message}`)
  process.exit(1)
})
server.listen(port, '0.0.0.0', () => {
  console.log(`[serve] ${root} -> http://0.0.0.0:${port}/`)
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
