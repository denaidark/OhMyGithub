import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const script = new URL('./setup-mac-dns.sh', import.meta.url)
for (const failure of [false, true]) test(`Mac DNS setup ${failure ? 'fails closed' : 'configures DNS before flushing caches'}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mac-dns-test-'))
  try {
    writeFileSync(join(dir, 'sudo'), '#!/bin/bash\nexec "$@"\n', { mode: 0o755 })
    for (const cmd of ['networksetup', 'dscacheutil', 'killall']) {
      writeFileSync(join(dir, cmd), `#!/bin/bash\nprintf '%s\\n' '${cmd}'" $*" >> "$CALL_LOG"\n${failure && cmd === 'networksetup' ? 'exit 1' : ':'}\n`, { mode: 0o755 })
    }
    const log = join(dir, 'calls')
    const result = spawnSync('bash', [script.pathname], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALL_LOG: log } })
    assert.equal(result.status, failure ? 1 : 0)
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), failure ? ['networksetup -setdnsservers Ethernet 1.1.1.1 8.8.8.8'] : [
      'networksetup -setdnsservers Ethernet 1.1.1.1 8.8.8.8', 'dscacheutil -flushcache',
      'killall -HUP mDNSResponder', 'networksetup -getdnsservers Ethernet'
    ])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('Configure only Mac runners before tunnel startup', () => {
  const workflow = readFileSync(new URL('../.github/workflows/opencode-reusable.yml', import.meta.url), 'utf8')
  assert.match(workflow, /name: Configure Mac runner DNS\n        if: runner.os == 'macOS'/)
  assert.ok(workflow.indexOf('scripts/setup-mac-dns.sh') < workflow.indexOf('name: Start OpenCode web UI'))
})
