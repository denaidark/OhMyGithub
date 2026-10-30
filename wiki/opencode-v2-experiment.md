# Test OpenCode 2 in isolation

Keep production on V1 until every gate below passes. Run V2 only from the
separate caller in `lasseondev/omgithub-v2-test`.

## Run the experiment

Dispatch `opencode-v2-test.yml` for Linux or macOS with an issue number. The
reusable workflow installs the pinned `OPENCODE_V2_VERSION`, starts the server,
verifies SSH, runs the checks, and holds the worker for five minutes.

Follow live logs with `bash scripts/ssh-run-log.sh <run-id> --repo lasseondev/omgithub-v2-test`.

## Covered checks

- Create a file with the model, then continue the conversation.
- Send a prompt through the V2 proxy and observe lifecycle events.
- Save the session through `Lifecycle`, fork it, and validate the fork.
- Export, import, and continue the restored session.
- Interrupt an active session and checkpoint the stopped response.

## Known V2 differences

- Use `--server` instead of `--attach`; pass no `--dir`, `--variant`, or `--command`.
- Read `opencode v2.2.2` from `--version`; strip the prefix before saving.
- Check `/api/info` with Basic auth; `/global/health` returns the web app.
- Use `/api/session/*` with `{ data }` responses; V1 paths return HTML.
- Build session links as `<origin>/server/<base64url(origin)>/session/<id>`.
- Pair browsers with `POST /api/pair`, then open `<origin>/auth/connect/<code>`; the session page shows an empty shell until pairing.
- Save exports through `/api/experimental/session/<id>/export`.
- Expect `idle` markers with `succeeded`, `interrupted`, or failure outcomes.
- Treat a user stop as `interrupted` with an `aborted` assistant error.

## Credentials

`OPENCODE_AUTH_CONTENT` and `auth.json` did not expose OpenRouter to V2 in local
testing. Provider environment variables did. Keep the DeepSeek-first free model
order and fall back to a connected provider when the free tier returns
`FreeUsageLimit` 429.

## Remaining work

- Port plugin-backed modes; V1 plugins do not run in V2.
- Accept V2 checkpoint transcripts in OmSite storage and resume.
- Wire publishing, preview validation, and run registration to the V2 controller.
- Verify every production provider, not only the test provider.
- Repeat the gates on a staging OmGithub instance before switching defaults.
