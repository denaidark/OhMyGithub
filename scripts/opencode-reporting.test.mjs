import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const workflow = readFileSync(new URL('../.github/workflows/opencode-reusable.yml', import.meta.url), 'utf8');
test('all tunnel parsers ignore API errors and select ready-box URLs', () => {
  const parsers = [...workflow.matchAll(/sed -nE '([^']+)'/g)].map(m => m[1]).filter(s => s.includes('trycloudflare'));
  assert.equal(parsers.length, 3);
  for (const parser of parsers) {
    assert.equal(execFileSync('sed', ['-nE', parser], { input: 'ERR https://api.trycloudflare.com/tunnel\nINF | https://worker-name.trycloudflare.com |\n', encoding: 'utf8' }).trim(), 'https://worker-name.trycloudflare.com');
  }
});
test('failure reporting attempts every operation despite earlier API failures', async () => {
  const block = workflow.split('      - name: Mark issue failed')[1].split('      - name:')[0];
  const script = block.split('          script: |\n')[1].split('\n').map(l => l.replace(/^            /, '')).join('\n');
  const calls = [];
  const fail = name => async () => { calls.push(name); throw new Error(name); };
  const github = { paginate: fail('jobs'), rest: { actions: { listJobsForWorkflowRun() {} }, issues: {
    createComment: fail('comment'), removeLabel: fail('remove'), addLabels: fail('add')
  } } };
  const run = new (Object.getPrototypeOf(async function() {}).constructor)('github','core','context','require',script);
  await run(github, { warning() {} }, { repo: { owner: 'o', repo: 'r' }, runId: 1 }, () => ({ attach() {}, renderTemplate: () => 'failure' }));
  assert.deepEqual(calls, ['comment', 'remove', 'remove', 'add']);
});
test('routes live validation through one lifecycle controller', () => {
  assert.match(workflow, /scripts\/session-lifecycle.mjs/);
  assert.match(workflow, /OPENCODE_CONTROL_PORT/);
});

test('runtime does not require pull-request permission to execute or deliver branches', () => {
  assert.doesNotMatch(workflow, /pull-requests:\s*write/);
  assert.doesNotMatch(workflow, /gh pr create/);
});

test('keeps checkpoints on main and starts restored preview before model execution', () => {
  assert.equal((workflow.match(/> "\$OPENCODE_WEB_DIR\/checkpoint-session-id"/g) || []).length, 1);
  assert.doesNotMatch(workflow, /"\$VERIFICATION_SESSION_ID" > "\$OPENCODE_WEB_DIR\/checkpoint-session-id"/);
  assert.ok(workflow.indexOf('name: Start saved app before OpenCode') < workflow.indexOf('name: Run OpenCode and locate'));
  assert.ok(workflow.indexOf('name: Publish restored preview') < workflow.indexOf('name: Run OpenCode and locate'));
  assert.match(workflow, /name: Wait for main OpenCode completion/);
  assert.equal((workflow.match(/echo \$! > "\$OPENCODE_WEB_DIR\/app-cloudflared.pid"/g) || []).length, 1);
});
test('asks OpenCode to generate and test the portable startup script during verification', () => {
  const prompt = readFileSync(new URL('../.github/prompts/02-verify.md', import.meta.url), 'utf8');
  assert.match(prompt, /Generate `start.sh`/);
  assert.match(prompt, /no installed project dependencies/);
});

test('passes exact resumed text to OpenCode without command wrappers', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'exact-resume-'));
  try {
    const prompt = '  Keep @SKILL_TEXT@ and $HOME exactly.\n\n';
    const input = join(dir, 'prompt'), capture = join(dir, 'args'), binary = join(dir, 'oc');
    writeFileSync(input, prompt);
    writeFileSync(binary, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)))\n', { mode: 0o755 });
    const block = workflow.split('name: Run OpenCode and locate its web session')[1].split('      - name:')[0];
    const script = block.match(/nohup bash -c '([\s\S]*?)' \\/)[1];
    execFileSync('bash', ['-c', script, '_', binary, '3000', input, join(dir, 'log'), join(dir, 'exit'), 'model', 'true', 'true', 'true'], {
      env: { ...process.env, RESUME_SESSION_ID: 'ses_main', PROJECT_DIR: dir, CAPTURE: capture }
    });
    const args = JSON.parse(readFileSync(capture, 'utf8'));
    assert.equal(args.at(-1), prompt);
    assert.equal(args.includes('--command'), false);
    assert.equal(args[args.indexOf('--session') + 1], 'ses_main');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('validates every main completion through the lifecycle worker', () => {
  assert.match(workflow, /session-lifecycle.mjs/);
  assert.match(workflow, /checkpoint-session-id/);
  assert.match(workflow, /omgithub\/reconcile/);
});

test('registers progress before checkout and preserves real production delivery for fixtures', () => {
  assert.ok(workflow.indexOf('name: Register Actions progress') < workflow.indexOf('name: Checkout target repository'))
  const bootstrap = workflow.split('name: Register Actions progress')[1].split('      - name:')[0]
  assert.doesNotMatch(bootstrap, /RUNTIME_DIR/)
  assert.match(workflow, /seed-test-session.mjs/)
  assert.match(workflow, /wait-deployment.mjs/)
  assert.doesNotMatch(workflow, /name: Push project branch|name: Verify mock OpenCode project locally|steps.delivery.outputs|opencode_release|assets_json/)
  assert.match(workflow, /gh release create/)
  assert.doesNotMatch(workflow, /upload-artifact/)
})


test('hold failed debug workers for 30 minutes and successful workers for five hours', () => {
  const hold = workflow.split('      - name: Keep temporary access available\n')[1].split('      - name:')[0];
  assert.match(hold, /failure\(\) && vars\.OPENCODE_DEBUG_HOLD == 'true'/);
  assert.match(hold, /steps\.opencode_web\.outcome == 'success'/);
  assert.match(hold, /env\.TEST_REQUEST != 'true' && env\.SSH_ONLY_REQUEST != 'true'/);
  assert.match(hold, /HOLD_SECONDS: \$\{\{ job\.status == 'failure' && '1800' \|\| '18000' \}\}/);
  assert.match(hold, /run: \/usr\/bin\/time -p sleep "\$HOLD_SECONDS"/);
});
