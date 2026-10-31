import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import captures from './wip-screenshots.cjs'
const last = new Map()
export async function uploadScreenshots(env, request = fetch) {
  const web = captures.webDirectory(env)
  if (!web || !env.OMGITHUB_CALLBACK_TOKEN || Date.now() - (last.get(web) || 0) < 30000) return
  const dir = join(web, 'wip-queue')
  let names
  try { names = readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  const items = names.map(name => ({ name, meta: JSON.parse(readFileSync(join(dir, name), 'utf8')) })).sort((a, b) => a.meta.captured_at - b.meta.captured_at).slice(0, 32)
  if (!items.length) return
  last.set(web, Date.now())
  const index = join(web, `progress-index-${process.pid}`), branch = `opencode-progress/${env.TRIGGER_ISSUE_NUMBER}`
  const git = (args, input) => execFileSync('git', args, { cwd: env.GITHUB_WORKSPACE, env: { ...env, GIT_INDEX_FILE: index }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) }).trim()
  let commit
  try {
    const remote = git(['ls-remote', 'origin', `refs/heads/${branch}`]).split(/\s/)[0]
    if (remote) { git(['fetch', '--no-tags', 'origin', remote]); git(['read-tree', remote]) }
    else git(['read-tree', '--empty'])
    for (const { meta } of items) {
      if (!/^[a-f0-9]{64}$/.test(meta.hash)) throw new Error('Invalid screenshot hash')
      meta.extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[meta.type]
      if (!meta.extension) throw new Error('Unsupported screenshot type')
      const bytes = readFileSync(join(dir, `${meta.hash}.image`))
      if (bytes.length > 100000000) throw new Error('Screenshot exceeds Git file limit')
      const blob = git(['hash-object', '-w', '--stdin'], bytes)
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${meta.hash}.${meta.extension}`])
    }
    commit = git(['commit-tree', git(['write-tree']), ...(remote ? ['-p', remote] : []), '-m', `Save progress screenshots for issue #${env.TRIGGER_ISSUE_NUMBER}\n\nRun: ${env.GITHUB_RUN_ID}`])
    git(['push', 'origin', `${commit}:refs/heads/${branch}`])
  } finally { rmSync(index, { force: true }) }
  for (const { name, meta } of items) {
    const response = await request(`${env.OMGITHUB_ORIGIN || 'https://omgithub.com'}/api/github/${env.GITHUB_REPOSITORY}/issues/${env.TRIGGER_ISSUE_NUMBER}/progress-screenshots`, {
      method: 'POST', headers: { authorization: `Bearer ${env.OMGITHUB_CALLBACK_TOKEN}`, 'content-type': 'application/json',
        'x-omgithub-run': env.GITHUB_RUN_ID, 'x-omgithub-attempt': env.GITHUB_RUN_ATTEMPT || '1' },
      body: JSON.stringify({ ...meta, url: `https://f.ondev.store/${env.GITHUB_REPOSITORY}/blob/${commit}/${meta.hash}.${meta.extension}` }), signal: AbortSignal.timeout(15000)
    })
    if (!response.ok && response.status !== 409) throw new Error(`WIP registration HTTP ${response.status}`)
    writeFileSync(join(dir, `${meta.hash}.done`), response.ok ? 'registered' : 'superseded')
    rmSync(join(dir, name), { force: true }); rmSync(join(dir, `${meta.hash}.image`), { force: true })
  }
}
