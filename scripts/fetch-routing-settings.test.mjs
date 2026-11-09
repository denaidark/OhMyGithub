import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fetchRoutingSettings, resolveRouting } from './fetch-routing-settings.mjs'

function createMockServer(handler) {
  const server = createServer(handler)
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise(res => server.close(res))
      })
    })
  })
}

test('fetchRoutingSettings returns defaults when endpoint succeeds with defaults', async t => {
  const mock = await createMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ enable_warp: false, skip_direct_opencode: false }))
  })
  t.after(() => mock.close())
  
  const result = await fetchRoutingSettings({ origin: mock.origin })
  assert.deepEqual(result, { enable_warp: false, skip_direct_opencode: false })
})

test('fetchRoutingSettings returns admin settings when configured', async t => {
  const mock = await createMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ enable_warp: true, skip_direct_opencode: true }))
  })
  t.after(() => mock.close())
  
  const result = await fetchRoutingSettings({ origin: mock.origin })
  assert.deepEqual(result, { enable_warp: true, skip_direct_opencode: true })
})

test('fetchRoutingSettings returns defaults on error', async t => {
  const mock = await createMockServer((req, res) => {
    res.writeHead(500)
    res.end('Server error')
  })
  t.after(() => mock.close())
  
  const result = await fetchRoutingSettings({ origin: mock.origin })
  assert.deepEqual(result, { enable_warp: false, skip_direct_opencode: false })
})

test('fetchRoutingSettings returns defaults on timeout', async t => {
  const mock = await createMockServer((req, res) => {
    // Never respond - will timeout
  })
  t.after(() => mock.close())
  
  const result = await fetchRoutingSettings({ origin: mock.origin, timeout: 100 })
  assert.deepEqual(result, { enable_warp: false, skip_direct_opencode: false })
})

test('fetchRoutingSettings returns defaults on unreachable', async () => {
  const result = await fetchRoutingSettings({ origin: 'http://127.0.0.1:1', timeout: 100 })
  assert.deepEqual(result, { enable_warp: false, skip_direct_opencode: false })
})

// Route order tests based on requirements:
// - Both off: directOC → ondev
// - WARP on: directOC → WARP → ondev  
// - Skip on: ondev only
// - Both on: WARP → ondev

test('resolveRouting: both off = directOC then ondev (warp off, skipDirect false)', () => {
  const result = resolveRouting({
    userWarpRequested: false,
    adminSettings: { enable_warp: false, skip_direct_opencode: false },
    fusionEnabled: false,
    labels: []
  })
  assert.deepEqual(result, { warp: 'off', skipDirect: false })
})

test('resolveRouting: admin WARP on = directOC then WARP then ondev', () => {
  const result = resolveRouting({
    userWarpRequested: false,
    adminSettings: { enable_warp: true, skip_direct_opencode: false },
    fusionEnabled: false,
    labels: []
  })
  assert.deepEqual(result, { warp: 'on', skipDirect: false })
})

test('resolveRouting: user WARP on = directOC then WARP then ondev', () => {
  const result = resolveRouting({
    userWarpRequested: true,
    adminSettings: { enable_warp: false, skip_direct_opencode: false },
    fusionEnabled: false,
    labels: []
  })
  assert.deepEqual(result, { warp: 'on', skipDirect: false })
})

test('resolveRouting: skip on, WARP off = ondev only', () => {
  const result = resolveRouting({
    userWarpRequested: false,
    adminSettings: { enable_warp: false, skip_direct_opencode: true },
    fusionEnabled: false,
    labels: []
  })
  assert.deepEqual(result, { warp: 'off', skipDirect: true })
})

test('resolveRouting: both on = WARP then ondev', () => {
  const result = resolveRouting({
    userWarpRequested: false,
    adminSettings: { enable_warp: true, skip_direct_opencode: true },
    fusionEnabled: false,
    labels: []
  })
  assert.deepEqual(result, { warp: 'on', skipDirect: true })
})

test('resolveRouting: skip on with user WARP = WARP then ondev', () => {
  const result = resolveRouting({
    userWarpRequested: true,
    adminSettings: { enable_warp: false, skip_direct_opencode: true },
    fusionEnabled: false,
    labels: []
  })
  assert.deepEqual(result, { warp: 'on', skipDirect: true })
})

test('resolveRouting: Fusion skip preserved for Default without admin WARP', () => {
  const result = resolveRouting({
    userWarpRequested: true,
    adminSettings: { enable_warp: false, skip_direct_opencode: false },
    fusionEnabled: true,
    labels: []
  })
  assert.deepEqual(result, { warp: 'skip', skipDirect: false })
})

test('resolveRouting: admin WARP overrides Fusion skip', () => {
  const result = resolveRouting({
    userWarpRequested: false,
    adminSettings: { enable_warp: true, skip_direct_opencode: false },
    fusionEnabled: true,
    labels: []
  })
  assert.deepEqual(result, { warp: 'on', skipDirect: false })
})

test('resolveRouting: picked model with Fusion does not skip WARP', () => {
  const result = resolveRouting({
    userWarpRequested: true,
    adminSettings: { enable_warp: false, skip_direct_opencode: false },
    fusionEnabled: true,
    labels: ['model/opencode/deepseek-v4.1-flash-free']
  })
  assert.deepEqual(result, { warp: 'on', skipDirect: false })
})

test('today\'s default behavior reproduced: per-user WARP on, admin defaults', () => {
  // Current production: per-user WARP is on by default
  // Admin toggles default to OFF
  // Route should be: directOC → WARP → ondev (same as today)
  const result = resolveRouting({
    userWarpRequested: true,
    adminSettings: { enable_warp: false, skip_direct_opencode: false },
    fusionEnabled: false,
    labels: []
  })
  assert.deepEqual(result, { warp: 'on', skipDirect: false })
})

test('today\'s Fusion behavior reproduced: skip WARP for Default with Fusion', () => {
  // When Fusion is on and no model/* label: skip WARP
  // This behavior should be preserved
  const result = resolveRouting({
    userWarpRequested: true,
    adminSettings: { enable_warp: false, skip_direct_opencode: false },
    fusionEnabled: true,
    labels: []
  })
  assert.deepEqual(result, { warp: 'skip', skipDirect: false })
})
