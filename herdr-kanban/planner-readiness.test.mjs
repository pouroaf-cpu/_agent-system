import assert from 'node:assert/strict'
import { validatePlan } from './lib/cards.mjs'

const realistic = `**Workflow version:** 2
**Plan readiness:** build-ready
**Workspace:** .
## Approved brief
Deliver the agreed keyboard behavior.
## Files
- \`src/app.mjs\` — handleKeyDown(event) and renderStatus()
- \`test/keyboard.test.mjs\` — focused positive and negative keyboard assertions
## Implementation plan
Outcome: preserve the approved keyboard behavior.
Unchanged constraints: no API, data, or deployment changes.
Observed cause: handleKeyDown drops the Enter event when focus is in the control.
Evidence: current focused test reproduces the dropped event.
Inspected current revision/state: git revision abc123; working tree clean for listed files.
Changes: update handleKeyDown(event) and add the focused assertion.
Setup: none; use the existing Node runtime.
Check: node --test test/keyboard.test.mjs
Expected result: the positive and negative checks pass.
Scope: only src/app.mjs and its focused test.
Stop rules: stop if the target handler or revision differs from this evidence.
## Acceptance criteria
- AC1: Enter activates the control.
## Outcome checks
AC1 | src/app.mjs handleKeyDown(event) | node --test planner-readiness.test.mjs passes | remove the handler branch and the check fails
## Prerequisites
Existing Node runtime; no additional access.
`

validatePlan(realistic)
assert.throws(() => validatePlan(realistic.replace('**Plan readiness:** build-ready', ''), { requireReadiness: true }),
  /authenticated Planner handoff requires/i)
const investigation = realistic
  .replace('**Plan readiness:** build-ready', '**Plan readiness:** investigation\n**Investigation approved:** yes')
  .replace('Observed cause: handleKeyDown drops the Enter event when focus is in the control.', 'Observed cause: unknown; measure the keyboard event first.')
validatePlan(investigation, { requireReadiness: true })
validatePlan(investigation.replace('AC1 | src/app.mjs handleKeyDown(event) | node --test planner-readiness.test.mjs passes | remove the handler branch and the check fails', '| AC1 | src/app.mjs handleKeyDown(event) | node --test planner-readiness.test.mjs passes | remove the handler branch and the check fails |'))
validatePlan(investigation.replace('- `test/keyboard.test.mjs`', '- `test/evidence/`'))
assert.throws(() => validatePlan(realistic.replace('- `test/keyboard.test.mjs`', '- `test/evidence/`')),
  /exact relative file paths/i)
assert.throws(() => validatePlan(investigation.replace('**Investigation approved:** yes', '')),
  /explicit approval/i, 'a Planner cannot self-authorize investigation')
assert.throws(() => validatePlan(investigation.replace('**Investigation approved:** yes', '').replace('## Implementation plan', '## Implementation plan\n**Investigation approved:** yes')),
  /explicit approval/i, 'approval in Planner-authored sections is not authorization')
assert.throws(() => validatePlan(investigation.replace('Check: node --test test/keyboard.test.mjs', 'Command omitted.')),
  /measurement\/check/i)
assert.throws(() => validatePlan(investigation.replace('Stop rules: stop if the target handler or revision differs from this evidence.', '')),
  /stop rules/i)
assert.throws(() => validatePlan(realistic.replace('Observed cause: handleKeyDown drops the Enter event when focus is in the control.', 'Observed cause: unknown')),
  /unknown cause/i)
assert.throws(() => validatePlan(realistic.replace('- `src/app.mjs` — handleKeyDown(event) and renderStatus()', '- `src/app.mjs`')),
  /concrete target/i)
assert.throws(() => validatePlan(realistic.replace('**Plan readiness:** build-ready', '**Plan readiness:** maybe')),
  /build-ready or investigation/i)
assert.throws(() => validatePlan(realistic.replace('Outcome: preserve the approved keyboard behavior.', 'Outcome:')),
  /agreed outcome/i)
console.log('Planner readiness validation passed')
