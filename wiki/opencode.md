# OMG (Oh My GitHub) workflow

The canonical workflow is `.github/workflows/opencode.yml`.
The numbered build, verification, remediation, completion, and screenshot
prompt templates are stored as Markdown files in `.github/prompts/`.

Keep the default static app server watching generated files. Inject its change-event client only for `omgithub_live=1`; leave the ordinary preview unmodified. For Vite projects, keep the output build running in watch mode while the worker is live.

Keep the runtime checkout, AgentsWeb client, SSH files, and web-control state under `$RUNNER_TEMP`, outside the project checkout. Fetch the runtime at the pinned workflow commit. Keep Playwright CLI snapshots and logs under `$HOME/.local/share/omgithub-playwright/output`. Read live lifecycle diagnostics from `$RUNNER_TEMP/omgithub-web` over SSH.

## Lifecycle shutdown

Inspect `lifecycle.log` for deployment callback failures. Match the run, attempt, state, generation, and response body before diagnosing a superseded registration. Preserve the server generation fence.

Use `scripts/stop-lifecycle.mjs` in both cleanup paths. Allow 10 seconds to drain an aborted worker, 150 seconds to save the interrupted checkpoint, and 15 seconds for the ended callback. Enforce the controller's 180-second deadline and the supervisor's 210-second deadline. Terminate recorded child process groups before deleting runtime state. Preserve checkpoint errors and forced-stop failures in the job outcome.

Run `node --test scripts/session-lifecycle.test.mjs scripts/stop-lifecycle.test.mjs scripts/session-checkpoint.test.mjs` after changing shutdown behavior. Update consuming repositories' pinned workflow and runtime refs before creating a verification issue.

## Trigger

Create the issue with `OpenCode` and requested mode labels, to start `.github/workflows/opencode.yml` through `issues.opened`. Install this listener
on the default branch first. Run `opencode-prepare.yml` on the Actions runner
to verify author access and resolve the target branch.
Pass validated outputs to `opencode-reusable.yml` only after approval.

Use the issue body as the request, or its title when the body is empty. Add
`Goal` to select `opencode run --command goal` with
`noInterruptOnUserMessage: true`. Omit `Goal` for the standard invocation.

An issue with the `ralph` label installs the standalone
[`opencode-ralph-loop`](https://github.com/charfeng1/opencode-ralph-loop) plugin
and starts `opencode run --command ralph-loop` in the same workflow session.
Ralph takes precedence when both `Goal` and `ralph` are present, which makes it
safe to add `ralph` to the usual Goal-labeled issue. The workflow requires
Ralph's `<promise>DONE</promise>` completion marker before validation and
completion reporting.

Use the App installation helper or install the caller manually. Set repository
variable `OPENCODE_ACCESS=everyone` to accept any issue author.
Attach the execution label when creating the issue. Leave the variable unset
to require write, maintain, or admin access.

Attach `OpenCode` and `test` for synthetic generation. Copy the fixture project, import a completed synthetic conversation into the real OpenCode server, and run the production lifecycle for checkpoint, startup, capture, and deployment. Require a ready deployment with screenshots before marking the test complete. Keep the normal diagnostic logs release.

The workflow uses the `macos-latest` GitHub-hosted runner by default for the
entire OpenCode job. The `linux` label opts the run into `ubuntu-latest`.

Store `branch` in an `omgithub-request:v1` JSON HTML comment to select project checkout.
Validate this branch during preparation and freeze its commit as `target_sha`.
Use `target_ref` for the result base. Use the default branch when no branch metadata
exists. When the metadata selects another branch, let default-branch preparation
dispatch `opencode.yml` at that branch and stop. Run preparation and OpenCode
from the selected branch workflow. Use the central workflow revision pinned by
that branch's caller.

Read the [Oh My Github App documentation](https://github.com/denaidark/omsite/blob/main/wiki/oh-my-github-app.md) for
App ownership, installation scope, permissions, events, and webhook details.

An issue labeled `omo` additionally installs and configures the OpenCode Ultimate
edition of `oh-my-openagent` with Bun before the OpenCode server starts. The
installer runs non-interactively with provider authentication skipped; `/omo` is
not a command and does not trigger a run by itself. An `omo`-labeled OpenCode run
uses OMO's native `goal` command and prepends `ulw` to the objective. The Codex
Light `ulw-loop` component is not recreated or registered for OpenCode.

## Run the job

1. Register run/attempt identity before runtime checkout. Preserve detailed Actions progress throughout execution.
2. Check out the target and runtime. Install worker instructions and optional label policies.
3. Start optional SSH access, OpenCode, and the control/app tunnels. Route project files through the control tunnel.
4. Initialize the project once. Restore saved conversations and start saved apps before submitting resumed work.
5. Run the model, or import synthetic generation for test requests. Publish real session URLs.
6. Let the lifecycle controller checkpoint every completed main response. Execute startup and capture directly; fork OC only to repair broken scripts.
7. Record local readiness before public checks. Retry temporary tunnel/capture failures without restarting a healthy app.
8. Package declared static output and fresh screenshots. Retry the same upload archive and generation.
9. Store deployed screenshots in OmSite. Post the durable preview link to GitHub. Preserve successful publication if reporting fails.
10. Store diagnostic logs and response JSON in a run logs release. Reuse the checkpoint export only when its session revision matches current OpenCode metadata.
11. Keep normal live access available for five hours. Save changed state and end registration during shutdown.

Validation is controlled by the repository variable `VALIDATION_ENABLED`. It
defaults to `true`. When set to `off` (or any value other than `true`), the
workflow stops after the initial OpenCode prompt and temporary OpenCode Web
trycloudflare exposure; app verification/remediation, completion and screenshot
prompts, Git delivery, immutable project publication, release/report generation, and the
complete label are skipped. The temporary access session still sleeps for five
hours before cleanup.

After the branch is pushed, the completion report links the repository path to
OmGithub. Opening that URL anonymously resolves the named branch and optional
project directory, discovers root `index.html` or `dist/index.html`, and creates
the store page and playable deployment. Keep the full
commit-SHA URL working for compatibility. There is no separate publishing
credential or upload step.
Read [OmGithub publishing](https://github.com/denaidark/omsite/blob/main/wiki/omgithub.md).

The OmGithub issue workspace polls issue comments every eight seconds. Its
header contains the four numbered workflow stages plus the currently executing
stage and description. On desktop it shows the live OpenCode session on the
left and the newest progress screenshot or playable preview on the right. At
the mobile breakpoint, Chat and Preview tabs keep only one iframe visible at a
time. Numbered preview controls retain access to every progress and final
screenshot found in issue comments.

The comment URL opens `/<encoded-worktree>/session/<session-id>` rather than
the web home page. This matters because the web home page stores its project
selection in the browser, while the runner's project exists only on the
temporary GitHub Actions filesystem.

## Local tracker test

On macOS, run `./scripts/test-opencode-progress-tracker.sh`. It starts a local
mock OpenCode HTTP server with nested, active, and completed child sessions,
including user and tool image attachments, then asserts the three derived
progress counters.

The workflow uses the built-in OpenCode model path and does not require an
`OPENCODE_API_KEY` secret. To authenticate an ephemeral worker with the Mac's
OpenAI OAuth login, save the complete local OpenCode `auth.json` as the
`OPENCODE_AUTH_JSON` repository secret; the workflow passes it through
OpenCode's `OPENCODE_AUTH_CONTENT` environment variable. Branch creation and
pushing are deliberately handled by the workflow rather than by OpenCode's
GitHub integration.

## Findings: tracking the GitHub run in Web UI

The previous GitHub integration installed the OpenCode CLI and ran:

```sh
opencode github run
```

The workflow now sends the comment text directly to `opencode run --attach --dir
<project-directory>`. The explicit directory is required when the CLI attaches
to a separately started OpenCode server; without it, the CLI can answer while
the resulting session is not visible in the intended Web UI workspace.

For the installed `opencode-goal-plugin`, invoke a goal from the non-interactive
CLI with `opencode run --command goal "<objective>"`; passing `/goal <objective>`
as the message sends literal text instead of invoking the custom command. To
send a follow-up to the same attached session, use `opencode run --attach
<server-url> --session <session-id> "<message>"`. In this workflow, the
issue text is passed directly as the objective before it is passed to the custom
command, and later human messages steer the running goal instead of
pausing it.

Before starting OpenCode, the workflow checks out `denaidark/skills` into
`$PROJECT_DIR/.agents`. OpenCode discovers project skills from
`$PROJECT_DIR/.agents/skills/**/SKILL.md`.
The workflow excludes this nested skills checkout through `.git/info/exclude`
so it cannot be included in the generated app commit.
The workflow verifies the discovered skill list through OpenCode's `/skill`
endpoint. OmGithub installs `model/<provider>/<name>` and `skill/<name>` labels
before the first issue, while `OpenCode` is absent. Create `OpenCode` last.
This keeps the regular OpenCode session while making branch and immutable
commit behavior explicit and reviewable in YAML.
Initial model labels come from the live OpenCode catalog and are
limited to models with zero input, output, and cache-read cost. Add
`model/openai/gpt-6-luna` only when an issue explicitly selects that model.
Omit the model label when the workflow default is selected. Default GitHub labels are removed, and
the triggering issue is marked `in progress`, `validating`, `complete`, or
`failed` as the job advances.
For difficult game requests, the `game-issue-e2e` skill selects the synchronized
`model/opencode/deepseek-v4.1-flash-free` label; if that label is
unavailable, the skill records that it used the workflow default instead.

The workflow reads the repository variable `PROJECT_DIR` as a repository-relative
project home. It defaults to `./`.
Absolute paths and parent-directory traversal are rejected. OpenCode Web and all
OpenCode runs use the resolved directory, and skill checkout, Git delivery,
and screenshot links use the same project home. OpenCode's server
also loads project instances per request using the `x-opencode-directory` header.
A tunneled browser request does not know the runner's `$GITHUB_WORKSPACE`, so
the UI can appear empty even while `opencode github run` is actively working.

The reliable architecture is:

```text
opencode github run
        |
        v
shared OpenCode session/database
        ^
        | x-opencode-directory: $PROJECT_DIR
        |
trycloudflare tunnel -> workspace-scoped OpenCode Web UI
```

The workflow starts OpenCode from `$PROJECT_DIR`, so its direct server is
already scoped to the checked-out worktree. API and session probes explicitly
send `x-opencode-directory: $PROJECT_DIR`, while Cloudflare tunnels directly
to that same loopback server. This avoids an extra reverse-proxy hop and keeps
WebSocket upgrades native. The access comment points to the encoded
canonical worktree/session route, so the browser opens the live run directly.
The resolver emits the repository root without a trailing `/.`; this keeps the
encoded browser route identical to OpenCode's canonical session directory. A loaded
Web UI or healthy tunnel alone does not prove session tracking; acceptance
requires a screenshot while the run is active.

## Repository settings

- For runner-side SSH access and verification, configure the
  `AGENTSWEB_SSH_PUBLIC_KEY` Actions secret with the public key matching the Mac
  private key described in [access.md](access.md). Without it, the workflow
  skips SSH setup and verification but still exposes the OpenCode Web session.

## Verify OpenCode installation

Install OpenCode with the official `https://opencode.ai/install` script and
the selected release version. Add `$HOME/.opencode/bin` to the current shell
and `GITHUB_PATH`. Link the installed binary at `/usr/local/bin/opencode`
for fresh SSH shells. Verify `opencode --version` after installation and
from a new Bash process. Do not depend on installer changes to shell profiles
for non-interactive Actions or SSH commands.

## Resume saved games

Save code and the main public conversation after each completed response with `scripts/session-checkpoint.mjs`.
Save again before closing temporary access. Keep the five-hour access period.
Store the conversation and manifest in OmGithub-managed checkpoint storage. Publish the latest pointer after both files are durable. Read old releases only for legacy sessions.
Retain legacy releases for old-session restores. Exclude credentials, dependencies, and runner files.

Restore version 2 checkpoints with matching repository, issue, commit, and OpenCode version.
Import the complete conversation and submit only the next requested change.
Use a new issue and result branch. Keep the source game's publication unchanged.
Mark games without complete checkpoints as **Resume unavailable**.
Run `node --test scripts/session-checkpoint.test.mjs` to verify the checkpoint cycle.

Preserve transcript text and tool results when importing. Remove provider-bound replay IDs, encrypted reasoning, and signatures before submitting to a new runner's provider session.
Set `OPENCODE_DEBUG_HOLD=true` only in a debugging repository to retain failed live runners for 30 minutes. Use `scripts/ssh-run-log.sh` to inspect the live worker. Remove the variable after debugging.

## Restore the main session and preview

Keep `checkpoint-session-id` set to the main session. Save the latest workspace files with that conversation. Submit the exact user prompt to the restored main session. Preserve whitespace and bypass command wrappers. Run scripted capture after each completed response. Reject saved child sessions instead of importing them as main conversations.

Provision the default start.sh before main OpenCode runs. Install dependencies, build when required, and serve port 3000 in the foreground. Test from a stopped app without installed dependencies. Start control and app tunnels during worker setup. Serve files through the control proxy. Run the saved script before submitting resumed work. Publish the restored preview only after local and public HTTP checks pass. Reuse the app tunnel for delivery. Run capture.sh against the ready preview. Repair missing or failing scripts in an OC repair fork; execute the repaired scripts and inspect their screenshots. Inspect `app.log` for startup failures.

## Save and deploy main-session responses

Run `scripts/session-lifecycle.mjs` once before exposing the web tunnel. Route browser requests through its control port. Read `main-model` after execution-label resolution. Register the main session before reconciling idle events.

Save each completed main response through `scripts/session-checkpoint.mjs`. Keep one OmGithub checkpoint pointer per issue and separate conversation and manifest files. Validate through `scripts/session-deploy.mjs` in the main workspace against the shared live server. Cancel validation before forwarding new web messages. Preserve the last successful deployment and reject obsolete generations. Save changed state during shutdown without starting validation.

Report total chat runtime as the sum of all main-session turns. Measure each turn from its user message creation time through its assistant completion time. Add the active turn through the current time. Include tool and subagent work inside each turn. Exclude idle time between turns. Divide cumulative session tokens by total chat runtime for the speed score.

Run `node --test scripts/session-lifecycle.test.mjs scripts/session-checkpoint.test.mjs scripts/opencode-prepare.test.mjs scripts/opencode-reporting.test.mjs`. Run `actionlint .github/workflows/opencode.yml .github/workflows/opencode-reusable.yml`.

## Restore cross-repository checkpoints

- Fetch the saved checkpoint commit from the metadata source repository before restoring it.
- Keep the destination origin for result pushes. Do not require source checkpoint branches in the destination.
- Test cross-repository restore when a copied game branch does not contain the separate checkpoint commit.

## Recover shared preview startup

Run the existing project startup and capture scripts directly after each checkpoint. Reuse the healthy preview on port 3000; start it when stopped. Accept PORT in start.sh and serve in the foreground. Check local and public HTTP readiness. Accept CAPTURE_URL and CAPTURE_DIR in capture.sh; capture fresh final-desktop.png and final-mobile.png outside source, close the capture browser, and leave the server running. Invoke an OC repair fork only for missing or failing scripts, with at most two repairs. Require OC to execute its changes and inspect both screenshots. Save repaired setup with the main conversation export. Publish only after scripted startup and capture succeed. Cancel deployment when main continues and reject superseded deployment generations. Retain the last successful draft and diagnostic evidence on failure. Store SSH connectivity-test keys in runner.temp and retain the Mac authorized key.

## Separate script lifecycles

Provision missing project scripts after checkpoint restore and before main OC starts. Execute startup.sh once per worker from the project directory; keep its default empty except for the Bash header and strict mode. Store project-specific prerequisites there. Stop initialization on failure. Apply new setup commands manually in the current worker when a repair changes this hook.

Use start.sh for repeatable application startup and capture.sh for screenshot capture. Preserve customized scripts. Use the shared Node helpers through RUNTIME_DIR on macOS and Linux. Detect npm/Vite projects before standalone HTML, install dependencies when their manifest changes, build Vite output into dist, and serve on PORT defaulting to 3000. Customize start.sh and deployment output for other frameworks. Set CAPTURE_READY_SELECTOR for application-specific rendering readiness. Keep browser installation in worker infrastructure and capture output outside source.

Adopt the new script contract directly. Create new checkpoints using startup.sh for initialization and start.sh for the server.

## Register and deliver current runs

Register structured run state through scripts/run-record.mjs. Send a heartbeat every 30 seconds from the controller. Persist tunnel URLs in web-url, files-url, and app-url. Tunnel live source files directly to the managed Vite server on PROJECT_FILE_PORT. Keep OpenCode on its control tunnel and final preview on its app tunnel. List directories without automatically opening index.html; process explicit source HTML and module requests through Vite. Keep dist for final preview. Preserve readable Markdown and shell files. Install the locked live-browser dependencies through scripts/start-live-files.sh. Use the managed vanilla Vite configuration independently of generated project build configuration; install project dependencies before expecting package imports to resolve. Extend the managed server explicitly before using framework-specific plugins or project aliases.

Declare the static deployment directory in OPENCODE_WEB_DIR/deployment-output.json with absolute project and directory fields. Use the shared default starter to write this declaration for HTML and Vite. Write the same declaration from custom start.sh scripts. Restart the app when its recorded checkpoint differs from the current checkpoint. Capture the resulting server before packaging that declared output.

Keep deployment success separate from result reporting. Retry reporting independently and retain capture evidence on failure. Generate the human-readable deployment report from the controller result. Read readiness from structured run/deployment state. Require a version 2 checkpoint and an explicit OmGithub manifest pointer. Supply branch selection as omgithub-request:v1 metadata.

## Keep state and tests deterministic

Use the bootstrap request only before the lifecycle starts. Let the lifecycle own later connectivity updates. Keep deployment state out of heartbeat payloads. Keep checkpoint manifests and conversations separate from deployment screenshots.

Use monotonically ordered synthetic message IDs. OpenCode sorts messages by ID; random IDs can put the user after the completed assistant and prevent reconciliation. Verify imported message order before writing the main-session marker.

Return capture exit 75 for temporary navigation/browser failures. Return exit 1 for script or rendering defects. Preserve bounded retries and diagnostics.

## Advertise ready previews

Keep raw tunnel allocation in app-url and publish ready-preview-url only after the runtime launcher confirms local and public HTTP readiness. Clear readiness when restarting the app. Notify the lifecycle immediately after readiness succeeds. Keep tunnels owned by the runtime and keep start.sh focused on the foreground application.

## Gate public tunnel readiness

Probe chat, files, and ready-preview HTTPS endpoints through normal DNS before publishing their URLs. Require a successful response within four seconds; reject redirects and retry failed checks on subsequent heartbeats or status refreshes. Run checks independently and concurrently on the worker and OmGithub server. Keep unready URLs empty and retain the waiting panel. Do not treat URL allocation or a local heartbeat as public readiness. Allow for client-specific DNS caches even after server probes succeed.

## Prepare remix snapshots

Read `omgithub-snapshot:v1` from the frozen request. Download the selected public commit archive in the runner before checkpoint restore and AI startup. Preserve the installed execution workflow and runtime checkouts. Import selected files with a fresh commit; retain licenses and source attribution in `.omgithub-remix.json`. Push to the prepared branch without force. Export the new `TARGET_SHA` and strip snapshot metadata from the AI prompt. Restore a matching conversation without fetching source history. Read the named preparation step for progress and errors.

Run `node --test scripts/remix-snapshot.test.mjs scripts/session-checkpoint.test.mjs`. Dispatch `remix-snapshot-smoke.yml` to check a public snapshot on Linux and Mac using isolated local Git destinations. Keep source code unexecuted during the import smoke test.

## Install preview prerequisites

Install and verify tmux before starting the web runtime on Linux and macOS. Keep preview dependency setup independent of optional SSH access. Fail the setup step when installation fails. Diagnose missing tmux from lifecycle.log before attempting project-script repairs.

## Recover provider failures

Resume terminal retryable provider errors and `Invalid upload request` errors in the same session and model. Wait 30 seconds and send exactly `Continue`. Limit automatic resumes to five per human request, including failures after partial progress. Cancel pending recovery on new input, cancellation, shutdown, or successful completion. Inspect `lifecycle.log` for recovery attempts and exhaustion. Apply this behavior to newly started workers; do not expect running controllers to reload code.

## Report preparation and terminal status

Register the run with OmGithub before preparation checkout. Grant preparation contents-write permission to support the existing workflow-token callback authentication. Report preparation failure from an always-run finalizer. Report the execution outcome after cleanup. Generate shell callback sequences with Node `Date.now()` on macOS and Linux; preserve millisecond precision when lifecycle shutdown and final reporting share a second. Bound callback retries; keep execution independent of the optional GitHub App. Preserve GitHub error messages, request IDs, and rate-limit headers in preparation diagnostics.

Update existing listener pins and permissions when deploying this workflow. Keep late heartbeats from replacing terminal outcomes. Reconcile missing callbacks in OmGithub rather than polling Actions separately from each project card.

## Report status without GitHub REST

Grant `id-token: write` in listener and reusable jobs. Exchange the Actions identity
for an OmGithub callback credential before checkout. Pass `OMGITHUB_CALLBACK_TOKEN`
to run registration and deployment uploads. Keep registration nonfatal. Report
terminal outcomes without loading checkout files. Install the updated listener
before creating a fresh test issue; do not rerun existing issues for verification.


## Load OmGithub account credentials

Load account credentials with `scripts/account-credentials.mjs` after fetching the pinned runtime and before starting OpenCode. Authenticate each request with fresh Actions OIDC. Keep repository auth JSON and explicit workflow environment values as overrides. Load only the account bound to the issue by OmGithub. Keep unbound GitHub issues on repository defaults.

Write merged auth outside the checkout. Preserve repository credentials for matching providers. Import missing account providers. Clear inline auth after writing the merged file so OpenCode reads refreshed credentials. Synchronize imported account providers and preserve account values shadowed by repository overrides. Mask account values before exporting custom environment variables. Retain initial and refreshed values for checkpoint redaction. Run the auth watcher every minute; return refreshed auth with its revision and stop synchronization after main execution and validation settle, before the temporary-access hold. Retain final cleanup as a fallback. Start authorized account runs concurrently with the same auth JSON. Preserve newer saved credentials when revision checks reject a stale update. Replace expired or revoked subscription credentials in OmGithub Settings.

Map `openai/gpt-6.1-sol` and `openai/gpt-6-astra` to `--variant high` in every invocation mode, including resumes and Goal/Ralph commands. Keep other models on their existing defaults.

Run `node --test scripts/account-credentials.test.mjs scripts/session-checkpoint.test.mjs`. Validate the workflow with `actionlint .github/workflows/opencode-reusable.yml`.


## Validate the publish directory before capture

Keep source and static build output inside PROJECT_DIR, such as PROJECT_DIR/dist. Reserve OPENCODE_WEB_DIR and RUNNER_TEMP for runner metadata and capture evidence. Validate the declared directory inside the startup/capture repair loop, before treating a working preview as publishable. Reuse the same validation before packaging. Repair an external build path instead of accepting screenshots and failing only at upload.


## Verify parallel subscription execution

Use [Tribes 3D issue 31](https://omgithub.com/VibeFin/PlayGround/issues/31) and [Warcraft 3D issue 32](https://omgithub.com/VibeFin/PlayGround/issues/32) as the 2026-10-01 live concurrency evidence. Inspect [the Tribes run](https://github.com/VibeFin/PlayGround/actions/runs/36818330174) and [the Warcraft run](https://github.com/VibeFin/PlayGround/actions/runs/36818335585). Verify both passed account credential loading and produced model output during overlapping execution. Compare access-token fingerprints inside a diagnostic process without logging credentials. Require account-auth files in both workers and no repository-auth override. Treat this as concurrency verification, not completed-game validation or simultaneous provider-refresh validation.

Close child-process stdin when spawning isolated `opencode run` smoke tests; avoid blocking the CLI while it waits for piped input. Keep each smoke process in its own data directory and clean up only its own files.

## Link issue access through OmGithub

Publish one [Open project](https://omgithub.com/OWNER/REPO/issues/NUMBER) access link in workspace, live-progress, preview, and deployment comments. Build the URL from OMGITHUB_ORIGIN, the repository, and the issue number. Keep SSH commands and diagnostic evidence links available. Keep service URLs in structured run registration.
## Finish interrupted builds

Treat a completed, idle `MessageAbortedError` response as finished. Save the checkpoint and run deployment validation after manual Stop. Reject ordinary execution errors and unfinished tool calls. Preserve the checkpoint branch's workflow tree; use the current remote default workflow tree for its first checkpoint. Keep game edits in the isolated index. Surface child stderr when checkpoint saving or publishing fails.

## Capture project progress

Use the shared Playwright CLI or default capture script to collect page and locator screenshots from every agent. Match the page origin at capture time against port 3000, `app-url`, and explicitly registered project origins. Register additional project servers in `$OPENCODE_WEB_DIR/project-preview-origins.json` as a JSON URL array. Exclude reference sites and unregistered local servers. Keep captures in `$OPENCODE_WEB_DIR/wip-queue`; upload them asynchronously every two seconds. Retry failed uploads without blocking generation. Deduplicate identical bytes and retain capture timestamps. Keep WIP history separate from final deployment evidence. Instrument custom browser tools with `scripts/wip-screenshots.cjs`; exclude unattributed image attachments.

Run `node --test scripts/wip-screenshots.test.mjs`. Run `scripts/test-wip-capture.mjs` with `PLAYWRIGHT_CLI`, `PLAYWRIGHT_ROOT`, and an optional `CHROME_PATH`. Verify main/child browser captures, locator captures, reference exclusion, and duplicate suppression.

## Inherit account MCP connections

Load the MCP configuration returned by account credential checkout before starting OpenCode. Merge account servers into `OPENCODE_CONFIG_CONTENT`; retain explicit workflow entries. Mask run gateway credentials. Keep provider tokens in OmGithub. Retain MCP access until main and validation work settle, including MCP-only runs. Revoke gateway grants during release. Run `node --test scripts/account-credentials.test.mjs` after changing this flow.
