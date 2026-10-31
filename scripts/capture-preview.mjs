#!/usr/bin/env node
// Capture desktop + mobile evidence for the running preview.
// Exit 75: temporary browser/navigation infrastructure failure (safe to retry).
// Exit 1:  script or rendering defect.
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const url = process.env.CAPTURE_URL
const outputDir = process.env.CAPTURE_DIR

if (!url || !outputDir) {
  console.error('Set CAPTURE_URL and CAPTURE_DIR.')
  process.exit(1)
}

const runtime = process.env.PLAYWRIGHT_RUNTIME || join(process.env.HOME, '.local/share/omgithub-playwright')
const require = createRequire(join(runtime, 'package.json'))

let chromium
let config = {}
try {
  ;({ chromium } = require('playwright'))
  const platform = process.platform === 'darwin' ? 'metal.json' : 'linux.json'
  config = JSON.parse(readFileSync(join(runtime, platform), 'utf8'))
} catch (error) {
  console.error(`[capture] browser runtime unavailable: ${error.message}`)
  process.exit(75)
}
if (process.platform === 'linux' && !process.env.DISPLAY) {
  try {
    process.env.DISPLAY = ':' + readFileSync(join(runtime, 'display'), 'utf8').trim()
  } catch {
    process.env.DISPLAY = ':0'
  }
}

mkdirSync(outputDir, { recursive: true })

const views = [
  ['desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
  ['mobile', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
]
const transientStatuses = new Set([408, 429, 500, 502, 503, 504])

class CaptureError extends Error {
  constructor(message, exitCode) {
    super(message)
    this.exitCode = exitCode
  }
}

const transient = (error) => {
  if (error?.exitCode) return error
  return new CaptureError(error?.message || String(error), 75)
}

let browser
let exitCode = 0

try {
  browser = await chromium.launch({ ...config.browser?.launchOptions, timeout: 30000 }).catch((error) => {
    throw transient(error)
  })

  for (const [name, contextOptions] of views) {
    const context = await browser.newContext(contextOptions).catch((error) => { throw transient(error) })
    const page = await context.newPage()
    page.setDefaultTimeout(30000)
    page.on('pageerror', (error) => console.error(`[capture] page error (${name}): ${error.message}`))

    let response
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout: 45000 })
    } catch (error) {
      throw transient(error)
    }
    if (!response) throw new CaptureError(`No HTTP response loading ${url}`, 75)
    if (!response.ok()) {
      throw new CaptureError(`HTTP ${response.status()} loading ${url}`, transientStatuses.has(response.status()) ? 75 : 1)
    }

    try {
      await page.locator('canvas, main, #app, #game, body > *').first().waitFor({ state: 'visible', timeout: 15000 })
    } catch (error) {
      throw new CaptureError(`Rendered content did not appear: ${error.message}`, 1)
    }

    // Require real pixels, not just a mounted (blank) canvas.
    try {
      await page.waitForFunction(() => {
        const canvas = document.querySelector('canvas')
        if (!canvas || !canvas.width || !canvas.height) return true
        const context = canvas.getContext('2d')
        if (!context) return true
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
        let lit = 0
        for (let i = 0; i < data.length; i += 4 * 53) {
          if (data[i] + data[i + 1] + data[i + 2] > 40) lit++
          if (lit > 60) return true
        }
        return false
      }, null, { timeout: 15000 })
    } catch (error) {
      throw new CaptureError(`Canvas stayed blank (${name}): ${error.message}`, 1)
    }

    // Start play without guessing at app-specific controls.
    const canvas = page.locator('canvas').first()
    if (await canvas.count()) {
      const box = await canvas.boundingBox().catch(() => null)
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    }

    const hasHook = await page.evaluate(() => Boolean(window.__pong?.state))
    if (hasHook) {
      try {
        await page.waitForFunction(() => window.__pong?.state?.mode === 'playing', null, { timeout: 5000 })
      } catch (error) {
        throw new CaptureError(`Game did not enter play after a click: ${error.message}`, 1)
      }
    }

    await page.waitForTimeout(1400)
    const file = join(outputDir, `final-${name}.png`)
    try {
      await page.screenshot({ path: file, timeout: 30000 })
    } catch (error) {
      if (error.name === 'TimeoutError' || !browser.isConnected()) throw transient(error)
      throw new CaptureError(`Screenshot failed (${name}): ${error.message}`, 1)
    }

    const stats = statSync(file)
    const signature = readFileSync(file).subarray(0, 8).toString('hex')
    if (stats.size < 24 || signature !== '89504e470d0a1a0a') {
      throw new CaptureError(`Invalid PNG written for ${name}`, 1)
    }
    const state = hasHook ? await page.evaluate(() => window.__pong.state) : null
    console.log(`[capture] ${name}: ${file} (${stats.size} bytes)${state ? ` mode=${state.mode} score=${state.score.join('-')}` : ''}`)
    await context.close().catch(() => {})
  }
} catch (error) {
  exitCode = error.exitCode || 1
  console.error(`[capture] ${exitCode === 75 ? 'transient' : 'defect'}: ${error.message}`)
} finally {
  if (browser) {
    try {
      await browser.close()
    } catch (error) {
      console.error(`[capture] browser close failed: ${error.message}`)
      if (!exitCode) exitCode = 75
    }
  }
}

process.exit(exitCode)
