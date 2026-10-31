import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, ftruncateSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { commitBuild } from './git-build.mjs'
test('publish unpacked build files separately from pinned source and retain prior builds', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-build-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  try {
    git('init');git('config', 'user.name', 'Test');git('config', 'user.email', 'test@example.test')
    git('init', '--bare', join(root, 'remote.git'));git('remote', 'add', 'origin', join(root, 'remote.git'))
    writeFileSync(join(root, 'source.js'), 'source');git('add', 'source.js');git('commit', '-m', 'Source')
    const sourceCommit = git('rev-parse', 'HEAD'), directory = join(root, 'dist')
    mkdirSync(directory);mkdirSync(join(directory, 'assets'))
    writeFileSync(join(directory, 'index.html'), '<title>Game</title><script src="./assets/game.js"></script>')
    writeFileSync(join(directory, 'assets/game.js'), 'game')
    const input = { root, directory, temporary: root, repository: 'alice/game', issue: 6, run: 1, attempt: 1, generation: '1', sourceCommit }
    const first = commitBuild(input)
    assert.equal(git('show', `${first.build_commit}:assets/game.js`), 'game')
    assert.equal(JSON.parse(git('show', `${first.build_commit}:.omgithub/deployment.json`)).source_commit, sourceCommit)
    assert.throws(() => git('show', `${first.build_commit}:source.js`))
    const second = commitBuild({ ...input, generation: '2' })
    assert.equal(git('rev-parse', `${second.build_commit}^`), first.build_commit)
    const fd = openSync(join(directory, 'huge.dat'), 'w');ftruncateSync(fd, 100000001);closeSync(fd)
    assert.throws(() => commitBuild(input), /per-file/)
    assert.equal(git('ls-remote', 'origin', 'refs/heads/opencode-deployments/6').split(/\s/)[0], second.build_commit)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
