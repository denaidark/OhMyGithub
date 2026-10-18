import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startLiveFiles } from './live-files/server.mjs'

const workflow = readFileSync(new URL('../.github/workflows/opencode-reusable.yml', import.meta.url), 'utf8')

test('live source browser lists directories and transforms explicit HTML and package/CSS imports', async t => {
  const root = mkdtempSync(join(tmpdir(), 'live-files-'))
  const state = mkdtempSync(join(tmpdir(), 'live-files-state-'))
  const put = (name, content) => writeFileSync(join(root, name), content)
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'a folder'))
  mkdirSync(join(root, 'node_modules', 'fixture-package'), { recursive: true })
  put('package.json', JSON.stringify({ type: 'module', dependencies: { 'fixture-package': '1.0.0' } }))
  put('node_modules/fixture-package/package.json', JSON.stringify({ name: 'fixture-package', version: '1.0.0', type: 'module', exports: './index.js' }))
  put('node_modules/fixture-package/index.js', 'export const value = 42;')
  const html = '<h1>Live app</h1><script type="module" src="/src/main.js"></script>'
  put('index.html', html)
  put('src/main.js', "import './style.css'; import { value } from 'fixture-package'; document.body.dataset.value = value;")
  put('src/style.css', 'body { color: red }')
  put('a folder/notes.md', '# Notes')
  put('start.sh', '#!/bin/bash\necho hello\n')
  put('asset.wasm', Buffer.from([0, 97, 115, 109]))
  const server = await startLiveFiles({ root, cacheDir: join(state, 'cache') })
  t.after(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  const listing = await fetch(base + '/')
  assert.match(await listing.text(), /index\.html/)
  assert.match(listing.headers.get('cache-control'), /no-cache/)
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), html, 'do not replace project HTML with a listing template')
  const page = await (await fetch(base + '/index.html')).text()
  assert.match(page, /\/\@vite\/client/)
  assert.match(page, /Live app/)
  const script = await fetch(base + '/src/main.js')
  assert.match(script.headers.get('content-type'), /javascript/)
  const module = await script.text()
  assert.doesNotMatch(module, /from ['"]fixture-package['"]/)
  const dependency = module.match(/from\s*["']([^"']+)["']/)?.[1]
  assert.ok(dependency, module)
  const dep = await fetch(base + dependency)
  assert.equal(dep.status, 200)
  assert.match(dep.headers.get('content-type'), /javascript/)
  const cssModule = await fetch(base + '/src/style.css', { headers: { Accept: '*/*' } })
  assert.match(cssModule.headers.get('content-type'), /javascript/)
  assert.match(await cssModule.text(), /updateStyle/)
  const cssFile = await fetch(base + '/src/style.css?direct')
  assert.match(cssFile.headers.get('content-type'), /text\/css/)
  assert.match(await (await fetch(base + '/src/')).text(), /main\.js/)
  const redirect = await fetch(base + '/a%20folder?browse=1', { redirect: 'manual' })
  assert.equal(redirect.headers.get('location'), '/a%20folder/?browse=1')
  assert.match(await (await fetch(base + '/a%20folder/')).text(), /notes\.md/)
  for (const path of ['/a%20folder/notes.md', '/start.sh']) {
    const response = await fetch(base + path)
    assert.match(response.headers.get('content-type'), /text\/plain/)
  }
  assert.match((await fetch(base + '/asset.wasm')).headers.get('content-type'), /application\/wasm/)
  assert.equal((await fetch(base + '/missing.js')).status, 404)
  assert.equal((await fetch(base + '/missing-page', { headers: { Accept: 'text/html' } })).status, 404)
  const head = await fetch(base + '/start.sh', { method: 'HEAD' })
  assert.equal(await head.text(), '')
  put('added.html', '<h1>Added after startup</h1>')
  assert.match(await (await fetch(base + '/added.html')).text(), /Added after startup/)

  // Observe Vite's real HMR transport rather than asserting only injected markup.
  const socket = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}/?token=${server.config.webSocketToken}`, 'vite-hmr')
  t.after(() => socket.close())
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const update = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No HMR update received')), 5000)
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.type === 'update' || message.type === 'full-reload') { clearTimeout(timeout); resolve(message) }
    })
  })
  put('src/style.css', 'body { color: blue }')
  assert.ok(await update)
  socket.close()
})

test('workflow separates OpenCode and files while retaining the final-preview tunnel', () => {
  const startup = readFileSync(new URL('./start-live-files.sh', import.meta.url), 'utf8')
  assert.match(startup, /npm ci --prefix "\$RUNTIME_DIR\/scripts\/live-files"/)
  assert.match(startup, /scripts\/live-files\/server\.mjs/)
  assert.match(workflow, /scripts\/start-live-files\.sh/)
  assert.match(workflow, /files-cloudflared\.log/)
  assert.match(workflow, /files-cloudflared\.pid/)
  assert.match(workflow, /files-url/)
  assert.match(workflow, /for tunnel in web app files/)
  assert.match(workflow, /\[\[ -n "\$WEB_URL" && -n "\$APP_URL" && -n "\$FILES_URL" \]\]/)
  assert.doesNotMatch(workflow, /nginx|omgithub\/files\//i)
  const controller = readFileSync(new URL('./session-lifecycle.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(controller, /nginx|omgithub\/files\//i)
})
