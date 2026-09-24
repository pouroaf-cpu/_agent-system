import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createCard, findCard } from './lib/cards.mjs'
import { readCardPlanners, runCardPlanner } from './lib/card-planner.mjs'
import { saveCardPlanners } from './lib/planner-state.mjs'

test('a Planner issue that keeps the card in Planning is a handoff, not a no-handoff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-issue-'))
  try {
    const card = createCard(dir, { title: 'Blocked plan', brief: 'Plan it' })
    const owners = readCardPlanners(dir)
    owners[card.id] = { assignmentId: 'a1', lifecycle: 'active', paneId: 'p1', submitted: true, revokedPaneIds: [] }
    saveCardPlanners(dir, owners)
    const hkb = spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', dir, '--planner-assignment', 'a1', 'issue', card.id, '[planning] Returned blocker remains: source list incomplete'], { encoding: 'utf8' })
    assert.equal(hkb.status, 0, hkb.stderr)
    assert.equal(findCard(dir, card.id).column, 'planning')
    // Injectbuddy I152/I178: left submitted, the watchdog later called this a no-handoff.
    const owner = readCardPlanners(dir)[card.id]
    assert.equal(owner.submitted, false)
    assert.ok(owner.correctionRequestedAt)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('one card failing does not end the Planner pass for the cards after it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-pass-'))
  try {
    const first = createCard(dir, { title: 'Fails', brief: 'x' })
    const second = createCard(dir, { title: 'Plans', brief: 'y' })
    let panes = 0
    const agents = []
    const io = {
      agentList: async () => agents, agentWorkspaceOr: async () => 'w', waitForPrompt: async () => {},
      tabCreate: async () => ({ root_pane: { pane_id: `p${++panes}` } }),
      agentStart: async ({ name, paneId }) => { agents.push({ name, pane_id: paneId, agent_status: 'idle' }) },
      deliver: async (paneId, text) => { if (text.includes(first.id)) throw Object.assign(new Error('Delivery unconfirmed'), { preservePane: true }) },
      paneClose: async () => {}, paneRead: async () => '', recordUsageStart: () => {}, recordUsageFinish: async () => {},
    }
    const errors = []
    const result = await runCardPlanner({ project: 'P', projectPath: dir, tasksDir: dir, boardRoot: dir, model: 'gpt-5.5', io, onCardError: (card, err) => errors.push([card.id, err.message]) })
    // Injectbuddy I192/I193: the failing card ended every pass, so no Planner ever started.
    assert.deepEqual(errors, [[first.id, 'Delivery unconfirmed']])
    assert.deepEqual(result.cards, [second.id])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a delivery herdr gave up on counts once the agent starts working', async () => {
  const { deliverWith } = await import('./lib/spawn.mjs')
  let looks = 0
  // Injectbuddy I157: herdr's 5s stall check failed, one immediate look saw idle, and a
  // real delivery was marked unconfirmed twice, sending the card to Owner.
  await deliverWith({
    paneId: 'p', text: 'Read the brief', confirmMs: 3000,
    prompt: async () => { throw new Error('agent_prompt_stalled') }, read: async () => '', sendKeys: async () => {},
    list: async () => (++looks >= 3 ? [{ pane_id: 'p', agent_status: 'working' }] : []),
  })
})

test('a Planner blocked on an interactive question goes to Owner with it after the grace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-blocked-'))
  try {
    const card = createCard(dir, { title: 'Needs a label decision', brief: 'x' })
    const owners = readCardPlanners(dir)
    owners[card.id] = { assignmentId: 'a1', lifecycle: 'active', paneId: 'p1', submitted: true, revokedPaneIds: [] }
    saveCardPlanners(dir, owners)
    const agents = [{ name: 'p', pane_id: 'p1', agent_status: 'blocked' }]
    const io = {
      agentList: async () => agents, agentWorkspaceOr: async () => 'w', waitForPrompt: async () => {}, tabCreate: async () => ({}),
      agentStart: async () => {}, deliver: async () => {}, paneClose: async () => {}, recordUsageStart: () => {}, recordUsageFinish: async () => {},
      paneRead: async () => '? 1 question: which CTA label should non-syringe tools use?',
    }
    const run = (now) => runCardPlanner({ project: 'P', projectPath: dir, tasksDir: dir, boardRoot: dir, model: 'gpt-5.5', io, now, handoffGraceMs: 1000 }).catch(() => null)
    await run(10000)
    assert.equal(findCard(dir, card.id).column, 'planning', 'still inside the grace')
    await run(12000)
    // Injectbuddy I176/I181 sat blocked on an unanswerable prompt overnight.
    const moved = findCard(dir, card.id)
    assert.equal(moved.column, 'owner')
    assert.match(moved.ask?.text || '', /which CTA label/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the third Planner blocker in a row goes to Owner as the question', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-cap-'))
  try {
    const card = createCard(dir, { title: 'Hard plan', brief: 'x' })
    const hkb = (n) => {
      const owners = readCardPlanners(dir)
      owners[card.id] = { ...(owners[card.id] || {}), assignmentId: `a${n}`, lifecycle: 'active', paneId: `p${n}`, submitted: true, revokedPaneIds: [] }
      saveCardPlanners(dir, owners)
      return spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', dir, '--planner-assignment', `a${n}`, 'issue', card.id, `[planning] blocker remains, attempt ${n}`], { encoding: 'utf8' })
    }
    for (const n of [1, 2]) { assert.equal(hkb(n).status, 0); assert.equal(findCard(dir, card.id).column, 'planning') }
    assert.equal(hkb(3).status, 0)
    // Injectbuddy I152/I168/I184 each ran 25 Planners overnight on reworded blockers.
    const moved = findCard(dir, card.id)
    assert.equal(moved.column, 'owner')
    assert.match(moved.ask?.text || '', /Three Planners in a row[\s\S]*attempt 3/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the plan check accepts text files such as public/llms.txt', async () => {
  const { validatePlan } = await import('./lib/cards.mjs')
  const plan = '## Approved brief\nx\n## Files\n- `public/llms.txt` — site summary\n## Implementation plan\nx\n## Acceptance criteria\n1. x\n'
  // Injectbuddy I168: 25 Planners could never hand off a card that edits llms.txt.
  assert.doesNotThrow(() => validatePlan(plan))
})
