---
name: issue-e2e
description: Start the issue-triggered workflow and return its initial OpenCode session link.
---

# Issue E2E kickoff

Use only for an explicitly requested issue-triggered E2E run. Always create a
new issue and Action for each invocation. Never reuse, continue, edit, or
inspect an existing matching issue or run as a substitute. Then stop at the
initial Web UI link. Do not claim implementation completion.

## Write the issue prompt

Locate the skill invocation in the user's message. Remove only the invocation
syntax and routing metadata such as `#main` and mode labels. Keep the surrounding
request text in its original order.

If `#c` is present, drop `#c` and all routing metadata, then copy the remaining
request text exactly as the issue body. Set the issue title to the remaining text. Attach `OpenCode`. Do not read the rubric, rewrite the
text, add a heading, or add a skills sentence.

Read `references/gauntlet-prompt-rubric.md` whenever the remaining request is
sparse, names only a product or concept, lacks a concrete quality bar, or does
not state the required output surface and dimensionality. Rewrite that request
as a concise Gauntlet Loop prompt. Never let invocation placement bypass the
rubric.

If the invocation has no request text, invent a fresh random small playable
browser-game brief. Do not substitute a generic workflow-validation task or
ask the user for a game concept.

Keep the title and visible body limited to the user request. Attach `OpenCode`.
Store branch routing in an `omgithub-request:v1` JSON HTML comment.

Write the issue body to a temporary Markdown file and pass it with
`gh issue create --body-file <path>` or `gh issue edit --body-file <path>`.
Do not interpolate Markdown containing backticks, `$`, `$(...)`, or backslashes
inside a shell double-quoted argument. Verify the saved body with
`gh issue view <number> --json title,body,labels` before checking the run.

Do not execute the full Gauntlet Loop during issue-e2e kickoff. The prompt
should instruct the worker to perform the sustained project work after the
issue starts.

Before writing the issue, list the target repository's `skill/*` labels and
select only the skills that directly support the request. Add one short
imperative sentence to the issue prompt that names the selected skills and
requires the worker to load and use them where relevant. Attach every selected
`skill/*` label when creating the issue so the workflow passes the same skill
names to OpenCode. For visual recreation work, prefer an available image-search
skill over generic web search. For 3D game work, select available 3D asset or
runtime skills only when they match the requested implementation.

With `#c`, still attach selected `skill/*` labels but do not alter the copied
title or body to name them.


Check `git branch --show-current`. If non-empty and not `main`, verify it and
set `branch` in the hidden request metadata. The reusable workflow checks
out the validated `target_sha` and uses `target_ref` as its result base, preserving the
debugging worktree. Default-branch preparation dispatches the listener at this
branch. Treat the selected-branch run as the execution run. This suffix is
routing metadata, not prompt text. On `main`, omit it.

Resolve the target repository before creating the issue. With `#main`, use the
current checkout repository on `main`.
Resolve that repository before listing labels or creating the issue. Do not use
the `AgentsLoop/PlayGround` fallback when `#main` is present. Otherwise, on
`main` without a supplied repository, use
`AgentsLoop/PlayGround` explicitly. On another branch, use the current
repository. Never infer the default `main` repository from `git remote`.

If the user mentions another local skill, verify it exists in
`https://github.com/agents-dev/skills/` before selecting it. If it is absent,
push it first.

## Procedure

1. Check `git status --short` and the current branch; preserve unrelated work.
   Resolve `<target-repo>` and `<target-branch>` before any issue or workflow
   command. Verify the default `main` target is `AgentsLoop/PlayGround`.
2. Treat request tags like `#mac` as GitHub labels: strip `#`, create missing
   labels. Do not create a label for `#c`. List available `skill/*` labels,
   select the useful skills, and name them in the generated prompt unless
   `#c` is present. Verify the default-branch listener exists,
   then create an issue with the `OpenCode` label. Attach only mode
   labels explicitly requested by the user and all selected `skill/*` labels.
   Never add another mode label by default. Always create this
   new issue even when a matching issue or run already exists. Do not create a
   label for `#self`. Verify labels with `gh issue view <number> --json labels`.
   Comments, edits, and other labels are not triggers.
3. Confirm the newest run is matching `issues`, title, resolved
   `<target-repo>`, and the repository default branch:

   ```sh
   gh run list --repo <owner>/<repo> --workflow opencode.yml --limit 5 \
     --json databaseId,displayTitle,event,status,url,headBranch
   ```

   Check preparation outputs for `<target-branch>` and the frozen checkout SHA.
4. Poll only until the initial Web UI URL appears; return issue, run, and session
   links immediately. Also extract the SSH command from the temporary access
   comment and return it with the links. Do not `gh run watch` to completion or
   cancel/rerun an active run without checking its current step.
