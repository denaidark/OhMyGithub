import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const cli = process.env.PLAYWRIGHT_CLI || 'playwright-cli'
const runtime = process.env.PLAYWRIGHT_ROOT
assert.ok(runtime, 'Set PLAYWRIGHT_ROOT to the CLI installation directory')
const evidence = process.env.EVIDENCE_DIR || '/tmp/omgithub-wip-capture'
mkdirSync(evidence, { recursive: true })
const web = mkdtempSync(join(tmpdir(), 'wip-real-'))
const project = createServer((req, res) => res.end('<html><body style="background:#181818;color:white"><h1>Project under construction</h1><canvas width="600" height="240"></canvas><script>let c=document.querySelector("canvas").getContext("2d");c.fillStyle="#ff6719";c.fillRect(20,20,500,200)</script></body></html>'))
const reference = createServer((req, res) => res.end('<h1>Reference website</h1>'))
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const started = Date.now(), sessions = ['wip-main-test', 'wip-child-test']
const env = { ...process.env, CI: '1', OMGITHUB_CAPTURE_WEB_DIR: web, OMGITHUB_PLAYWRIGHT_ROOT: runtime,
  NODE_OPTIONS: `--require=${fileURLToPath(new URL('./wip-screenshot-hook.cjs', import.meta.url))}` }
const run = async (...args) => {
  const start = Date.now()
  try { return await promisify(execFile)(cli, args, { env, cwd: evidence, timeout: 60000, maxBuffer: 1024 * 1024 }) }
  finally { console.log(`[timing] playwright-cli ${args[1] || args[0]}: ${Date.now() - start} ms`) }
}
try {
  await listen(project); await listen(reference)
  const url = `http://127.0.0.1:${project.address().port}`
  writeFileSync(join(web, 'app-url'), url)
  const config = join(web, 'config.json')
  writeFileSync(config, JSON.stringify({ browser: { browserName: 'chromium', launchOptions: { headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) } } }))
  for (const session of sessions) await run(`-s=${session}`, 'open', url, `--config=${config}`)
  await run(`-s=${sessions[0]}`, 'screenshot', `--filename=${resolve(evidence, 'project.png')}`)
  await run(`-s=${sessions[1]}`, 'run-code', `async page => { await page.locator('canvas').screenshot({path:${JSON.stringify(resolve(evidence, 'canvas.png'))}}); }`)
  const queue = join(web, 'wip-queue')
  const items = () => readdirSync(queue).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(queue, name))))
  assert.equal(items().length, 2, 'collect screenshot and run-code/locator captures from both browser sessions')
  assert.ok(items().every(item => item.page_url === url + '/'))
  await run(`-s=${sessions[1]}`, 'goto', `http://127.0.0.1:${reference.address().port}`)
  await run(`-s=${sessions[1]}`, 'screenshot', `--filename=${resolve(evidence, 'reference.png')}`)
  assert.equal(items().length, 2, 'exclude a reference website even on localhost')
  await run(`-s=${sessions[0]}`, 'screenshot', `--filename=${resolve(evidence, 'duplicate.png')}`)
  assert.equal(items().length, 2, 'deduplicate identical captures')
  console.log(JSON.stringify({ ok: true, captures: items().length, elapsedMs: Date.now() - started, evidence }))
} finally {
  for (const session of sessions) await run(`-s=${session}`, 'close').catch(() => {})
  project.close(); reference.close(); rmSync(web, { recursive: true, force: true })
}
