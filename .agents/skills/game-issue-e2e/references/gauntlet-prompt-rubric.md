# Gauntlet Loop prompt rubric

Use this rubric to convert a sparse request into a short agent brief. Follow the
method described in [How to Run a Gauntlet Loop](https://somethingbig.ai/gauntlet-loop).
Write imperative English. Preserve the user's subject, outcome, domain, and
constraints. Remove invocation syntax and routing labels.

## Build the prompt

- State the destination, not a detailed implementation plan.
- Name the strongest concrete quality bar that the agent can inspect. For a
  recreation, use the named product and real screenshots, footage, and gameplay
  as the bar. For new work, choose a specific comparable product, fixture, or
  measurable target and explain its value in one sentence.
- Preserve the required surface and dimensionality. Infer intrinsic properties
  of a named reference when omission would permit a materially flatter
  substitute. For example, require a browser recreation of a 3D game to remain
  a real 3D browser game.
- Require the lead agent to choose the approach and divide the work into the
  smallest pieces that can be built and judged independently.
- Assign every important piece to a builder and a separate fresh-context
  critic. Give the critic the brief, bar, rules, and real artifact, but do not
  give it the builder's history or justification.
- Require each critic to inspect the real output and compare it directly with
  the bar. Use blind A/B comparison when practical. When the result loses,
  identify the largest meaningful gap and return it for another build round.
- Continue until the output meets the bar or the user stops the run. Do not add
  arbitrary time, token, auto-continue, agent-count, or round limits to the
  prompt.
- Maintain a simple live progress page that shows the artifact changing over
  time through useful evidence such as screenshots, videos, test results, or
  drafts.
- Name the useful skills selected from the target repository's available
  `skill/*` labels. Instruct the worker to load and use them where relevant.
  Keep this to one sentence and do not name unavailable or unrelated skills.
- Keep only essential product constraints and observable completion evidence.
  Do not prescribe architecture, exact decomposition, tools, or a long feature
  checklist unless the user supplied them. Naming selected available skills is
  not implementation prescription.

## Prompt shape

Write the title heading, then one short paragraph or a few compact paragraphs.
Do not force boilerplate sections. Use this pattern:

```markdown
# [Exact issue title]

Build [specific outcome and required surface or dimensionality] at [named,
inspectable quality bar]. Use real [references or measurements] as the bar and
compare the running result directly against them.

Act as the lead. Choose the approach and split the work into the smallest
independently judgeable pieces. For each important piece, use a builder and a
separate fresh-context critic that inspects the real artifact. When our output
loses, fix the largest meaningful gap and repeat until it meets the bar or the
user stops the run.

Maintain a simple live progress page with concrete evidence of each round.

Load and use these available skills where relevant: [selected skill names].
```

Replace every bracketed phrase. Keep the final prompt close to this size. Add
only constraints needed to preserve the user's intent or make the quality bar
observable.

This rubric guides issue text only. The issue-e2e skill starts the workflow and
stops after returning the initial session link.
