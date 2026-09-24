import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
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
  let agents = [], starts = 0, submissions = 0, usage = 0, closes = 0, panes = 0
  const io = {
    agentList: async () => agents, agentWorkspaceOr: async () => 'workspace',
    tabCreate: async () => ({ root_pane: { pane_id: `pane-${++panes}` } }), waitForPrompt: async () => {},
    agentStart: async ({ name, paneId }) => { starts++; agents = [{ name, pane_id: paneId, agent_status: 'idle' }] },
    deliver: async () => { submissions++ }, recordUsageStart: () => { usage++ }, recordUsageFinish: async () => {},
    paneClose: async () => { closes++; agents = [] }, paneRead: async () => 'saved planner output'
  }
  const args = { project: 'Proof', projectPath: dir, tasksDir: dir, boardRoot: dir, model: 'gpt-5.5', io }
  const first = await runCardPlanner(args)
  await runCardPlanner(args)
  assert.equal(first.spawnedNewAgent, true)
  assert.equal(starts, 1); assert.equal(submissions, 1)
  moveCard(dir, card.id, 'owner'); await runCardPlanner(args)
  assert.equal(closes, 0)
  // A correction goes to a fresh Planner; the idle one is retired, its output saved.
  moveCard(dir, card.id, 'issues'); const correction = await runCardPlanner(args)
  assert.equal(correction.spawnedNewAgent, true)
  assert.equal(starts, 2); assert.equal(submissions, 2); assert.equal(usage, 2); assert.equal(closes, 1)
  assert.equal(readCardPlanners(dir)[card.id].paneId, 'pane-2')
  assert.deepEqual(readCardPlanners(dir)[card.id].revokedPaneIds, ['pane-1'])
  appendFileSync(findCard(dir, card.id).path, '\n## Reviewer evidence\nIndependent outcome check passed.\n**Review verdict:** PASS\n')
  moveCard(dir, card.id, 'archive'); await runCardPlanner(args)
  assert.equal(closes, 2); assert.ok(readCardPlanners(dir)[card.id].closedAt)

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
      recordUsageStart: () => {}, recordUsageFinish: async () => {}, paneRead: async () => "old output", paneClose: async (paneId) => {
        currentAgents = currentAgents.filter(a => a.pane_id !== paneId)
      },
    }
    const replacementArgs = { project: 'Replacement', projectPath: replacementDir, tasksDir: replacementDir, boardRoot: replacementDir, model: 'test', io: replacementIo }
    await runCardPlanner(replacementArgs)
    requestPlannerCorrection(replacementDir, replacementCard.id)
    const corrected = await runCardPlanner(replacementArgs)
    assert.equal(corrected.spawnedNewAgent, true)
    assert.deepEqual(delivered, ['pane-1', 'pane-2'], 'the correction never goes back to the idle pane-1')
    const replacementOwner = readCardPlanners(replacementDir)[replacementCard.id]
    assert.equal(replacementOwner.paneId, 'pane-2')
    assert.equal(replacementOwner.previousPaneId, 'pane-1')
    assert.equal(replacementOwner.replacementAttempts, 0, 'a fresh correction Planner is not a failed-launch replacement')
    // An accepted prompt that exits without handoff gets one fresh Planner,
    // then stops in Owner; it never spins.
    await runCardPlanner({ ...replacementArgs, now: 1000000, handoffGraceMs: 10 })
    await runCardPlanner({ ...replacementArgs, now: 1000011, handoffGraceMs: 10 })
    assert.equal(findCard(replacementDir, replacementCard.id).column, 'planning')
    assert.deepEqual(delivered, ['pane-1', 'pane-2', 'pane-3'])
    await runCardPlanner({ ...replacementArgs, now: 1000020, handoffGraceMs: 10 })
    await runCardPlanner({ ...replacementArgs, now: 1000031, handoffGraceMs: 10 })
    assert.equal(findCard(replacementDir, replacementCard.id).column, 'owner')
    await runCardPlanner({ ...replacementArgs, now: 2000034 })
    assert.equal(delivered.length, 3, 'Owner fallback does not spin')
    await runCardPlanner(replacementArgs)
    assert.equal(findCard(replacementDir, replacementCard.id).column, 'owner', 'human decisions are not automatically recovered')
    assert.notEqual(correctionFingerprint('**Kicked back** date\nA'), correctionFingerprint('**Kicked back** date\nB'))
  } finally { rmSync(replacementDir, { recursive: true, force: true }) }
  // Tradeflow T-42: a card in Issues with a 0-byte twin in Working holds only itself;
  // the run goes on to plan other cards instead of throwing (which tripped the breaker).
  const dupDir = mkdtempSync(join(tmpdir(), 'card-planner-dup-'))
  try {
    const twin = moveCard(dupDir, createCard(dupDir, { title: 'Twin', brief: 'Duplicated card' }).id, 'issues')
    mkdirSync(join(dupDir, 'working'), { recursive: true })
    writeFileSync(join(dupDir, 'working', twin.file), '')
    const other = createCard(dupDir, { title: 'Other', brief: 'Unrelated card' })
    let dupAgents = [], dupPanes = 0
    const holds = []
    const dupIo = {
      agentList: async () => dupAgents, agentWorkspaceOr: async () => 'workspace',
      tabCreate: async () => ({ root_pane: { pane_id: `dup-${++dupPanes}` } }), waitForPrompt: async () => {},
      agentStart: async ({ name, paneId }) => { dupAgents = [{ name, pane_id: paneId, agent_status: 'idle' }] },
      deliver: async () => {}, recordUsageStart: () => {}, recordUsageFinish: async () => {},
      paneClose: async () => {}, paneRead: async () => '',
    }
    const run = await runCardPlanner({ project: 'Dup', projectPath: dupDir, tasksDir: dupDir, boardRoot: dupDir, model: 'test', io: dupIo, onHold: err => holds.push(err.message) })
    assert.deepEqual(run.cards, [other.id], 'the other card is still planned')
    assert.equal(holds.length, 1)
    for (const path of [`working/${twin.file}`, `issues/${twin.file}`]) assert.ok(holds[0].includes(path), holds[0])
    assert.ok(existsSync(join(dupDir, 'working', twin.file)) && existsSync(twin.path), 'both copies are kept')
  } finally { rmSync(dupDir, { recursive: true, force: true }) }
  console.log('Planner pickup, idle retention, fresh-Planner correction, no-handoff retry then Owner, and archive retirement passed; a duplicated card id holds only that card')
} finally { rmSync(dir, { recursive: true, force: true }) }
