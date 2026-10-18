import { gzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const env = process.env
const digest = value => createHash('sha256').update(value).digest('hex')
export function command(file, args, options = {}) {
  const start = Date.now()
  try { return (execFileSync(file, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'], ...options }) || '').trim() }
  catch (error) {
    const secrets = Object.entries(env).filter(([key]) => /TOKEN|SECRET|PASSWORD|API_KEY|AUTH_CONTENT|PRIVATE_KEY/.test(key)).map(([, value]) => value)
    const detail = redactSession(String(error.stderr || '').trim(), secrets).slice(-2000)
    throw Object.assign(new Error(`${file} ${args[0] || ''} failed (exit ${error.status ?? 'timeout'}).${detail ? `\n${detail}` : ''}`), { status: Number(String(error.stderr || '').match(/(?:HTTP |error: )(\d{3})/)?.[1]) || undefined })
  }
  finally { process.stderr.write(`[timing] ${file} ${args[0] || ''}: ${Date.now() - start} ms\n`) }
}
// OpenCode can exit before a piped stdout buffer drains. A regular file descriptor
// makes large JSON exports synchronous at the CLI boundary instead of truncating them.
export function exportSession(binary, sessionId, cwd, temporaryDirectory) {
  const file = join(temporaryDirectory, `session-export-${randomUUID()}.json`)
  const fd = openSync(file, 'wx', 0o600)
  try {
    command(binary, ['export', sessionId], { cwd, stdio: ['ignore', fd, 'pipe'] })
    return JSON.parse(readFileSync(file, 'utf8'))
  } finally { closeSync(fd); rmSync(file, { force: true }) }
}

export function parseResume(request) {
  const matches = [...String(request).matchAll(/<!-- omgithub-resume:v1 (\{[^\n]*\}) -->/g)]
  if (!matches.length) {
    if (/<!--\s*omgithub-resume:/i.test(request)) throw new Error('Invalid resume request.')
    return null
  }
  if (matches.length !== 1) throw new Error('Ambiguous resume request.')
  const source = JSON.parse(matches[0][1])
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.source_repository) || !Number.isSafeInteger(source.source_issue) || source.source_issue < 1 ||
      !new RegExp(`^opencode-checkpoint-${source.source_issue}(?:-[1-9]\\d*-\\d+)?$`).test(source.checkpoint_tag)) throw new Error('Invalid checkpoint source.')
  if (typeof source.user_prompt === 'string') return { ...source, prompt: source.user_prompt }
  return { ...source, prompt: String(request).replace(matches[0][0], '').replace(/<!-- omgithub-resume-request:[a-f0-9]+ -->/g, '').replace(/^Continue from https:\/\/github\.com\/[^\n]+\n?/gm, '').trim() }
}
export function validateCheckpoint(c, source) {
  if (!(c?.version === 2 && c.repository?.toLowerCase() === source.source_repository.toLowerCase() && c.issue_number === source.source_issue &&
      Number.isSafeInteger(c.run_id) && c.run_id > 0 && /^[a-f0-9]{40}$/.test(c.commit) && /^opencode-checkpoints\/[1-9]\d*$/.test(c.branch) &&
      typeof c.project_dir === 'string' && !c.project_dir.startsWith('/') && !c.project_dir.includes('\\') && !/[\r\n\0]/.test(c.project_dir) && !c.project_dir.split('/').includes('..') &&
      /^\d+\.\d+\.\d+$/.test(c.opencode_version) && c.public_history === true && /^ses_[a-zA-Z0-9]+$/.test(c.session?.info?.id || '') &&
      Array.isArray(c.session?.messages) && c.session.messages.length > 0 && c.session.messages.every(m => m.info?.id && ['user', 'assistant'].includes(m.info.role) && Array.isArray(m.parts)))) throw new Error('No complete saved session is available.')
  if (c.session.info.parentID) throw new Error('This checkpoint contains a verification fork. Select an earlier main-session checkpoint or start a new build.')
  return c
}
export function portableSession(value) {
  const session = structuredClone(value)
  for (const message of session.messages || []) {
    message.parts = message.parts.flatMap(part => {
      // Provider replay IDs, signatures and encrypted reasoning belong to the old
      // caller. Keep all readable transcript/tool content, not those opaque tokens.
      delete part.metadata
      if (part.type !== 'reasoning') return [part]
      if (!part.text?.trim()) return []
      return [{ id: part.id, sessionID: part.sessionID, messageID: part.messageID, type: 'text', text: part.text }]
    })
  }
  return session
}

export function redactSession(session, secrets = []) {
  function clean(value) {
    if (typeof value === 'string') {
      for (const secret of secrets.filter(s => typeof s === 'string' && s.length >= 8)) value = value.split(secret).join('[credential removed]')
      return value.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key removed]')
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[credential removed]')
    }
    if (Array.isArray(value)) return value.map(clean)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(?:apiKey|api_key|access_token|refresh_token|password|authorization)$/i.test(k) ? '[credential removed]' : clean(v)]))
    return value
  }
  return clean(session)
}
const forbidden = /(^|\/)(?:\.env(?:\.[^/]*)?|auth\.json|credentials(?:\.json)?|node_modules|screenshots|\.playwright-cli|\.git|\.agents|\.agentsweb|\.omgithub-runtime|\.opencode-ssh|\.opencode-web|opencode-agentsweb-id_ed25519(?:\.pub)?)(\/|$)|(?:\.log|\.pid|\.pem|\.key)$/i
export function excludedPath(path) { return forbidden.test(path) || /(^|\/)\.opencode\/(?:goals|auth\.json)(\/|$)/.test(path) }

// Snapshot game edits, not listener changes. A new branch is compared with the
// current default branch by GitHub, which may have advanced since checkout.
export function retainWorkflowTree(git, baseline) {
  const staged = git('ls-files', '-z', '--', '.github/workflows').split('\0').filter(Boolean)
  if (staged.length) git('update-index', '--force-remove', '-z', '--stdin', { input: staged.join('\0') + '\0' })
  const entries = git('ls-tree', '-r', '-z', baseline, '--', '.github/workflows')
  if (entries) git('update-index', '-z', '--index-info', { input: entries.endsWith('\0') ? entries : entries + '\0' })
}

function api(path, args = []) { return command('gh', ['api', path, ...args]) }
function checkpointPath() { return join(env.RUNNER_TEMP, 'omgithub-restore-checkpoint.json') }
function setEnv(name, value) {
  const delimiter = `OMGHITHUB_${randomUUID().replaceAll('-', '')}`
  appendFileSync(env.GITHUB_ENV, `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
}
export function usesImportedSnapshot(source, checkpoint, runtime = env) {
  if (!runtime.SNAPSHOT_SOURCE_REPOSITORY && !runtime.SNAPSHOT_SOURCE_COMMIT) return false
  if (runtime.SNAPSHOT_SOURCE_REPOSITORY?.toLowerCase() !== source.source_repository.toLowerCase() || runtime.SNAPSHOT_SOURCE_COMMIT !== checkpoint.commit) throw new Error('Imported snapshot does not match the saved checkpoint.')
  return true
}
export function prepare() {
  const source = parseResume(env.COMMENT_BODY || '')
  if (!source) return
  if (!source.prompt.trim()) throw new Error('Enter the next game change.')
  let payload
  const managedUrl = `${env.OMGITHUB_ORIGIN || 'https://omgithub.com'}/api/github/${source.source_repository}/issues/${source.source_issue}/checkpoint`
  const download = join(env.RUNNER_TEMP, `checkpoint-download-${randomUUID()}.json`)
  try {
    command('curl', ['--fail', '--silent', '--show-error', '--max-time', '120', '--output', download, managedUrl])
    payload = JSON.parse(readFileSync(download, 'utf8'))
  }
  catch (error) {
    if (error.status !== 404) throw error
    // Read old releases until their checkpoints have moved to OmGithub storage.
    const repository = JSON.parse(api(`repos/${source.source_repository}`))
    if (repository.private) throw new Error('Only public checkpoints can be copied.')
    const release = JSON.parse(api(`repos/${source.source_repository}/releases/tags/${source.checkpoint_tag}`))
    const manifestName = release.body?.match(/<!-- checkpoint-asset:([^ ]+) -->/)?.[1]
    const asset = release.assets?.find(a => a.name === manifestName && a.state === 'uploaded' && a.size > 0 && a.size <= 25 * 1024 * 1024)
    if (release.draft || !asset) throw new Error('No complete saved session is available.')
    payload = JSON.parse(api(`repos/${source.source_repository}/releases/assets/${asset.id}`, ['-H', 'Accept: application/octet-stream']))
    if (payload.version !== 2) throw new Error('Unsupported checkpoint version.')
    const sessionAsset = release.assets?.find(a => a.name === payload.session_asset && a.state === 'uploaded')
    if (!sessionAsset) throw new Error('Missing conversation asset.')
    payload.session = JSON.parse(api(`repos/${source.source_repository}/releases/assets/${sessionAsset.id}`, ['-H', 'Accept: application/octet-stream']))
  }
  finally { rmSync(download, { force: true }) }
  const checkpoint = validateCheckpoint(payload, source)
  if (source.source_commit && source.source_commit !== checkpoint.commit) throw new Error('The selected checkpoint has been replaced. Select the current saved version.')
  const importedSnapshot = usesImportedSnapshot(source, checkpoint)
  if (!importedSnapshot) {
    command('git', ['fetch', '--no-tags', `https://github.com/${source.source_repository}.git`, checkpoint.commit], { cwd: env.GITHUB_WORKSPACE })
    // Restore same-repository checkpoints before installing runtime-only files.
    command('git', ['checkout', '--detach', checkpoint.commit], { cwd: env.GITHUB_WORKSPACE })
  }
  writeFileSync(checkpointPath(), JSON.stringify(checkpoint), { mode: 0o600 })
  if (!importedSnapshot) setEnv('TARGET_SHA', checkpoint.commit)
  setEnv('PROJECT_PATH', checkpoint.project_dir || '.')
  setEnv('COMMENT_BODY', source.prompt)
  setEnv('RESUME_OPENCODE_VERSION', checkpoint.opencode_version)
  setEnv('RESUME_CHECKPOINT_FILE', checkpointPath())
}
export function restore() {
  if (!env.RESUME_CHECKPOINT_FILE) return
  const checkpoint = JSON.parse(readFileSync(env.RESUME_CHECKPOINT_FILE, 'utf8'))
  if (checkpoint.session?.info?.parentID) throw new Error('Cannot resume a verification fork. Select a main-session checkpoint.')
  const binary = env.OPENCODE_BIN || join(env.HOME, '.opencode/bin/opencode')
  const version = command(binary, ['--version'])
  if (version !== checkpoint.opencode_version) throw new Error('Install the saved OpenCode version before importing.')
  const session = portableSession(checkpoint.session)
  session.info.directory = resolve(env.PROJECT_DIR)
  delete session.info.parentID
  const file = join(env.RUNNER_TEMP, 'omgithub-session-import.json')
  writeFileSync(file, JSON.stringify(session), { mode: 0o600 })
  try {
    command(binary, ['import', file], { cwd: env.PROJECT_DIR })
    // Some CLI import errors exit zero. Prove all messages survived before submitting work.
    const restored = exportSession(binary, session.info.id, env.PROJECT_DIR, env.RUNNER_TEMP)
    if (restored.info?.id !== session.info.id || restored.messages?.length !== session.messages.length ||
        session.messages.some(m => !restored.messages.some(r => r.info.id === m.info.id && r.parts.length === m.parts.length))) throw new Error('The saved conversation could not be restored completely.')
    setEnv('RESUME_SESSION_ID', session.info.id)
  } finally { rmSync(file, { force: true }) }
}
export function saveCheckpoint({ interrupted = false } = {}) {
  const root = resolve(env.GITHUB_WORKSPACE), project = resolve(env.PROJECT_DIR)
  const projectDir = relative(root, project)
  if (projectDir.startsWith('..') || projectDir.startsWith('/')) throw new Error('Project must be inside the repository.')
  const directory = env.OPENCODE_WEB_DIR
  const sessionFile = join(directory, 'checkpoint-session-id')
  if (!existsSync(sessionFile)) return null
  const sessionId = readFileSync(sessionFile, 'utf8').trim()
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) throw new Error('Invalid session ID.')
  const binary = env.OPENCODE_BIN || join(env.HOME, '.opencode/bin/opencode')
  const version = command(binary, ['--version'])
  const secrets = Object.entries(env).filter(([k]) => /TOKEN|SECRET|PASSWORD|API_KEY|AUTH_CONTENT|PRIVATE_KEY/.test(k)).map(([,v]) => v)
  // Authentication JSON can contain individual secrets echoed separately in tool output.
  const leaves = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(leaves) : []
  try { secrets.push(...leaves(JSON.parse(env.OPENCODE_AUTH_CONTENT || '{}'))) } catch {}
  if (env.OMGITHUB_SECRET_VALUES_FILE) secrets.push(...JSON.parse(readFileSync(env.OMGITHUB_SECRET_VALUES_FILE, 'utf8')))
  if (env.OMGITHUB_ACCOUNT_AUTH_FILE && existsSync(env.OMGITHUB_ACCOUNT_AUTH_FILE)) secrets.push(...leaves(JSON.parse(readFileSync(env.OMGITHUB_ACCOUNT_AUTH_FILE, 'utf8'))))
  const session = portableSession(redactSession(exportSession(binary, sessionId, project, env.RUNNER_TEMP), secrets))
  writeFileSync(join(directory, 'log-session-export.json'), JSON.stringify(session), { mode: 0o600 })
  const issue = Number(env.TRIGGER_ISSUE_NUMBER), run = Number(env.GITHUB_RUN_ID)
  const branch = `opencode-checkpoints/${issue}`
  const source = { source_repository: env.GITHUB_REPOSITORY, source_issue: issue }
  const gitEnv = { ...env, GIT_INDEX_FILE: join(directory, `checkpoint-index-${process.pid}`) }
  const git = (...args) => {
    const options = typeof args.at(-1) === 'object' ? args.pop() : {}
    return command('git', args, { cwd: root, env: gitEnv, ...options })
  }
  try {
    const remote = git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0] || ''
    const baseline = remote || git('ls-remote', 'origin', 'HEAD').split(/\s/)[0]
    if (baseline) git('fetch', '--no-tags', 'origin', baseline)
    git('read-tree', 'HEAD')
    git('add', '-A', '--', '.')
    const files = command('git', ['ls-files', '-z'], { cwd: root, env: gitEnv }).split('\0').filter(Boolean)
    const exclude = files.filter(excludedPath)
    if (exclude.length) command('git', ['update-index', '--force-remove', '-z', '--stdin'], { cwd: root, env: gitEnv, input: `${exclude.join('\0')}\0` })
    if (baseline) retainWorkflowTree(git, baseline)
    const tree = git('write-tree')
    const fingerprint = digest(`${tree}\n${version}\n${JSON.stringify(session)}`)
    const stateFile = join(directory, 'checkpoint-state.json')
    let previous
    try { previous = JSON.parse(readFileSync(stateFile, 'utf8')) } catch {}
    if (previous?.fingerprint === fingerprint) return previous
    const parent = git('rev-parse', 'HEAD')
    const commit = git('commit-tree', tree, '-p', parent, '-m', `Save game and conversation for issue #${issue}\n\nRun: ${run}`)
    const checkpoint = validateCheckpoint({ version: 2, repository: env.GITHUB_REPOSITORY, issue_number: issue, run_id: run, commit, branch,
      project_dir: projectDir, opencode_version: version, session, public_history: true, created_at: new Date().toISOString() }, source)
    const generation = `${run}-${Date.now()}`
    const tag = `opencode-checkpoint-${issue}`
    const { session: exported, ...metadata } = checkpoint
    if (Buffer.byteLength(JSON.stringify(exported)) > 128 * 1024 * 1024) throw new Error('Session export exceeds 128 MB.')
    git('push', `--force-with-lease=refs/heads/${branch}:${remote}`, 'origin', `${commit}:refs/heads/${branch}`)
    const uploadPath = join(directory, `checkpoint-upload-${generation}.json`)
    writeFileSync(uploadPath, gzipSync(JSON.stringify({ manifest: { ...metadata, generation, interrupted, session_id: sessionId }, session: exported })), { mode: 0o600 })
    try {
      command('curl', ['--fail-with-body', '--silent', '--show-error', '--max-time', '120', '-X', 'PUT',
        '-H', `Authorization: Bearer ${env.OMGITHUB_CALLBACK_TOKEN || ''}`, '-H', 'Content-Type: application/octet-stream', '-H', 'Content-Encoding: gzip',
        '-H', `x-omgithub-run: ${run}`, '-H', `x-omgithub-attempt: ${env.GITHUB_RUN_ATTEMPT || 1}`,
        '--data-binary', `@${uploadPath}`,
        `${env.OMGITHUB_ORIGIN || 'https://omgithub.com'}/api/github/${env.GITHUB_REPOSITORY}/issues/${issue}/checkpoint`])
    } finally { rmSync(uploadPath, { force: true }) }
    const state = { fingerprint, tag, commit, generation, sessionId }
    writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 })
    return state
  } finally { rmSync(gitEnv.GIT_INDEX_FILE, { force: true }) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2]
    if (mode === 'prepare') prepare()
    else if (mode === 'restore') restore()
    else if (mode === 'save') saveCheckpoint()
    else if (mode === 'shutdown') saveCheckpoint({ interrupted: true })
    else throw new Error('Use prepare, restore, save, or shutdown.')
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}

export function findRelease(path, request) {
  try { return JSON.parse(request(path)) }
  catch (error) { if (error.status === 404) return null; throw error }
}
