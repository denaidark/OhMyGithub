# Isolate OpenCode GitHub credentials

Status: proposal only. This document does not change the workflow.

## Goal

Prevent the OpenCode worker from pushing directly to `main` or arbitrary
branches, while preserving issue statistics, progress updates, and trusted
workflow delivery.

## Recommended design

The worker should not receive the write-capable `GITHUB_TOKEN` or `GH_TOKEN`:

1. Remove the job-level `GH_TOKEN` from `.github/workflows/opencode.yml`.
2. Set `persist-credentials: false` on the repository checkout.
3. Provide the token only to trusted runner-side steps that update issue status,
   push the generated branch, or create the pull request.
4. If OpenCode needs issue metadata, fetch it on the runner and pass the data to
   the agent, or provide a separate read-only credential.

## Acceptance criteria

- OpenCode can edit and test the project normally.
- The worker cannot authenticate a Git push to `main` or another branch.
- Issue statistics and progress/status comments continue working.
- The trusted runner can push only the generated `opencode/<run-id>` branch and
  create its pull request.
- No token is exposed through inherited environment variables, Git credential
  files, command-line arguments, or generated OpenCode configuration.

## Implementation sketch

Keep `GH_TOKEN` and `GITHUB_TOKEN` out of the job-level environment so they are
not inherited by the OpenCode process or its SSH worker. Set
`persist-credentials: false` on the repository checkout. Add the token back
only on the runner-side steps that post comments, create the pull request, and
upload screenshots or logs.

The delivery step should authenticate its own `git push` with a temporary HTTP
extra header and enforce the exact target before pushing:

```sh
expected="opencode/${GITHUB_RUN_ID}"
[[ "$BRANCH_NAME" == "$expected" ]] || exit 1
auth="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64)"
git -c "http.extraheader=AUTHORIZATION: basic $auth" \
  push origin "HEAD:refs/heads/$BRANCH_NAME"
```

Do not rely on agent instructions, Git hooks, or a branch-name convention as
the security boundary. Verify the change from a live worker with
`git push --dry-run` to `main` and a non-generated branch: both should fail
authentication, while the trusted runner should still comment, upload release
assets, and create the generated-branch PR.
