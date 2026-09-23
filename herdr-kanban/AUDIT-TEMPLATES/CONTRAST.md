# {{ID}} — {{TITLE}}

**Created:** {{CREATED}}
**Workflow:** card-owned
**Audit:** contrast
**Audit disposition:** planner
**Workspace:** {{WORKSPACE}}
**Auto-review:** no
**Priority** 5/10

## Approved audit scope
{{BRIEF}}

## Required tools/MCPs
{{TOOLS}}
- chrome-devtools (headless isolated browser and Lighthouse accessibility report)

## Project constraints
{{PROJECT_CONSTRAINTS}}

## Required skills
<!-- Exact relevant skill paths; browser skill is routed on demand. No dedicated contrast skill is assumed. -->

## Evidence gates
- Preflight: prove callable named tools, target URL/rendered controls and approved isolated auth plus identity for private routes. Save the exact Lighthouse report path; it is not a performance trace. On prerequisite failure set `**Audit preflight:** BLOCKED` and return to Planner; no unchanged redispatch.
- Test 390px, 768px, and 1440px viewports with the named accessibility/contrast tool.
- Check normal, hover, focus, active, disabled, error, placeholder, and selected states present in scope.
- Record measured foreground/background colors, ratio, required WCAG level, selector, state, and viewport for every failure.
- Capture a screenshot for each failure. Do not mark `CLEAR` when a state was unreachable or evidence is missing.

## Evidence
<!-- Auditor: replace with tool runs, targets, states, measurements, and evidence references. -->

## Findings
<!-- Auditor: replace with numbered findings: severity, target, viewport/state, observed ratio, required ratio, and screenshot. Write "None" only when every gate passed. -->

## Audit conclusion
<!-- Auditor: replace with Status: CLEAR, FINDINGS, or INCOMPLETE; finding count; checked targets/states; and missing evidence. -->
