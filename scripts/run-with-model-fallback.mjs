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
export async function runModels({ binary, port, promptFile, logFile, exitFile, selected, models = modelCandidates(selected), env = process.env }) {
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
      let failure, pending = { out: '', err: '' }
      const inspect = (name, chunk, finish = false) => {
        pending[name] += chunk
        const lines = pending[name].split('\n'); pending[name] = finish ? '' : lines.pop()
        for (const line of lines) {
          try {
            const row = JSON.parse(line)
            if (/^ses_[A-Za-z0-9]+$/.test(row.sessionID || '')) sessionID = row.sessionID
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
      // A structured provider failure is authoritative even if the CLI exits zero.
      const retryable = retryableProviderError(failure)
      if (failure && code === 0) code = 1
      attempts.push({ model, code, retryable, duration_ms: Date.now() - started })
      writeFileSync(join(directory, 'model-attempts.json'), JSON.stringify(attempts))
      appendFileSync(logFile, `[timing] model ${model}: ${Date.now() - started} ms; exit ${code}\n`)
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
