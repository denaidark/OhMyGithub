# Testing and verification

## Use the preconfigured Linux CLI

Run `scripts/setup-linux-playwright.sh` on an Ubuntu worker to install the pinned
CLI, Chromium, Mesa Vulkan drivers, and a persistent Xvfb display. Let the reusable
workflow run this before publishing SSH access. Use `playwright-cli` from Actions
or a fresh SSH shell; let the wrapper supply DISPLAY and the Linux configuration.
Use `playwright-cli -s=check open <url>`, `eval`, `screenshot`, and `close` without
manual browser flags. Load `.github/templates/linux.md` by default. Select `mac.md` instead when
a `mac` label or `#mac` hashtag is present. Match case insensitively. Recheck the actual screenshot after upgrades.

## Capture the Linux WebGPU triangle

Install Playwright 1.63.0 and its full Chromium browser as below. Install
`mesa-vulkan-drivers`, `vulkan-tools`, and `xvfb` on Ubuntu. Serve
`tests/fixtures/webgpu-triangle.html` over localhost HTTP. Run:

```sh
PLAYWRIGHT_ROOT=/tmp/gpu-runtime xvfb-run -a node scripts/gpu-capture.mjs \
  http://127.0.0.1:8000/webgpu-triangle.html --canvas '#wgpu' \
  --backend swiftshader --require-green-triangle --out /tmp/linux-triangle
```

Require green triangle pixels, a usable device, `scene.webgpu.rendered=true`,
and no page errors. Inspect the image. Treat SwiftShader and Mesa llvmpipe as
CPU rendering, not GPU hardware acceleration. Use the headed Xvfb result on
[run 34908797646](https://github.com/AgentsLoop/PlayGround/actions/runs/34908797646)
as the verified 2026-09-15 reference. Do not accept the headless result from
that run: its initial generic pixel check falsely accepted background pixels.
Retain the fixture's GPU reference. Preserve failed diagnostics when investigating
`A valid external Instance reference no longer exists`. Do not infer a single
root cause from the combined driver-installation and fixture changes.
Use `--backend vulkan` for native-driver experiments, `--backend swangle` for
ANGLE SwiftShader experiments, and `--executable` to select another browser.
Keep the default Metal path for the Mac test.

## Capture Pascal Editor on Linux

Use `http://localhost:3002`, not the numeric loopback origin, with the default
Pascal Next.js development server. Check the server log for blocked development
resources when HTTP 403 or HMR handshake errors occur.
Install dependencies with the repository's Bun lockfile. Start `bun dev` and
wait for the editor on port 3002. Create a studio through `POST /api/scenes`
using the documented scene structure. Open `/scene/<id>?disable=postFx` for
the reduced-effects capture. Do not use the empty root page as a scene test.
Run headed Chromium under Xvfb with the tested SwiftShader flags above.
Wait for visible geometry; verify the existing canvas accepts `webgpu` and
rejects `webgl2`. Require the viewer's `WebGPU device ready` log, no failed
HTTP requests, and no JavaScript errors. Inspect the screenshot manually.
Treat the 2026-09-15 room capture on issue 113 as a software-rendering result.
Do not claim full post-processing coverage. Preserve readiness-timeout warnings
in the report; do not confuse an earlier WebGL fallback capture with the final
WebGPU capture. Keep the saved scene and application server for further tests.

## Capture WebGPU on a hosted Mac

Use full Chromium with the Metal backend. Keep Playwright's other launch defaults. Test
headed mode first; use `--headless` only after comparing the actual captures.
Install Playwright and its full Chromium build in a separate runtime directory:

```sh
npm install --prefix /tmp/gpu-capture-runtime playwright@1.63.0
/tmp/gpu-capture-runtime/node_modules/.bin/playwright install chromium
PLAYWRIGHT_ROOT=/tmp/gpu-capture-runtime node scripts/gpu-capture.mjs \
  http://127.0.0.1:8000/ --canvas '#wgpu' \
  --require-metal --out /tmp/game-capture
```

Replace the URL and canvas selector with the running game's values. Start the
game before capture if it requires user input. Read `diagnostic.json`,
`canvas.png`, and `page.png` from the output directory. Require an available
WebGPU device, no page errors, and painted canvas pixels. Exclude CSS borders
from the pixel check. Accept a flat triangle with two interior colours; reject
a uniform interior even when its border has another colour.

Use `--baseline` to test full Chromium without extra flags. Use `--headless`
to test the same full browser headlessly. Do not substitute the separate
headless shell. Preserve failed diagnostics; do not silently skip absent
adapters. Keep Vulkan flags out of the macOS Metal capture path.

Use the verified flags: `--enable-gpu`, `--ignore-gpu-blocklist`,
`--enable-unsafe-webgpu`, and `--use-angle=metal`. Check `chrome://gpu` in a
separate headed page. Interpret `Apple Paravirtual device` as a virtual Metal
adapter, not proof of a physical GPU model or hardware performance.

Refer to [Playwright's browser documentation](https://playwright.dev/docs/browsers#opt-in-to-new-headless-mode)
for the full-browser/headless-shell distinction. Reproduce the evidence from
[issue #110](https://github.com/AgentsLoop/PlayGround/issues/110) and
[run 34801504801](https://github.com/AgentsLoop/PlayGround/actions/runs/34801504801).
Use the 2026-09-14 result as a reference, not a promise for later runner images:
Playwright 1.63.0 / Chromium 153.0.8010.12 acquired vendor `apple`,
`isFallbackAdapter=false`, and a usable WebGPU device. Both headed and headless
Metal captures visibly showed the green triangle; pure headed baseline also
succeeded. Run `node --test scripts/gpu-capture.test.mjs` for the pixel and
symlink-entry regressions, then repeat the live screenshot test.

## Test standalone issue access

Create an issue with the `OpenCode` label and `OPENCODE_ACCESS=everyone`.
Verify that Actions starts one execution job.
Restore the access variable after testing. Verify restricted access with the
variable unset. Verify one Actions run for each new issue.

## Test the `-rc` repository at a selected commit

Use the release-candidate repository when you need to test the workflow against
an older or experimental commit without changing the source repository.

Set the repository and commit variables first:

```sh
repo=AgentsLoop/OhMyGithub-rc
commit=<full-commit-sha>
branch=rc-<short-commit-sha>
```

Create a branch from the exact commit and make it the GitHub default branch:

```sh
git push "https://github.com/$repo.git" "${commit}:refs/heads/$branch"
gh repo edit "$repo" --default-branch "$branch"
gh repo view "$repo" --json defaultBranchRef
```

Keep the existing `main` branch and older test branches. Use a new branch name
for each commit so the tested revision remains clear and recoverable. The
workflow checks out the GitHub default branch when the issue title has no
branch metadata.

Create an SSH test issue with the required labels:

```sh
gh issue create --repo "$repo" \
  --title "Check SSH connectivity on $branch" \
  --body $'# Check SSH connectivity on <branch>\n\nVerify the temporary AgentsWeb SSH session, authentication, tunnel, and remote response. Record concrete evidence without exposing secrets.' \
  --label Goal --label ssh --label OpenCode
```

Create the issue after listener installation to trigger one native `issues` run. The
`Goal` label selects goal mode. The `ssh` label requests an SSH-only check in
the reusable workflow. Verify the issue labels and the selected checkout:

```sh
gh issue view <issue-number> --repo "$repo" --json labels
gh run list --repo "$repo" --workflow opencode.yml --limit 5 \
  --json databaseId,displayTitle,event,status,url,headBranch
```

Confirm `event` is `issues` and `headBranch` is the default branch.
Check preparation outputs for the selected `target_ref` and `target_sha`.

Discover and follow the temporary SSH connection with the repository helper:

```sh
bash scripts/ssh-run-log.sh <run-id> --repo "$repo"
```

Run the helper while the Actions job is active. It reports no command after the
worker closes the tunnel. If it reports no command at the start, inspect the
run steps and logs before changing the SSH secret. `AGENTSWEB_SSH_ENABLED:
true` proves that GitHub received the public-key secret; it does not prove that
the tunnel or SSH service started.

After testing, restore the normal default branch if required:

```sh
gh repo edit "$repo" --default-branch main
```

Project acceptance testing is live production testing. Manually create a real
GitHub issue with the required labels and prompt, then verify the resulting
issue run, exactly one execution runner/session, and the completed production
outcome. Do not use unit tests as the testing strategy; local checks such as
`actionlint` and `git diff --check` are only static safeguards before the live
test.

For an issue-triggered run with `AGENTSWEB_SSH_PUBLIC_KEY` configured, verify
these checkpoints in order:

1. `Start AgentsWeb SSH session` succeeds.
2. `Post temporary SSH connection command` succeeds.
3. `Verify AgentsWeb SSH availability` succeeds.
4. `Run OpenCode` succeeds.
5. `Mark SSH session closed` and `Clean up AgentsWeb SSH session` succeed.
6. The expected branch and immutable commit exist.

The verification loop must confirm a browser entrypoint before public-app and
Pages checks: either `$PROJECT_DIR/index.html` or `$PROJECT_DIR/dist/index.html`
must exist, and remediation retries must repeat that check. Static root
`index.html` apps are copied to a temporary Pages directory; built
`dist/index.html` apps are published directly.

When `AGENTSWEB_SSH_PUBLIC_KEY` is missing, the SSH session and SSH-based
verification steps must be skipped. OpenCode Web, the Cloudflare session URL,
and the browser-based workflow path must still run; the access comment should
omit SSH instructions and cleanup must not report an SSH session closure.

The AgentsWeb public port must be derived from `GITHUB_RUN_ID`, not
`GITHUB_RUN_NUMBER`. Run numbers restart at `1` for each repository, which made
the first OMG run in every newly installed repository contend for port `32001`
and close during SSH verification. The globally unique run ID spreads those
runs across the broker's `32000-32999` port range.

Validate workflow edits locally with:

```sh
actionlint .github/workflows/opencode.yml .github/workflows/opencode-prepare.yml .github/workflows/opencode-reusable.yml
git diff --check
```

Create an issue with `OpenCode` and `test` for a synthetic-generation run. Copy the committed fixture and import a completed conversation into the real OpenCode server. Exercise the production checkpoint, startup, capture, and deployment path. Require a ready deployment with desktop/mobile screenshots. Keep logs in the run release and skip the five-hour hold for synthetic runs.

The caller must grant every permission requested by the reusable workflow.
Otherwise GitHub rejects the run at startup before creating a job, even when
`actionlint` succeeds.

For goal support, create an issue with both `Goal` and `OpenCode`. Verify one
native `issues` run, successful preparation, and the Goal invocation. Verify
that an issue without `Goal` uses the standard invocation. Preserve `Goal`
when adding lifecycle labels.

For Ralph support, create an issue with `OpenCode` and `ralph` labels and
confirm the workflow installs `opencode-ralph-loop`, invokes
`opencode run --command ralph-loop`, and preserves the same OpenCode session.
The build is accepted only when the session emits
`<promise>DONE</promise>`; a missing promise must not receive the `complete`
label. If both `Goal` and `ralph` are present, Ralph takes precedence.

For custom-branch support, set `branch` in hidden `omgithub-request:v1` metadata.
Verify preparation strips routing metadata, resolves the branch, and supplies
a frozen commit to checkout. Reject invalid or missing branches before execution.
Verify workflow code comes from the default branch.

For the `omo` issue label, verify that an otherwise normal OpenCode issue causes
the OpenCode startup step to install `oh-my-openagent` with Bun before starting
the web server and launches `opencode ... --command goal` with `ulw` in the
objective; an issue without the `OpenCode` label must not run that installer, and the
`omo` label alone must not trigger a workflow. The OMO config must use its
native Goal command and must not register a compatibility `ulw-loop` command.

The log-release step must copy and upload only non-empty `.log`/`.json` files;
empty service logs such as `nginx.log` can make GitHub's upload API return
`400 Bad Content-Length`. The OpenCode response JSON remains required and must
be non-empty.

Check scripted startup/capture before delivery. Require fresh desktop/mobile PNGs outside source. Invoke OC only for script repair and require execution plus screenshot inspection. Check the durable OmSite URL in the final comment and the diagnostic response/log files in the logs release.

Watch a running workflow with live per-step logs using the same internal
endpoints as the GitHub Actions web UI:

```sh
python3 scripts/gh-run-watch-logs.py <run-id> \
  --repo AgentsLoop/OhMyGithub --internal-job-id <web-job-id> --exit-status
```

The script authenticates with `gh auth token`. GitHub's web log endpoints are
unsupported and may change. Unlike `gh run view --log`, they expose the
currently available text while a job is running. GitHub does not expose the
web UI's second, internal job ID through its supported API. Read it from the
job page's `data-job-steps-url`, whose form is
`.../actions/runs/<run>/jobs/<web-job-id>/steps`.

In the browser console on the job page, print that URL with:

```js
document.querySelector("check-steps").dataset.jobStepsUrl
```

The workflow may show non-fatal Node.js deprecation or Actions cache warnings.

For the freshest local log, connect to the temporary SSH session posted by the
workflow and follow the runner's current page log:

```sh
find /home/runner/actions-runner/cached/*/_diag/pages -type f -name '*_1.log' -print
tail -F /home/runner/actions-runner/cached/*/_diag/pages/*_1.log
```

The runner writes the live Actions console output to `_diag/pages` and uploads
step-log chunks from `_diag/blocks`. This can be ahead of `gh run view --log`
while a job is still running. Avoid printing environment files, tokens, or keys.

Use the helper to discover the posted SSH endpoint automatically:

```sh
bash scripts/ssh-run-log.sh <run-id>
```

The helper checks the AgentsWeb broker `/api/registrations` endpoint first when
`BROKER_API_TOKEN` is available (or when `../../sshworker/workers-dashboard/.env`
contains it), then falls back to the workflow issue comments.

## Test the local SSH tunnel service

Run the raw tunnel health check from the `sshworker` checkout. Set `PYTHONPATH`
to the checkout because the test imports the local `lolgames_tunnel` package:

```sh
PYTHONPATH=/Users/igor/Documents/sshworker \
  /Users/igor/Documents/sshworker/tests/test-ssh-tunnel.sh
```

Interpret the output in this order:

- `PASS control TCP` confirms that the local machine can reach the broker
  control port.
- `PASS local SSH listener` confirms that the local SSH service is listening.
- `PASS registered` and `PASS SSH host-key exchange` confirm the complete
  public tunnel path.

If the test reports `No module named lolgames_tunnel`, set `PYTHONPATH` as
shown above. Do not treat that error as a broker outage. If the module-path
fix is present and registration still fails, inspect the client error output
and then check the broker service.

## Verify generated-file exclusions

Check that project `.gitignore` rules exist before OpenCode starts. Check both
root and nested projects. Stage a nested `.agents` repository, change its HEAD,
and confirm that delivery removes its index entry without deleting worker files.
Confirm that prompts leave source changes uncommitted for workflow delivery.

## Recover failed issue runs

Create a new issue with the same title and body after installing the fix. Attach the original execution and requested mode labels. Omit status labels.
Retry status updates three times. Treat exhausted status-update failures as warnings so validation and delivery can continue.

## Check live progress startup

Run the tracker with SSH disabled. Default optional SSH variables to empty strings before starting the background process. Check that the process stays alive after launch.

## Check reporting failure paths

Extract Cloudflare URLs only from the tunnel-ready box. Reject API URLs from error lines.
Wait for the progress tracker to exit before appending final results. Bound local API requests.
Attempt failure comments and each status-label update independently when GitHub requests fail.

## Test completion recovery

Reproduce registration failures with an Actions installation token. Retry the same completion after registration recovers. Model draft-release tag lookups as unavailable; read the draft by its release ID. Confirm checkpoint creation, validation screenshots, and draft deployment on a live runner, not only with fixture tests.

## Verify live preview priority

Start the main workspace with `scripts/start-project.sh` after checkpointing a completed response. Publish its `Playable preview` tunnel link once. Run capture on the shared live server. Confirm the issue iframe selects the healthy live tunnel ahead of its deployed draft, and inspect the latest workspace change there.

## Check validation setup ownership

Keep the main build prompt equal to the user request. Run existing start.sh and capture.sh directly. Create a repair fork only after startup or capture fails. Require that fork to execute changed scripts, check readiness, and inspect desktop/mobile screenshots. Save repaired scripts with the main session export. Read new draft release IDs directly from the creation response. Retry tunnel startup at most three times and route files through the control tunnel.

## Preserve validation evidence

Exclude `.playwright-cli` output from checkpoint trees and deployment archives. Keep capture screenshots outside source and retain them when deployment fails; remove them after successful delivery. Test healthy-server reuse, stopped-server startup, missing scripts, bounded repairs, fresh PNG output, and continuation cancellation. Treat successful capture as startup-and-capture evidence.

## Separate deployment retries from repairs

Reuse the lifecycle checkpoint when preview preparation returns repaired=false. Save again after successful OC repair. Upload new checkpoint data to OmGithub and verify the latest pointer and conversation digest. Read legacy releases only when no managed checkpoint exists. Run legacy cleanup separately with GITHUB_REPOSITORY and TRIGGER_ISSUE_NUMBER set: bash scripts/cleanup-legacy-checkpoints.sh.

Retry readiness and capture at most three times with bounded backoff. Return startup exit code 75 for a running server that remains unready or an unavailable public tunnel; report an exited startup process as a script failure. Retry capture without restarting the server. Preserve each capture attempt's stdout and stderr outside source. Escalate persistent script failures to OC; surface persistent DNS/network failures directly. Execute repaired scripts and inspect screenshots.

Retry deployment upload using the same archive and generation for transient network failures, HTTP 408/429/500/502/503/504, and explicitly signaled rate limits. Stop on cancellation, superseded generations, and permanent errors. Deploy the server's idempotent upload handler before enabling workflow retries. Test concurrent uploads, lost responses, successful-generation replay after service recreation, capture diagnostics, readiness failures, and cancellation.

## Verify project file serving

Run `npm ci --prefix scripts/live-files --no-audit --no-fund`, then `node --test scripts/live-files.test.mjs scripts/run-record.test.mjs scripts/opencode-reporting.test.mjs`. Verify directory listings, explicit HTML transformation, root-relative module paths, package imports, CSS processing, HMR messages, encoded folder names, readable Markdown and shell files, WASM types, and missing-file 404 responses. Confirm independent OpenCode and files URLs in run registration. Preserve the final-preview tunnel and keep dist execution outside live mode.

Start a new worker after publishing workflow changes. Open its files URL and click index.html. Confirm that JS requests return modules rather than OpenCode HTML and that source edits update the page over the tunnel. Run project dependencies and framework-specific compatibility checks separately; do not treat generic Vite transforms as proof of project-plugin support.

## Verify progress and lean delivery

Check the first Actions step registers the run before checkout. Render detailed steps in dark desktop/mobile views for starting, live, disconnected, and failed states. Retry temporary Actions errors without stopping page polling.

Test metadata-only checkpoint reads and negative caching. Force fresh full validation on resume. Simulate three launcher calls with a healthy local app and failing public endpoint; require only one startup. Return exit 75 from transient capture fixtures and prove retries never invoke OC.

Test diagnostic-export reuse with matching, stale, missing, and unknown session revisions. Keep nonempty logs in GitHub Releases. Keep screenshots in OmSite and checkpoint assets limited to restore data.

## Auto-start screenshot captures

Use the default capture helper to click one visible, enabled button named Start, Play, Start game, Play game, Start now, or Play now before taking each viewport screenshot. Allow up to three seconds for delayed controls. Skip ambiguous matches, links, forms, and obscured controls. Keep capture on the menu when no eligible control appears.

Set `CAPTURE_AUTO_START=false` to capture the initial screen. Set `CAPTURE_START_SELECTOR` to select a project-specific start control. Keep custom capture scripts responsible for their own interactions. Run `node --test scripts/capture-start.test.mjs`. Set `PLAYWRIGHT_MODULE` and optionally `CHROME_PATH` to enable the real-browser checks; set `CAPTURE_TEST_DIR` to an existing screenshot output directory.

## Regress remix preview port ownership

Run `node --test scripts/reclaim-preview-port.test.mjs scripts/start-project.test.mjs scripts/preview-setup.test.mjs`. Start an unmanaged project server before the controller; verify the controller stops only same-user listeners whose working directory belongs to the project, starts its own server, and serves the built output through the public hostname. Reject unrelated listeners without terminating them. Check controller process health before accepting HTTP readiness. Classify persistent HTTP 4xx host rejection as a repairable app defect; retry transport and 5xx failures separately.

## Verify slow remix startup

Run `node --test scripts/start-project.test.mjs scripts/preview-setup.test.mjs`.
Allow up to 600 seconds for dependency installation and a cold production build.
Set `STARTUP_TIMEOUT_SECONDS` to override the local readiness window.
Reuse the live `starting-commit` process for the same checkpoint across readiness retries.
Restart for a changed checkpoint, an exited process, or explicit `RESTART_APP=true`.
Reproduce Greywatch issue 1 with its pinned snapshot; require deployment and desktop/mobile captures after its 73-second build.

## Regress oversized checkpoint publication

Run `node --test scripts/session-checkpoint.test.mjs`. Verify a conversation above 25 MiB uploads as gzip, restores every message and part, and deduplicates unchanged saves. Keep the full conversation within the 128 MiB limit. Download managed restore payloads to a temporary file and remove it after parsing.
