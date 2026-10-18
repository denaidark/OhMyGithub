import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { reclaimPreviewPort } from './reclaim-preview-port.mjs'
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'preview-port-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
test('stops a real unmanaged project listener and frees its port', async t => {
  const root = fixture(t)
  const proc = spawn(process.execPath, ['-e', `const s=require('node:http').createServer((q,r)=>r.end('old Vite'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))`], {cwd:root, stdio:['ignore','pipe','pipe']})
  t.after(() => proc.kill())
  const exit = once(proc, 'exit')
  const [chunk] = await once(proc.stdout, 'data')
  await reclaimPreviewPort({port:Number(String(chunk).trim()),project:root})
  await exit
})
test('does not terminate a listener from another project or user', async t => {
  const root = fixture(t)
  for (const owner of [{uid:process.getuid(),cwd:tmpdir()}, {uid:process.getuid()+1,cwd:root}]) {
    await assert.rejects(reclaimPreviewPort({port:3000,project:root,
      inspect:async args=> args.includes('-Fn') ? `p98765\nn${owner.cwd}\n` : `p98765\nu${owner.uid}\n`,
      kill:()=>assert.fail('must not kill unrelated process')}), /outside this project/)
  }
})
test('reports a listener that refuses to stop without killing replacement processes', async t => {
  const root=fixture(t), killed=[]
  await assert.rejects(reclaimPreviewPort({port:3000,project:root,
    inspect:async args=>args.includes('-Fn') ? `p98765\nn${root}\n` : `p98765\nu${process.getuid()}\n`,
    kill:(...args)=>killed.push(args),wait:async()=>{}}), /did not become free/)
  assert.deepEqual(killed, [[98765,'SIGTERM']])
})

test('real launcher replaces an unmanaged server with the built preview', { timeout: 20000 }, async t => {
  const { writeFileSync, mkdirSync, readFileSync } = await import('node:fs')
  const { promisify } = await import('node:util')
  const { execFile } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const execute = promisify(execFile)
  const root = fixture(t), socket = `remix-test-${process.pid}-${Date.now()}`
  const runtime = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
  const tmux = (await execute('which', ['tmux'])).stdout.trim()
  mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'web'))
  writeFileSync(join(root, 'bin/tmux'), `#!/bin/sh\nexec "${tmux}" -L "${socket}" "$@"\n`, { mode: 0o755 })
  t.after(async () => { await execute(tmux, ['-L', socket, 'kill-server']).catch(() => {}) })
  writeFileSync(join(root, 'index.html'), '<h1>Built remix preview</h1>')
  writeFileSync(join(root, 'start.sh'), '#!/bin/bash\nexec node "$RUNTIME_DIR/scripts/default-start.mjs"\n')
  const old = spawn(process.execPath, ['-e', `const s=require('node:http').createServer((q,r)=>{r.statusCode=q.headers.host.startsWith('localhost:')?403:200;r.end('old Vite host rejection')});s.listen(0,'0.0.0.0',()=>console.log(s.address().port))`], {cwd:root,stdio:['ignore','pipe','pipe']})
  t.after(() => old.kill())
  const [chunk] = await once(old.stdout, 'data'), port=String(chunk).trim()
  const result = await execute('bash', [join(runtime, 'scripts/start-project.sh')], {timeout:15000,env:{...process.env,
    PATH:`${root}/bin:${process.env.PATH}`,PROJECT_DIR:root,RUNTIME_DIR:runtime,OPENCODE_WEB_DIR:join(root,'web'),APP_PORT:port,
    APP_URL:`http://localhost:${port}`, CHECKPOINT_COMMIT:'new-remix-checkpoint',OPENCODE_CONTROL_PORT:''}})
  assert.match(result.stdout, /preview are ready/)
  assert.equal(await (await fetch(`http://localhost:${port}`)).text(), '<h1>Built remix preview</h1>')
  assert.equal(readFileSync(join(root,'web/served-commit'),'utf8'), 'new-remix-checkpoint')
})
