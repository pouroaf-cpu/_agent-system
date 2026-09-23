import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { findCard, canArchive } from './lib/cards.mjs'
test('operator waiver is per-card, integrated/self-verified only, preserves counters and never invents Review PASS', t => {
  const root = mkdtempSync(join(tmpdir(), 'operator-complete-')), tasks = join(root, 'Proof', 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasks, 'completed'), { recursive: true }); mkdirSync(join(tasks, 'reports'))
  const text = '# T-1 — proof\n**Workflow:** card-owned\n**Recovery:** {"returns":3}\n'
  writeFileSync(join(tasks, 'completed', 'T-1.md'), text)
  writeFileSync(join(tasks, 'completed', 'T-2.md'), text.replace('T-1', 'T-2'))
  writeFileSync(join(tasks, '.board-worktrees.json'), JSON.stringify({ 'T-1': { state: 'issue', commit: 'kept' } }))
  const config = join(root, 'config.json'); writeFileSync(config, JSON.stringify({ projects: ['Proof'], projectsRoot: root, maxConcurrentAgents: 0, projectControls: { Proof: { paused: true } } }))
  const report = join(tasks, 'reports', 'result.json'); writeFileSync(report, JSON.stringify({ cardId: 'T-1', status: 'SELF-VERIFIED', independentReview: 'WAIVED BY USER', checks: [{ status: 'PASS' }] }))
  const run = () => spawnSync(process.execPath, ['operator-complete.mjs', 'Proof', 'T-1', report, 'Explicit test operator waiver'], { cwd: new URL('.', import.meta.url), env: { ...process.env, KANBAN_CONFIG: config }, encoding: 'utf8' })
  assert.notEqual(run().status, 0)
  writeFileSync(join(tasks, '.board-worktrees.json'), JSON.stringify({ 'T-1': { state: 'integrated', commit: 'kept' } }))
  const result = run(); assert.equal(result.status, 0, result.stderr)
  const card = findCard(tasks, 'T-1'); assert.equal(card.column, 'archive'); assert.equal(card.reviewPassed, false); assert.equal(canArchive(card), true)
  assert.equal(readFileSync(card.path, 'utf8'), text); assert.equal(canArchive(findCard(tasks, 'T-2')), false)
  appendFileSync(report, ' '); assert.equal(canArchive(card), false)
})
