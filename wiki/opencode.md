# Operate OpenCode execution

Use OpenCode v2. Keep the project owner’s source, conversation history, and generated builds in the project repository. Keep the GitHub App responsible for listener installation; prepare and execute issues in Actions.

## Select execution

Create an issue with the OpenCode label attached. Freeze its request, branch, and source commit during preparation. Keep the user request unchanged. Select branches through omgithub-request:v1 metadata. Serialize runs per issue. Install a current listener before requesting execution.

## Start workers

Install the pinned v2 runtime. Restore compatible conversation history before opening the browser session. Start a new conversation when only source code is available. Run startup.sh once for project prerequisites. Run start.sh in the foreground through the controller. Declare the built static directory inside PROJECT_DIR in deployment-output.json.

## Expose live services

Start one named Cloudflare Tunnel per run and attempt through the authenticated OmGithub callback. Route OC, Files, and Live through separate omgithub.com hostnames. Keep account management credentials on OmGithub. Pair browsers through /omgithub/connect. Keep the main session distinct from script-repair forks. Validate actual browser message submission, SSE, Files, and Live.

## Save checkpoints

Commit source and .omgithub/checkpoint.json on opencode-checkpoints/ISSUE. Include .omgithub/conversation.json when the complete main conversation fits within 100,000,000 bytes. Record its digest and skipped files. Keep checkpoint commits reachable. Push normally and reject superseded writes. Keep the workspace branch unchanged while saving. Restore exact pinned commits; start fresh when history is absent or oversized.

## Publish builds

Validate startup and capture through scripts/preview-setup.mjs. Repair project scripts in a fork only after failure. Use relative asset paths; configure Vite builds with a relative base. Commit unpacked static output, final screenshots, and .omgithub/deployment.json on opencode-deployments/ISSUE. Keep source and build commit identities separate. Capture the exact immutable f.ondev.store URL before activating its catalog record. Preserve the previous playable deployment when validation fails.

## Publish progress images

Batch captures into opencode-progress/ISSUE commits every thirty seconds. Register immutable f.ondev.store URLs with OmGithub. Keep image bytes off the server. Keep old hosted screenshot readers available.

## Resume and remix

Restore source independently of conversation history. Preserve source attribution, licenses, repository references, and the selected commit. Copy source into the destination through scripts/remix-snapshot.mjs when necessary. Use the current runtime and listener for new work. Keep existing published games available.

## Inspect workers

Read lifecycle.log and deployment-status.json over SSH before interpreting public readiness. Use scripts/ssh-run-log.sh for active runs. Read completed logs through GitHub. Inspect source checkpoints, immutable build URLs, and diagnostics separately. Export diagnostic responses through the v2 API.

## Clean up

Stop the lifecycle and connector. Remove execution tunnel and DNS resources. Reconcile abandoned tunnels through the server journal. Preserve existing hosted builds, screenshots, recordings, and source references. Remove server conversation payloads only after verifying the Git-backed restore path.
