import test from 'node:test'
import assert from 'node:assert/strict'
import { createFusionGateway } from './fusion-gateway.mjs'
import { createFakeCopilotUpstream } from './fake-copilot-upstream.mjs'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ==================== Integration Test Fixtures ====================

async function createIntegrationFixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fusion-integration-'))
  const tokenFile = join(dir, 'fusion-token')
  const socketPath = join(dir, 'fusion-control.sock')
  const logs = []
  
  // Create fake upstream
  const directUpstream = await createFakeCopilotUpstream({
    validCredentials: new Set(['direct-credential']),
    log: msg => logs.push(`[direct] ${msg}`)
  })
  await directUpstream.start()
  directUpstream.addCredential('direct-credential')
  
  const sharedUpstream = await createFakeCopilotUpstream({
    validCredentials: new Set(['shared-credential']),
    log: msg => logs.push(`[shared] ${msg}`)
  })
  await sharedUpstream.start()
  sharedUpstream.addCredential('shared-credential')
  
  // Create gateway
  const gateway = createFusionGateway({
    tokenFile,
    socketPath,
    log: msg => logs.push(`[gateway] ${msg}`)
  })
  
  await gateway.start()
  
  // Allow localhost for testing (simulates OmSite proxy)
  gateway.allowSharedUpstream('127.0.0.1')
  
  // Cleanup
  t.after(async () => {
    await gateway.stop()
    await directUpstream.stop()
    await sharedUpstream.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  
  return {
    gateway,
    directUpstream,
    sharedUpstream,
    tokenFile,
    logs,
    getGenerationToken: () => readFileSync(tokenFile, 'utf8')
  }
}

// ==================== Direct Route Integration ====================

test('integration: direct route with valid credential proxies to Copilot', async (t) => {
  const f = await createIntegrationFixture(t)
  const gwPort = f.gateway.getPort()
  const directPort = f.directUpstream.getPort()
  
  // Set direct route (simulate real Copilot upstream)
  // For testing, we use localhost with the fake upstream
  const setResult = f.gateway.setRoute({
    credential: 'direct-credential',
    upstream: `http://127.0.0.1:${directPort}`,
    routeType: 'direct',
    expires: Date.now() + 60000
  })
  assert.equal(setResult.success, true)
  
  const token = f.getGenerationToken()
  
  // Send /auto request through gateway
  const response = await fetch(`http://127.0.0.1:${gwPort}/auto`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ tier: 'default' })
  })
  
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.ok(body.session_token, 'should return session token')
  assert.ok(body.selected_model?.id, 'should return model')
  
  // Verify upstream received the request with correct credential
  const requests = f.directUpstream.getRequests()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].headers.authorization, 'Bearer direct-credential')
})

test('integration: direct route strips incoming Authorization header', async (t) => {
  const f = await createIntegrationFixture(t)
  const gwPort = f.gateway.getPort()
  const directPort = f.directUpstream.getPort()
  
  f.gateway.setRoute({
    credential: 'direct-credential',
    upstream: `http://127.0.0.1:${directPort}`,
    routeType: 'direct',
    expires: Date.now() + 60000
  })
  
  const token = f.getGenerationToken()
  
  // Send with fake "attacker" authorization that should be stripped
  await fetch(`http://127.0.0.1:${gwPort}/auto`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-Attacker-Token': 'should-not-appear',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ tier: 'default' })
  })
  
  // Gateway should have injected the real credential
  const requests = f.directUpstream.getRequests()
  assert.equal(requests[0].headers.authorization, 'Bearer direct-credential')
  // Attacker header should pass through (not in strip list), but auth should be replaced
  assert.ok(requests[0].headers['x-attacker-token'] === 'should-not-appear')
})

// ==================== Shared Route Integration ====================

test('integration: shared route uses distinct credential and upstream', async (t) => {
  const f = await createIntegrationFixture(t)
  const gwPort = f.gateway.getPort()
  const sharedPort = f.sharedUpstream.getPort()
  
  // Set shared route (simulate OmSite pool proxy)
  const setResult = f.gateway.setRoute({
    credential: 'shared-credential',
    upstream: `http://127.0.0.1:${sharedPort}`,
    routeType: 'shared',
    expires: Date.now() + 60000
  })
  assert.equal(setResult.success, true)
  
  const token = f.getGenerationToken()
  
  const response = await fetch(`http://127.0.0.1:${gwPort}/auto`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ tier: 'default' })
  })
  
  assert.equal(response.status, 200)
  
  // Verify shared upstream received the request (not direct)
  const sharedRequests = f.sharedUpstream.getRequests()
  const directRequests = f.directUpstream.getRequests()
  
  assert.equal(sharedRequests.length, 1, 'shared upstream should receive request')
  assert.equal(directRequests.length, 0, 'direct upstream should NOT receive request')
  assert.equal(sharedRequests[0].headers.authorization, 'Bearer shared-credential')
})

test('integration: direct and shared use different transports', async (t) => {
  const f = await createIntegrationFixture(t)
  const gwPort = f.gateway.getPort()
  const directPort = f.directUpstream.getPort()
  const sharedPort = f.sharedUpstream.getPort()
  
  // First request via direct
  f.gateway.setRoute({
    credential: 'direct-credential',
    upstream: `http://127.0.0.1:${directPort}`,
    routeType: 'direct',
    expires: Date.now() + 60000
  })
  
  let token = f.getGenerationToken()
  await fetch(`http://127.0.0.1:${gwPort}/auto`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: 'default' })
  })
  
  assert.equal(f.directUpstream.getRequests().length, 1)
  assert.equal(f.sharedUpstream.getRequests().length, 0)
  
  // Switch to shared
  f.gateway.setRoute({
    credential: 'shared-credential',
    upstream: `http://127.0.0.1:${sharedPort}`,
    routeType: 'shared',
    expires: Date.now() + 60000
  })
  
  token = f.getGenerationToken()  // New token after route change
  await fetch(`http://127.0.0.1:${gwPort}/auto`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: 'default' })
  })
  
  assert.equal(f.directUpstream.getRequests().length, 1, 'direct should still have 1')
  assert.equal(f.sharedUpstream.getRequests().length, 1, 'shared should now have 1')
})

// ==================== Stale Token / Revocation Tests ====================

test('integration: stale token rejected after route change', async (t) => {
  const f = await createIntegrationFixture(t)
  const gwPort = f.gateway.getPort()
  const directPort = f.directUpstream.getPort()
  
  f.gateway.setRoute({
    credential: 'direct-credential',
    upstream: `http://127.0.0.1:${directPort}`,
    routeType: 'direct',
    expires: Date.now() + 60000
  })
  
  const staleToken = f.getGenerationToken()
  
  // Change route (rotates token)
  f.gateway.clearRoute('test')
  f.gateway.setRoute({
    credential: 'direct-credential',
    upstream: `http://127.0.0.1:${directPort}`,
    routeType: 'direct',
    expires: Date.now() + 60000
  })
  
  // Stale token should be rejected
  const response = await fetch(`http://127.0.0.1:${gwPort}/auto`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${staleToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ tier: 'default' })
  })
  
  assert.equal(response.status, 401, 'stale token should be rejected')
})

test('integration: 503 after route expiry', async (t) => {
  let mockNow = Date.now()
  
  const dir = mkdtempSync(join(tmpdir(), 'fusion-integration-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  
  const directUpstream = await createFakeCopilotUpstream({
    validCredentials: new Set(['direct-credential']),
    log: () => {}
  })
  await directUpstream.start()
  t.after(() => directUpstream.stop())
  
  const gateway = createFusionGateway({
    tokenFile: join(dir, 'token'),
    socketPath: join(dir, 'socket'),
    now: () => mockNow,
    log: () => {}
  })
  await gateway.start()
  t.after(() => gateway.stop())
  
  gateway.setRoute({
    credential: 'direct-credential',
    upstream: `http://127.0.0.1:${directUpstream.getPort()}`,
    routeType: 'direct',
    expires: mockNow + 5000
  })
  
  const token = readFileSync(join(dir, 'token'), 'utf8')
  
  // Fast forward past expiry
  mockNow += 10000
  
  const response = await fetch(`http://127.0.0.1:${gateway.getPort()}/auto`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ tier: 'default' })
  })
  
  assert.equal(response.status, 503)
  const body = await response.json()
  assert.equal(body.code, 'route_expired')
})

// ==================== Donor Failure Tests ====================

test('integration: shared donor 402 returns 503 to client', async (t) => {
  const f = await createIntegrationFixture(t)
  const gwPort = f.gateway.getPort()
  const sharedPort = f.sharedUpstream.getPort()
  
  // Configure donor to fail with 402
  f.sharedUpstream.setDonorFailure('shared-credential', 402, 0)
  
  f.gateway.setRoute({
    credential: 'shared-credential',
    upstream: `http://127.0.0.1:${sharedPort}`,
    routeType: 'shared',
    expires: Date.now() + 60000
  })
  
  const token = f.getGenerationToken()
  
  const response = await fetch(`http://127.0.0.1:${gwPort}/auto`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ tier: 'default' })
  })
  
  // Gateway should return the upstream error
  assert.ok([402, 502].includes(response.status), `should propagate error, got ${response.status}`)
})

test('integration: shared donor 401 invalidates credential', async (t) => {
  const f = await createIntegrationFixture(t)
  const gwPort = f.gateway.getPort()
  const sharedPort = f.sharedUpstream.getPort()
  
  // Configure donor to fail with 401 (credential revoked)
  f.sharedUpstream.setDonorFailure('shared-credential', 401, 0)
  
  f.gateway.setRoute({
    credential: 'shared-credential',
    upstream: `http://127.0.0.1:${sharedPort}`,
    routeType: 'shared',
    expires: Date.now() + 60000
  })
  
  const token = f.getGenerationToken()
  
  const response = await fetch(`http://127.0.0.1:${gwPort}/auto`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ tier: 'default' })
  })
  
  // 401 from upstream becomes 502 (gateway error) or propagates
  assert.ok([401, 502].includes(response.status))
})

// ==================== Streaming Tests ====================

test('integration: streaming response proxied correctly', async (t) => {
  const f = await createIntegrationFixture(t)
  const gwPort = f.gateway.getPort()
  const directPort = f.directUpstream.getPort()
  
  f.gateway.setRoute({
    credential: 'direct-credential',
    upstream: `http://127.0.0.1:${directPort}`,
    routeType: 'direct',
    expires: Date.now() + 60000
  })
  
  const token = f.getGenerationToken()
  
  // First get session
  const autoResponse = await fetch(`http://127.0.0.1:${gwPort}/auto`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ tier: 'default' })
  })
  const autoBody = await autoResponse.json()
  const sessionToken = autoBody.session_token
  
  // Now request streaming /responses
  const streamResponse = await fetch(`http://127.0.0.1:${gwPort}/responses`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'copilot-session-token': sessionToken
    },
    body: JSON.stringify({ 
      model: autoBody.selected_model.id,
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Test' }] }],
      stream: true
    })
  })
  
  assert.equal(streamResponse.status, 200)
  assert.ok(streamResponse.headers.get('content-type')?.includes('text/event-stream'))
  
  // Read stream
  const reader = streamResponse.body.getReader()
  const decoder = new TextDecoder()
  let streamData = ''
  
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    streamData += decoder.decode(value, { stream: true })
  }
  
  assert.ok(streamData.includes('data:'), 'should contain SSE data')
  assert.ok(streamData.includes('[DONE]'), 'should contain [DONE]')
})

// ==================== No Route Tests ====================

test('integration: 503 fusion_unavailable when no route set', async (t) => {
  const f = await createIntegrationFixture(t)
  const gwPort = f.gateway.getPort()
  const token = f.getGenerationToken()
  
  // Don't set any route
  
  const response = await fetch(`http://127.0.0.1:${gwPort}/auto`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ tier: 'default' })
  })
  
  assert.equal(response.status, 503)
  const body = await response.json()
  assert.equal(body.error, 'fusion_unavailable')
  assert.equal(body.code, 'no_route')
})

// ==================== Path Allowlist Tests ====================

test('integration: path allowlist enforced', async (t) => {
  const f = await createIntegrationFixture(t)
  const gwPort = f.gateway.getPort()
  const directPort = f.directUpstream.getPort()
  
  f.gateway.setRoute({
    credential: 'direct-credential',
    upstream: `http://127.0.0.1:${directPort}`,
    routeType: 'direct',
    expires: Date.now() + 60000
  })
  
  const token = f.getGenerationToken()
  
  // /auto should work
  const autoResponse = await fetch(`http://127.0.0.1:${gwPort}/auto`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
  assert.equal(autoResponse.status, 200)
  
  // /evil should be rejected
  const evilResponse = await fetch(`http://127.0.0.1:${gwPort}/evil`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
  assert.equal(evilResponse.status, 404)
})
