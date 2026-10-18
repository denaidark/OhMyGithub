import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { command, prepareSnapshot } from './remix-snapshot.mjs'

const source = { source_repository: process.env.SOURCE_REPOSITORY, source_commit: process.env.SOURCE_COMMIT }
const temporary = mkdtempSync(join(tmpdir(), 'snapshot-smoke-'))
const root = join(temporary, 'project'), remote = join(temporary, 'remote.git'), environment = join(temporary, 'env')
const start = Date.now()
try {
  mkdirSync(root)
  const git = (...args) => command('git', args, { cwd: root })
  command('git', ['init', '--bare', remote])
  git('init', '-b', 'main'); git('config', 'user.name', 'Snapshot smoke'); git('config', 'user.email', 'snapshot@example.com')
  mkdirSync(join(root, '.github/workflows'), { recursive: true })
  writeFileSync(join(root, '.github/workflows/opencode.yml'), '# Preserve the installed listener.\n')
  git('add', '.'); git('commit', '-m', 'Initialize test listener'); git('remote', 'add', 'origin', remote)
  git('push', 'origin', 'HEAD:refs/heads/main')
  prepareSnapshot({ ...process.env, GITHUB_WORKSPACE: root, RUNNER_TEMP: temporary, GITHUB_ENV: environment, TARGET_REF: 'main',
    COMMENT_BODY: `Verify snapshot import\n\n<!-- omgithub-snapshot:v1 ${JSON.stringify(source)} -->` })
  assert.equal(git('rev-list', '--count', 'HEAD'), '2')
  assert.equal(readFileSync(join(root, '.github/workflows/opencode.yml'), 'utf8'), '# Preserve the installed listener.\n')
  assert.deepEqual(readdirSync(join(root, '.github/workflows')), ['opencode.yml'])
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'origin/main'))
  assert.ok(git('ls-files').split('\n').length > 2)
  const result = `Import ${source.source_repository}@${source.source_commit} in ${((Date.now() - start) / 1000).toFixed(1)} seconds. Verify two local commits, selected files, preserved listener, and a successful push.\n`
  console.log(result)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result)
} finally { rmSync(temporary, { recursive: true, force: true }) }
