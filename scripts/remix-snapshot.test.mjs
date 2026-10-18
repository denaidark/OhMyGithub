import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { command, fetchSnapshotLfs, importSnapshot, parseSnapshot, prepareSnapshot } from './remix-snapshot.mjs'
const source = { source_repository: 'creator/game', source_commit: 'b'.repeat(40) }
const request = `Make sky red\n\n<!-- omgithub-snapshot:v1 ${JSON.stringify(source)} -->`
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'snapshot-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'target'), snapshot = join(directory, 'source'), remote = join(directory, 'remote.git')
  mkdirSync(root); mkdirSync(snapshot)
  const git = (...args) => command('git', args, { cwd: root })
  git('init', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test')
  mkdirSync(join(root, '.github/workflows'), { recursive: true })
  writeFileSync(join(root, '.github/workflows/opencode.yml'), 'trusted listener')
  writeFileSync(join(root, 'README.md'), 'bootstrap')
  git('add', '.'); git('commit', '-m', 'bootstrap')
  mkdirSync(join(root, '.omgithub-runtime')); writeFileSync(join(root, '.omgithub-runtime/runtime.mjs'), 'runtime')
  command('git', ['init', '--bare', remote]); git('remote', 'add', 'origin', remote); git('push', 'origin', 'HEAD:refs/heads/main')
  mkdirSync(join(snapshot, '.github/workflows'), { recursive: true })
  writeFileSync(join(snapshot, '.github/workflows/source.yml'), 'source workflow')
  writeFileSync(join(snapshot, '.github/workflows/opencode.yml'), 'source listener')
  writeFileSync(join(snapshot, 'index.html'), 'selected version')
  writeFileSync(join(snapshot, 'LICENSE'), 'original license')
  writeFileSync(join(snapshot, '.gitignore'), 'index.html\n')
  return { directory, root, snapshot, git }
}

test('require exactly one immutable source and remove only snapshot metadata from the request', () => {
  assert.deepEqual(parseSnapshot(request), { ...source, prompt: 'Make sky red' })
  assert.equal(parseSnapshot('ordinary request'), null)
  for (const value of ['<!-- omgithub-snapshot:v1 bad -->', request + request, request.replace(source.source_commit, 'main'), request.replace('creator/game', '../bad/repo')]) assert.throws(() => parseSnapshot(value))
})

test('import only selected files, preserve listener/runtime/license, and remain idempotent', t => {
  const { root, snapshot, git } = fixture(t)
  const sha = importSnapshot({ root, directory: snapshot, source })
  assert.match(sha, /^[a-f0-9]{40}$/)
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), 'selected version')
  assert.equal(readFileSync(join(root, 'LICENSE'), 'utf8'), 'original license')
  assert.equal(readFileSync(join(root, '.github/workflows/opencode.yml'), 'utf8'), 'trusted listener')
  assert.equal(readFileSync(join(root, '.omgithub-runtime/runtime.mjs'), 'utf8'), 'runtime')
  assert.equal(existsSync(join(root, '.github/workflows/source.yml')), false)
  assert.equal(existsSync(join(root, 'README.md')), false)
  assert.ok(git('ls-files').includes('index.html'), 'preserve tracked source files even when ignored')
  assert.ok(!git('ls-files').includes('runtime.mjs'))
  assert.equal(git('rev-list', '--count', 'HEAD'), '2', 'retain no source history')
  assert.equal(importSnapshot({ root, directory: snapshot, source }), sha)
})

test('prepare an archive through extraction, push, and runner environment handoff', t => {
  const { directory, root, snapshot, git } = fixture(t)
  const archive = join(directory, 'fixture.tar.gz'), output = join(directory, 'env')
  command('tar', ['-czf', archive, '-C', directory, 'source'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const run = (file, args, options) => {
    if (file === 'curl') {
      assert.equal(args.at(-1), `https://codeload.github.com/${source.source_repository}/tar.gz/${source.source_commit}`)
      copyFileSync(archive, args[args.indexOf('--output') + 1]); return ''
    }
    return command(file, args, options)
  }
  prepareSnapshot({ COMMENT_BODY: request, GITHUB_WORKSPACE: root, GITHUB_ENV: output, TARGET_REF: 'main', RUNNER_TEMP: directory }, run)
  const values = readFileSync(output, 'utf8')
  assert.match(values, /SNAPSHOT_SOURCE_COMMIT/)
  assert.ok(values.includes(git('rev-parse', 'HEAD')))
  assert.match(values, /COMMENT_BODY<<[^\n]+\nMake sky red\n/)
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'origin/main'))
})

test('failed downloads do not publish readiness or alter the destination', t => {
  const { directory, root, git } = fixture(t), before = git('rev-parse', 'HEAD'), output = join(directory, 'env')
  assert.throws(() => prepareSnapshot({ COMMENT_BODY: request, GITHUB_WORKSPACE: root, GITHUB_ENV: output, TARGET_REF: 'main', RUNNER_TEMP: directory }, (file,args,options) => {
    if (file === 'curl') throw new Error('download failed')
    return command(file,args,options)
  }), /download failed/)
  assert.equal(git('rev-parse', 'HEAD'), before)
  assert.equal(existsSync(output), false)
})

test('failed commands retain stdout and stderr diagnostics', () => {
  assert.throws(() => command('node', ['-e', "process.stdout.write('push rejected'); process.stderr.write('remote reason'); process.exit(1)"]), /push rejected[\s\S]*remote reason/)
})

test('fetch source LFS objects before push and remove its temporary remote', () => {
  const calls = []
  const run = (_file, args) => {
    calls.push(args)
    if (args[0] === 'lfs' && args[1] === 'ls-files') return 'public/assets/avatar.vrm\npublic/ui/logo.png'
    return ''
  }
  assert.equal(fetchSnapshotLfs({ root: '/project', source, run }), true)
  const remote = calls[1][2]
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [['lfs', 'ls-files'], ['remote', 'add'], ['fetch', '--no-tags'], ['lfs', 'fetch'], ['remote', 'remove']])
  assert.equal(calls[1][3], `https://github.com/${source.source_repository}.git`)
  assert.equal(calls[2].at(-1), source.source_commit)
  assert.deepEqual(calls[3], ['lfs', 'fetch', remote, 'FETCH_HEAD'])
  assert.equal(calls[4][2], remote)
  assert.equal(fetchSnapshotLfs({ root: '/project', source, run: (_file, args) => args[1] === 'ls-files' ? '' : assert.fail('No fetch expected') }), false)
})
