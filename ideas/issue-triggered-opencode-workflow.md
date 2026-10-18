# Run OpenCode once per issue

Install the listener on the default branch. Use `issues.opened` as the only automatic trigger.
Create the issue with `OpenCode` and all mode labels already attached, or include `/OpenCode` in the title.
For the default branch, use one Actions run containing preparation and execution jobs.
For another branch, use a default-branch preparation run to dispatch `opencode.yml` at the selected branch.
Stop the first run, then run preparation and OpenCode in the selected-branch run.
Serialize each issue with Actions concurrency.

Leave `OPENCODE_ACCESS` unset or use `writers` to require write, maintain, or admin access for the author.
Set `OPENCODE_ACCESS=everyone` to accept any author.
Read the issue, check access, resolve `branch: <existing-branch>`, and dispatch that branch when it differs from the current workflow ref.
Pass the resolved SHA to execution after the workflow runs at the selected ref.
Use the App only to install the listener. Run preparation through the GitHub API on the runner.

Start an existing issue with `gh workflow run opencode.yml --repo <owner>/<repo> -f issue_number=<number>`.
Read the current issue and branch on each manual start or retry.
Update installed callers to the current runtime SHA when migrating from the old service-based preparation.

Verify one run for a default-branch issue. Verify a forwarding run and a selected-branch run for a routed issue.
Test both access modes and reject invalid branches, closed issues, and pull requests.
