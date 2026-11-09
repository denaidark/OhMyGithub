import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTransportAdapter, RouteKind } from './transport-adapter.mjs'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'transport-adapter-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('TransportState', () => {
  test('direct route removes proxy settings', t => {
    const dir = tempDir(t)
    const logFile = join(dir, 'test.log')
    const adapter = createTransportAdapter({ 
      workDir: dir, 
      logFile,
      env: { 
        HTTPS_PROXY: 'http://proxy:8080',
        HTTP_PROXY: 'http://proxy:8080',
        https_proxy: 'http://proxy:8080',
        http_proxy: 'http://proxy:8080'
      }
    })
    
    const env = adapter.getEnvForRoute(RouteKind.DEEPSEEK_DIRECT)
    assert.equal(env.HTTPS_PROXY, undefined)
    assert.equal(env.HTTP_PROXY, undefined)
    assert.equal(env.https_proxy, undefined)
    assert.equal(env.http_proxy, undefined)
  })

  test('WARP route sets proxy when available', t => {
    const dir = tempDir(t)
    const logFile = join(dir, 'test.log')
    const adapter = createTransportAdapter({ workDir: dir, logFile, env: {} })
    adapter.warpReady = true
    adapter.warpProxy = 'http://127.0.0.1:40000'
    
    const env = adapter.getEnvForRoute(RouteKind.DEEPSEEK_WARP)
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:40000')
    assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:40000')
  })

  test('WARP route falls through when not available', t => {
    const dir = tempDir(t)
    const logFile = join(dir, 'test.log')
    const adapter = createTransportAdapter({ workDir: dir, logFile, env: {} })
    // warpReady = false by default
    
    const env = adapter.getEnvForRoute(RouteKind.DEEPSEEK_WARP)
    assert.equal(env.HTTPS_PROXY, undefined)
  })

  test('Fusion route preserves credentials', t => {
    const dir = tempDir(t)
    const logFile = join(dir, 'test.log')
    const adapter = createTransportAdapter({ 
      workDir: dir, 
      logFile,
      env: { 
        FUSION_ACCESS_TOKEN: 'test-token',
        FUSION_UPSTREAM: 'https://copilot.example.com'
      }
    })
    
    const env = adapter.getEnvForRoute(RouteKind.FUSION_DIRECT)
    assert.equal(env.FUSION_ACCESS_TOKEN, 'test-token')
    assert.equal(env.FUSION_UPSTREAM, 'https://copilot.example.com')
  })

  test('updateFusionCredentials updates state', t => {
    const dir = tempDir(t)
    const logFile = join(dir, 'test.log')
    const adapter = createTransportAdapter({ workDir: dir, logFile, env: {} })
    
    assert.equal(adapter.fusionToken, null)
    adapter.updateFusionCredentials('new-token', 'https://new-upstream.com')
    assert.equal(adapter.fusionToken, 'new-token')
    assert.equal(adapter.fusionUpstream, 'https://new-upstream.com')
    
    // Check it's reflected in route env
    const env = adapter.getEnvForRoute(RouteKind.FUSION_SHARED)
    assert.equal(env.FUSION_ACCESS_TOKEN, 'new-token')
    assert.equal(env.FUSION_UPSTREAM, 'https://new-upstream.com')
  })

  test('isRouteAvailable checks correct conditions', t => {
    const dir = tempDir(t)
    const logFile = join(dir, 'test.log')
    const adapter = createTransportAdapter({ workDir: dir, logFile, env: {} })
    
    // Direct always available
    assert.equal(adapter.isRouteAvailable(RouteKind.DEEPSEEK_DIRECT), true)
    
    // WARP not available without setup or lazy flag
    assert.equal(adapter.isRouteAvailable(RouteKind.DEEPSEEK_WARP), false)
    
    // WARP available with lazy flag
    adapter.env.WARP_LAZY = '1'
    assert.equal(adapter.isRouteAvailable(RouteKind.DEEPSEEK_WARP), true)
    
    // Ondev always available
    assert.equal(adapter.isRouteAvailable(RouteKind.DEEPSEEK_ONDEV), true)
    
    // Fusion direct requires token
    assert.equal(adapter.isRouteAvailable(RouteKind.FUSION_DIRECT), false)
    adapter.fusionToken = 'test-token'
    assert.equal(adapter.isRouteAvailable(RouteKind.FUSION_DIRECT), true)
    
    // Fusion shared always potentially available
    assert.equal(adapter.isRouteAvailable(RouteKind.FUSION_SHARED), true)
  })

  test('checkWarpStatus reads from status file', t => {
    const dir = tempDir(t)
    const logFile = join(dir, 'test.log')
    const warpDir = join(dir, 'warp')
    mkdirSync(warpDir, { recursive: true })
    
    const adapter = createTransportAdapter({ 
      workDir: dir, 
      logFile, 
      env: { RUNNER_TEMP: dir, OPENCODE_WEB_DIR: dir }
    })
    
    // No status file - not ready
    assert.equal(adapter.checkWarpStatus(), false)
    
    // Status file with ok - ready
    writeFileSync(join(warpDir, 'status.json'), JSON.stringify({ result: 'ok' }))
    writeFileSync(join(dir, 'opencode-proxy'), 'http://127.0.0.1:40000\n')
    assert.equal(adapter.checkWarpStatus(), true)
    assert.equal(adapter.warpReady, true)
    assert.equal(adapter.warpProxy, 'http://127.0.0.1:40000')
  })

  test('prepareRoute returns true for direct and ondev', async t => {
    const dir = tempDir(t)
    const logFile = join(dir, 'test.log')
    const adapter = createTransportAdapter({ workDir: dir, logFile, env: {} })
    
    assert.equal(await adapter.prepareRoute(RouteKind.DEEPSEEK_DIRECT), true)
    assert.equal(await adapter.prepareRoute(RouteKind.DEEPSEEK_ONDEV), true)
    assert.equal(await adapter.prepareRoute(RouteKind.FUSION_DIRECT), true)
    assert.equal(await adapter.prepareRoute(RouteKind.FUSION_SHARED), true)
  })
})

describe('route logging', () => {
  test('logs transport decisions', t => {
    const dir = tempDir(t)
    const logFile = join(dir, 'test.log')
    const adapter = createTransportAdapter({ workDir: dir, logFile, env: {} })
    
    adapter.getEnvForRoute(RouteKind.DEEPSEEK_DIRECT)
    adapter.getEnvForRoute(RouteKind.DEEPSEEK_ONDEV)
    
    const log = readFileSync(logFile, 'utf8')
    assert.match(log, /Transport: direct/)
    assert.match(log, /Transport: ondev\.store/)
  })
})
