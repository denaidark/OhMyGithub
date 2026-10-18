import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preparePreview } from './preview-setup.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'preview-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { PROJECT_DIR: root, RUNTIME_DIR: root, OPENCODE_WEB_DIR: root, APP_URL: 'https://preview.test' }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  writeFileSync(join(root, 'index.html'), '<h1>Ready</h1>')
  writeFileSync(join(root, 'deployment-output.json'), JSON.stringify({ project: root, directory: root }))
  const capture = () => {
    for (const name of ['final-desktop.png', 'final-mobile.png']) writeFileSync(join(root, name), png)
  }
  return { env, evidence: root, capture, wait: async () => {} }
}
test('runs startup and capture directly without OC', async t => {
  const f = fixture(t), calls = []
  const result = await preparePreview({ ...f, repair: () => assert.fail('unexpected OC'), run: async (file, args, options) => {
    calls.push(args)
    if (args.length === 1 && args[0].endsWith('/capture.sh')) {
      assert.equal(options.env.CAPTURE_URL, f.env.APP_URL)
      assert.equal(options.env.CAPTURE_DIR, f.evidence)
      f.capture()
    }
  } })
  assert.equal(calls.length, 3)
  assert.equal(result.repaired, false)
})
test('repairs missing startup then reruns scripts', async t => {
  const f = fixture(t)
  let repaired = false, repairs = 0
  const result = await preparePreview({ ...f, repair: async prompt => {
    repairs++; repaired = true
    assert.match(prompt, /Run every start/)
    assert.match(prompt, /Open and inspect both screenshots/)
  }, run: async (file, args) => {
    if (!repaired) throw new Error('missing start.sh')
    if (args.length === 1 && args[0].endsWith('/capture.sh')) f.capture()
  } })
  assert.equal(repairs, 1)
  assert.equal(result.repaired, true)
})
test('rejects stale screenshots and bounds repairs', async t => {
  const f = fixture(t)
  f.capture()
  let repairs = 0
  await assert.rejects(preparePreview({ ...f, run: async () => {}, repair: async () => { repairs++ } }), /after two repairs/)
  assert.equal(repairs, 2)
})
test('cancellation does not invoke repair', async t => {
  const f = fixture(t), controller = new AbortController()
  await assert.rejects(preparePreview({ ...f, signal: controller.signal, repair: () => assert.fail('repair after abort'),
    run: async () => { controller.abort(); throw new Error('Cancelled') } }), /Cancelled|aborted/)
})

test('retries readiness without OC and stops after bounded infrastructure failures', async t => {
  const f = fixture(t)
  let starts = 0
  await assert.rejects(preparePreview({ ...f, repair: () => assert.fail('infrastructure must not invoke OC'),
    run: async () => { starts++; throw Object.assign(new Error('not ready'), { exitCode: 75 }) }
  }))
  assert.equal(starts, 3)
})
test('retries capture without restarting the server', async t => {
  const f = fixture(t)
  let starts = 0, captures = 0
  const result = await preparePreview({ ...f, repair: () => assert.fail('unexpected repair'),
    run: async (file, args) => {
      if (args[0].endsWith('start-project.sh')) starts++
      if (args.length === 1 && args[0].endsWith('/capture.sh')) {
        if (++captures < 3) throw Object.assign(new Error('browser temporarily unavailable'), { exitCode: 75 })
        f.capture()
      }
    }
  })
  assert.equal(starts, 1)
  assert.equal(captures, 3)
  assert.equal(result.repaired, false)
})
test('includes capture stderr in repair diagnostics', async t => {
  const f = fixture(t)
  let repaired = false
  await preparePreview({ ...f, repair: async prompt => { assert.match(prompt, /capture-specific defect/); repaired = true },
    run: async (file, args, options) => {
      if (args.length === 1 && args[0].endsWith('/capture.sh')) {
        if (!repaired) { writeFileSync(options.stdio[2], 'capture-specific defect\n'); throw new Error('capture failed') }
        f.capture()
      }
    }
  })
})
test('persistent DNS capture errors never invoke OC', async t => {
  const f = fixture(t)
  let captures = 0
  await assert.rejects(preparePreview({ ...f, repair: () => assert.fail('DNS must not invoke repair'),
    run: async (file, args, options) => {
      if (args.length === 1 && args[0].endsWith('/capture.sh')) {
        captures++
        writeFileSync(options.stdio[2], 'net::ERR_NAME_NOT_RESOLVED')
        throw Object.assign(new Error('navigation failed'), { exitCode: 75 })
      }
    }
  }))
  assert.equal(captures, 3)
})


test('repair external build output before accepting captures or beginning an upload', async t => {
  const f = fixture(t), external = mkdtempSync(join(tmpdir(), 'external-preview-'))
  t.after(() => rmSync(external, { recursive: true, force: true }))
  writeFileSync(join(external, 'index.html'), 'preview')
  writeFileSync(join(f.env.PROJECT_DIR, 'deployment-output.json'), JSON.stringify({ project: f.env.PROJECT_DIR, directory: external }))
  let repairs = 0, captures = 0
  const result = await preparePreview({ ...f, repair: async prompt => {
    repairs++; assert.equal(captures, 0)
    assert.match(prompt, /Deployment output must be inside the project/)
    assert.match(prompt, /not OPENCODE_WEB_DIR or RUNNER_TEMP/)
    writeFileSync(join(f.env.PROJECT_DIR, 'deployment-output.json'), JSON.stringify({ project: f.env.PROJECT_DIR, directory: f.env.PROJECT_DIR }))
  }, run: async (file, args) => {
    if (args.length === 1 && args[0].endsWith('/capture.sh')) { captures++; f.capture() }
  } })
  assert.equal(result.repaired, true); assert.equal(repairs, 1); assert.equal(captures, 1)
})
