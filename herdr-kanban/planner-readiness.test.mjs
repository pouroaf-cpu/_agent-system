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

// Plan check at Planner handoff: Files must exist (unless marked new) and callers must be listed.
{
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const root = mkdtempSync(join(tmpdir(), 'plan-check-'))
  try {
    assert.throws(() => validatePlan(realistic, { workspace: root }), /Plan check failed: ## Files path src\/app\.mjs does not exist/)
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'app.mjs'), '')
    assert.throws(() => validatePlan(realistic, { workspace: root }), /test\/keyboard\.test\.mjs does not exist/)
    const newFile = realistic.replace('- `test/keyboard.test.mjs` —', '- `test/keyboard.test.mjs` (new) —')
    assert.throws(() => validatePlan(newFile, { workspace: root }), /Callers checked/)
    assert.throws(() => validatePlan(newFile.replace('Changes:', '**Callers checked:**\nChanges:'), { workspace: root }), /Callers checked/, 'an empty line is not a check')
    validatePlan(newFile.replace('Changes:', '**Callers checked:** src/main.mjs imports handleKeyDown\nChanges:'), { workspace: root })
    validatePlan(realistic) // no workspace = not a handoff; cards already queued are never re-checked

    // hkb applies the check when a Planner hands off from Planning.
    const tasks = join(root, 'TASKS'); mkdirSync(join(tasks, 'planning'), { recursive: true })
    const card = join(tasks, 'planning', 'T-1.md')
    writeFileSync(card, `# T-1 — plan check\n**Workflow:** card-owned\n${newFile.replace('src/app.mjs', 'src/missing.mjs')}`)
    const hkb = () => spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', tasks, 'move', 'T-1', 'planned'], { encoding: 'utf8' })
    let result = hkb()
    assert.notEqual(result.status, 0); assert.match(result.stderr, /src\/missing\.mjs does not exist/)
    writeFileSync(card, `# T-1 — plan check\n**Workflow:** card-owned\n${newFile.replace('Changes:', '**Callers checked:** none\nChanges:')}\n## Current feedback\nNeeds you: an old question from Owner\nHistory entry: x\n`)
    result = hkb()
    assert.equal(result.status, 0, result.stderr)
    // The build-ready plan answers the old Owner question (Injectbuddy I165, I178).
    const { findCard } = await import('./lib/cards.mjs')
    const planned = readFileSync(findCard(tasks, 'T-1').path, 'utf8')
    assert.doesNotMatch(planned, /^Needs you:/m); assert.match(planned, /^Resolved:/m)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// In a Git workspace the card worktree is a checkout of HEAD: Files and explicit
// prerequisite paths must be tracked there (Kiwitown T-1, Injectbuddy T-148).
{
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { execFileSync } = await import('node:child_process')
  const root = mkdtempSync(join(tmpdir(), 'plan-git-'))
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
  try {
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
    mkdirSync(join(root, 'src')); mkdirSync(join(root, 'TASKS'))
    writeFileSync(join(root, 'src', 'app.mjs'), ''); writeFileSync(join(root, '.gitignore'), '*.md\n')
    git('add', '.'); git('commit', '-qm', 'base')
    writeFileSync(join(root, 'REPORT.md'), 'ignored'); writeFileSync(join(root, 'TASKS', 'check.mjs'), 'untracked')
    const plan = realistic.replace('Changes:', '**Callers checked:** none\nChanges:')
      .replace('- `test/keyboard.test.mjs` —', '- `test/keyboard.test.mjs` (new) —')
    validatePlan(plan, { workspace: root })
    assert.throws(() => validatePlan(plan.replace('- `src/app.mjs` —', '- `REPORT.md` —'), { workspace: root }),
      /## Files path REPORT\.md exists .* not tracked by git .*absolute path as a read-only reference/)
    const prereq = (line) => plan.replace('Existing Node runtime; no additional access.', line)
    assert.throws(() => validatePlan(prereq('Run `node TASKS/check.mjs` then `TASKS/check.mjs` validates.'), { workspace: root }),
      /## Prerequisites path TASKS\/check\.mjs exists .* not tracked/)
    assert.throws(() => validatePlan(prereq('Rules: `C:/definitely/missing/CLAUDE.md`.'), { workspace: root }),
      /Prerequisites path C:\/definitely\/missing\/CLAUDE\.md does not exist/)
    // Tracked, new, absolute existing, node_modules, commands and prose are all fine.
    validatePlan(prereq(`\`src/app.mjs\` exists; \`scripts/check.mjs\` (new); read-only \`${join(root, 'REPORT.md')}\`; \`node_modules/.bin/x.cmd\`; run \`npm ci\`; see \`lib/guides.ts:getGuide\`.`), { workspace: root })
  } finally { rmSync(root, { recursive: true, force: true }) }
}
