import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCard, moveCard } from './lib/cards.mjs'
import { runCardPlanner, requestPlannerCorrection } from './lib/card-planner.mjs'
import { readCardPlanners, saveCardPlanners } from './lib/planner-state.mjs'

// Injectbuddy I1420: a Planning recovery retired by planner-reconcile (recoveryReady) stayed
// retired. The watchdog's correction request was refused, so the card went to Owner instead of
// getting a fresh Planner. A requested correction must now let the board poll launch one.
function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'planner-recovery-request-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const card = createCard(dir, { title: 'Recovery', brief: 'A specific approved outcome' })
  moveCard(dir, card.id, 'planning')
  const counts = { starts: 0, submissions: 0 }
  let agents = [], panes = 0
  const io = {
    agentList: async () => agents, agentWorkspaceOr: async () => 'workspace',
    tabCreate: async () => ({ root_pane: { pane_id: `pane-${++panes}` } }), waitForPrompt: async () => {},
    agentStart: async ({ name, paneId }) => { counts.starts++; agents = [{ name, pane_id: paneId, agent_status: 'idle' }] },
    deliver: async () => { counts.submissions++ }, recordUsageStart: () => {}, recordUsageFinish: async () => {},
    paneClose: async () => { agents = [] }, paneRead: async () => 'saved planner output'
  }
  const args = { project: 'Proof', projectPath: dir, tasksDir: dir, boardRoot: dir, model: 'gpt-5.5', io }
  return { dir, card, counts, args }
}

function retire(dir, id, recoveryReady) {
  const owners = readCardPlanners(dir)
  owners[id] = {
    paneId: 'old', lifecycle: 'retired', closedAt: '2026-10-16T00:21:00.000Z', closureReason: 'Planner exited with no handoff',
    recoveryReady, reconciliationHistoryId: 'history-1', submitted: false, replacementAttempts: 0, correctionRounds: 1, sameFailureCount: 1
  }
  saveCardPlanners(dir, owners)
}

test('a correction request reopens an authorized Planning recovery for a fresh Planner outside a card run', async t => {
  const { dir, card, counts, args } = harness(t)
  retire(dir, card.id, true)
  await runCardPlanner(args)
  assert.equal(counts.starts, 0, 'a retired recovery never launches on its own')
  assert.equal(requestPlannerCorrection(dir, card.id), true, 'the watchdog correction is accepted')
  const launched = await runCardPlanner(args)
  assert.equal(launched.spawnedNewAgent, true)
  assert.equal(counts.starts, 1)
  const owner = readCardPlanners(dir)[card.id]
  assert.equal(owner.lifecycle, 'active')
  assert.equal(owner.paneId, 'pane-1')
  assert.equal(owner.recoveryRequested, undefined, 'the request is consumed by the launch')
})

test('a retired owner that is not recovery-ready is still refused and never launches', async t => {
  const { dir, card, counts, args } = harness(t)
  retire(dir, card.id, false)
  assert.equal(requestPlannerCorrection(dir, card.id), false)
  await runCardPlanner(args)
  assert.equal(counts.starts, 0)
  assert.equal(readCardPlanners(dir)[card.id].lifecycle, 'retired')
})
