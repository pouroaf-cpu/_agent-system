import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { focusedText, projectConstraints, writeBrief, writeCurrentFeedback, historyPath, appendHistory } from './lib/card-history.mjs'
import { workerPrompt, reviewerPrompt, psLiteral } from './lib/prompt.mjs'
import { createCard } from './lib/cards.mjs'

const source = `# T-1 — Exact task
**Recovery:** {"returns":3}
## Approved brief
Preserve the agreed outcome.
## Project constraints
Never reset account data; mandatory auth method.
## Files
- app.js — updateKnownSelector
## Acceptance criteria
All named states must pass.
## Implementation
Old finished implementation narrative.
## Reviewer evidence
Superseded PASS narrative.
## Evidence
Earlier evidence link.
## History
Long historic narrative.
**Build attempt** old
obsolete attempt body
## Return 1 implementation plan
Superseded return instruction.
**Review feedback** current

Prove the missing authenticated route, no scope widening.
## Return 2 files
- check.mjs — main
## Return 2 implementation plan
Use the approved isolated cookie helper; no data reset.
## Return 2 check
node check.mjs --base http://127.0.0.1:4139
## Evidence
Current result and exact artifact link.
## Unusual safety requirement
Do not overwrite retained snapshots.
`

test('whole-card projection retains late current correction/safety and excludes stale role narrative', () => {
  const builder = focusedText(source, 'builder')
  for (const expected of ['approved isolated cookie helper', 'Current result', 'Never reset', 'Do not overwrite', 'All named states', '"returns":3', 'http://127.0.0.1:4139']) assert.ok(builder.includes(expected), expected)
  for (const stale of ['Old finished', 'Superseded PASS', 'Long historic', 'obsolete attempt', 'Superseded return', 'Earlier evidence']) assert.ok(!builder.includes(stale), stale)
  assert.equal(builder.split('Prove the missing authenticated route').length, 2)
  const reviewer = focusedText(source, 'reviewer')
  assert.match(reviewer, /Old finished implementation narrative/)
  assert.doesNotMatch(reviewer, /Superseded PASS narrative/)
  const partialReturn = focusedText('## Return 1 project constraints\nNever reset data.\n## Return 1 check\nnode known-check.mjs\n## Return 2 files\n- only.mjs\n', 'builder')
  assert.match(partialReturn, /Never reset data/)
  assert.match(partialReturn, /node known-check.mjs/)
  assert.match(partialReturn, /only.mjs/)
})

test('brief generation preserves original card/history and pause state without truncation', () => {
  const root = mkdtempSync(join(tmpdir(), 'current-brief-')), tasks = join(root, 'TASKS')
  mkdirSync(tasks); const cardPath = join(tasks, 'T-1.md'); writeFileSync(cardPath, source)
  const config = join(root, 'board.config.json'); writeFileSync(config, '{"maxConcurrentAgents":0,"paused":true}')
  const path = writeBrief(tasks, { id: 'T-1', path: cardPath }, 'builder')
  assert.equal(readFileSync(cardPath, 'utf8'), source)
  assert.equal(JSON.parse(readFileSync(historyPath(tasks, 'T-1'), 'utf8').trim()).text, source)
  assert.match(readFileSync(path, 'utf8'), /Return 2 check/)
  assert.equal(readFileSync(config, 'utf8'), '{"maxConcurrentAgents":0,"paused":true}')
  assert.throws(() => writeBrief(tasks, { id: 'T-1', path: cardPath }, 'builder', { maxChars: 20 }), /exceeds/)
  assert.doesNotMatch(readFileSync(path, 'utf8'), /Current project constraints/, 'no PROJECT-CONSTRAINTS.md, no section')
  assert.match(readFileSync(path, 'utf8'), /^## Project constraints\r?\nNever reset account data/m, 'without a current copy the card keeps its own')
})

test('an API note appended after a history marker still reaches the Builder and Planner briefs', () => {
  const card = '# T-5 — Note\n## Approved brief\nPad the button.\n## Implementation\nOld.\n\n**Failed return 1** 2026-09-27T10:00:00.000Z\n\nPadding wrong.\n\n**Decision** 2026-09-27T11:00:00.000Z\n\nUse 6px.\n'
  for (const role of ['builder', 'planner']) {
    const brief = focusedText(card, role)
    assert.match(brief, /## Decisions and notes\n\*\*Decision\*\* 2026-09-27T11:00:00\.000Z\nUse 6px\./, role)
    assert.doesNotMatch(brief, /Padding wrong/, `${role}: history markers stay out`)
  }
  const inline = focusedText('# T-6\n## Approved brief\nX.\n\n**Decision** 2026-09-27T11:00:00.000Z\n\nKeep it.\n', 'builder')
  assert.equal(inline.match(/Keep it\./g).length, 1, 'a note already in a kept section is not repeated')
})

test('every role brief carries the current PROJECT-CONSTRAINTS.md, not only the creation-time copy', async () => {
  const { createCard } = await import('./lib/cards.mjs')
  const tasks = join(mkdtempSync(join(tmpdir(), 'constraints-brief-')), 'TASKS')
  mkdirSync(join(tasks, 'planning'), { recursive: true })
  const constraints = join(tasks, 'PROJECT-CONSTRAINTS.md')
  writeFileSync(constraints, '## all\nOld rule.\n## ui\nUI rule.\n')
  const card = createCard(tasks, { title: 'Later rule', brief: 'Fix it.', category: 'code' })
  writeFileSync(constraints, '## all\nOld rule.\nCard checkouts have NO .env files.\n## code\nCode rule.\n## ui\nUI rule.\n')
  for (const role of ['planner', 'reviewer']) {
    const brief = readFileSync(writeBrief(tasks, card, role), 'utf8')
    assert.match(brief, /## Current project constraints\n[\s\S]*Card checkouts have NO \.env files\.[\s\S]*Code rule\./, role)
    assert.doesNotMatch(brief.split('## Current project constraints')[1], /UI rule/, 'other categories stay out')
    assert.doesNotMatch(brief, /^## Project constraints\r?$/m, `${role}: the current copy replaces the card's old one`)
  }
  // HK47: the Builder brief points at the live file instead of carrying its body.
  const builder = readFileSync(writeBrief(tasks, card, 'builder'), 'utf8')
  assert.doesNotMatch(builder, /## Current project constraints/)
  assert.doesNotMatch(builder, /^## Project constraints\r?$/m)
  assert.ok(!builder.includes('Card checkouts have NO .env files.'))
  assert.ok(builder.includes('PROJECT-CONSTRAINTS.md'))
  writeFileSync(constraints, '## all\nNewest rule.\n')
  assert.match(readFileSync(writeBrief(tasks, card, 'reviewer'), 'utf8'), /Newest rule/, 'a later edit changes the brief revision')
})

test('PowerShell literals survive spaces/apostrophes; generated handoff is directly runnable syntax', () => {
  const root = mkdtempSync(join(tmpdir(), 'command-brief-')), board = join(root, "board O'Brien")
  mkdirSync(board); writeFileSync(join(board, 'hkb.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))')
  const tasks = join(root, "task O'Brien"), card = { id: 'T-1', path: join(root, 'T-1.md'), workspace: '.' }
  const worker = workerPrompt({ card, projectPath: root, boardRoot: board, tasksDir: tasks, engine: 'codex' })
  assert.match(worker, /login:false/); assert.match(worker, /never prefix bare -NoProfile/)
  const command = `node ${psLiteral(join(board, 'hkb.mjs'))} --tasks ${psLiteral(tasks)} done T-1`
  assert.ok(worker.includes(command))
  const run = spawnSync('pwsh', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(run.stdout.trim()), ['--tasks', tasks, 'done', 'T-1'])
  const review = reviewerPrompt({ cards: [card], projectPath: root, boardRoot: board, tasksDir: tasks, reviewClaim: 'exact-claim', reviewRoot: root })
  assert.ok(review.includes(`--review-root ${psLiteral(root)} --review-claim 'exact-claim' pass T-1`))
  assert.doesNotMatch(review, /run "node|\\\\"which criterion/)
  assert.match(review, /may append only the current Reviewer evidence and Review verdict/)
  assert.doesNotMatch(review, /do not edit the card by hand/)
})

// Token audit 2026-10-12, finding 3: the Planner brief stops repeating the card; Builder
// and Reviewer briefs are untouched by this.
test('a first-time Planner brief with unchanged constraints is at or below 1,000 characters (F3 AC1)', () => {
  const tasks = join(mkdtempSync(join(tmpdir(), 'planner-brief-size-')), 'TASKS')
  mkdirSync(join(tasks, 'planning'), { recursive: true })
  const card = createCard(tasks, { title: 'Fresh card', brief: 'Add the thing.', category: 'code' })
  const brief = readFileSync(writeBrief(tasks, card, 'planner'), 'utf8')
  assert.ok(brief.length <= 1000, `${brief.length} chars`)
})

test('a kicked-back Planner brief holds Current feedback and drops the implementation plan (F3 AC2); Builder/Reviewer briefs are unaffected (F3 AC3); brief-source is still written (F3 AC4)', () => {
  const tasks = join(mkdtempSync(join(tmpdir(), 'planner-brief-feedback-')), 'TASKS')
  mkdirSync(join(tasks, 'planning'), { recursive: true })
  const card = createCard(tasks, { title: 'Returned card', brief: 'Add the thing.', category: 'code' })
  appendFileSync(card.path, '\n## Implementation plan\nDo the exact approved step.\nCheck: node check.mjs\n')
  writeCurrentFeedback(tasks, card, 'Kicked back', '[planning] Add missing fixtures.json to ## Files')

  const plannerBrief = readFileSync(writeBrief(tasks, card, 'planner'), 'utf8')
  assert.match(plannerBrief, /## Current feedback\nKicked back: \[planning\] Add missing fixtures\.json to ## Files/)
  assert.doesNotMatch(plannerBrief, /## Implementation plan/)
  assert.doesNotMatch(plannerBrief, /Do the exact approved step/)

  assert.match(readFileSync(writeBrief(tasks, card, 'reviewer'), 'utf8'), /Do the exact approved step/)
  const builderBrief = readFileSync(writeBrief(tasks, card, 'builder'), 'utf8')
  assert.doesNotMatch(builderBrief, /Do the exact approved step/)
  assert.ok(builderBrief.includes(card.path.replaceAll('\\', '/')))

  const history = readFileSync(historyPath(tasks, card.id), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.ok(history.some(e => e.event === 'brief-source' && e.stage === 'planner'))
})

// HK48 (token audit 2026-10-14, F7): a rerun Builder brief points at the recorded baseline.
function baselineBrief({ evidence, rerun }) {
  const tasks = join(mkdtempSync(join(tmpdir(), 'baseline-brief-')), 'TASKS')
  mkdirSync(join(tasks, 'planning'), { recursive: true })
  const card = createCard(tasks, { title: 'Baseline card', brief: 'Add the thing.', category: 'code' })
  // The card template already has an ## Evidence placeholder; a Builder fills that section in.
  writeFileSync(card.path, readFileSync(card.path, 'utf8').replace(/^## Evidence\r?\n<!--[\s\S]*?-->/m, () => `## Evidence\n${evidence}`))
  assert.ok(readFileSync(card.path, 'utf8').includes(`## Evidence\n${evidence}`), 'evidence placed in the card')
  if (rerun) appendHistory(tasks, card.id, { event: 'builder-return', difficulty: 'easy', attempt: 1 })
  assert.doesNotMatch(readFileSync(writeBrief(tasks, card, 'reviewer'), 'utf8'), /Baseline already recorded/)
  return readFileSync(writeBrief(tasks, card, 'builder'), 'utf8')
}

test('HK48 AC1 a rerun Builder brief names the recorded baseline and says to reuse it', () => {
  const brief = baselineBrief({ evidence: 'Base check: node check.mjs -> AC1 FAIL (before fix)', rerun: true })
  assert.match(brief, /Baseline already recorded/)
  assert.ok(brief.includes('Base check: node check.mjs -> AC1 FAIL'))
  assert.match(brief, /do not rebuild or rerun the baseline unless the revised plan changes/)
})

test('HK48 AC2 a first-run Builder brief has no baseline pointer', () => {
  assert.doesNotMatch(baselineBrief({ evidence: 'Base check: node check.mjs -> AC1 FAIL (before fix)', rerun: false }), /Baseline already recorded/)
})

test('HK48 AC3 a rerun with no recorded baseline has no baseline pointer', () => {
  assert.doesNotMatch(baselineBrief({ evidence: 'Check: node check.mjs\nResult: pass', rerun: true }), /Baseline already recorded/)
})

// HK47 (token audit 2026-10-14, F5): AC1 size and pointers, AC2 verbatim sections, AC3 Reviewer unchanged.
test('HK47 Builder brief points to the plan and constraints', () => {
  const tasks = join(mkdtempSync(join(tmpdir(), 'builder-brief-size-')), 'TASKS')
  mkdirSync(join(tasks, 'planning'), { recursive: true })
  writeFileSync(join(tasks, 'PROJECT-CONSTRAINTS.md'), `## all\n${'Constraint line.\n'.repeat(300)}`)
  const card = createCard(tasks, { title: 'Big card', brief: 'Add the thing.', category: 'code' })
  const files = '- `lib/a.mjs` lines 1-9, `thing` — the change', prereq = '- Node on PATH; `lib/a.mjs` exists', ac = '- AC1: it works\n- AC2: it stays working'
  appendFileSync(card.path, `\n## Implementation plan\n${'Plan step detail.\n'.repeat(500)}\n## Files\n${files}\n## Prerequisites\n${prereq}\n## Acceptance criteria\n${ac}\n\n**Decision** 2026-10-14T01:00:00.000Z\n\nUse the exact helper.\n`)
  writeCurrentFeedback(tasks, card, 'Kicked back', '[implementation] Fix the edge case')

  const builder = readFileSync(writeBrief(tasks, card, 'builder'), 'utf8')
  assert.ok(builder.length < 6000, `${builder.length} chars`)
  assert.ok(builder.includes(card.path.replaceAll('\\', '/')) && builder.includes('PROJECT-CONSTRAINTS.md'))
  for (const verbatim of [files, prereq, ac, 'Use the exact helper.','## Current feedback\nKicked back: [implementation] Fix the edge case']) assert.ok(builder.includes(verbatim), verbatim)
  assert.ok(!builder.includes('Plan step detail.') && !builder.includes('Constraint line.'))

  // The Reviewer brief is the pre-change expression, not a stored copy of the old output.
  const source = readFileSync(card.path, 'utf8'), constraints = projectConstraints(tasks, 'code')
  const expected = `${focusedText(source, 'reviewer', { skip: ['Project constraints'] })}\n\n## Current project constraints\n${constraints}\n\nAuthoritative card: ${card.path}\nHistory (read only relevant entries on demand): ${historyPath(tasks, card.id)}\n`
  assert.equal(readFileSync(writeBrief(tasks, card, 'reviewer'), 'utf8'), expected)
})
