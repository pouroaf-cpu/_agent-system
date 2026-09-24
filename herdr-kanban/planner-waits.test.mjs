import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'planner-waits-'))
process.env.KANBAN_CONFIG = join(root, 'board.config.json') // delivery records live beside it
writeFileSync(process.env.KANBAN_CONFIG, JSON.stringify({ projects: ['uncertain', 'missing', 'blocked'], projectsRoot: root }))
const { createCard, findCard } = await import('./lib/cards.mjs')
const { runCardPlanner, readCardPlanners } = await import('./lib/card-planner.mjs')
const saveCardPlanners = (dir, data) => writeFileSync(join(dir, '.card-planners.json'), JSON.stringify(data))
const { readDelivery, saveDelivery } = await import('./lib/delivery-state.mjs')
const { readWorkflow, recordOperationalFailure } = await import('./lib/workflow-state.mjs')
const { historyPath } = await import('./lib/card-history.mjs')
const { checkStalls } = await import('./lib/stall-watchdog.mjs')
const history = (dir, id) => existsSync(historyPath(dir, id)) ? readFileSync(historyPath(dir, id), 'utf8').trim().split('\n').map(JSON.parse) : []

function fixture(name) {
  const dir = join(root, name); mkdirSync(dir)
  const log = { starts: 0, closed: [], delivered: [] }
  let panes = 1, agents = []
  const io = {
    agentList: async () => agents, agentWorkspaceOr: async () => 'ws',
    tabCreate: async () => ({ root_pane: { pane_id: `pane-${++panes}` } }), waitForPrompt: async () => {},
    agentStart: async ({ name, paneId }) => { log.starts++; agents.push({ name, pane_id: paneId, agent_status: 'idle' }) },
    deliver: async (paneId) => { log.delivered.push(paneId) }, recordUsageStart: () => {}, recordUsageFinish: async () => {},
    paneClose: async (paneId) => { log.closed.push(paneId); agents = agents.filter(a => a.pane_id !== paneId) }, paneRead: async () => 'output',
  }
  const run = (now) => runCardPlanner({ project: name, projectPath: dir, tasksDir: dir, boardRoot: dir, model: 'm', io, now, handoffGraceMs: 1000 })
  return { dir, log, io, run, setAgents: (a) => { agents = a } }
}

try {
  // 4. Uncertain Planner delivery (Tradeflow T-41): resolved as failed, fresh Planner.
  {
    const { dir, log, run, setAgents } = fixture('uncertain')
    const card = createCard(dir, { title: 'Uncertain', brief: 'Plan it' })
    saveCardPlanners(dir, { [card.id]: { assignmentId: 'a1', lifecycle: 'active', paneId: 'w5:p17', submitted: true, revokedPaneIds: [] } })
    saveDelivery('uncertain', 'w5:p17', { text: 'x', key: 'k', status: 'uncertain' })
    recordOperationalFailure(dir, findCard(dir, card.id), 'Previous delivery is uncertain; verify the existing session before redispatch', dir)
    const at = Date.parse(readDelivery('uncertain', 'w5:p17').at)
    setAgents([{ pane_id: 'w5:p17', agent_status: 'idle' }])
    assert.equal(await run(at + 10), null, 'inside the grace an idle pane may still be starting')
    assert.equal(log.starts, 0)
    const result = await run(at + 5000)
    assert.equal(result.spawnedNewAgent, true)
    assert.deepEqual(log.closed, ['w5:p17'], 'the old Planner is retired')
    assert.deepEqual(log.delivered, ['pane-2'])
    assert.equal(readDelivery('uncertain', 'w5:p17').status, 'failed')
    assert.equal(readWorkflow(dir)[card.id].operational, null)
    assert.equal(readCardPlanners(dir)[card.id].paneId, 'pane-2')
    assert.ok(history(dir, card.id).some(e => e.event === 'planner-delivery-failed'))
  }
  // A missing pane resolves at once.
  {
    const { dir, log, run } = fixture('missing')
    const card = createCard(dir, { title: 'Missing', brief: 'Plan it' })
    saveCardPlanners(dir, { [card.id]: { assignmentId: 'a1', lifecycle: 'active', paneId: 'gone', submitted: true, revokedPaneIds: [] } })
    saveDelivery('missing', 'gone', { text: 'x', key: 'k', status: 'uncertain' })
    recordOperationalFailure(dir, findCard(dir, card.id), 'Delivery unconfirmed: transport', dir)
    assert.equal((await run(Date.now())).spawnedNewAgent, true)
    assert.deepEqual(log.delivered, ['pane-2'])
    assert.ok(readCardPlanners(dir)[card.id].revokedPaneIds.includes('gone'))
    assert.equal(readCardPlanners(dir)[card.id].deliveryFailures, undefined, 'a confirmed delivery clears the count')
  }
  // A second fresh Planner that never takes its prompt goes to Owner, never loops.
  {
    const { dir, log, run } = fixture('looping')
    const card = createCard(dir, { title: 'Looping', brief: 'Plan it' })
    saveCardPlanners(dir, { [card.id]: { assignmentId: 'a1', lifecycle: 'active', paneId: 'dead', submitted: true, deliveryFailures: 1, revokedPaneIds: [] } })
    saveDelivery('looping', 'dead', { text: 'x', key: 'k', status: 'uncertain' })
    assert.equal(await run(Date.now()), null)
    assert.equal(log.starts, 0)
    assert.equal(findCard(dir, card.id).column, 'owner')
    assert.match(readFileSync(findCard(dir, card.id).path, 'utf8'), /never accepted their prompt/)
  }

  // 5. Blocked-by prerequisites unfinished (Tradeflow TF44): wait, no Planner, no loop.
  {
    const { dir, log, run, setAgents } = fixture('blocked')
    mkdirSync(join(dir, 'queue'), { recursive: true })
    writeFileSync(join(dir, 'queue', 'T-1-prereq.md'), '# T-1 — prerequisite\n')
    const card = createCard(dir, { title: 'Dependent', brief: 'Plan after T-1' })
    const text = readFileSync(card.path, 'utf8').replace('**Priority** 5/10', '**Priority** 5/10\n**Blocked by:** T-1')
    writeFileSync(card.path, text)
    assert.equal(await run(0), null); assert.equal(log.starts, 0, 'no Planner while T-1 is unfinished')
    // A Planner that already reported "not build-ready yet" is a wait, not a no-handoff.
    saveCardPlanners(dir, { [card.id]: { assignmentId: 'a1', lifecycle: 'active', paneId: 'p-old', submitted: true, inactiveSince: new Date(0).toISOString(), revokedPaneIds: [] } })
    setAgents([{ pane_id: 'p-old', agent_status: 'idle' }])
    for (const now of [10000, 20000, 30000]) await run(now)
    const owner = readCardPlanners(dir)[card.id]
    assert.equal(findCard(dir, card.id).column, 'planning')
    assert.equal(owner.submitted, false); assert.equal(owner.noHandoffCount, undefined)
    assert.equal(log.starts, 0); assert.deepEqual(log.delivered, [])
    // The stall watchdog treats it as an allowed wait.
    checkStalls({ tasksDir: dir, agents: [], builderSlotsFree: 0, now: 0 })
    assert.deepEqual(checkStalls({ tasksDir: dir, agents: [], builderSlotsFree: 0, now: 60 * 60000 }), [])
    // A Planner issue that names the unfinished prerequisite is recorded as a wait.
    const hkb = spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', dir, '--planner-assignment', 'a1', 'issue', card.id, '[planning] not build-ready until T-1 lands'], { encoding: 'utf8', env: { ...process.env } })
    assert.equal(hkb.status, 0, hkb.stderr)
    assert.equal(findCard(dir, card.id).column, 'planning')
    const events = history(dir, card.id).map(e => e.event)
    assert.ok(events.includes('planner-prerequisite-wait')); assert.ok(!events.includes('failure'))
    assert.equal(readWorkflow(dir)[card.id]?.correction, undefined)
    // Once T-1 lands, the card is planned normally.
    mkdirSync(join(dir, 'archive'), { recursive: true })
    renameSync(join(dir, 'queue', 'T-1-prereq.md'), join(dir, 'archive', 'T-1-prereq.md'))
    const planned = await run(40000)
    assert.equal(planned.spawnedNewAgent, true); assert.equal(log.starts, 1)
  }
  console.log('Planner waits passed')
} finally { rmSync(root, { recursive: true, force: true }) }
