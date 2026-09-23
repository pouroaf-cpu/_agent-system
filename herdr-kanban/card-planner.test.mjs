import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCard, moveCard, findCard } from './lib/cards.mjs'
import { runCardPlanner, readCardPlanners, requestPlannerCorrection, correctionFingerprint } from './lib/card-planner.mjs'
const dir = mkdtempSync(join(tmpdir(), 'card-planner-'))
try {
  const card = createCard(dir, { title: 'Proof', brief: 'A specific approved outcome', now: new Date('2026-09-11T00:00:00Z') })
  assert.equal(card.createdAt, '2026-09-11T00:00:00.000Z')
  assert.equal(card.cardOwned, true)
  assert.throws(() => createCard(dir, { title: '../x\ninvalid', brief: 'x' }))
  let agents = [], starts = 0, submissions = 0, usage = 0, closes = 0
  const io = {
    agentList: async () => agents, agentWorkspaceOr: async () => 'workspace',
    tabCreate: async () => ({ root_pane: { pane_id: 'pane-1' } }), waitForPrompt: async () => {},
    agentStart: async ({ name }) => { starts++; agents = [{ name, pane_id: 'pane-1', agent_status: 'idle' }] },
    deliver: async () => { submissions++ }, recordUsageStart: () => { usage++ }, recordUsageFinish: async () => {},
    paneClose: async () => { closes++; agents = [] }
  }
  const args = { project: 'Proof', projectPath: dir, tasksDir: dir, boardRoot: dir, model: 'gpt-5.5', io }
  const first = await runCardPlanner(args)
  await runCardPlanner(args)
  assert.equal(first.spawnedNewAgent, true)
  assert.equal(starts, 1); assert.equal(submissions, 1)
  moveCard(dir, card.id, 'owner'); await runCardPlanner(args)
  assert.equal(closes, 0)
  moveCard(dir, card.id, 'issues'); const correction = await runCardPlanner(args)
  assert.equal(correction.spawnedNewAgent, false)
  assert.equal(starts, 1); assert.equal(submissions, 2); assert.equal(usage, 2)
  appendFileSync(findCard(dir, card.id).path, '\n## Reviewer evidence\nIndependent outcome check passed.\n**Review verdict:** PASS\n')
  moveCard(dir, card.id, 'archive'); await runCardPlanner(args)
  assert.equal(closes, 1); assert.ok(readCardPlanners(dir)[card.id].closedAt)

  const replacementDir = mkdtempSync(join(tmpdir(), 'card-planner-replace-'))
  try {
    const replacementCard = createCard(replacementDir, { title: 'Correction', brief: 'Correct malformed plan' })
    let pane = 0
    let currentAgents = []
    const delivered = []
    const replacementIo = {
      agentList: async () => currentAgents,
      agentWorkspaceOr: async () => 'workspace',
      tabCreate: async () => ({ root_pane: { pane_id: `pane-${++pane}` } }),
      waitForPrompt: async () => {},
      agentStart: async ({ name, paneId }) => { currentAgents = [{ name, pane_id: paneId, agent_status: 'idle' }] },
      deliver: async (paneId) => {
        delivered.push(paneId)
        if (paneId === 'pane-1' && delivered.filter(id => id === paneId).length > 1) throw new Error('original planner stalled')
      },
      recordUsageStart: () => {}, recordUsageFinish: async () => {}, paneClose: async (paneId) => {
        currentAgents = currentAgents.filter(a => a.pane_id !== paneId)
      },
    }
    const replacementArgs = { project: 'Replacement', projectPath: replacementDir, tasksDir: replacementDir, boardRoot: replacementDir, model: 'test', io: replacementIo }
    await runCardPlanner(replacementArgs)
    requestPlannerCorrection(replacementDir, replacementCard.id)
    const corrected = await runCardPlanner(replacementArgs)
    assert.equal(corrected.spawnedNewAgent, true)
    assert.deepEqual(delivered, ['pane-1', 'pane-1', 'pane-2'])
    const replacementOwner = readCardPlanners(replacementDir)[replacementCard.id]
    assert.equal(replacementOwner.paneId, 'pane-2')
    assert.equal(replacementOwner.previousPaneId, 'pane-1')
    assert.equal(replacementOwner.replacementAttempts, 1)
    // An accepted prompt that exits without handoff is a durable Issues
    // fallback; it must not be replaced or retried into ambiguity.
    await runCardPlanner({ ...replacementArgs, now: 1000000, handoffGraceMs: 10 })
    await runCardPlanner({ ...replacementArgs, now: 1000011, handoffGraceMs: 10 })
    assert.equal(findCard(replacementDir, replacementCard.id).column, 'issues')
    const beforeCooldown = delivered.length
    await runCardPlanner({ ...replacementArgs, now: 1000034 })
    assert.equal(delivered.length, beforeCooldown, 'Issues fallback does not spin during recovery hold')
    await runCardPlanner({ ...replacementArgs, now: 2000034 })
    assert.equal(findCard(replacementDir, replacementCard.id).column, 'issues')
    moveCard(replacementDir, replacementCard.id, 'owner')
    await runCardPlanner(replacementArgs)
    assert.equal(findCard(replacementDir, replacementCard.id).column, 'owner', 'human decisions are not automatically recovered')
    assert.notEqual(correctionFingerprint('**Kicked back** date\nA'), correctionFingerprint('**Kicked back** date\nB'))
  } finally { rmSync(replacementDir, { recursive: true, force: true }) }
  console.log('Planner pickup, idle retention, same-session correction and archive retirement passed')
} finally { rmSync(dir, { recursive: true, force: true }) }
