import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runModels, modelCandidates, preferredFreeModels, retryableProviderError } from './run-with-model-fallback.mjs'

test('order preferred free candidates and preserve explicitly chosen non-free models', () => {
  assert.deepEqual(modelCandidates(preferredFreeModels[0]), preferredFreeModels)
  assert.deepEqual(modelCandidates(preferredFreeModels[1]), [preferredFreeModels[1], preferredFreeModels[0], ...preferredFreeModels.slice(2)])
  assert.deepEqual(modelCandidates(preferredFreeModels[0], [preferredFreeModels[0], preferredFreeModels[3]]), [preferredFreeModels[0], preferredFreeModels[3]])
  assert.deepEqual(modelCandidates('openai/gpt-6-astra'), ['openai/gpt-6-astra'])
})
test('only retry structured provider/model availability failures', () => {
  for (const error of [{ type: 'provider.free-limit' }, { status: 429 }, { status: 503 }, { message: 'ModelDeprecated' }]) assert.equal(retryableProviderError(error), true)
  for (const error of [undefined, { type: 'tool.error' }, { status: 401 }, { message: 'Game build failed' }]) assert.equal(retryableProviderError(error), false)
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
if(outcome!=='success')console.log(JSON.stringify({type:'error',sessionID:'ses_main',error:outcome==='fatal'?{type:'tool.error',message:'Build failed'}:{type:'provider.free-limit',status:429}}));
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
