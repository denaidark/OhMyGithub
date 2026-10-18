const { createHash } = require('node:crypto')
const { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } = require('node:fs')
const { join } = require('node:path')

function webDirectory(env) { return env.OMGITHUB_CAPTURE_WEB_DIR || env.OPENCODE_WEB_DIR }
function projectOrigins(env = process.env) {
  const directory = webDirectory(env)
  const port = env.APP_PORT || 3000
  const urls = [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]
  if (env.APP_URL) urls.push(env.APP_URL)
  if (directory) {
    try { urls.push(readFileSync(join(directory, 'app-url'), 'utf8').trim()) } catch {}
    // Register additional project servers explicitly; never infer from localhost.
    try { urls.push(...JSON.parse(readFileSync(join(directory, 'project-preview-origins.json'), 'utf8'))) } catch {}
  }
  return new Set(urls.flatMap(url => { try { return [new URL(url).origin] } catch { return [] } }))
}
function isProjectPage(url, env = process.env) {
  try { const parsed = new URL(url); return /^https?:$/.test(parsed.protocol) && projectOrigins(env).has(parsed.origin) } catch { return false }
}
function imageType(bytes) {
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  return ''
}
function queueScreenshot(bytes, metadata, env = process.env) {
  const web = webDirectory(env)
  if (!web || !isProjectPage(metadata.page_url, env) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 10 * 1024 * 1024) return null
  const type = imageType(bytes)
  if (!type) return null
  const hash = createHash('sha256').update(bytes).digest('hex'), dir = join(web, 'wip-queue')
  mkdirSync(dir, { recursive: true })
  if (existsSync(join(dir, `${hash}.json`)) || existsSync(join(dir, `${hash}.done`))) return hash
  const page = new URL(metadata.page_url); page.search = ''; page.hash = ''; page.username = ''; page.password = ''
  const value = { ...metadata, page_url: page.href, captured_at: metadata.captured_at || Date.now(), type, hash }
  try { writeFileSync(join(dir, `${hash}.image`), bytes, { flag: 'wx', mode: 0o600 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const temporary = join(dir, `${hash}.${process.pid}.tmp`)
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  renameSync(temporary, join(dir, `${hash}.json`))
  return hash
}

// Wrap public browser APIs so CLI screenshot, run-code, and locator captures
// use the same provenance, including captures that never become OC attachments.
function instrument(playwright, env = process.env) {
  const patched = Symbol.for('omgithub.wipScreenshot')
  function patchScreenshot(prototype, pageFor) {
    if (!prototype?.screenshot || prototype.screenshot[patched]) return
    const original = prototype.screenshot
    const wrapped = async function (...args) {
      const page = pageFor(this), page_url = page.url(), captured_at = Date.now()
      const bytes = await original.apply(this, args)
      if (page.url() === page_url) {
        try { queueScreenshot(bytes, { page_url, captured_at, browser_session: env.OMGITHUB_BROWSER_SESSION || '', session_id: env.OPENCODE_SESSION_ID || '' }, env) }
        catch (error) { console.error('WIP capture deferred:', error.message) }
      }
      return bytes
    }
    wrapped[patched] = true
    prototype.screenshot = wrapped
  }
  function pageReady(page) {
    patchScreenshot(Object.getPrototypeOf(page), page => page)
    patchScreenshot(Object.getPrototypeOf(page.locator('html')), locator => locator.page())
  }
  function contextReady(context) {
    for (const page of context.pages()) pageReady(page)
    context.on('page', pageReady)
    return context
  }
  function browserReady(browser) {
    for (const context of browser.contexts()) contextReady(context)
    const original = browser.newContext.bind(browser)
    browser.newContext = async (...args) => contextReady(await original(...args))
    return browser
  }
  for (const type of [playwright.chromium, playwright.firefox, playwright.webkit].filter(Boolean)) {
    for (const name of ['launch', 'connect', 'connectOverCDP', 'launchPersistentContext']) {
      if (!type[name] || type[name][patched]) continue
      const original = type[name].bind(type)
      const wrapped = async (...args) => name === 'launchPersistentContext' ? contextReady(await original(...args)) : browserReady(await original(...args))
      wrapped[patched] = true; type[name] = wrapped
    }
  }
}
module.exports = { projectOrigins, isProjectPage, imageType, queueScreenshot, instrument, webDirectory }
