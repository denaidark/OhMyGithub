# Run OpenCode in a Docker sandbox

Status: proposal only. This document does not change the workflow.

## Motivation

Running OpenCode directly in the Actions worktree gives the worker access to
more of the checkout than the generated application needs. A Docker boundary
can make accidental edits outside the application files impossible when the container is
given only the application directory.

## Recommended design

Keep the detached sparse Git worktree as the host-side source boundary, then
run OpenCode inside a non-root Docker container:

1. Create `/tmp/opencode-worktree-${GITHUB_RUN_ID}` from the selected base
   branch, containing only the application files.
2. Mount the application directory at `/workspace/app` in the container.
3. Mount shared skills read-only and do not mount the workflow checkout or
   `.github/` into the container.
4. Run OpenCode, the app server, tests, and browser checks inside the
   container, using explicit port mappings for the workflow tunnels.
5. Keep Git synchronization on the host. OpenCode writes files but does not
   commit or push; the host sync helper copies only the application files, validates the
   path scope, commits, and pushes with `--force-with-lease`.

## Git boundary options

Mounting only the application files gives the strongest scope protection, but OpenCode
cannot inspect Git history or commit directly. Mounting the complete sparse
worktree would allow direct Git operations, but requires exposing Git metadata,
handling container path references and UID permissions, and weakens the
protection against out-of-scope changes. Host-side synchronization is preferred.

## Risks to validate before implementation

- Docker availability and permissions on the temporary AgentsWeb worker.
- Non-root container UID ownership of generated files.
- Playwright/Chromium dependencies and browser sandbox behavior.
- App, OpenCode Web, SSH, and Cloudflare tunnel networking and port mapping.
- Bun/npm/pnpm caches without mounting host credentials or the Docker socket.
- Cleanup of containers, volumes, and worktrees after cancellation or failure.

## Acceptance criteria

- The container can read/write only the isolated application directory.
- A standard `OpenCode`-labeled run completes browser and public URL verification.
- The host sync step rejects any changed path outside the application files.
- Worker-generated files survive container exit and are committed by the host.
- No workflow, credential, GitHub token, Docker socket, or private key is
  mounted into the OpenCode container.
- Existing non-Docker workflow behavior remains unchanged until the Docker
  path passes a separate end-to-end test.
