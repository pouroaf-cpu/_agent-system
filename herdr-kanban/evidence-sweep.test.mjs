import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { COLUMNS } from './lib/cards.mjs'
import { applyEvidencePlan, planArchivedEvidence } from './lib/evidence-sweep.mjs'
import { EVIDENCE_FILE_CAP } from './lib/evidence-guard.mjs'

// T-1 is archived. T-2 is archived and an audit. T-3 is in the Working lane. T-9 has an evidence folder and no card file.
// 2026-10-16-i1361 is an audit folder that names no card.
function fixture() {
  const tasks = mkdtempSync(join(tmpdir(), 'ev-sweep-'))
  for (const dir of ['archive', ...COLUMNS.map(c => c.dir)]) mkdirSync(join(tasks, dir), { recursive: true })
  writeFileSync(join(tasks, 'archive', 'T-1-thing.md'), '**Workspace:** x\n')
  writeFileSync(join(tasks, 'archive', 'T-2-audit.md'), '**Audit:** UX review\n')
  writeFileSync(join(tasks, 'working', 'T-3-live.md'), '**Workspace:** x\n')
  for (const id of ['T-1', 'T-2', 'T-3', 'T-9']) {
    const folder = join(tasks, '.evidence', id)
    mkdirSync(join(folder, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(folder, 'node_modules', 'pkg', 'i.js'), 'x')
    writeFileSync(join(folder, 'big.json'), Buffer.alloc(EVIDENCE_FILE_CAP + 1))
    writeFileSync(join(folder, 'summary.md'), 'ok')
  }
  mkdirSync(join(tasks, '.evidence', '2026-10-16-i1361', 'node_modules'), { recursive: true })
  return tasks
}

test('the archived-card sweep plans caches and over-cap files for archived cards only', async () => {
  const plan = await planArchivedEvidence(fixture())
  assert.deepEqual(plan.cards.map(c => c.id), ['T-1'])
  assert.deepEqual(plan.cards[0].items.map(i => i.kind).sort(), ['cache', 'oversize'])
  assert.deepEqual(plan.skipped, { live: 1, audit: 1, unknown: 2 })
})

test('applying the plan removes archived cache folders, cuts over-cap files, and touches nothing else', async () => {
  const tasks = fixture()
  const done = await applyEvidencePlan(await planArchivedEvidence(tasks))
  assert.deepEqual(done.failed, [])
  const ev = id => join(tasks, '.evidence', id)
  assert.equal(existsSync(join(ev('T-1'), 'node_modules')), false)
  assert.ok(statSync(join(ev('T-1'), 'big.json')).size <= EVIDENCE_FILE_CAP + 300)
  assert.ok(existsSync(join(ev('T-1'), 'summary.md')))
  for (const id of ['T-2', 'T-3', 'T-9']) {
    assert.ok(existsSync(join(ev(id), 'node_modules', 'pkg', 'i.js')), id)
    assert.equal(statSync(join(ev(id), 'big.json')).size, EVIDENCE_FILE_CAP + 1, id)
  }
})

test('with keepDays, an archived card whose files are all older is planned and removed as a whole folder', async () => {
  const tasks = fixture()
  const old = new Date(Date.now() - 100 * 86400000)
  utimesSync(join(tasks, '.evidence', 'T-1', 'big.json'), old, old)
  utimesSync(join(tasks, '.evidence', 'T-1', 'summary.md'), old, old)
  assert.deepEqual((await planArchivedEvidence(tasks)).cards[0].items.map(i => i.kind).sort(), ['cache', 'oversize'])
  const plan = await planArchivedEvidence(tasks, { keepDays: 30 })
  assert.equal(plan.cards.length, 1)
  assert.deepEqual(plan.cards[0].items.map(i => i.kind), ['age'])
  assert.equal(plan.cards[0].items[0].path, join(tasks, '.evidence', 'T-1'))
  assert.deepEqual((await applyEvidencePlan(plan)).failed, [])
  assert.equal(existsSync(join(tasks, '.evidence', 'T-1')), false)
  assert.ok(existsSync(join(tasks, '.evidence', 'T-2', 'node_modules')))
})

test('an archived card with fresh files is not aged out when keepDays is set', async () => {
  const plan = await planArchivedEvidence(fixture(), { keepDays: 30 })
  assert.deepEqual(plan.cards.map(c => c.items.map(i => i.kind)), [['cache', 'oversize']])
})

test("the plan yields to the board event loop while it walks the evidence", async () => {
  const tasks = fixture()
  let ran = false
  const pending = planArchivedEvidence(tasks)
  setImmediate(() => { ran = true })
  await pending
  assert.equal(ran, true)
})
