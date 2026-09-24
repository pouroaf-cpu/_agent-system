# {{ID}} — {{TITLE}}

**Created:** {{CREATED}}
**Workflow:** card-owned
**Audit:** general
**Audit disposition:** report-only-await-owner
**Workspace:** {{WORKSPACE}}
**Auto-review:** no
**Priority** 5/10

## Approved audit scope
{{BRIEF}}

<!-- The scope above names the topic (free text), targets (URLs or routes), devices and exclusions. Audit only that. -->

## Required tools/MCPs
{{TOOLS}}

## Project constraints
{{PROJECT_CONSTRAINTS}}

## Required skills
<!-- Exact relevant skill paths only; no unrelated preload. Verify correct project and callable tools. -->

## Evidence gates
- Preflight: prove every named tool is callable and every target loads (URL, final status, rendered page), plus approved isolated auth and identity for private routes. On prerequisite failure set `**Audit preflight:** BLOCKED`, record the exact failure and return for recovery; no unchanged redispatch.
- Save the report as `TASKS/reports/{{ID}}-general/report.md` (template `C:/Users/PFrew/Projects/_roles/AUDIT-REPORT-TEMPLATE.md`) and all evidence under `TASKS/reports/{{ID}}-general/evidence/`.
- Every claim needs its own screenshot or measurement (selector, value, tool output) saved under evidence and linked from the finding. Opinion without evidence is not a finding.
- Cover every target on every agreed device. A target, state or device without evidence makes the audit `INCOMPLETE`.
- Do not mark `CLEAR` from automated output alone or when any gate lacks evidence.
- `FINDINGS` requires the card-ready format below: numbered `## Findings` and a matching, valid ```json block under `## Card-ready findings`. Without it the handoff is routed as `INCOMPLETE`.

## Evidence
<!-- Auditor: replace with preflight result, then target/state, device, screenshot and measurement paths, and result for every gate. -->

## Findings
<!-- Auditor: replace with numbered findings, one per line starting "1.", "2."..., each followed by these bullets:
1. <Title: one line, max 120 characters, written as the problem>
   - Severity: high | medium | low
   - Priority: 0-10
   - Category: ui | code | data | auth-security
   - Workspace: . (project-relative)
   - Files: exact repo-relative paths, or unknown — planner to locate
   - Evidence: TASKS/reports/{{ID}}-general/evidence/<file>
   - Problem: what is wrong and who it affects
   - Recommended change: what to change
   - Acceptance criteria: AC1: <observable result>; AC2: ...
   - Depends on: other finding numbers, or none
Write "None" only when every gate passed. -->

## Card-ready findings
<!-- Auditor (FINDINGS only): the same findings as a ```json array, one object per finding:
[{"n": 1, "title": "...", "severity": "high", "priority": 8, "category": "ui", "workspace": ".",
  "files": ["src/app/page.tsx"], "evidence": ["TASKS/reports/{{ID}}-general/evidence/home-390.png"],
  "problem": "...", "recommendation": "...", "acceptance": ["AC1: ..."], "dependsOn": []}] -->

## Audit conclusion
<!-- Auditor: replace with Status: CLEAR, FINDINGS, or INCOMPLETE; finding count; checked targets/devices; and missing evidence. -->
