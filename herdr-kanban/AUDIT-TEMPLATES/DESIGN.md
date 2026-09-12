# {{ID}} — {{TITLE}}

**Created:** {{CREATED}}
**Workflow:** card-owned
**Audit:** design
**Workspace:** {{WORKSPACE}}
**Auto-review:** no
**Priority** 5/10

## Approved audit scope
{{BRIEF}}

## Required tools/MCPs
{{TOOLS}}

## Project constraints
{{PROJECT_CONSTRAINTS}}

## Evidence gates
- Capture full-page screenshots at 390px, 768px, and 1440px for every target and required state.
- For authenticated targets, use the card's named pre-authenticated session; missing access is `INCOMPLETE`.
- Check each required control's own selector, visible label, bounding box, and click target; container text alone is not evidence.
- At each viewport measure document `scrollWidth` versus `clientWidth` and report every element crossing the viewport.
- Check text clipping/wrapping, overlapping boxes, obscured controls, fixed/sticky collisions, broken grids, and touch-target visibility with exact selectors.
- Inspect the screenshots at full resolution. Do not mark `CLEAR` from automated output alone or when any target/state lacks evidence.

## Evidence
<!-- Auditor: replace with target/state, viewport, screenshot, DOM measurements, selectors checked, and result. -->

## Findings
<!-- Auditor: replace with numbered findings: severity, target, viewport, selector, observed, expected, and evidence. Write "None" only when every gate passed. -->

## Audit conclusion
<!-- Auditor: replace with Status: CLEAR, FINDINGS, or INCOMPLETE; finding count; checked targets/states; and missing evidence. -->
