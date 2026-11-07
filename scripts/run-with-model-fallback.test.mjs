import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runModels, modelCandidates, preferredFreeModels, retryableProviderError, terminalAttemptOutcome, defaultModelChain, fusionFallbackError, fusionModel, resolveRunModels, fusionUpstreamHost, fusionFailureLine, appendBackupModel } from './run-with-model-fallback.mjs'

test('the backup endpoint runs after every model but before Fusion', () => {
  const chain = ['opencode/deepseek-v4.1-flash-free', 'copilot-fusion-direct/fusion', 'opencode/glm-5.3-flash-free']
  assert.deepEqual(appendBackupModel(chain, { OMG_BACKUP_MODEL: 'omdev/deepseek-v4.1-flash-free' }),
    ['opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free', 'omdev/deepseek-v4.1-flash-free', 'copilot-fusion-direct/fusion'])
  assert.deepEqual(appendBackupModel(chain, {}), chain)
  assert.deepEqual(appendBackupModel(['copilot-fusion-direct/fusion'], { OMG_BACKUP_MODEL: 'omdev/deepseek-v4.1-flash-free' }),
    ['omdev/deepseek-v4.1-flash-free', 'copilot-fusion-direct/fusion'])
  assert.deepEqual(appendBackupModel(chain, { OMG_BACKUP_MODEL: 'not a model' }), chain)
})

test('name the fusion endpoint behind a failed attempt without leaking credentials', () => {
  assert.equal(fusionUpstreamHost({ FUSION_UPSTREAM: 'https://omgithub.com/api/fusion-pool?token=secret' }), 'omgithub.com')
  assert.equal(fusionUpstreamHost({}), 'unknown')
  const line = fusionFailureLine({ message: 'Copilot /auto returned HTTP 502' }, { FUSION_UPSTREAM: 'https://omgithub.com/api/fusion-pool' })
  assert.match(line, /fusion upstream omgithub\.com/)
  assert.match(line, /HTTP 502/)
  assert.doesNotMatch(line, /token|secret/)
})

test('default chain order comes from model-chain.json; picked models fall back to it', () => {
  const [deepseek, glm, mimo, pickle] = preferredFreeModels
  assert.deepEqual(JSON.parse(readFileSync(new URL('./model-chain.json', import.meta.url), 'utf8')).chain, [fusionModel, deepseek, glm, mimo, pickle])
  assert.deepEqual(preferredFreeModels, ['opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free', 'opencode/mimo-v2.6-flash-free', 'opencode/big-pickle'])
  // Without Fusion
  assert.deepEqual(defaultModelChain(false), preferredFreeModels)
  assert.deepEqual(modelCandidates(deepseek), preferredFreeModels)
  assert.deepEqual(modelCandidates(glm), [glm, deepseek, mimo, pickle])
  assert.deepEqual(modelCandidates(deepseek, [deepseek, pickle]), [deepseek, pickle])
  assert.deepEqual(modelCandidates('openai/gpt-6-astra'), ['openai/gpt-6-astra', ...preferredFreeModels], 'hand-picked models fall back to the default chain')
  assert.deepEqual(modelCandidates('opencode/beam-free', ['opencode/beam-free', glm]), ['opencode/beam-free', glm])
  assert.deepEqual(modelCandidates(deepseek, ['opencode/other-free']), preferredFreeModels, 'none live: keep the list')
  // With Fusion (Copilot): Fusion first, then the free chain
  const chain = defaultModelChain(true)
  assert.deepEqual(chain, [fusionModel, deepseek, glm, mimo, pickle])
  assert.deepEqual(modelCandidates(chain[0], null, chain), chain)
  assert.deepEqual(modelCandidates(fusionModel, null, chain), [fusionModel, deepseek, glm, mimo, pickle])
  assert.deepEqual(modelCandidates(glm, null, chain), [glm, fusionModel, deepseek, mimo, pickle])
  assert.deepEqual(modelCandidates('openai/gpt-6-astra', null, chain), ['openai/gpt-6-astra', ...chain])
  assert.deepEqual(modelCandidates(deepseek, [deepseek, mimo], chain), [deepseek, fusionModel, mimo])
  assert.deepEqual(modelCandidates(fusionModel, null, preferredFreeModels), [fusionModel, ...preferredFreeModels])
})
test('only retry structured provider/model availability failures', () => {
  for (const error of [{ type: 'provider.free-limit' }, { status: 429 }, { status: 503 }, { message: 'ModelDeprecated' }]) assert.equal(retryableProviderError(error), true)
  for (const error of [undefined, { type: 'tool.error' }, { status: 401 }, { message: 'Game build failed' }]) assert.equal(retryableProviderError(error), false)
})
test('advance from Fusion on auth, quota, gateway, and route failures only', () => {
  for (const error of [{ status: 401 }, { status: 429 }, { message: 'Copilot /auto returned HTTP 429' }, { message: 'Refuse fallback or GPT-4.1 route' }, { message: 'Unexpected server error' }]) assert.equal(fusionFallbackError(fusionModel, error), true)
  for (const error of [undefined, { status: 500 }, { message: 'Unexpected server error' }]) assert.equal(fusionFallbackError('openai/gpt-6-astra', error), false)
})
async function fixture(pattern, resume = '') {
  const directory = mkdtempSync(join(tmpdir(), 'model-fallback-')), binary = join(directory, 'oc')
  const prompt = '  Build exactly $HOME and @SKILL_TEXT@\n\n'
  writeFileSync(join(directory, 'prompt'), prompt)
  writeFileSync(binary, `#!/usr/bin/env node
const fs=require('node:fs'),p=require('node:path'),args=process.argv.slice(2),f=p.join(process.env.PROJECT_DIR,'calls.json');
const calls=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):[];calls.push(args);fs.writeFileSync(f,JSON.stringify(calls));
const outcome=JSON.parse(process.env.PATTERN)[calls.length-1]||'success';
console.log(JSON.stringify({type:'step_start',sessionID:'ses_main'}));
if(outcome!=='success')console.log(JSON.stringify({type:'error',sessionID:'ses_main',error:outcome==='fatal'?{type:'tool.error',message:'Build failed'}:outcome==='proxy'?{type:'provider.transport',message:'ERR_PROXY_TUNNEL: Proxy refused to open a tunnel: 502 Upstream Proxy Error'}:outcome==='fusion-auth'?{type:'provider.auth',status:401,message:'Copilot /auto returned HTTP 401'}:{type:'provider.free-limit',status:429}}));
process.exit(outcome==='success'||outcome==='zero-error'?0:1);
`, { mode: 0o755 })
  return { directory, prompt, options: { binary, port: 4096, promptFile: join(directory, 'prompt'), logFile: join(directory, 'run.log'), exitFile: join(directory, 'run.exit'), selected: preferredFreeModels[0], models: preferredFreeModels,
    env: { ...process.env, OPENROUTER_API_KEY: '', PROJECT_DIR: directory, PATTERN: JSON.stringify(pattern), RESUME_SESSION_ID: resume } }, close: () => rmSync(directory, { recursive: true, force: true }) }
}
test('try the sequence until success; retain exact prompt and main session across attempts', async () => {
  const f = await fixture(['quota', 'quota', 'success'])
  try {
    const result = await runModels(f.options), calls = JSON.parse(readFileSync(join(f.directory, 'calls.json')))
    assert.equal(result.code, 0)
    assert.deepEqual(result.attempts.map(row => row.model), preferredFreeModels.slice(0, 3))
    assert.equal(calls[0].includes('--session'), false)
    assert.equal(calls[1][calls[1].indexOf('--session') + 1], 'ses_main')
    assert.ok(calls.every(args => args.at(-1) === f.prompt))
    assert.equal(readFileSync(join(f.directory, 'run.exit'), 'utf8').trim(), '0')
    assert.equal(readFileSync(join(f.directory, 'main-model'), 'utf8').trim(), preferredFreeModels[2])
  } finally { f.close() }
})
test('exhaust all four models, handle zero-exit provider errors, and report failure once', async () => {
  const f = await fixture(['zero-error', 'quota', 'quota', 'quota'], 'ses_restored')
  try {
    const result = await runModels(f.options), calls = JSON.parse(readFileSync(join(f.directory, 'calls.json')))
    assert.equal(result.code, 1)
    assert.equal(calls.length, 4)
    assert.equal(calls[0][calls[0].indexOf('--session') + 1], 'ses_restored')
    assert.equal(readFileSync(join(f.directory, 'run.exit'), 'utf8').trim(), '1')
  } finally { f.close() }
})
test('stop immediately on success or unrelated failure; use connected fallback only after free exhaustion', async () => {
  for (const pattern of [['success'], ['fatal']]) {
    const f = await fixture(pattern)
    try { const result = await runModels(f.options); assert.equal(result.attempts.length, 1) }
    finally { f.close() }
  }
  const f = await fixture(['quota', 'quota', 'quota', 'quota', 'success'])
  try {
    const result = await runModels({ ...f.options, env: { ...f.options.env, OPENROUTER_API_KEY: 'configured' } })
    assert.equal(result.code, 0)
    assert.equal(result.attempts.at(-1).model, 'openrouter/cohere/north-mini-code:free')
  } finally { f.close() }
})
test('Default with Fusion tries Fusion first, then DeepSeek', async () => {
  const f = await fixture(['fusion-auth', 'success'])
  try {
    const chain = defaultModelChain(true)
    const result = await runModels({ ...f.options, selected: chain[0], models: modelCandidates(chain[0], null, chain) })
    assert.equal(result.code, 0)
    assert.deepEqual(result.attempts.map(row => row.model), [fusionModel, preferredFreeModels[0]])
  } finally { f.close() }
})
test('lazy proxy runs once, only when the chain reaches a free model', async () => {
  for (const [outcomes, calls] of [[['success'], 0], [['fusion-auth', 'quota', 'success'], 1]]) {
    const f = await fixture(outcomes)
    try {
      let lazy = 0
      const chain = defaultModelChain(true)
      const result = await runModels({ ...f.options, selected: chain[0], models: modelCandidates(chain[0], null, chain), switchProxy: null, lazyProxy: async () => { lazy++; return 'none' } })
      assert.equal(result.code, 0)
      assert.equal(lazy, calls)
    } finally { f.close() }
  }
})
test('a picked Fusion advances to the free chain on its auth failure', async () => {
  const f = await fixture(['fusion-auth', 'success'])
  try {
    const chain = defaultModelChain(true)
    const result = await runModels({ ...f.options, selected: fusionModel, models: modelCandidates(fusionModel, null, chain) })
    assert.equal(result.code, 0)
    assert.deepEqual(result.attempts.map(row => row.model), [fusionModel, preferredFreeModels[0]])
    assert.equal(result.attempts[0].retryable, true)
    assert.equal(readFileSync(join(f.directory, 'main-model'), 'utf8').trim(), preferredFreeModels[0])
  } finally { f.close() }
})


const successfulSnapshot = created => ({ busy: false, messages: [
  { type: 'idle', outcome: 'succeeded', time: { created } },
  { type: 'assistant', id: 'msg_recovered', finish: 'stop' }
] })
test('honor a fresh successful terminal outcome after recovered provider errors, including a sticky CLI exit', async () => {
  for (const pattern of [['zero-error'], ['quota']]) {
    const f = await fixture(pattern)
    try {
      const result = await runModels({ ...f.options, api: { snapshot: async () => successfulSnapshot(Date.now()) } })
      assert.equal(result.code, 0)
      assert.equal(result.attempts.length, 1)
      assert.equal(result.attempts[0].outcome, 'succeeded')
      assert.equal(result.attempts[0].retryable, false)
      const completion = JSON.parse(readFileSync(join(f.directory, 'main-completion.json')))
      assert.equal(completion.message_id, 'msg_recovered')
      assert.equal(completion.session_id, 'ses_main')
      assert.equal(readFileSync(f.options.exitFile, 'utf8').trim(), '0')
    } finally { f.close() }
  }
})
test('never trust old success, an active turn, missing assistant proof, or a transport gap', async () => {
  const started = Date.now(), pause = async () => {}
  for (const snapshot of [successfulSnapshot(started - 1), { ...successfulSnapshot(started), busy: true }, { busy: false, messages: [{ type: 'idle', outcome: 'succeeded', time: { created: started } }] }]) {
    assert.equal(await terminalAttemptOutcome({ api: { snapshot: async () => snapshot }, sessionID: 'ses_main', started, pause }), null)
  }
  assert.equal(await terminalAttemptOutcome({ api: { snapshot: async () => { throw new Error('offline') } }, sessionID: 'ses_main', started, pause }), null)
})
test('a fresh interrupted terminal outcome stops the model sequence', async () => {
  const f = await fixture(['zero-error'])
  try {
    const result = await runModels({ ...f.options, api: { snapshot: async () => ({ busy: false, messages: [{ type: 'idle', outcome: 'interrupted', time: { created: Date.now() } }] }) } })
    assert.equal(result.code, 1)
    assert.equal(result.attempts.length, 1)
    assert.equal(result.attempts[0].outcome, 'interrupted')
  } finally { f.close() }
})
test('runtime switch: first free-limit on WARP switches to DataImpulse once and retries the same model', async () => {
  const f = await fixture(['quota', 'quota', 'success'])
  try {
    let switches = 0
    const result = await runModels({ ...f.options, switchProxy: async () => { switches++; return true } })
    assert.equal(result.code, 0)
    assert.equal(switches, 1, 'switch only once per build')
    assert.deepEqual(result.attempts.map(row => row.model), [preferredFreeModels[0], preferredFreeModels[0], preferredFreeModels[1]])
    assert.equal(result.attempts[0].proxy_switch, 'ok')
    assert.match(readFileSync(f.options.logFile, 'utf8'), /retrying opencode\/deepseek/)
  } finally { f.close() }
})
test('runtime switch: a failed switch keeps going down the chain', async () => {
  const f = await fixture(['quota', 'success'])
  try {
    const result = await runModels({ ...f.options, switchProxy: async () => false })
    assert.deepEqual(result.attempts.map(row => row.model), preferredFreeModels.slice(0, 2))
    assert.equal(result.attempts[0].proxy_switch, 'failed')
  } finally { f.close() }
})
test('runtime switch: not for Fusion, non-free failures, or when WARP was not ok', async () => {
  const f = await fixture(['fusion-auth', 'success'])
  try {
    let switches = 0
    const chain = defaultModelChain(true)
    await runModels({ ...f.options, selected: fusionModel, models: modelCandidates(fusionModel, null, chain), switchProxy: async () => { switches++; return true } })
    assert.equal(switches, 0)
  } finally { f.close() }
  const { runtimeProxySwitch } = await import('./run-with-model-fallback.mjs')
  assert.equal(runtimeProxySwitch({ env: {}, binary: 'oc', logFile: '/dev/null' }), null)
  assert.equal(typeof runtimeProxySwitch({ env: { WARP_RUNTIME_SWITCH: '1', PROXY_REQUEST: 'true' }, binary: 'oc', logFile: '/dev/null' }), 'function')
  assert.equal(runtimeProxySwitch({ env: { WARP_RUNTIME_SWITCH: '1' }, binary: 'oc', logFile: '/dev/null' }), null, 'proxy toggle off by default')
})
test('dead proxy (502 Upstream Proxy Error / TRAFFIC_EXHAUSTED) drops the proxy once and retries the same model', async () => {
  const { proxyTunnelError, attemptErrorClass } = await import('./run-with-model-fallback.mjs')
  const error = { type: 'provider.transport', message: 'ERR_PROXY_TUNNEL: Proxy refused to open a tunnel: 502 Upstream Proxy Error' }
  assert.equal(proxyTunnelError(error), true)
  assert.equal(attemptErrorClass(error), 'proxy')
  assert.equal(proxyTunnelError({ message: 'Build failed' }), false)
  const f = await fixture(['proxy', 'success'])
  try {
    let drops = 0, switches = 0
    const result = await runModels({ ...f.options, dropProxy: async () => { drops++; return true }, switchProxy: async () => { switches++; return true } })
    assert.equal(drops, 1)
    assert.equal(switches, 0, 'never switch back onto a proxy after dropping one')
    assert.equal(result.attempts[0].proxy_drop, 'ok')
    assert.equal(result.attempts[0].error_class, 'proxy')
    assert.equal(result.code, 0)
    assert.deepEqual(result.attempts.map(row => row.model), [preferredFreeModels[0], preferredFreeModels[0]])
  } finally { f.close() }
  const g = await fixture(['proxy'])
  try {
    const result = await runModels({ ...g.options, dropProxy: null })
    assert.equal(result.attempts.length, 1, 'no proxy to drop: stop as before')
  } finally { g.close() }
})

test('forced shared overrides inherited free labels, fails closed without plugin and never falls through on quota/auth',async()=>{
 assert.deepEqual(resolveRunModels({selected:preferredFreeModels[0],fusionEnabled:true,requireShared:true}),{model:fusionModel,models:[fusionModel]})
 assert.throws(()=>resolveRunModels({selected:preferredFreeModels[0],fusionEnabled:false,requireShared:true}),/unavailable/)
 assert.equal(resolveRunModels({selected:preferredFreeModels[0],fusionEnabled:true}).model,preferredFreeModels[0])
 for(const pattern of [['success'],['fusion-auth'],['quota']]){const f=await fixture(pattern,'ses_restored');try{const result=await runModels({...f.options,env:{...f.options.env,FUSION_REQUIRE_SHARED:'true',FUSION_ROUTE:'shared',OPENROUTER_API_KEY:'configured'}});assert.equal(result.attempts.length,1);assert.equal(result.attempts[0].model,fusionModel);const calls=JSON.parse(readFileSync(join(f.directory,'calls.json')));assert.equal(calls[0][calls[0].indexOf('--model')+1],fusionModel);assert.equal(calls[0][calls[0].indexOf('--session')+1],'ses_restored')}finally{f.close()}}
})

test('normal shared and own Fusion primaries cannot silently fall through after auxiliary free quota; own explicit free choices remain honored',async()=>{
 assert.deepEqual(resolveRunModels({fusionEnabled:true,route:'own'}).models,[fusionModel]);assert.equal(resolveRunModels({selected:preferredFreeModels[0],fusionEnabled:true,route:'own'}).model,preferredFreeModels[0]);const f=await fixture(['quota','success']);try{const r=await runModels({...f.options,selected:fusionModel,models:[fusionModel,...preferredFreeModels],env:{...f.options.env,FUSION_ROUTE:'own'}});assert.equal(r.attempts.length,1);assert.equal(r.attempts[0].model,fusionModel);assert.equal(r.code,1)}finally{f.close()}
})

test('normal shared fixes free-first labels without overriding explicit connected providers; admin force overrides both',()=>{
 assert.deepEqual(resolveRunModels({selected:'openai/gpt-6-astra',fusionEnabled:true,requireShared:true}).models,['openai/gpt-6-astra',fusionModel]);assert.deepEqual(resolveRunModels({selected:'openai/gpt-6-astra',fusionEnabled:true,requireShared:true,forceSharedTest:true}).models,[fusionModel])
})
