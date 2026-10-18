# GitHub agent project comparison

Use the strongest patterns from existing GitHub agent projects while keeping
aiplay's public-preview and browser-verification pipeline.

## Comparison

| Project | Take from it | Do not copy blindly |
| --- | --- | --- |
| [Aixgo Code](https://github.com/aixgo-dev/code) | GitHub App identity, `@app` commands, lifecycle labels, same issue-to-PR continuity, narrow permissions, human merge gate, repository quality gate | Its simpler issue-to-PR verification model; aiplay needs runtime and browser proof |
| [Deep Agent Action](https://github.com/dipjyotimetia/deep-agent-action) | Sticky progress comment, continuation, review/fix modes, fork protection, protected paths, cost/token caps, provider abstraction | Its in-runner agent can remain optional; aiplay's OpenCode session and AgentsWeb experience are core |
| [OpenCode GitHub integration](https://thdxr.dev.opencode.ai/docs/github/) | Comment-command workflow integration, issue triage, branch/PR execution, same PR follow-up | A basic workflow-only trigger is insufficient for a multi-repository App |
| [Probot](https://github.com/probot/probot) | Webhook handling, signature validation, GitHub App authentication, Octokit integration, webhook test fixtures | Do not put long-running agent execution inside the webhook request |

## Product features to implement

### GitHub identity and commands

Use one installable App and one bot identity, such as `@aiplay`, with modes:

```text
@aiplay web build a landing page
@aiplay android implement this feature
@aiplay game create a Three.js game
@aiplay review
@aiplay address the review feedback
@aiplay continue
@aiplay help
```

Do not retain comment-command compatibility aliases. The App should
parse the mode internally rather than creating separate Apps for `@omgweb`,
`@omgandroid`, and similar names.

### Run lifecycle

Use one sticky comment and visible labels:

```text
aiplay:queued → aiplay:working → aiplay:verifying
                                ├→ aiplay:blocked
                                └→ aiplay:done
```

The comment should show the current stage, live OpenCode session, preview URL,
PR URL, elapsed time, token/cost totals, retry count, and final evidence.

Follow-up commands on the same issue or PR should reuse the existing session,
branch, and PR whenever possible.

### Verification and quality gates

Support repository-local configuration such as:

```yaml
verification:
  command: npm test
  runtime_command: npm run dev
  public_preview: true
  browser_checks: true
  max_retries: 3

limits:
  max_cost_usd: 5
  max_total_tokens: 100000
  max_runtime_minutes: 45
```

Run the repository quality gate first, then aiplay-specific runtime, public
preview, browser, and screenshot checks. Feed structured failure evidence back
to the same OpenCode session for remediation. Open the PR only after the
configured acceptance checks pass; otherwise preserve partial work as a draft
PR or mark the run blocked.

### Security defaults

- Accept implementation commands only from users with repository write access.
- Require the App mention at the beginning of a comment.
- Ignore bot-authored events and deduplicate webhook deliveries.
- Deny fork-PR execution by default.
- Protect workflow files, deployment files, and secret configuration paths.
- Use least-privilege App permissions: Contents, Issues, and Pull requests;
  avoid Secrets, Environments, Administration, and workflow administration
  unless a later feature proves they are necessary.
- Require human approval for risky changes and never auto-merge.
- Enforce token, cost, runtime, retry, and concurrency limits.

## Recommended architecture

```text
GitHub webhook
      ↓
GitHub App: authenticate, authorize, parse, deduplicate
      ↓
Durable queue / workflow dispatch
      ↓
GitHub Actions runner
      ↓
OpenCode + AgentsWeb
      ↓
quality gate → runtime → public preview → browser/screenshots
      ↓
sticky progress comment + branch/PR + release evidence
```

The App should acknowledge and enqueue quickly. GitHub Actions remains the
execution plane for checkout, OpenCode, AgentsWeb, verification, PR creation,
and cleanup.

## Priority order

1. App identity, mention parser, authorization, and webhook deduplication.
2. Workflow dispatch with normalized issue/PR inputs.
3. Sticky progress comment and lifecycle labels.
4. Same-session, same-branch, and same-PR continuation.
5. Quality-gate plus public-preview/browser verification loop.
6. Review and review-and-fix modes.
7. Repository configuration and cost/runtime limits.
8. Bootstrap CLI, multi-repository installation UI, and Marketplace readiness.
