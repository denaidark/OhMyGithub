# GitHub Actions Visual Workflow Editor

## Product idea

Build a browser-based visual editor for GitHub Actions YAML, tentatively called
**FlowForge**. Users design and understand workflows as connected nodes while
keeping the GitHub Actions YAML as the source of truth.

The product should be a workflow IDE rather than only a diagram generator:
visualize existing workflows, safely edit them, validate execution paths,
compare runs, generate workflows from natural-language goals, and collaborate
through pull requests and visual diffs.

## Core experience

- Import an existing `.github/workflows/*.yml` file.
- Render triggers, jobs, steps, dependencies, permissions, secrets, matrices,
  artifacts, and conditions as a flow diagram.
- Edit through node properties, inline YAML, or both side by side.
- Keep edits synchronized with the underlying YAML.
- Validate continuously with schema checks, expression checks, and `actionlint`.
- Explain execution order, skipped jobs, permissions, environment variables,
  and dependency paths.
- Preview a readable YAML diff before saving, committing, or opening a PR.

Example flow:

```text
Trigger
  ↓
Checkout
  ↓
Install dependencies
  ↓
Build ──────→ Upload artifact
  ↓
Test
  ↓
Deploy
```

## MVP

- Import and export GitHub Actions YAML.
- Visual job graph with collapsible steps.
- Add, delete, reorder, and connect jobs.
- Common action library for checkout, language setup, caching,
  artifact upload/download, Docker builds, and deployment.
- Editable `runs-on`, `if`, `needs`, `env`, `permissions`, action inputs, and
  secrets.
- Workflow dispatch and reusable workflow support.
- YAML diff preview and validation panel with actionable errors.
- Safe-mode warnings before changing triggers, permissions, secrets, or deploy
  steps.

## Differentiating features

- **Explain this workflow:** generate a plain-English description of each job
  and the overall pipeline.
- **Why was this skipped?:** trace `if` expressions, event filters, matrix
  behavior, and `needs` dependencies.
- **Runtime overlay:** import a GitHub Actions run and color graph nodes as
  passed, failed, skipped, cancelled, or in progress.
- **Visual pull-request diff:** show structural workflow changes, not only text
  changes.
- **Natural-language generation:** describe a goal, produce a visual draft,
  and require review before generating YAML.
- **Security linting:** flag excessive permissions, unpinned actions, exposed
  secrets, unsafe shell interpolation, and suspicious third-party actions.
- **Reusable workflow navigation:** make called workflows and composite actions
  clickable and inspectable.
- **Version history:** compare workflow graphs across commits and runs.

## Project-specific opportunity

The current OpenCode workflow is a good stress test because it includes:

- Multiple event triggers and conditional execution.
- Dynamic environment variables and issue-derived inputs.
- External repository checkouts.
- Temporary SSH/session infrastructure.
- Model and skill synchronization.
- Prompt files stored separately from YAML.
- Runtime verification, retries, and final reporting.

The editor could organize complex workflows into lanes such as **intent**,
**agent execution**, **infrastructure**, and **verification**, while preserving
the exact underlying YAML.

## Acceptance criteria

- Importing a valid workflow produces a structurally equivalent graph.
- Exporting without edits produces semantically equivalent YAML.
- Unknown or unsupported advanced syntax is preserved rather than discarded.
- Invalid dependencies, expressions, permissions, and action inputs are clearly
  reported.
- A visual edit produces a readable YAML diff.
- A real GitHub Actions run can be mapped back onto the graph.
- Users can understand why a job ran, failed, or was skipped.

## Comparable projects and research

- [timoa/workflow-editor](https://github.com/timoa/workflow-editor) — VS Code
  visual editor for GitHub Actions YAML. Supports jobs, steps, triggers,
  matrices, reusable workflows, validation, and YAML export. Closest direct
  competitor.
- [riccardoperra/pipelineui](https://github.com/riccardoperra/pipelineui) —
  browser-based visual editor using SolidStart/Appwrite, with YAML editing,
  linting, GitHub workflow search, and repository integration. Closest web-app
  precedent.
- [Actionforge](https://docs.actionforge.dev/) — node-based workflow editor
  with a portable `.act` graph format and GitHub Actions runtime adapter.
  Strong graph-interaction inspiration, but not YAML-first.
- [GATE / Actions Editor](https://github.com/marketplace/actions-editor) —
  visual GitHub Actions template editor with action discovery, parameter
  checking, composite action support, and commit/PR integration. Useful GitHub
  App and commercial-product reference.
- [29cmb/Github-Workflow-Builder](https://github.com/29cmb/Github-Workflow-Builder)
  — community visual builder for creating GitHub workflows.
- [GitHub visualization graph](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph)
  — GitHub's native runtime graph for jobs and dependencies; establishes the
  baseline for run visualization.
- [workflowbuilder](https://github.com/synergycodes/workflowbuilder) — Apache
  2.0 React Flow SDK for embeddable visual workflow editors; useful technical
  foundation, though not GitHub Actions-specific.
- [bunlongheng/automations](https://github.com/bunlongheng/automations) — React
  Flow-based drag-and-drop automation builder with typed integrations, trigger
  and action nodes, and Playwright/Vitest coverage. Useful reference for node
  palettes and interaction patterns.
- [fluxturn/fluxturn](https://github.com/fluxturn/fluxturn) — open-source
  workflow automation platform combining natural-language workflow generation
  with a visual node editor. Useful inspiration for AI-assisted workflow
  drafting, although it targets general automation rather than GitHub Actions.

## Positioning

Avoid competing only on drag-and-drop workflow creation. The strongest
positioning is:

> Understand, safely edit, and debug real GitHub Actions workflows visually.

The initial product should combine the feature coverage of
`timoa/workflow-editor`, the browser integration of `pipelineui`, and the graph
interaction ideas of Actionforge, then differentiate through runtime overlays,
explanations, security checks, and visual pull-request review.

The competitive gap is not basic graph rendering: GitHub already provides a
runtime visualization graph, and several projects provide visual authoring.
The stronger opportunity is a YAML-preserving workflow IDE with safe semantic
diffs, security diagnostics, skipped-job explanations, and run-to-source
traceability.

## Suggested implementation path

1. Start with a VS Code extension or local web app.
2. Parse `.github/workflows/*.yml` with the official GitHub Actions workflow
   parser and retain source locations for round-trip editing.
3. Render triggers, jobs, `needs`, steps, and common action inputs using React
   Flow or an equivalent graph library.
4. Add a synchronized YAML editor and semantic diff.
5. Add `actionlint` and security diagnostics.
6. Add GitHub API integration for run status and runtime graph overlays.
7. Add natural-language workflow drafting only after safe import/export and
   validation are reliable.

## Open questions

- Should the first distribution be a VS Code extension, browser app, or both?
- How should unsupported YAML constructs be displayed and edited without data
  loss?
- Should the graph model be derived entirely from YAML, or should it maintain a
  separate metadata file for layout positions?
- How much GitHub API access should be required for local use?
- Should visual edits directly modify a branch, create a commit, or open a PR?
