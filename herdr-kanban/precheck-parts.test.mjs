// Token audit item 20 (2026-10-16): `hkb precheck <ID> --parts <files>` runs the split --parts checks on
// each part, read-only, and prints PASS or every failing item numbered, so a Planner fixes them in one pass.
// It must refuse exactly what split --parts refuses, and write nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createCard, findCard, readBoard } from './lib/cards.mjs'
import { readCardPlanners, saveCardPlanners } from './lib/planner-state.mjs'

function part(title, { file, blocked, noAc } = {}) {
  const ac = noAc ? '' : `## Acceptance criteria\n- AC1: ${title} works as described.\n`
  return `# ${title}\n\n**Difficulty:** medium\n**Plan readiness:** build-ready\n${blocked ? `**Blocked by:** ${blocked}\n` : ''}` +
    `## Approved brief\nDeliver the agreed behavior for ${title}.\n` +
    `## Files\n- \`${file}\` (new) — purpose\n` +
    `## Implementation plan\nOutcome: ship the behavior for ${title}.\nUnchanged constraints: no API changes.\n` +
    `Observed cause: the behavior for ${title} does not exist yet.\nEvidence: manual inspection of the current code.\n` +
    `Inspected current revision/state: new file; nothing to inspect yet.\nChanges: add ${file} implementing the behavior.\n` +
    `Scope: only ${file} and its test.\nStop rules: stop if ${file} already exists with different content.\n**Callers checked:** none\n` +
    ac +
    `## Prerequisites\nExisting Node runtime; no additional access.\n`
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'precheck-parts-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const card = createCard(dir, { title: 'Parent to split', brief: 'Preserve the approved scope' })
  writeFileSync(card.path, readFileSync(card.path, 'utf8').replace(/## Files[^\n]*\n/, '## Files\n- `src/parent.mjs` (new): placeholder\n'))
  const owners = readCardPlanners(dir)
  owners[card.id] = { assignmentId: 'a1', lifecycle: 'active', paneId: 'p1', submitted: true }
  saveCardPlanners(dir, owners)
  const partsDir = join(dir, 'parts'); mkdirSync(partsDir, { recursive: true })
  const writePart = (name, text) => { const p = join(partsDir, name); writeFileSync(p, text); return p }
  const hkb = (...args) => spawnSync(process.execPath, [resolve('hkb.mjs'), '--tasks', dir, ...args], { encoding: 'utf8', windowsHide: true })
  const split = (...args) => spawnSync(process.execPath, [resolve('hkb.mjs'), '--tasks', dir, '--planner-assignment', 'a1', ...args], { encoding: 'utf8', windowsHide: true })
  return { dir, card, writePart, hkb, split }
}

const idsOf = (dir) => Object.values(readBoard(dir)).flat().map(c => c.id)

test('precheck --parts prints PASS for good parts and writes nothing', t => {
  const { dir, card, writePart, hkb } = fixture(t)
  const before = idsOf(dir).sort()
  const cardBefore = readFileSync(card.path, 'utf8')
  const p1 = writePart('part1.md', part('First piece', { file: 'src/one.mjs' }))
  const p2 = writePart('part2.md', part('Second piece', { file: 'src/two.mjs' }))
  const run = hkb('precheck', card.id, '--parts', p1, p2)
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, new RegExp(`^PRECHECK PASS ${card.id}: split ${card.id} --parts now`))
  assert.deepEqual(idsOf(dir).sort(), before)
  assert.equal(findCard(dir, card.id).column, 'planning')
  assert.equal(readFileSync(card.path, 'utf8'), cardBefore)
})

test('precheck --parts lists every failing part in one numbered output, exit 1, and split refuses the same parts', t => {
  const { dir, card, writePart, hkb, split } = fixture(t)
  const before = idsOf(dir).sort()
  const p1 = writePart('part1.md', part('No criteria', { file: 'src/one.mjs', noAc: true }))
  const p2 = writePart('part2.md', part('Bad link', { file: 'src/two.mjs', blocked: 'part 9' }))
  const run = hkb('precheck', card.id, '--parts', p1, p2)
  assert.equal(run.status, 1, run.stdout + run.stderr)
  assert.match(run.stdout, new RegExp(`^PRECHECK FAIL ${card.id}: \\d+ problem\\(s\\); fix only these, then precheck again:\\n1\\. `))
  assert.match(run.stdout, /part1\.md/)
  assert.match(run.stdout, /does not refer to one of the other 1 parts/)
  const parts = [p1, p2]
  const refused = split(card.id, '--parts', ...parts)
  assert.equal(refused.status, 1, refused.stdout + refused.stderr)
  assert.deepEqual(idsOf(dir).sort(), before, 'a failing precheck and a refused split both write nothing')
  assert.equal(findCard(dir, card.id).column, 'planning')
})

test('precheck --parts needs at least two part files', t => {
  const { card, writePart, hkb } = fixture(t)
  const p1 = writePart('part1.md', part('Only one', { file: 'src/one.mjs' }))
  const run = hkb('precheck', card.id, '--parts', p1)
  assert.equal(run.status, 1)
  assert.match(run.stderr + run.stdout, /precheck --parts needs the card id and at least two part files/)
})
