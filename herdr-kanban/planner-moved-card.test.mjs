import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createCard, findCard, moveCard } from './lib/cards.mjs'
import { runCardPlanner, readCardPlanners, requestPlannerCorrection } from './lib/card-planner.mjs'
import { saveCardPlanners } from './lib/planner-state.mjs'

test('a split during a planner pass skips the moved card without reporting a failure', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-moved-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const retired = createCard(dir, { title: 'Retired', brief: 'Already handed off' })
  moveCard(dir, retired.id, 'owner')
  const card = createCard(dir, { title: 'Split', brief: 'Several independent findings' })
  const other = createCard(dir, { title: 'Other', brief: 'Still needs planning' })
  const owners = readCardPlanners(dir)
  owners[retired.id] = { paneId: 'retired', submitted: true }
  owners[card.id] = { paneId: 'split', submitted: true, inactiveSince: new Date(0).toISOString() }
  saveCardPlanners(dir, owners)
  const errors = []
  let splitAt = 'snapshot', starts = 0
  const split = () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', dir, 'split', card.id, '1. First finding (a.log)\n2. Second finding (b.log)'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const io = {
    agentList: async () => [], agentWorkspaceOr: async () => 'workspace',
    recordUsageFinish: async ({ paneId }) => { if (paneId === 'retired' && splitAt === 'snapshot') split() },
    paneRead: async () => { if (splitAt === 'pane') split(); return 'Planner handed off with hkb split' },
    paneClose: async () => {}, tabCreate: async () => ({ root_pane: { pane_id: 'other' } }),
    waitForPrompt: async () => {}, agentStart: async () => { starts++ },
    deliver: async () => {}, recordUsageStart: () => {},
  }
  const args = { project: 'Moved', projectPath: dir, tasksDir: dir, boardRoot: dir, model: 'test', io, now: 10000, handoffGraceMs: 1, onCardError: (card, error) => errors.push([card.id, error.message]) }
  for (splitAt of ['snapshot', 'pane']) {
    if (splitAt === 'pane') {
      moveCard(dir, card.id, 'planning')
      requestPlannerCorrection(dir, other.id)
    }
    const result = await runCardPlanner(args)
    assert.deepEqual(errors, [], `${splitAt}: a successful split is not a planner error`)
    assert.equal(findCard(dir, card.id).column, 'owner')
    assert.equal(readCardPlanners(dir)[card.id].noHandoffCount, undefined, 'a split is not a missing handoff')
    assert.deepEqual(result.cards, [other.id], 'the pass continues with another Planning card')
  }
  assert.equal(starts, 2, 'only the unrelated card gets a Planner')
})
