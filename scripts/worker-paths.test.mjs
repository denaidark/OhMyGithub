import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')

test('workflow keeps run-only support directories outside the project checkout', () => {
  const workflow = read('.github/workflows/opencode-reusable.yml')
  for (const name of ['SSH_DIR', 'OPENCODE_WEB_DIR', 'RUNTIME_DIR', 'AGENTSWEB_DIR']) {
    assert.match(workflow, new RegExp(`${name}=%s`))
  }
  assert.match(workflow, /"\$RUNNER_TEMP\/omgithub-runtime"/)
  assert.match(workflow, /"\$RUNNER_TEMP\/omgithub-agentsweb"/)
  assert.match(workflow, /"\$RUNNER_TEMP\/omgithub-ssh"/)
  assert.match(workflow, /"\$RUNNER_TEMP\/omgithub-web"/)
  assert.doesNotMatch(workflow, /^\s+path: \.(?:omgithub-runtime|agentsweb)$/m)
  assert.match(workflow, /PYTHONPATH="\$AGENTSWEB_DIR"/)
  assert.match(workflow, /git -C "\$RUNTIME_DIR" fetch --depth=1 origin "\$RUNTIME_REF"/)
})

test('Linux and Mac Playwright wrappers write outputs outside the project', () => {
  for (const platform of ['linux', 'mac']) {
    const script = read(`scripts/setup-${platform}-playwright.sh`)
    assert.match(script, /runtime="\$HOME\/\.local\/share\/omgithub-playwright"/)
    assert.match(script, /"outputDir": "\$runtime\/output"/)
    assert.match(script, /export PLAYWRIGHT_MCP_OUTPUT_DIR="\$runtime\/output"/)
    const config = script.match(/<<JSON\n([\s\S]*?)\nJSON/)?.[1]
    assert(config)
    assert.equal(JSON.parse(config.replaceAll('$runtime', '/tmp/runner-playwright')).outputDir, '/tmp/runner-playwright/output')
  }
})
