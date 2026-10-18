import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { publicUrlReady } from './public-readiness.mjs'

const exec = promisify(execFile)
const marker = `omgithub-dns-${Date.now()}`
const server = createServer((req, res) => res.end(marker))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let tunnel, log = ''
const started = Date.now()
try {
  tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${server.address().port}`])
  tunnel.on('error', error => { log += error.message })
  for (const stream of [tunnel.stdout, tunnel.stderr]) stream.on('data', chunk => { log += chunk; process.stdout.write(chunk) })
  let passed = false
  while (Date.now() - started < 300000) {
    if (tunnel.exitCode !== null) throw new Error(`Tunnel exited: ${tunnel.exitCode}`)
    const url = log.match(/\|\s*(https:\/\/[a-z0-9-]+\.trycloudflare\.com)\s*\|/)?.[1]
    if (url && await publicUrlReady(url)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
      if (await response.text() !== marker) throw new Error('Node fetched unexpected origin content')
      const { stdout: body } = await exec('curl', ['--fail', '--silent', '--show-error', '--max-time', '15', url], { encoding: 'utf8' })
      if (body !== marker) throw new Error('curl fetched unexpected origin content')
      console.log(`PASS: fresh tunnel works through normal Node and curl DNS: ${url}`)
      passed = true
      break
    }
    console.log(`Waiting for public DNS/HTTPS readiness (${Date.now() - started} ms)`)
    await delay(5000)
  }
  if (!passed) throw new Error('Fresh tunnel failed public readiness within five minutes')
} finally {
  tunnel?.kill('SIGTERM')
  server.closeAllConnections()
  server.close()
  console.log(`[timing] tunnel smoke test: ${Date.now() - started} ms`)
}
