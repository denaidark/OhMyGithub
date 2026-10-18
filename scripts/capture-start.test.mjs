import test from 'node:test'
import assert from 'node:assert/strict'
import { startForCapture } from './capture-start.mjs'

function fixture(controls) {
  return { locator: () => ({ all: async () => controls }), waitForTimeout: async () => {} }
}
function control(label, options = {}) {
  let clicks = 0
  const element = { textContent: label, closest: () => options.form || options.link || null,
    getAttribute: key => key === 'aria-label' ? options.ariaLabel : key === 'aria-disabled' ? options.ariaDisabled : null }
  return { isVisible: async () => !options.hidden, isEnabled: async () => !options.disabled,
    evaluate: async (fn, explicit) => fn(element, explicit), click: async ({ trial }) => {
      if (options.obscured) throw Object.assign(new Error('Obscured'), { name: 'TimeoutError' })
      if (!trial) clicks++
    }, get clicks() { return clicks } }
}
test('click exactly one common start button once', async () => {
  for (const label of ['Start', 'Play', 'START GAME', 'Play now', ' Start now ']) {
    const button = control(label)
    assert.deepEqual(await startForCapture(fixture([button]), { timeout: 0 }), { clicked: true })
    assert.equal(button.clicks, 1)
  }
})
test('skip links, forms, hidden, disabled, ambiguous and unrelated controls', async () => {
  for (const options of [{ link: true }, { form: true }, { hidden: true }, { disabled: true }, { ariaDisabled: 'true' }, { obscured: true }]) {
    const button = control('Play', options)
    assert.equal((await startForCapture(fixture([button]), { timeout: 0 })).clicked, false)
    assert.equal(button.clicks, 0)
  }
  const a = control('Start'), b = control('Play')
  assert.equal((await startForCapture(fixture([a, b]), { timeout: 0 })).reason, 'ambiguous')
  assert.equal(a.clicks + b.clicks, 0)
  for (const label of ['Restart', 'Play video', 'Start subscription', 'Start over']) assert.equal((await startForCapture(fixture([control(label)]), { timeout: 0 })).clicked, false)
})
test('support accessible labels, explicit selectors and opt-out', async () => {
  assert.equal((await startForCapture(fixture([control('▶', { ariaLabel: 'Play game' })]), { timeout: 0 })).clicked, true)
  assert.equal((await startForCapture(fixture([control('Enter village')]), { selector: '#enter', timeout: 0 })).clicked, true)
  assert.equal((await startForCapture({ locator: () => assert.fail('Must not inspect page') }, { enabled: false })).reason, 'disabled')
})

test('real browser: delayed startup, responsive screenshots, ambiguity and opt-out', { skip: !process.env.PLAYWRIGHT_MODULE }, async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE)
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) })
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, colorScheme: 'dark' })
      await page.setContent(`<style>body{margin:0;background:#101318;color:#eee;font:20px system-ui;display:grid;min-height:100vh;place-items:center}button{padding:20px;background:#30483b;color:#fff;border:0;border-radius:12px;font:inherit}</style><main><h1>Village capture fixture</h1><button hidden onclick="this.remove();document.querySelector('h1').textContent='Village running';window.starts=(window.starts||0)+1">Start game</button></main><script>setTimeout(()=>document.querySelector('button').hidden=false,150)</script>`)
      assert.equal((await startForCapture(page)).clicked, true)
      assert.equal(await page.evaluate(() => window.starts), 1)
      assert.equal(await page.locator('h1').textContent(), 'Village running')
      if (process.env.CAPTURE_TEST_DIR) await page.screenshot({ path: `${process.env.CAPTURE_TEST_DIR}/auto-start-${width}.png` })
      await page.setContent('<button>Start</button><button>Play</button>')
      assert.equal((await startForCapture(page)).reason, 'ambiguous')
      await page.setContent('<button onclick="window.clicked=true">Play</button>')
      assert.equal((await startForCapture(page, { enabled: false })).reason, 'disabled')
      assert.notEqual(await page.evaluate(() => window.clicked), true)
      await page.close()
    }
  } finally { await browser.close() }
})
