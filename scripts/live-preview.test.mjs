import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from './default-start.mjs'

test('static live preview signals source changes without changing the manual preview', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omgithub-live-'))
  const previousPort = process.env.PORT
  process.env.PORT = '0'
  writeFileSync(join(root, 'index.html'), '<html><body>first</body></html>')
  const server = await start(root)
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
    if (previousPort === undefined) delete process.env.PORT
    else process.env.PORT = previousPort
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const plain = await (await fetch(base)).text()
  const live = await (await fetch(`${base}/?omgithub_live=1`)).text()
  assert.equal(plain, '<html><body>first</body></html>')
  assert.match(live, /EventSource\('\/__omgithub\/live'\)/)
  assert.match(live, /postMessage\(\{ type: 'omgithub:live-change' \}/)

  const controller = new AbortController()
  const response = await fetch(`${base}/__omgithub/live`, { signal: controller.signal })
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const reader = response.body.getReader()
  await reader.read()
  let timeout
  const changed = Promise.race([
    reader.read(),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('No live update received')), 3000) })
  ])
  writeFileSync(join(root, 'index.html'), '<html><body>second</body></html>')
  try { assert.match(new TextDecoder().decode((await changed).value), /event: change/) }
  finally { clearTimeout(timeout) }
  controller.abort()
})
