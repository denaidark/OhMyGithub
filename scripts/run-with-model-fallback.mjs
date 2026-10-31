import { createV2Client, finishedV2Message } from './opencode-v2-api.mjs'
import { spawn } from 'node:child_process'
import { appendFileSync, openSync, writeSync, closeSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const preferredFreeModels = ['opencode/deepseek-v4.1-flash-free', 'opencode/glm-5.3-flash-free', 'opencode/mimo-v2.6-flash-free', 'opencode/big-pickle']
export function modelCandidates(selected, live = null) {
  if (!preferredFreeModels.includes(selected)) return [selected]
  const available = preferredFreeModels.filter(model => !live || live.includes(model))
  return [...new Set([selected, ...(available.length ? available : preferredFreeModels)])]
}
export function retryableProviderError(error) {
  if (!error || typeof error !== 'object') return false
  const type = String(error.type || ''), message = String(error.message || '')
  return [429, 500, 502, 503, 504].includes(Number(error.status)) || ['provider.free-limit', 'provider.rate-limit', 'provider.overloaded', 'provider.model-not-found'].includes(type) ||
    /FreeUsageLimit|ModelDeprecated|model.*(?:not found|unavailable|deprecated)|free usage limit|rate.limit/i.test(message)
}
export async function terminalAttemptOutcome({ api, sessionID, started, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!api || !/^ses_[A-Za-z0-9]+$/.test(sessionID)) return null
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const snapshot = await api.snapshot(sessionID)
      const terminal = snapshot.messages?.find(message => ['idle', 'assistant', 'user'].includes(message.type))
      // Reject an earlier turn's successful idle marker while projections catch up.
      if (!snapshot.busy && terminal?.type === 'idle' && Number(terminal.time?.created) >= started) {
        if (terminal.outcome === 'succeeded' && finishedV2Message(snapshot)) return { outcome: 'succeeded', message_id: finishedV2Message(snapshot), finished_at: terminal.time.created }
        if (['failed', 'interrupted'].includes(terminal.outcome)) return { outcome: terminal.outcome }
      }
    } catch { /* Retry short projection/transport gaps, without trusting stale success. */ }
    if (attempt < 3) await pause(250)
  }
  return null
}

export async function runModels({ binary, port, promptFile, logFile, exitFile, selected, models = modelCandidates(selected), env = process.env, api = env.OPENCODE_PASSWORD ? createV2Client({ base: `http://127.0.0.1:${port}`, password: env.OPENCODE_PASSWORD }) : null }) {
  const directory = dirname(logFile), prompt = readFileSync(promptFile, 'utf8')
  const candidates = [...new Set(models)]
  if (!candidates.length || candidates.some(model => typeof model !== 'string' || !/^[\w.-]+\/[\w./:-]+$/.test(model))) throw new Error('Invalid model fallback candidates')
  // Preserve the existing connected OpenRouter fallback after the preferred free chain.
  if (preferredFreeModels.includes(selected) && env.OPENROUTER_API_KEY && !candidates.includes('openrouter/cohere/north-mini-code:free')) candidates.push('openrouter/cohere/north-mini-code:free')
  let sessionID = env.RESUME_SESSION_ID || '', child, interrupted = false, code = 1
  const attempts = []
  const stop = signal => { interrupted = true; child?.kill(signal) }
  const onTerm = () => stop('SIGTERM'), onInt = () => stop('SIGINT')
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt)
  try {
    for (const model of candidates) {
      if (interrupted) break
      const started = Date.now()
      writeFileSync(join(directory, 'main-model'), model + '\n')
      appendFileSync(logFile, `[model-fallback] Trying ${model}\n`)
      const fd = openSync(logFile, 'a')
      let failure, observedSession = false, pending = { out: '', err: '' }
      const inspect = (name, chunk, finish = false) => {
        pending[name] += chunk
        const lines = pending[name].split('\n'); pending[name] = finish ? '' : lines.pop()
        for (const line of lines) {
          try {
            const row = JSON.parse(line)
            if (/^ses_[A-Za-z0-9]+$/.test(row.sessionID || '')) { sessionID = row.sessionID; observedSession = true }
            if (row.type === 'error') failure = row.error
          } catch {}
        }
        if (pending[name].length > 1024 * 1024) pending[name] = ''
      }
      try {
        code = await new Promise(resolve => {
          child = spawn(binary, ['run', ...(sessionID ? ['--session', sessionID] : []), '--auto', '--server', `http://127.0.0.1:${port}`, '--model', model, '--format', 'json', prompt], { cwd: env.PROJECT_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] })
          for (const [name, stream] of [['out', child.stdout], ['err', child.stderr]]) stream.on('data', chunk => { writeSync(fd, chunk); inspect(name, chunk.toString()) })
          child.on('error', () => resolve(1))
          child.on('close', (status, signal) => { inspect('out', '', true); inspect('err', '', true); resolve(signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : status ?? 1) })
        })
      } finally { closeSync(fd); child = null }
      const cliCode = code
      const terminal = observedSession && !interrupted && cliCode < 128 ? await terminalAttemptOutcome({ api, sessionID, started }) : null
      const outcome = terminal?.outcome
      // Providers can emit recoverable errors before the same turn succeeds.
      // Trust only a fresh terminal session outcome, not the presence of old errors.
      if (outcome === 'succeeded') {
        code = 0; failure = undefined
        writeFileSync(join(directory, 'main-completion.json'), JSON.stringify({ ...terminal, session_id: sessionID }))
      }
      else if (outcome === 'failed' || outcome === 'interrupted' || code === 0 && (failure || api)) code = 1
      const retryable = outcome !== 'interrupted' && retryableProviderError(failure)
      attempts.push({ model, cli_code: cliCode, outcome: outcome || 'unverified', code, retryable, duration_ms: Date.now() - started })
      writeFileSync(join(directory, 'model-attempts.json'), JSON.stringify(attempts))
      appendFileSync(logFile, `[timing] model ${model}: ${Date.now() - started} ms; cli exit ${cliCode}; terminal ${outcome || 'unverified'}; exit ${code}\n`)
      if (code === 0 || interrupted || !retryable) break
      if (model !== candidates.at(-1)) appendFileSync(logFile, '[model-fallback] Provider/model unavailable; advancing to the next candidate in the same session.\n')
    }
    if (interrupted && code === 0) code = 143
    return { code, attempts, sessionID }
  } finally {
    process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onInt)
    writeFileSync(exitFile + '.tmp', String(code) + '\n'); renameSync(exitFile + '.tmp', exitFile)
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [binary, port, promptFile, logFile, exitFile, selected] = process.argv.slice(2)
  try {
    const result = await runModels({ binary, port, promptFile, logFile, exitFile, selected, models: process.env.OPENCODE_MODELS_JSON ? JSON.parse(process.env.OPENCODE_MODELS_JSON) : modelCandidates(selected) })
    process.exitCode = result.code
  } catch {
    appendFileSync(logFile, '[model-fallback] Model execution setup failed. Inspect the workflow configuration.\n')
    writeFileSync(exitFile + '.tmp', '1\n'); renameSync(exitFile + '.tmp', exitFile)
    process.exitCode = 1
  }
}
