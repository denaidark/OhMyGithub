import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provision } from './provision-project.mjs'
import { projectType, start } from './default-start.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'project-defaults-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
test('provisions no-op initialization and separate repeatable scripts without overwriting', t => {
  const root = fixture(t)
  provision(root)
  assert.equal(readFileSync(join(root, 'startup.sh'), 'utf8'), '#!/usr/bin/env bash\nset -euo pipefail\n')
  assert.match(readFileSync(join(root, 'start.sh'), 'utf8'), /default-start.mjs/)
  assert.match(readFileSync(join(root, 'capture.sh'), 'utf8'), /default-capture.mjs/)
  writeFileSync(join(root, 'startup.sh'), 'custom initialization')
  provision(root)
  assert.equal(readFileSync(join(root, 'startup.sh'), 'utf8'), 'custom initialization')
})
test('detects packages before HTML and rejects unsupported frameworks', t => {
  const root = fixture(t)
  assert.throws(() => projectType(root), /No generated/)
  writeFileSync(join(root, 'index.html'), '<h1>Hello</h1>')
  assert.equal(projectType(root), 'html')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { vite: '*' } }))
  assert.equal(projectType(root), 'vite')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '*' } }))
  assert.throws(() => projectType(root), /Unsupported framework/)
})
test('serves a generated HTML project using the default server', async t => {
  const root = fixture(t)
  writeFileSync(join(root, 'index.html'), '<h1>Ready</h1>')
  const old = process.env.PORT
  process.env.PORT = '0'
  const server = await start(root)
  if (old === undefined) delete process.env.PORT
  else process.env.PORT = old
  t.after(() => server.close())
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '<h1>Ready</h1>')
})
test('workflow initializes once after restore and before starting main', () => {
  const source = readFileSync(new URL('../.github/workflows/opencode-reusable.yml', import.meta.url), 'utf8')
  const init = source.indexOf('name: Initialize project worker')
  assert.ok(init > source.indexOf('name: Restore saved OpenCode conversation'))
  assert.ok(init < source.indexOf('name: Run OpenCode and locate'))
  assert.equal((source.match(/bash startup.sh/g) || []).length, 1)
})

test('builds and serves Vite output with the installed dependency cache', { skip: !process.env.VITE_TEST_MODULES }, async t => {
  const { symlinkSync, mkdirSync } = await import('node:fs')
  const { createHash } = await import('node:crypto')
  const modules = process.env.VITE_TEST_MODULES
  const root = fixture(t)
  const pkg = '{"devDependencies":{"vite":"*"}}'
  writeFileSync(join(root, 'package.json'), pkg)
  writeFileSync(join(root, 'index.html'), '<div>Vite fixture</div><script type="module" src="/main.js"></script>')
  writeFileSync(join(root, 'main.js'), 'document.body.dataset.ready="true"')
  symlinkSync(modules, join(root, 'node_modules'))
  const cache = join(root, '.runtime')
  mkdirSync(cache)
  writeFileSync(join(cache, 'default-dependencies'), createHash('sha256').update(pkg).digest('hex'))
  const oldPort = process.env.PORT, oldCache = process.env.OPENCODE_WEB_DIR
  process.env.PORT = '0'; process.env.OPENCODE_WEB_DIR = cache
  let server
  try { server = await start(root) }
  finally {
    if (oldPort === undefined) delete process.env.PORT; else process.env.PORT = oldPort
    if (oldCache === undefined) delete process.env.OPENCODE_WEB_DIR; else process.env.OPENCODE_WEB_DIR = oldCache
  }
  t.after(() => server.close())
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve))
  const html = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text()
  assert.match(html, /Vite fixture/)
  assert.match(html, /assets\//)
})
