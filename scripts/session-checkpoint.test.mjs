import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { usesImportedSnapshot, parseResume, validateCheckpoint, redactSession, excludedPath, saveCheckpoint, restore, exportSession, portableSession, retainWorkflowTree, command } from './session-checkpoint.mjs'
const session = { info: { id: 'ses_checkpoint', directory: '/old/project' }, messages: [{ info: { id: 'msg_one', role: 'user' }, parts: [{ id: 'prt_one', type: 'text', text: 'Build a castle' }] }] }
const source = { source_repository: 'alice/game', source_issue: 6 }
const base = { version: 2, repository: 'alice/game', issue_number: 6, run_id: 123, commit: 'a'.repeat(40), branch: 'opencode-checkpoints/6', project_dir: '', opencode_version: '1.2.3', session, public_history: true }
test('retain remote listener workflows without losing game edits or altering the working index', () => {
  const root = mkdtempSync(join(tmpdir(), 'checkpoint-workflows-'))
  const git = (...args) => {
    const options = typeof args.at(-1) === 'object' ? args.pop() : {}
    return command('git', args, { cwd: root, ...options })
  }
  try {
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/workflows/opencode.yml'), 'current listener')
    writeFileSync(join(root, 'index.html'), 'old game')
    git('add', '.'); git('commit', '-m', 'Baseline')
    const baseline = git('rev-parse', 'HEAD')
    writeFileSync(join(root, '.github/workflows/opencode.yml'), 'stale or generated listener')
    writeFileSync(join(root, '.github/workflows/extra.yml'), 'new generated workflow')
    writeFileSync(join(root, 'index.html'), 'new game')
    git('add', '.')
    retainWorkflowTree(git, baseline)
    assert.equal(git('show', ':.github/workflows/opencode.yml'), 'current listener')
    assert.equal(git('ls-files', '--', '.github/workflows/extra.yml'), '')
    assert.equal(git('show', ':index.html'), 'new game')
    assert.equal(readFileSync(join(root, '.github/workflows/opencode.yml'), 'utf8'), 'stale or generated listener')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('requires a complete versioned checkpoint and rejects legacy data', () => {
  assert.equal(validateCheckpoint(base, source), base)
  for (const patch of [{ version: 0 }, { session: {} }, { repository: 'other/game' }, { project_dir: '../outside' }, { opencode_version: 'latest' }, { public_history: false }]) assert.throws(() => validateCheckpoint({ ...base, ...patch }, source), /complete/)
})
test('extracts only the next request and validates its checkpoint selector', () => {
  const metadata = { ...source, checkpoint_tag: 'opencode-checkpoint-6-123-1000' }
  const request = `Add water\n\nContinue from https://github.com/alice/game/issues/6\n<!-- omgithub-resume:v1 ${JSON.stringify(metadata)} -->\n<!-- omgithub-resume-request:abcdef -->`
  assert.equal(parseResume(request).prompt, 'Add water')
  assert.equal(parseResume('New game'), null)
  assert.throws(() => parseResume('<!-- omgithub-resume:v1 bad -->'), /Invalid/)
  assert.throws(() => parseResume(request + request), /Ambiguous/)
})
test('retains conversation text but removes credentials and excludes runtime files', () => {
  const secret = 'super-secret-api-value'
  const clean = redactSession({ text: `Build a game ${secret}`, nested: { apiKey: 'another' } }, [secret])
  assert.equal(clean.text, 'Build a game [credential removed]')
  assert.equal(clean.nested.apiKey, '[credential removed]')
  for (const file of ['.env', '.playwright-cli/page.yml', 'game/.playwright-cli/page.yml', 'game/.env.production', '.opencode-web/checkpoint.json', 'game/node_modules/lib.js', 'game/auth.json', 'opencode-agentsweb-id_ed25519']) assert.equal(excludedPath(file), true, file)
  assert.equal(excludedPath('game/index.html'), false)
})
test('save, late edit, shutdown checkpoint, and restore preserve code and full conversation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'checkpoint-cycle-'))
  const original = { ...process.env }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const root = join(directory, 'game'), remote = join(directory, 'remote.git'), bin = join(directory, 'bin'), state = join(directory, 'state')
  try {
    for (const path of [root, bin, state]) mkdirSync(path)
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' })
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
    git('remote', 'add', 'origin', remote)
    writeFileSync(join(root, 'index.html'), '<h1>Castle</h1>')
    git('add', '.'); git('commit', '-m', 'Initial game')
    const head = git('rev-parse', 'HEAD')
    mkdirSync(join(root, '.opencode-web'))
    writeFileSync(join(root, '.opencode-web/checkpoint-session-id'), session.info.id)
    writeFileSync(join(state, 'session.json'), JSON.stringify(session))
    const fake = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'); const args=process.argv.slice(2), state=process.env.FAKE_STATE;
if (path.basename(process.argv[1]) === 'curl') {
 const source=args[args.indexOf('--data-binary')+1];
 fs.writeFileSync(path.join(state,'checkpoint-upload.json'),require('node:zlib').gunzipSync(fs.readFileSync(source.slice(1))));
 process.stdout.write('{}');
} else if (path.basename(process.argv[1]) === 'opencode') {
 if(args[0]==='--version') process.stdout.write('1.2.3');
 else if(args[0]==='export') process.stdout.write(fs.readFileSync(path.join(state,'session.json')));
 else if(args[0]==='import') fs.copyFileSync(args[1],path.join(state,'session.json'));
 else process.exit(1);
} else {
 const file=path.join(state,'release-state.json');
 let release=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
 if(args[0]==='release' && args[1]==='create') {
   release={id:1,tag_name:args[2],assets:[],draft:true,body:''};
 } else if(args[0]==='release' && args[1]==='upload') {
   for(const p of args.slice(3,args.indexOf('--repo'))) {
     const name=path.basename(p); fs.copyFileSync(p,path.join(state,name));
     release.assets.push({id:Date.now()+release.assets.length,name,state:'uploaded',size:fs.statSync(p).size});
   }
 } else if(args[0]==='release' && args[1]==='edit') {
   release.body=args[args.indexOf('--notes')+1];release.draft=false;
 } else if(args[0]==='api') {
   if(args.includes('POST') && args[1].endsWith('/releases')) { release={id:1,tag_name:args.find(a=>a.startsWith('tag_name=')).slice(9),assets:[],draft:true,body:''}; process.stdout.write(JSON.stringify(release)); }
   else if(args.includes('DELETE')) release.assets=release.assets.filter(a=>!args[1].endsWith('/'+a.id));
   else if(args[1].includes('/releases?')) process.stdout.write(JSON.stringify(release?[release]:[]));
   else if(args[1].includes('/releases/tags/')) { if(release?.draft) process.exit(1); process.stdout.write(JSON.stringify(release)); }
   else if(args[1].endsWith('/releases/1')) process.stdout.write(JSON.stringify(release));
   else process.stdout.write(JSON.stringify({private:false}));
 } else process.exit(1);
 if(release) fs.writeFileSync(file,JSON.stringify(release));
}
`
    for (const name of ['opencode', 'gh', 'curl']) writeFileSync(join(bin, name), fake, { mode: 0o755 })
    Object.assign(process.env, { PATH: `${bin}:${original.PATH}`, OPENCODE_BIN: join(bin, 'opencode'), FAKE_STATE: state, GITHUB_WORKSPACE: root, PROJECT_DIR: root,
      OPENCODE_WEB_DIR: join(root, '.opencode-web'), RUNNER_TEMP: state, GITHUB_ENV: join(state, 'github-env'), GITHUB_REPOSITORY: 'alice/game', TRIGGER_ISSUE_NUMBER: '6', GITHUB_RUN_ID: '123' })
    writeFileSync(join(root, '.env'), 'SECRET=never-save')
    const first = saveCheckpoint()
    assert.equal(git('rev-parse', 'HEAD'), head, 'checkpoint leaves the working branch unchanged')
    assert.equal(git('show', `${first.commit}:index.html`), '<h1>Castle</h1>')
    assert.throws(() => git('show', `${first.commit}:.env`))
    assert.deepEqual(saveCheckpoint(), first, 'unchanged checkpoint does not upload again')
    writeFileSync(join(root, 'index.html'), '<h1>Castle and water</h1>')
    const updated = structuredClone(session)
    updated.messages.push({ info: { id: 'msg_two', role: 'user' }, parts: [{ id: 'prt_two', type: 'text', text: 'Add water' + 'x'.repeat(26 * 1024 * 1024) }] })
    writeFileSync(join(state, 'session.json'), JSON.stringify(updated))
    const second = saveCheckpoint()
    assert.notEqual(second.commit, first.commit)
    assert.equal(first.tag, second.tag, 'retain the issue checkpoint selector')
    assert.equal(git('show', `${second.commit}:index.html`), '<h1>Castle and water</h1>')
    const upload = JSON.parse(readFileSync(join(state, 'checkpoint-upload.json')))
    const manifest = upload.manifest
    assert.equal(manifest.session, undefined)
    assert.equal(manifest.version, 2)
    const exported = upload.session
    process.env.RESUME_CHECKPOINT_FILE = join(state, 'restore.json')
    writeFileSync(process.env.RESUME_CHECKPOINT_FILE, JSON.stringify({ ...manifest, session: exported }))
    writeFileSync(join(state, 'session.json'), '{}')
    restore()
    const restored = JSON.parse(readFileSync(join(state, 'session.json')))
    assert.equal(restored.messages.length, 2)
    assert.equal(restored.messages[1].parts[0].text, updated.messages[1].parts[0].text)
    assert.ok(Buffer.byteLength(JSON.stringify(exported)) > 25 * 1024 * 1024)
    assert.equal(restored.info.directory, root)
    assert.match(readFileSync(process.env.GITHUB_ENV, 'utf8'), /RESUME_SESSION_ID/)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
    Object.assign(process.env, original)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('real OpenCode imports and exports a complete portable conversation', { skip: !process.env.OPENCODE_REAL_BIN }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'checkpoint-real-cli-'))
  const binary = process.env.OPENCODE_REAL_BIN
  try {
    execFileSync('git', ['init', directory], { stdio: 'pipe' })
    const cwd = join(directory, 'game'); mkdirSync(cwd)
    const now = Date.now(), sid = 'ses_abcdef1234567890abcdef123456', mid = 'msg_abcdef1234567890abcdef123456', pid = 'prt_abcdef1234567890abcdef123456'
    const data = {
      info: { id: sid, slug: 'checkpoint-roundtrip', version: '1.18.30', projectID: 'global', directory: cwd, title: 'Checkpoint round-trip', time: { created: now, updated: now } },
      messages: [{ info: { id: mid, sessionID: sid, role: 'user', time: { created: now }, agent: 'build', model: { providerID: 'opencode', modelID: 'test' } },
        parts: [{ id: pid, sessionID: sid, messageID: mid, type: 'text', text: 'Retain the castle. Next add water. '.repeat(12000) }] }]
    }
    const input = join(directory, 'session.json'); writeFileSync(input, JSON.stringify(data))
    const env = { ...process.env, HOME: directory, XDG_DATA_HOME: join(directory, 'data'), XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_STATE_HOME: join(directory, 'state') }
    const run = (...args) => execFileSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024 })
    run('import', input)
    const previousEnv = { ...process.env }
    let exported
    try {
      Object.assign(process.env, env)
      exported = exportSession(binary, sid, cwd, directory)
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
      Object.assign(process.env, previousEnv)
    }
    assert.equal(exported.info.id, sid)
    assert.equal(realpathSync(exported.info.directory), realpathSync(cwd))
    assert.equal(exported.messages.length, 1)
    assert.equal(exported.messages[0].parts[0].text, data.messages[0].parts[0].text)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})


test('makes a full conversation portable without caller-bound provider replay tokens', () => {
  const source = { info: { id: 'ses_old' }, messages: [{ info: { id: 'msg_old', role: 'assistant' }, parts: [
    { id: 'p1', type: 'reasoning', text: '', metadata: { openai: { reasoningEncryptedContent: 'old-caller-ciphertext' } } },
    { id: 'p2', type: 'reasoning', text: 'Saved readable summary', metadata: { anthropic: { signature: 'old-signature' } } },
    { id: 'p3', type: 'text', text: 'Castle is ready', metadata: { openai: { itemId: 'old-item' } } },
    { id: 'p4', type: 'tool', tool: 'bash', state: { status: 'completed', output: 'Verified game', metadata: { exit: 0 } } }
  ] }] }
  const portable = portableSession(source)
  assert.equal(portable.messages[0].info.id, 'msg_old')
  assert.deepEqual(portable.messages[0].parts.map(p => p.id), ['p2', 'p3', 'p4'])
  assert.equal(portable.messages[0].parts[0].type, 'text')
  assert.equal(portable.messages[0].parts[0].text, 'Saved readable summary')
  assert.equal(portable.messages[0].parts[2].state.output, 'Verified game')
  assert.equal(portable.messages[0].parts[2].state.metadata.exit, 0)
  assert.equal(JSON.stringify(portable).includes('old-caller'), false)
  assert.equal(source.messages[0].parts.length, 4, 'leave the live session unchanged')
})

test('rejects a saved verification fork instead of converting it into a main session', () => {
  assert.throws(() => validateCheckpoint({ ...base, session: { ...session, info: { ...session.info, parentID: 'ses_main' } } }, source), /verification fork/)
})

test('preserves the exact resume prompt including whitespace and marker-like text', () => {
  const prompt = '  Keep @SKILL_TEXT@ and "quotes".\n\n'
  const metadata = { ...source, checkpoint_tag: 'opencode-checkpoint-6-123-1000', user_prompt: prompt }
  assert.equal(parseResume(`display text\n<!-- omgithub-resume:v1 ${JSON.stringify(metadata)} -->`).prompt, prompt)
})

test('prepare fetches checkpoint history from its source rather than the destination origin', () => {
  const runtime = readFileSync(new URL('./session-checkpoint.mjs', import.meta.url), 'utf8')
  assert.ok(runtime.includes("['fetch', '--no-tags', `https://github.com/${source.source_repository}.git`, checkpoint.commit]"))
  assert.ok(!runtime.includes("['fetch', '--no-tags', 'origin', checkpoint.commit]"))
})

test('restore cross-repository conversation against the imported snapshot without fetching history', () => {
  assert.equal(usesImportedSnapshot(source, base, {}), false)
  assert.equal(usesImportedSnapshot(source, base, { SNAPSHOT_SOURCE_REPOSITORY: 'Alice/Game', SNAPSHOT_SOURCE_COMMIT: base.commit }), true)
  assert.throws(() => usesImportedSnapshot(source, base, { SNAPSHOT_SOURCE_REPOSITORY: 'other/game', SNAPSHOT_SOURCE_COMMIT: base.commit }), /does not match/)
  assert.throws(() => usesImportedSnapshot(source, base, { SNAPSHOT_SOURCE_REPOSITORY: 'alice/game', SNAPSHOT_SOURCE_COMMIT: 'b'.repeat(40) }), /does not match/)
})
