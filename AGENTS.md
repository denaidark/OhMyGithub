# OMG (Oh My GitHub) agent instructions

Do not implement, suggest, report, or propose security issues unless the user explicitly asks for a security review.
Inspect the OpenCode implementation at `/Users/igor/Documents/ChatGPT/opencode` and [anomalyco/opencode](https://github.com/anomalyco/opencode) for related requests.

## Wiki index

- [OpenCode workflow](wiki/opencode.md)
- [Oh My Github App](https://github.com/AgentsLoop/omsite/blob/main/wiki/oh-my-github-app.md)
- [Temporary Mac SSH access](wiki/access.md)
- [Testing and verification](wiki/testing.md)
- [OmGithub publishing](https://github.com/AgentsLoop/omsite/blob/main/wiki/omgithub.md)


## Main project file

The main project file is [.github/workflows/opencode.yml](.github/workflows/opencode.yml).

Keep the local [game issue E2E skill](.agents/skills/game-issue-e2e/SKILL.md)
aligned with this workflow. Create an issue with `OpenCode` and only user-requested mode labels already attached, to start the native `issues.opened` listener. Wait only for the
initial OpenCode session link during E2E kickoff. Install the listener on the
default branch before requesting execution. Validate author access and freeze
the request inside Actions before starting the reusable execution job.
Set repository variable `OPENCODE_ACCESS=everyone` to accept any issue author
for labeled issues. Keep the App as a setup
helper. Use Actions concurrency to serialize each issue.
Store `branch` in an `omgithub-request:v1` JSON HTML comment to select the
project checkout, result base, and workflow. Let default-branch preparation
dispatch the selected branch. Run preparation and OpenCode in that branch run.

## Shell timing

When writing shell scripts,
always add explicit per-command execution-time measurements between commands.
Use `/usr/bin/time -p` or a small timing helper around each meaningful command;
the outer command duration is not sufficient because it hides which step is
slow or hung. Use `/usr/bin/time` only in scripts; do not invoke it directly in
interactive shell commands.

## Ideas

Store durable implementation ideas as individual Markdown files under
`./ideas/`, using descriptive kebab-case filenames such as
`ideas/opencode-oauth-env-auth.md`.




## Links in handoffs

When a relevant URL or stable identifier exists, include a clickable Markdown
link in the user-facing response. Link GitHub issues, Actions runs, pull
requests, commits, releases, public app URLs, and Codex tasks/threads rather
than reporting only their numbers or plain text. For Codex tasks/threads, use
the `codex://threads/<thread-id>` URL format.

When mentioning a commit, append its relative age in hours or days.

## OpenCode GitHub Actions

To execute an issue, create it with `OpenCode` and only mode labels explicitly requested by the user.
Check for a native `issues` run and successful preparation.
The workflow starts a temporary AgentsWeb SSH session,
verifies it, runs OpenCode, and cleans up the SSH session afterward.

When monitoring a triggered run, use `gh run watch <run-id> --repo AgentsLoop/OhMyGithub --exit-status` for overall job status.
Do not use `gh run view --log` to read logs from a running task: GitHub reports that
logs are unavailable until completion. Use `bash scripts/ssh-run-log.sh <run-id>`
for the live Actions log over SSH. Do not use tight `for` loops around `gh run list`,
which needlessly consume GitHub API rate limit.

To connect to an issue's live worker, find its run ID with
`gh run list --repo AgentsLoop/OhMyGithub --workflow opencode.yml --status in_progress`,
then run `bash scripts/ssh-run-log.sh <run-id>` to discover the host and port and SSH
with `~/.ssh/aiplay-agentsweb` as shown by the helper.

When the user asks to check a live OpenCode workflow, always pull the runner logs
over SSH first, using `scripts/ssh-run-log.sh` or a targeted SSH read from the
same runner. Base the answer on those logs before discussing whether an action
is confirmed; do not lead with a generic inability-to-confirm statement when
live log evidence can be collected.

For real-time inspection from a live temporary SSH session, use the helper:

```sh
bash scripts/ssh-run-log.sh <run-id>
```

The helper discovers the temporary SSH command from the triggering issue or pull
request, then follows the freshest `_diag/pages` log. The runner uploads chunks from
`_diag/blocks` to GitHub. Do not print environment files, tokens, or private keys while
inspecting the runner.

## Mac SSH access

The Mac private key stays at `~/.ssh/aiplay-agentsweb`. Its public key is
stored in the repository Actions secret `AGENTSWEB_SSH_PUBLIC_KEY`. The issue
commented by the workflow contains a directly usable command such as:

```sh
ssh -i ~/.ssh/aiplay-agentsweb -p <port> runner@<run-name>.agentsweb.space
```

The command works only while the corresponding Actions job is running.

## Connecting to a live OpenCode worker

Use the repository helper to discover the worker host and port from the broker
or issue comment. It uses the persistent local key `~/.ssh/aiplay-agentsweb`:

```sh
bash scripts/ssh-run-log.sh <run-id> --repo AgentsLoop/OhMyGithub
```

For an interactive shell, reuse the host and port printed by the helper and
use the same key:

```sh
ssh -tt -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -i ~/.ssh/aiplay-agentsweb \
  -p <port> runner@<run-name>.agentsweb.space
```

Do not substitute the generated runner key under `sshworker/outputs/keys/`; it
can produce a misleading `Permission denied (publickey)` result. Temporary
worker SSH access ends when the Actions job and session are cleaned up. Never
print secrets while inspecting a worker.
