// hkb split --parts: a Planner splits a card into several ready-to-build children
// in one step, no manager chat, no second Planner (operator, 2026-10-11).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createCard, findCard, readBoard } from './lib/cards.mjs'
import { readCardPlanners, saveCardPlanners } from './lib/planner-state.mjs'
import { historyPath } from './lib/card-history.mjs'

function part(title, { file, blocked, noAc, ok = true } = {}) {
  const ac = noAc ? '' : `## Acceptance criteria\n- AC1: ${title} works as described.\n`
  return `# ${title}\n\n**Difficulty:** medium\n**Plan readiness:** build-ready\n${blocked ? `**Blocked by:** ${blocked}\n` : ''}` +
    `## Approved brief\nDeliver the agreed behavior for ${title}.\n` +
    `## Files\n- \`${file}\` (new) — purpose\n` +
    `## Implementation plan\nOutcome: ship the behavior for ${title}.\nUnchanged constraints: no API changes.\n` +
    `Observed cause: the behavior for ${title} does not exist yet.\nEvidence: manual inspection of the current code.\n` +
    `Inspected current revision/state: new file; nothing to inspect yet.\nChanges: add ${file} implementing the behavior.\n` +
    `Scope: only ${file} and its test.\nStop rules: stop if ${file} already exists with different content.\n**Callers checked:** none\n` +
    (ok ? ac : '') +
    `## Prerequisites\nExisting Node runtime; no additional access.\n`
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'split-parts-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const card = createCard(dir, { title: 'Parent to split', brief: 'Preserve the approved scope' })
  writeFileSync(card.path, readFileSync(card.path, 'utf8').replace(/## Files[^\n]*\n/, '## Files\n- `src/parent.mjs` (new): placeholder\n'))
  const owners = readCardPlanners(dir)
  owners[card.id] = { assignmentId: 'a1', lifecycle: 'active', paneId: 'p1', submitted: true }
  saveCardPlanners(dir, owners)
  const partsDir = join(dir, 'parts'); mkdirSync(partsDir, { recursive: true })
  const writePart = (name, text) => { const p = join(partsDir, name); writeFileSync(p, text); return p }
  const run = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', dir, '--planner-assignment', 'a1', ...args], { encoding: 'utf8' })
  return { dir, card, writePart, run }
}

const idsOf = (dir) => Object.values(readBoard(dir)).flat().map(c => c.id)

test('split --parts makes a ready-to-build card per part and archives the parent', t => {
  const { dir, card, writePart, run } = fixture(t)
  const before = new Set(idsOf(dir))
  const p1 = writePart('part1.md', part('First piece', { file: 'src/one.mjs' }))
  const p2 = writePart('part2.md', part('Second piece', { file: 'src/two.mjs' }))
  const result = run('split', card.id, '--parts', p1, p2)
  assert.equal(result.status, 0, result.stderr)
  const made = idsOf(dir).filter(id => !before.has(id))
  assert.equal(made.length, 2)
  for (const id of made) {
    const child = findCard(dir, id)
    assert.equal(child.column, 'planned')
    const text = readFileSync(child.path, 'utf8')
    assert.match(text, /\*\*Workflow:\*\* card-owned/)
    assert.match(text, /\*\*Split from:\*\* I\d+|T-\d+/)
  }
  const parent = findCard(dir, card.id)
  assert.equal(parent.column, 'archive')
  const history = readFileSync(historyPath(dir, card.id), 'utf8')
  assert.match(history, new RegExp(`"note":"split into ${made.join(', ')}"`))
  const activity = readFileSync(join(dir, 'activity.log'), 'utf8')
  assert.match(activity, new RegExp(`card=${card.id} event=planner-finish message=planning -> archive \\(split into ${made.join(', ')}\\)`))
})

test('split --parts: Blocked by "part N" resolves to the real child id', t => {
  const { dir, card, writePart, run } = fixture(t)
  const before = new Set(idsOf(dir))
  const p1 = writePart('part1.md', part('Base piece', { file: 'src/base.mjs' }))
  const p2 = writePart('part2.md', part('Dependent piece', { file: 'src/dep.mjs', blocked: 'part 1' }))
  const result = run('split', card.id, '--parts', p1, p2)
  assert.equal(result.status, 0, result.stderr)
  const made = idsOf(dir).filter(id => !before.has(id))
  const first = findCard(dir, made[0])
  const second = findCard(dir, made[1])
  assert.deepEqual(second.blockedBy, [first.id])
})

test('split --parts accepts two parts sharing a file only when chained by Blocked by', t => {
  const { dir, card, writePart, run } = fixture(t)
  const shared = writePart('p1.md', part('Shares A', { file: 'src/shared.mjs' }))
  const sharedToo = writePart('p2.md', part('Shares B', { file: 'src/shared.mjs' }))
  const refused = run('split', card.id, '--parts', shared, sharedToo)
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /both edit src\/shared\.mjs.*Merge them.*Blocked by/s)
  assert.equal(findCard(dir, card.id).column, 'planning')

  const before = new Set(idsOf(dir))
  const chained = writePart('p2b.md', part('Shares B chained', { file: 'src/shared.mjs', blocked: 'part 1' }))
  const accepted = run('split', card.id, '--parts', shared, chained)
  assert.equal(accepted.status, 0, accepted.stderr)
  assert.equal(idsOf(dir).filter(id => !before.has(id)).length, 2)
})

test('split --parts refuses fewer than two parts and makes nothing', t => {
  const { dir, card, writePart, run } = fixture(t)
  const before = idsOf(dir)
  const p1 = writePart('only.md', part('Only piece', { file: 'src/only.mjs' }))
  const result = run('split', card.id, '--parts', p1)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /at least two part files/)
  assert.deepEqual(idsOf(dir), before)
  assert.equal(findCard(dir, card.id).column, 'planning')
})

test('split --parts refuses a part with no acceptance criteria and makes nothing', t => {
  const { dir, card, writePart, run } = fixture(t)
  const before = idsOf(dir)
  const p1 = writePart('p1.md', part('Good piece', { file: 'src/good.mjs' }))
  const p2 = writePart('p2.md', part('Bad piece', { file: 'src/bad.mjs', noAc: true }))
  const result = run('split', card.id, '--parts', p1, p2)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Bad piece.*Plan incomplete/s)
  assert.deepEqual(idsOf(dir), before)
  assert.equal(findCard(dir, card.id).column, 'planning')
})

test('split --parts refuses a caller that is not the assigned Planner', t => {
  const { dir, card, writePart } = fixture(t)
  const before = idsOf(dir)
  const p1 = writePart('p1.md', part('First piece', { file: 'src/one.mjs' }))
  const p2 = writePart('p2.md', part('Second piece', { file: 'src/two.mjs' }))
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', dir, '--planner-assignment', 'wrong-token', 'split', card.id, '--parts', p1, p2], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.deepEqual(idsOf(dir), before)
  assert.equal(findCard(dir, card.id).column, 'planning')
})

test('the old numbered-findings split still goes to Owner, unaffected by --parts', t => {
  const { dir, card, run } = fixture(t)
  const result = run('split', card.id, '1. First finding\n2. Second finding')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(findCard(dir, card.id).column, 'owner')
})
