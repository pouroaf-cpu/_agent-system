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
    assert.throws(() => validatePlan(newFile.replace('Changes:', '**Callers checked:** src/main.mjs imports handleKeyDown\nChanges:'), { workspace: root }), /Base check/)
    validatePlan(newFile.replace('Changes:', '**Callers checked:** src/main.mjs imports handleKeyDown\n**Base check:** node check.mjs on base: 1 failing as expected\nChanges:'), { workspace: root })
    validatePlan(realistic) // no workspace = not a handoff; cards already queued are never re-checked

    // hkb applies the check when a Planner hands off from Planning.
    const tasks = join(root, 'TASKS'); mkdirSync(join(tasks, 'planning'), { recursive: true })
    const card = join(tasks, 'planning', 'T-1.md')
    writeFileSync(card, `# T-1 — plan check\n**Workflow:** card-owned\n${newFile.replace('src/app.mjs', 'src/missing.mjs')}`)
    const hkb = () => spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', tasks, 'move', 'T-1', 'planned'], { encoding: 'utf8' })
    let result = hkb()
    assert.notEqual(result.status, 0); assert.match(result.stderr, /src\/missing\.mjs does not exist/)
    writeFileSync(card, `# T-1 — plan check\n**Workflow:** card-owned\n${newFile.replace('Changes:', '**Callers checked:** none\n**Base check:** node check.mjs on base: 1 failing as expected\nChanges:')}\n## Current feedback\nNeeds you: an old question from Owner\nHistory entry: x\n`)
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
    const plan = realistic.replace('Changes:', '**Callers checked:** none\n**Base check:** node check.mjs on base: 1 failing as expected\nChanges:')
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
    validatePlan(prereq(`\`src/app.mjs\` exists; \`scripts/check.mjs\` (new); read-only \`${join(root, 'REPORT.md')}\`; \`node_modules/.bin/x.cmd\`; run \`npm test\`; see \`lib/guides.ts:getGuide\`.`), { workspace: root })

    // Root-level ignored files (.env*) exist in the integration checkout the Planner
    // reads but never in a card worktree (Injectbuddy I227/I265). Prerequisites and
    // Implementation plan setup commands are both checked, word by word.
    writeFileSync(join(root, '.gitignore'), '*.md\n.env*\n'); writeFileSync(join(root, 'package.json'), '{}')
    git('add', '.'); git('commit', '-qm', 'env ignore')
    writeFileSync(join(root, '.env.devtools.local'), 'X=1\n')
    assert.throws(() => validatePlan(prereq('`.env.devtools.local` exists; copy it to `.env.local` before starting Next.'), { workspace: root }),
      /## Prerequisites path \.env\.devtools\.local exists .* not tracked .*envFile/)
    assert.throws(() => validatePlan(prereq('Run `Copy-Item -LiteralPath ".\\.env.devtools.local" -Destination .env.local`.'), { workspace: root }),
      /\.env\.devtools\.local exists .* not tracked/)
    assert.throws(() => validatePlan(plan.replace('Setup: none; use the existing Node runtime.', 'Setup: `Test-Path .env.devtools.local` then `node --env-file=.env.devtools.local scripts/check.mjs`'), { workspace: root }),
      /## Implementation plan path \.env\.devtools\.local exists .* not tracked .*envFile/)
    // A tracked root file, a file not yet created and ordinary words stay fine.
    validatePlan(prereq('`package.json` lists the scripts; `.env.local` is written by the card (absent); `Next.js` dev server.'), { workspace: root })
    validatePlan(plan.replace('Setup: none; use the existing Node runtime.', 'Setup: `npm run check -- package.json` and `node scripts/new-check.mjs`'), { workspace: root })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// A Planner handoff that edits more than 15 files is refused with the split instruction;
// read-only references don't count, and cards already queued (no workspace) aren't re-checked.
{
  const many = n => Array.from({ length: n }, (_, i) => `- \`src/f${i}.mjs\` — change handler ${i}`).join('\n')
  const wide = realistic.replace(/## Files\n[\s\S]*?## Implementation plan/, `## Files\n${many(16)}\n## Implementation plan`)
  assert.throws(() => validatePlan(wide, { workspace: process.cwd() }), /Plan too wide: 16 files[\s\S]*hkb split/)
  validatePlan(wide)
  const refs = realistic.replace(/## Files\n[\s\S]*?## Implementation plan/, `## Files\n${many(15)}\n- \`src/ctx.mjs\` — unchanged, read for context\n## Implementation plan`)
  assert.doesNotThrow(() => { try { validatePlan(refs, { workspace: process.cwd() }) } catch (e) { if (/too wide/.test(e.message)) throw e } })
}

// Card checkouts share the integration node_modules through a junction: a plan's npm ci
// reinstalled the shared copy under running Builders (throughput audit 2026-09-26 F3).
{
  const setup = cmd => realistic.replace('Setup: none; use the existing Node runtime.', `Setup: from the card workspace run \`${cmd}\` then node scripts/check-x.mjs`)
  const installError = (plan) => { try { validatePlan(plan, { workspace: process.cwd() }) } catch (e) { return /install/i.test(e.message) ? e.message : null } return null }
  assert.match(installError(setup('npm ci')), /npm ci[\s\S]*package\.json/)
  for (const cmd of ['npm install', 'npm i -D x', 'pnpm install', 'yarn install']) assert.ok(installError(setup(cmd)), cmd)
  assert.ok(installError(realistic.replace('Existing Node runtime; no additional access.', 'Run npm ci in the card checkout.')), 'Prerequisites too')
  assert.equal(installError(setup('npm ci').replace('- `src/app.mjs` —', '- `package.json` — add the dependency\n- `src/app.mjs` —')), null, 'a manifest change may install')
  assert.equal(installError(realistic.replace('Existing Node runtime; no additional access.', 'Do not run npm ci; node_modules is shared.')), null, 'a warning is not a step')
  validatePlan(setup('npm ci')) // cards already queued are never re-checked
}

// A project's shared check scripts serialised its queue when every card added its own check
// to them (Injectbuddy scripts/capture-authed.mjs, 15 cards; throughput audit F1).
{
  const shared = { workspace: process.cwd(), sharedFiles: ['scripts/capture-authed.mjs'] }
  const plan = (title, brief = 'Deliver the agreed keyboard behavior.') => `# I300 — ${title}\n${realistic.replace('Deliver the agreed keyboard behavior.', brief).replace('- `test/keyboard.test.mjs` —', '- `scripts/capture-authed.mjs` — add the keyboard capture\n- `test/keyboard.test.mjs` —')}`
  const sharedError = (text, opts = shared) => { try { validatePlan(text, opts) } catch (e) { return /shared/.test(e.message) ? e.message : null } return null }
  assert.match(sharedError(plan('Keyboard fix')), /scripts\/capture-authed\.mjs is shared[\s\S]*scripts\/check-i300-\*\.mjs/)
  assert.equal(sharedError(plan('Split helpers out of scripts/capture-authed.mjs')), null, 'the card is about the shared file')
  assert.equal(sharedError(plan('Keyboard fix', 'Speed up capture-authed.mjs logins.')), null, 'the brief names it')
  assert.equal(sharedError(plan('Keyboard fix').replace('- `scripts/capture-authed.mjs` — add', '- `scripts/capture-authed.mjs` — read-only, add')), null, 'a reference takes no lock')
  assert.equal(sharedError(plan('Keyboard fix'), { workspace: process.cwd() }), null, 'no sharedFiles setting')

  // hkb reads projectSettings.<project>.sharedFiles from the board config at a Planner handoff.
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const root = mkdtempSync(join(tmpdir(), 'plan-shared-')), project = join(root, 'Proj'), tasks = join(project, 'TASKS')
  try {
    for (const d of [join(tasks, 'planning'), join(project, 'src'), join(project, 'scripts')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(project, 'src', 'app.mjs'), ''); writeFileSync(join(project, 'scripts', 'capture-authed.mjs'), '')
    writeFileSync(join(root, 'board.config.json'), JSON.stringify({ projectsRoot: root, projects: ['Proj'], projectSettings: { Proj: { sharedFiles: ['scripts/capture-authed.mjs'] } } }))
    writeFileSync(join(tasks, 'planning', 'I300.md'), plan('Keyboard fix').replace('# I300 — Keyboard fix', '# I300 — Keyboard fix\n**Workflow:** card-owned')
      .replace('- `test/keyboard.test.mjs` —', '- `test/keyboard.test.mjs` (new) —').replace('Changes:', '**Callers checked:** none\n**Base check:** node check.mjs on base: 1 failing as expected\nChanges:'))
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', tasks, 'move', 'I300', 'planned'], { encoding: 'utf8', env: { ...process.env, KANBAN_CONFIG: join(root, 'board.config.json') } })
    assert.notEqual(result.status, 0); assert.match(result.stderr, /capture-authed\.mjs is shared/)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

// A script-generated change is one change: Injectbuddy I302's script rewrites 141 generated
// guide pages. A glob bullet marked "generated by <script>" counts as one file, only when the
// script is listed too; any other glob is refused as before.
{
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  const files = (lines) => realistic.replace(/## Files\n[\s\S]*?## Implementation plan/, `## Files\n${lines}\n## Implementation plan`).replace('Changes:', '**Callers checked:** none\n**Base check:** node check.mjs on base: 1 failing as expected\nChanges:')
  const script = '- `scripts/add-guide-article-image.mjs` (new) — idempotent script that adds Article.image'
  const glob = '- `public/legacy/guides/*/index.html` — generated by `scripts/add-guide-article-image.mjs`'
  const root = mkdtempSync(join(tmpdir(), 'plan-glob-'))
  const run = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  try {
    for (const g of ['a', 'b']) { mkdirSync(join(root, 'public', 'legacy', 'guides', g), { recursive: true }); writeFileSync(join(root, 'public', 'legacy', 'guides', g, 'index.html'), '') }
    run('init'); run('add', '-A'); run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'base')
    validatePlan(files(`${script}\n${glob}`))
    validatePlan(files(`${script}\n${glob}`), { workspace: root })
    // Counts as two files: 13 more fit, 14 more are too wide (16).
    const many = n => Array.from({ length: n }, (_, i) => `- \`src/f${i}.mjs\` (new) — change handler ${i}`).join('\n')
    validatePlan(files(`${script}\n${glob}\n${many(13)}`), { workspace: root })
    assert.throws(() => validatePlan(files(`${script}\n${glob}\n${many(14)}`), { workspace: root }), /Plan too wide: 16 files[\s\S]*generated by <script>/)
    // Unmarked glob, or marked by a script not in Files: refused.
    assert.throws(() => validatePlan(files(`${script}\n- \`public/legacy/guides/*/index.html\` — add Article.image`)), /glob public\/legacy\/guides\/\*\/index\.html needs the exact words generated by/)
    // I528 wording: "by the same generator" names no script, so it gets the same pointed message.
    assert.throws(() => validatePlan(files(`${script}
- \`public/legacy/guides/*/index.html\` — generated references only, by the same generator`)), /needs the exact words generated by/)
    assert.throws(() => validatePlan(files(`${glob}\n- \`src/other.mjs\` — other change`)), /generated by scripts\/add-guide-article-image\.mjs[\s\S]*not listed in ## Files/)
    // I530: a read-only .py bullet is a file; a bad path is named, not blamed on globs.
    validatePlan(files(`${script}\n${glob}\n- \`scripts/live_syringe.py\` — read-only`))
    assert.throws(() => validatePlan(files(`${script}\n${glob}\n- \`scripts/tools\` — folder`)), /scripts\/tools is not one/)
    // At plan time the glob must match at least one tracked file.
    assert.throws(() => validatePlan(files(`${script}\n${glob.replace('guides', 'guidez')}`), { workspace: root }), /matches no file tracked by git/)
  } finally { rmSync(root, { recursive: true, force: true }) }
}
