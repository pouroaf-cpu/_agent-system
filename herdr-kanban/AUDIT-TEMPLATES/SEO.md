# {{ID}} — {{TITLE}}

**Created:** {{CREATED}}
**Workflow:** card-owned
**Audit:** seo
**Audit disposition:** planner
**Workspace:** {{WORKSPACE}}
**Auto-review:** no
**Priority** 5/10

## Approved audit scope
{{BRIEF}}

## Required tools/MCPs
{{TOOLS}}
- chrome-devtools (headless isolated browser and Lighthouse SEO report)

## Project constraints
{{PROJECT_CONSTRAINTS}}

## Required skills
<!-- Exact relevant skill paths only; no unrelated preload. Verify correct project and callable tools. -->

## Evidence gates
- Preflight: prove callable named tools, target URL/rendered controls and approved isolated auth plus identity for private routes. Save the exact Lighthouse report path; use separate raw tracing only if performance is in scope. On prerequisite failure set `**Audit preflight:** BLOCKED` and return to Planner; no unchanged redispatch.
- Record crawl/indexability results for every target URL, including status, canonical, robots, and sitemap membership.
- Record title, description, heading, structured-data, and internal-link findings with exact URLs.
- Record the tool output or export reference used for every claim; sampled checks must state the sample.
- Do not mark `CLEAR` if a target failed to load, a required tool was unavailable, or any gate lacks evidence.

## Evidence
<!-- Auditor: replace with tool, target, command/query, result, and evidence reference for every gate. -->

## Findings
<!-- Auditor: replace with numbered findings: severity, URL, observed, expected, and evidence. Write "None" only when every gate passed. -->

## Audit conclusion
<!-- Auditor: replace with Status: CLEAR, FINDINGS, or INCOMPLETE; finding count; checked targets; and missing evidence. -->
