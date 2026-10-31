import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, closeSync, ftruncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { saveCheckpoint, restore, validateCheckpoint, redactSession, excludedPath } from './session-checkpoint.mjs'

test('Git checkpoints preserve source and v2 history, deduplicate, skip large files, and fast-forward', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-checkpoint-')), original = { ...process.env }
  const root = join(dir, 'game'), remote = join(dir, 'remote.git'), state = join(dir, 'state')
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  try {
    for (const p of [root, state, join(root, '.opencode-web')]) mkdirSync(p, { recursive: true })
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' })
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test'); git('remote', 'add', 'origin', remote)
    writeFileSync(join(root, 'index.html'), '<h1>Game</h1>');git('add', '.');git('commit', '-m', 'Initial')
    const head = git('rev-parse', 'HEAD')
    const session = { info: { id: 'ses_saved', location: { directory: root } }, messages: [{ type: 'user', id: 'msg_one', content: [{ type: 'text', text: 'Build a game' }] }] }
    writeFileSync(join(state, 'session.json'), JSON.stringify(session))
    writeFileSync(join(root, '.opencode-web/checkpoint-session-id'), 'ses_saved')
    const bin = join(dir, 'opencode')
    writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2),s=p.join(process.env.FAKE_STATE,'session.json');
if(a[0]==='--version')process.stdout.write('opencode v2.2.2');
else if(a[0]==='session'&&a[1]==='export')process.stdout.write(fs.readFileSync(s));
else if(a[0]==='session'&&a[1]==='import')fs.copyFileSync(a[2],s);
else process.exit(1);
`, { mode: 0o755 })
    Object.assign(process.env, { GITHUB_WORKSPACE: root, PROJECT_DIR: root, OPENCODE_WEB_DIR: join(root, '.opencode-web'), RUNNER_TEMP: state, OPENCODE_BIN: bin, FAKE_STATE: state, GITHUB_ENV: join(state, 'env'), GITHUB_REPOSITORY: 'alice/game', TRIGGER_ISSUE_NUMBER: '6', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' })
    writeFileSync(join(root, '.env'), 'secret')
    const fd = openSync(join(root, 'oversized.dat'), 'w');ftruncateSync(fd, 100000001);closeSync(fd)
    const first = saveCheckpoint()
    assert.equal(git('rev-parse', 'HEAD'), head)
    assert.equal(git('show', `${first.commit}:index.html`), '<h1>Game</h1>')
    assert.throws(() => git('show', `${first.commit}:oversized.dat`))
    assert.throws(() => git('show', `${first.commit}:.env`))
    const manifest = JSON.parse(git('show', `${first.commit}:.omgithub/checkpoint.json`))
    assert.equal(manifest.conversation_status, 'saved')
    assert.equal(manifest.skipped_files[0].bytes, 100000001)
    assert.deepEqual(JSON.parse(git('show', `${first.commit}:.omgithub/conversation.json`)), session)
    assert.deepEqual(saveCheckpoint(), first)
    writeFileSync(join(root, 'index.html'), '<h1>Changed</h1>')
    const second = saveCheckpoint()
    assert.equal(git('rev-parse', `${second.commit}^`), first.commit)
    const payload = { ...manifest, commit: second.commit, session }
    process.env.RESUME_CHECKPOINT_FILE = join(state, 'restore.json')
    writeFileSync(process.env.RESUME_CHECKPOINT_FILE, JSON.stringify(payload));restore()
    assert.match(readFileSync(process.env.GITHUB_ENV, 'utf8'), /ses_saved/)
    writeFileSync(process.env.RESUME_CHECKPOINT_FILE, JSON.stringify({ code_only: true }));restore()
    assert.throws(() => validateCheckpoint({ ...payload, opencode_version: '1.0.0' }, { source_repository: 'alice/game', source_issue: 6 }))
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
    Object.assign(process.env, original);rmSync(dir, { recursive: true, force: true })
  }
})
test('exclude runtime files and redact provider credentials', () => {
  for (const path of ['.env', 'node_modules/x', '.omgithub/conversation.json', '.opencode-web/log']) assert.equal(excludedPath(path), true)
  assert.equal(redactSession({ password: 'sensitive', text: 'test secret-value' }, ['secret-value']).text, 'test [credential removed]')
})
