import { openSync, fstatSync, readSync, closeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Report actionable categories, not arbitrary provider bodies or user/tool text.
export function modelFailureReason(log) {
  let failure
  for (const line of String(log).split('\n')) {
    try { const row = JSON.parse(line); if (row.type === 'error' && row.error && typeof row.error === 'object') failure = row.error } catch {}
  }
  if (!failure) return 'The build workflow failed. Open the workflow logs for details.'
  const type = String(failure.type || ''), message = String(failure.message || '')
  if (type === 'provider.free-limit' || /FreeUsageLimit|free usage limit/i.test(message)) return 'OpenCode free-model quota reached. Connect a provider in Settings or choose a model with available quota.'
  if (Number(failure.status) === 429 || /rate.limit/i.test(type)) return 'The model provider rate limit was reached. Wait for quota to reset or choose a model with available quota.'
  if ([401, 403].includes(Number(failure.status))) return 'The model provider rejected its credentials. Check the connected provider in Settings.'
  if (/model.*not.found|not.found.*model/i.test(type)) return 'The selected model is unavailable. Choose another model.'
  return 'OpenCode could not complete the request. Open the workflow logs for details.'
}
export function readFailureReason(directory) {
  if (!directory) return modelFailureReason('')
  let fd
  try {
    fd = openSync(join(directory, 'opencode-run.log'), 'r')
    const size = fstatSync(fd).size, length = Math.min(size, 65536), bytes = Buffer.alloc(length)
    readSync(fd, bytes, 0, length, size - length)
    return modelFailureReason(bytes.toString('utf8'))
  } catch (error) { if (error.code === 'ENOENT') return modelFailureReason(''); throw error }
  finally { if (fd !== undefined) closeSync(fd) }
}
export function failurePayload(env, sequence = Date.now()) {
  return { run: String(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT || 1), sequence: Number(sequence), state: 'ended', phase: 'building', outcome: 'failure', reason: readFailureReason(env.OPENCODE_WEB_DIR) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(process.argv[2] === '--payload' ? JSON.stringify(failurePayload(process.env, process.argv[3])) : readFailureReason(process.env.OPENCODE_WEB_DIR))
}
