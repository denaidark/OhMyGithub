import { spawn } from 'node:child_process'
import { openSync, closeSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function workerTunnel(env, mode = 'start', request = fetch) {
  const started = Date.now()
  try {
    const endpoint = `${env.OMGITHUB_ORIGIN || 'https://omgithub.com'}/api/github/${env.GITHUB_REPOSITORY}/issues/${env.TRIGGER_ISSUE_NUMBER}/tunnel`
    const body = { run: env.GITHUB_RUN_ID, attempt: Number(env.GITHUB_RUN_ATTEMPT || 1) }
    if (mode === 'start') body.ports = { oc: Number(env.OPENCODE_CONTROL_PORT), files: Number(env.PROJECT_FILE_PORT), live: Number(env.APP_PORT) }
    const response = await request(endpoint, { method: mode === 'start' ? 'POST' : 'DELETE', headers: {
      authorization: `Bearer ${env.OMGITHUB_CALLBACK_TOKEN}`, 'content-type': 'application/json'
    }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) })
    if (!response.ok) throw new Error(`Named worker tunnel ${mode}: HTTP ${response.status}`)
    if (mode !== 'start') return
    const { urls, token } = await response.json()
    if (!token || !['oc', 'files', 'live'].every(k => /^https:\/\/[a-z0-9-]+\.omgithub\.com$/.test(urls?.[k] || ''))) throw new Error('Invalid named worker tunnel configuration')
    console.log(`::add-mask::${token}`)
    const log = openSync(join(env.OPENCODE_WEB_DIR, 'cloudflared.log'), 'a', 0o600)
    try {
      const child = spawn(join(env.OPENCODE_WEB_DIR, 'cloudflared'), ['tunnel', '--no-autoupdate', 'run'], {
        env: { ...env, TUNNEL_TOKEN: token }, detached: true, stdio: ['ignore', log, log]
      })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      writeFileSync(join(env.OPENCODE_WEB_DIR, 'cloudflared.pid'), String(child.pid))
      child.unref()
    } finally { closeSync(log) }
    for (const [file, url] of [['web-url', urls.oc], ['files-url', urls.files + '/'], ['app-url', urls.live]]) writeFileSync(join(env.OPENCODE_WEB_DIR, file), url)
    appendFileSync(env.GITHUB_ENV, `APP_URL=${urls.live}\n`)
    appendFileSync(env.GITHUB_OUTPUT, `url=${urls.oc}\nproject_url=${urls.files}/\n`)
    for (let attempt = 0; attempt < 60; attempt++) {
      if (readFileSync(join(env.OPENCODE_WEB_DIR, 'cloudflared.log'), 'utf8').includes('Registered tunnel connection')) return
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error('Named tunnel did not register within 60 seconds')
  } finally { console.error(`[timing] named worker tunnel ${mode}: ${Date.now() - started} ms`) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await workerTunnel(process.env, process.argv[2])
