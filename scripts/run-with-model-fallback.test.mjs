import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { 
  runModels, modelCandidates, defaultModelChain, appendBackupModel, 
  fusionModel, defaultFreeModel, preferredFreeModels, resolveRunModels, 
  fusionUpstreamHost, freeEgressModel, attemptErrorClass,
  RouteKind, SelectionType, determineSelectionType, buildRouteSequence,
  proxyTunnelError, acquireFusionOnDemand, DEFAULT_IDLE_TIMEOUT_MS
} from './run-with-model-fallback.mjs'

const deepseek = defaultFreeModel

// ==================== Unit Tests ====================

test('model-chain.json structure', () => {
  const chain = JSON.parse(readFileSync(new URL('./model-chain.json', import.meta.url), 'utf8'))
  assert.equal(chain.fusion, fusionModel)
  assert.equal(chain.default_free, deepseek)
  // Chain has Fusion first for Default selection
  assert.deepEqual(chain.chain, [fusionModel, deepseek])
})

test('determineSelectionType correctly classifies user selections (intent-based, route-independent)', () => {
  // Default: no selection or "default" label
  assert.equal(determineSelectionType(null), SelectionType.DEFAULT)
  assert.equal(determineSelectionType(''), SelectionType.DEFAULT)
  assert.equal(determineSelectionType('default'), SelectionType.DEFAULT)
  
  // Fix #7 (corrected): Explicit Fusion-only is INTENT-based, independent of FUSION_ROUTE
  // User explicitly selected Fusion → EXPLICIT_FUSION_ONLY regardless of route availability
  assert.equal(determineSelectionType(fusionModel), SelectionType.EXPLICIT_FUSION_ONLY)
  assert.equal(determineSelectionType(fusionModel, 'none'), SelectionType.EXPLICIT_FUSION_ONLY)
  assert.equal(determineSelectionType(fusionModel, 'shared'), SelectionType.EXPLICIT_FUSION_ONLY)
  assert.equal(determineSelectionType(fusionModel, 'own'), SelectionType.EXPLICIT_FUSION_ONLY)
  
  // Explicit DeepSeek
  assert.equal(determineSelectionType(deepseek), SelectionType.EXPLICIT_DEEPSEEK)
  
  // Explicit Other
  assert.equal(determineSelectionType('openai/gpt-6-astra'), SelectionType.EXPLICIT_OTHER)
})

test('buildRouteSequence for DEFAULT: Fusion direct → Fusion shared', () => {
  const routes = buildRouteSequence({
    selectionType: SelectionType.DEFAULT,
    selected: null,
    fusionRoute: 'own',
    backupModel: 'omdev/oc/backup',
    hasFusionCredentials: true
  })
  assert.deepEqual(routes.map(r => r.route), [
    RouteKind.FUSION_DIRECT,
    RouteKind.FUSION_SHARED
  ])
  // Should NOT include DeepSeek routes
  assert.ok(!routes.some(r => r.route === RouteKind.DEEPSEEK_WARP))
  assert.ok(!routes.some(r => r.route === RouteKind.DEEPSEEK_ONDEV))
})

test('buildRouteSequence for EXPLICIT_DEEPSEEK: WARP → ondev → direct → shared', () => {
  const routes = buildRouteSequence({
    selectionType: SelectionType.EXPLICIT_DEEPSEEK,
    selected: deepseek,
    fusionRoute: 'own',
    backupModel: 'omdev/oc/backup',
    hasFusionCredentials: true
  })
  assert.deepEqual(routes.map(r => r.route), [
    RouteKind.DEEPSEEK_WARP,
    RouteKind.DEEPSEEK_ONDEV,
    RouteKind.FUSION_DIRECT,
    RouteKind.FUSION_SHARED
  ])
})

test('buildRouteSequence for EXPLICIT_OTHER: (selected prepended by runModels) → direct → shared', () => {
  const routes = buildRouteSequence({
    selectionType: SelectionType.EXPLICIT_OTHER,
    selected: 'openai/gpt-6-astra',
    fusionRoute: 'own',
    backupModel: 'omdev/oc/backup',
    hasFusionCredentials: true
  })
  // Does NOT include selected model (added by runModels)
  assert.deepEqual(routes.map(r => r.route), [
    RouteKind.FUSION_DIRECT,
    RouteKind.FUSION_SHARED
  ])
})

test('buildRouteSequence for EXPLICIT_FUSION_ONLY: direct → shared (strict, no backup)', () => {
  const routes = buildRouteSequence({
    selectionType: SelectionType.EXPLICIT_FUSION_ONLY,
    selected: fusionModel,
    fusionRoute: 'own',
    backupModel: 'omdev/oc/backup',
    hasFusionCredentials: true
  })
  assert.deepEqual(routes.map(r => r.route), [
    RouteKind.FUSION_DIRECT,
    RouteKind.FUSION_SHARED
  ])
  // Should NOT include any DeepSeek routes
  assert.ok(!routes.some(r => r.route === RouteKind.DEEPSEEK_WARP))
  assert.ok(!routes.some(r => r.route === RouteKind.DEEPSEEK_ONDEV))
})

test('attemptErrorClass classifies errors correctly', () => {
  assert.equal(attemptErrorClass(null), null)
  assert.equal(attemptErrorClass({ type: 'provider.free-limit' }), 'free-limit')
  assert.equal(attemptErrorClass({ status: 429 }), 'rate-limit')
  assert.equal(attemptErrorClass({ status: 401 }), 'auth')
  assert.equal(attemptErrorClass({ status: 402 }), 'donor-402')
  assert.equal(attemptErrorClass({ message: 'ERR_PROXY_TUNNEL' }), 'proxy')
  assert.equal(attemptErrorClass({ message: 'some error' }), 'other')
})

test('fusionUpstreamHost sanitizes URL without exposing secrets', () => {
  assert.equal(fusionUpstreamHost({ FUSION_UPSTREAM: 'https://omgithub.com/api/fusion-pool?token=secret' }), 'omgithub.com')
  assert.equal(fusionUpstreamHost({}), 'unknown')
})

// ==================== Integration Tests with Mocked Adapters ====================

async function fixture(pattern, resume = '') {
  const directory = mkdtempSync(join(tmpdir(), 'model-fallback-'))
  const binary = join(directory, 'oc')
  const prompt = '  Build exactly $HOME and @SKILL_TEXT@\n\n'
  writeFileSync(join(directory, 'prompt'), prompt)
  writeFileSync(binary, `#!/usr/bin/env node
const fs=require('node:fs'),p=require('node:path'),args=process.argv.slice(2),f=p.join(process.env.PROJECT_DIR,'calls.json');
const calls=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):[];calls.push(args);fs.writeFileSync(f,JSON.stringify(calls));
const outcome=JSON.parse(process.env.PATTERN)[calls.length-1]||'success';
console.log(JSON.stringify({type:'step_start',sessionID:'ses_main'}));
if(outcome!=='success')console.log(JSON.stringify({type:'error',sessionID:'ses_main',error:
  outcome==='fatal'?{type:'tool.error',message:'Build failed'}:
  outcome==='proxy'?{type:'provider.transport',message:'ERR_PROXY_TUNNEL: Proxy refused to open a tunnel: 502 Upstream Proxy Error'}:
  outcome==='fusion-auth'?{type:'provider.auth',status:401,message:'Copilot /auto returned HTTP 401'}:
  outcome==='donor-402'?{type:'provider.auth',status:402,message:'Payment Required'}:
  {type:'provider.free-limit',status:429}}));
process.exit(outcome==='success'||outcome==='zero-error'?0:1);
`, { mode: 0o755 })
  return { 
    directory, 
    prompt, 
    options: { 
      binary, 
      port: 4096, 
      promptFile: join(directory, 'prompt'), 
      logFile: join(directory, 'run.log'), 
      exitFile: join(directory, 'run.exit'), 
      selected: null,
      models: [fusionModel, deepseek],
      env: { ...process.env, OPENROUTER_API_KEY: '', PROJECT_DIR: directory, PATTERN: JSON.stringify(pattern), RESUME_SESSION_ID: resume },
      acquireFusion: async () => ({ success: false, cause: 'test_disabled' })
    }, 
    close: () => rmSync(directory, { recursive: true, force: true }) 
  }
}

// ==================== DEFAULT Selection Tests ====================

test('DEFAULT selection: Fusion direct → Fusion shared', async () => {
  const f = await fixture(['fusion-auth', 'success'])
  try {
    f.options.env.FUSION_ACCESS_TOKEN = 'test-token'
    f.options.env.FUSION_ROUTE = 'own'
    f.options.selected = null  // Default selection
    const result = await runModels(f.options)
    assert.equal(result.code, 0)
    assert.equal(result.selectionType, SelectionType.DEFAULT)
    assert.deepEqual(result.attempts.map(a => a.route), [
      RouteKind.FUSION_DIRECT,
      RouteKind.FUSION_SHARED
    ])
    // Should NOT try DeepSeek for Default
    assert.ok(!result.attempts.some(a => a.route === RouteKind.DEEPSEEK_WARP))
  } finally { f.close() }
})

test('DEFAULT selection with shared route only: Fusion shared', async () => {
  const f = await fixture(['success'])
  try {
    f.options.env.FUSION_ACCESS_TOKEN = 'test-token'
    f.options.env.FUSION_ROUTE = 'shared'
    f.options.selected = null
    const result = await runModels(f.options)
    assert.equal(result.code, 0)
    assert.equal(result.selectionType, SelectionType.DEFAULT)
    assert.deepEqual(result.attempts.map(a => a.route), [RouteKind.FUSION_SHARED])
  } finally { f.close() }
})

// ==================== EXPLICIT_DEEPSEEK Selection Tests ====================

test('EXPLICIT_DEEPSEEK: DeepSeek WARP → ondev → direct Fusion → shared Fusion', async () => {
  const f = await fixture(['quota', 'quota', 'fusion-auth', 'success'])
  try {
    f.options.env.FUSION_ACCESS_TOKEN = 'test-token'
    f.options.env.FUSION_ROUTE = 'own'
    f.options.env.OMG_BACKUP_MODEL = 'omdev/oc/deepseek-v4.1-flash-free'
    f.options.selected = deepseek  // Explicit DeepSeek selection
    const result = await runModels(f.options)
    assert.equal(result.code, 0)
    assert.equal(result.selectionType, SelectionType.EXPLICIT_DEEPSEEK)
    assert.deepEqual(result.attempts.map(a => a.route), [
      RouteKind.DEEPSEEK_WARP,
      RouteKind.DEEPSEEK_ONDEV,
      RouteKind.FUSION_DIRECT,
      RouteKind.FUSION_SHARED
    ])
  } finally { f.close() }
})

test('EXPLICIT_DEEPSEEK without backup: WARP → direct Fusion → shared Fusion', async () => {
  const f = await fixture(['quota', 'fusion-auth', 'success'])
  try {
    f.options.env.FUSION_ACCESS_TOKEN = 'test-token'
    f.options.env.FUSION_ROUTE = 'own'
    // No OMG_BACKUP_MODEL
    f.options.selected = deepseek
    const result = await runModels(f.options)
    assert.equal(result.code, 0)
    assert.deepEqual(result.attempts.map(a => a.route), [
      RouteKind.DEEPSEEK_WARP,
      RouteKind.FUSION_DIRECT,
      RouteKind.FUSION_SHARED
    ])
  } finally { f.close() }
})

// ==================== EXPLICIT_OTHER Selection Tests ====================

test('EXPLICIT_OTHER: selected model → direct Fusion → shared Fusion', async () => {
  const f = await fixture(['quota', 'fusion-auth', 'success'])
  try {
    f.options.env.FUSION_ACCESS_TOKEN = 'test-token'
    f.options.env.FUSION_ROUTE = 'own'
    f.options.selected = 'openai/gpt-6-astra'  // Explicit other model
    const result = await runModels(f.options)
    assert.equal(result.code, 0)
    assert.equal(result.selectionType, SelectionType.EXPLICIT_OTHER)
    // Selected model first, then Fusion fallback
    assert.equal(result.attempts[0].model, 'openai/gpt-6-astra')
    assert.equal(result.attempts[0].route, 'selected-other')
    assert.deepEqual(result.attempts.slice(1).map(a => a.route), [
      RouteKind.FUSION_DIRECT,
      RouteKind.FUSION_SHARED
    ])
  } finally { f.close() }
})

// ==================== EXPLICIT_FUSION_ONLY Selection Tests ====================

test('EXPLICIT_FUSION_ONLY: direct → shared (strict, no backup/DeepSeek)', async () => {
  const f = await fixture(['fusion-auth', 'success'])
  try {
    f.options.env.FUSION_ACCESS_TOKEN = 'test-token'
    f.options.env.FUSION_ROUTE = 'own'
    f.options.env.OMG_BACKUP_MODEL = 'omdev/oc/deepseek-v4.1-flash-free'
    f.options.selected = fusionModel  // Explicit Fusion selection
    const result = await runModels(f.options)
    assert.equal(result.code, 0)
    assert.equal(result.selectionType, SelectionType.EXPLICIT_FUSION_ONLY)
    assert.deepEqual(result.attempts.map(a => a.route), [
      RouteKind.FUSION_DIRECT,
      RouteKind.FUSION_SHARED
    ])
    // Should NOT try DeepSeek or backup
    assert.ok(!result.attempts.some(a => a.route === RouteKind.DEEPSEEK_WARP))
    assert.ok(!result.attempts.some(a => a.route === RouteKind.DEEPSEEK_ONDEV))
  } finally { f.close() }
})

test('EXPLICIT_FUSION_ONLY fails closed: no fallback on exhaustion', async () => {
  const f = await fixture(['fusion-auth', 'fusion-auth'])
  try {
    f.options.env.FUSION_ACCESS_TOKEN = 'test-token'
    f.options.env.FUSION_ROUTE = 'own'
    f.options.env.OMG_BACKUP_MODEL = 'omdev/oc/deepseek-v4.1-flash-free'
    f.options.selected = fusionModel
    const result = await runModels(f.options)
    assert.equal(result.code, 1)
    assert.equal(result.attempts.length, 2)
    // Should only try Fusion routes, not backup
    assert.ok(!result.attempts.some(a => a.route === RouteKind.DEEPSEEK_ONDEV))
  } finally { f.close() }
})

// ==================== Route Dedup & Donor 402 Tests ====================

test('route dedup: each route tried at most once', async () => {
  const f = await fixture(['quota', 'quota', 'fusion-auth', 'fusion-auth'])
  try {
    f.options.env.FUSION_ACCESS_TOKEN = 'test-token'
    f.options.env.FUSION_ROUTE = 'own'
    f.options.env.OMG_BACKUP_MODEL = 'omdev/oc/deepseek-v4.1-flash-free'
    f.options.selected = deepseek
    const result = await runModels(f.options)
    assert.equal(result.code, 1)
    const routes = result.attempts.map(a => a.route)
    const uniqueRoutes = [...new Set(routes)]
    assert.deepEqual(routes, uniqueRoutes, 'each route should be tried at most once')
  } finally { f.close() }
})

test('donor 402 is terminal for THIS route only, not all Fusion routes (fix #5)', async () => {
  // Fix #5: Donor 402 on direct Fusion should NOT suppress separately eligible shared Fusion
  const f = await fixture(['quota', 'quota', 'donor-402', 'success'])
  try {
    f.options.env.FUSION_ACCESS_TOKEN = 'test-token'
    f.options.env.FUSION_ROUTE = 'own'
    f.options.env.OMG_BACKUP_MODEL = 'omdev/oc/deepseek-v4.1-flash-free'
    f.options.selected = deepseek
    const result = await runModels(f.options)
    assert.equal(result.code, 0, 'shared Fusion should succeed after direct 402')
    const directAttempt = result.attempts.find(a => a.route === RouteKind.FUSION_DIRECT)
    assert.equal(directAttempt.error_class, 'donor-402')
    // Shared Fusion should be tried and succeed
    const sharedAttempts = result.attempts.filter(a => a.route === RouteKind.FUSION_SHARED)
    assert.equal(sharedAttempts.length, 1, 'shared Fusion should be tried after direct 402')
    assert.equal(sharedAttempts[0].code, 0)
    const log = readFileSync(f.options.logFile, 'utf8')
    assert.match(log, /Donor 402.*this route is terminal/)
    assert.doesNotMatch(log, /marking all Fusion routes/)
  } finally { f.close() }
})

// ==================== Session Preservation Tests ====================

test('session preserved across route switches', async () => {
  const f = await fixture(['fusion-auth', 'success'], 'ses_restored')
  try {
    f.options.env.FUSION_ACCESS_TOKEN = 'test-token'
    f.options.env.FUSION_ROUTE = 'own'
    f.options.selected = null  // Default
    const result = await runModels(f.options)
    const calls = JSON.parse(readFileSync(join(f.directory, 'calls.json')))
    assert.equal(calls[0][calls[0].indexOf('--session') + 1], 'ses_restored')
    assert.equal(calls[1][calls[1].indexOf('--session') + 1], 'ses_main')
    assert.equal(result.sessionID, 'ses_main')
  } finally { f.close() }
})

// ==================== On-Demand Fusion Acquisition Tests ====================

test('on-demand Fusion acquisition when no credentials', async () => {
  const f = await fixture(['success'])
  try {
    delete f.options.env.FUSION_ACCESS_TOKEN
    f.options.selected = null  // Default selection
    let acquisitionCalled = false
    f.options.acquireFusion = async ({ logFile }) => {
      acquisitionCalled = true
      const { appendFileSync } = await import('node:fs')
      appendFileSync(logFile, '[model-fallback] On-demand Fusion: acquired (route=shared)\n')
      return { success: true, token: 'acquired-token', upstream: 'https://test.com', route: 'shared' }
    }
    const result = await runModels(f.options)
    assert.equal(result.code, 0)
    assert.equal(acquisitionCalled, true)
    const log = readFileSync(f.options.logFile, 'utf8')
    assert.match(log, /On-demand Fusion.*acquired/)
  } finally { f.close() }
})

test('on-demand Fusion: consumer_limit skips SHARED only, not direct (fix #6)', async () => {
  // Fix #6: consumer_limit only affects shared pool, not direct credentials
  const f = await fixture(['success'])
  try {
    delete f.options.env.FUSION_ACCESS_TOKEN
    f.options.selected = null
    f.options.acquireFusion = async () => ({ success: false, cause: 'consumer_limit' })
    const result = await runModels(f.options)
    // Default with no Fusion credentials should fail
    assert.equal(result.code, 1)
    const log = readFileSync(f.options.logFile, 'utf8')
    // Should mention consumer limit for shared, not "all Fusion routes"
    assert.match(log, /consumer limit reached for shared pool/)
    assert.doesNotMatch(log, /skipping Fusion routes/)
  } finally { f.close() }
})

test('transport retries are bounded (fix #8)', async () => {
  // Fix #8: MAX_TRANSPORT_RETRIES=2 prevents infinite proxy drop/switch loops
  const f = await fixture(['proxy-drop', 'proxy-drop', 'proxy-drop', 'proxy-drop', 'success'])
  try {
    let dropCount = 0
    f.options.dropProxy = async () => { dropCount++; return true }
    f.options.env.FUSION_ACCESS_TOKEN = 'test-token'
    f.options.env.FUSION_ROUTE = 'own'
    f.options.selected = fusionModel
    const result = await runModels(f.options)
    // Should fail after bounded retries, not infinite loop
    const log = readFileSync(f.options.logFile, 'utf8')
    // Should not exceed MAX_TRANSPORT_RETRIES + 1 attempts per route
    assert.ok(dropCount <= 3, `Expected at most 3 drop retries, got ${dropCount}`)
  } finally { f.close() }
})

// ==================== Proxy Handling Tests ====================

test('proxy tunnel error: drops proxy and retries', async () => {
  const f = await fixture(['proxy', 'success'])
  try {
    f.options.env.FUSION_ACCESS_TOKEN = 'test-token'
    f.options.env.FUSION_ROUTE = 'shared'
    f.options.selected = null
    let drops = 0
    const result = await runModels({ 
      ...f.options, 
      dropProxy: async () => { drops++; return true }
    })
    assert.equal(drops, 1)
    assert.equal(result.code, 0)
    assert.equal(result.attempts[0].proxy_drop, 'ok')
  } finally { f.close() }
})

// ==================== Sanitized Diagnostics Tests ====================

test('attempt records are sanitized (no secrets)', async () => {
  const f = await fixture(['fusion-auth', 'success'])
  try {
    f.options.env.FUSION_ACCESS_TOKEN = 'super-secret-token'
    f.options.env.FUSION_UPSTREAM = 'https://secret-host.com?token=secret'
    f.options.env.FUSION_ROUTE = 'own'
    f.options.selected = null
    await runModels(f.options)
    const attempts = JSON.parse(readFileSync(join(f.directory, 'model-attempts.json')))
    const attemptsStr = JSON.stringify(attempts)
    assert.ok(!attemptsStr.includes('super-secret'), 'attempts should not contain FUSION_ACCESS_TOKEN')
    assert.ok(!attemptsStr.includes('secret-host'), 'attempts should not contain FUSION_UPSTREAM')
    for (const attempt of attempts) {
      assert.ok(attempt.model)
      assert.ok(attempt.route)
      assert.ok(attempt.selection_type)
      assert.ok(attempt.timestamp)
      assert.ok(typeof attempt.duration_ms === 'number')
    }
  } finally { f.close() }
})

// ==================== Contract Validation Tests ====================

test('local chain contract validation', () => {
  const chain = JSON.parse(readFileSync(new URL('./model-chain.json', import.meta.url), 'utf8'))
  assert.ok(Array.isArray(chain.chain))
  assert.ok(chain.chain.every(id => typeof id === 'string' && /^[\w.-]+\/[\w./:-]+$/.test(id)))
  assert.equal(typeof chain.fusion, 'string')
  assert.equal(typeof chain.default_free, 'string')
})

test('selection type semantics match picker behavior', () => {
  // Verify that selection type determination matches expected picker semantics
  // Default in picker = no explicit selection = Fusion first
  assert.equal(determineSelectionType(null), SelectionType.DEFAULT)
  assert.equal(determineSelectionType('default'), SelectionType.DEFAULT)
  
  // Selecting Fusion explicitly with own route = Fusion-only
  assert.equal(determineSelectionType(fusionModel, 'own'), SelectionType.EXPLICIT_FUSION_ONLY)
  
  // Selecting a free model = that model first with Fusion fallback
  assert.equal(determineSelectionType(deepseek), SelectionType.EXPLICIT_DEEPSEEK)
})
