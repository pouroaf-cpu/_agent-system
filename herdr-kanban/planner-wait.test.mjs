import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createCard, findCard } from './lib/cards.mjs'
import { readCardPlanners, runCardPlanner } from './lib/card-planner.mjs'
import { saveCardPlanners } from './lib/planner-state.mjs'
import { readWorkflow } from './lib/workflow-state.mjs'

const HKB = fileURLToPath(new URL('./hkb.mjs', import.meta.url))
// Hand off as the card's (Codex) Planner, with the manager inbox in the test folder.
const wait = (dir, id, ...args) => {
  const owners = readCardPlanners(dir)
  owners[id] = { assignmentId: 'a1', lifecycle: 'active', paneId: 'p1', submitted: true, revokedPaneIds: [], engine: 'codex' }
  saveCardPlanners(dir, owners)
  return spawnSync(process.execPath, [HKB, '--tasks', dir, '--planner-assignment', 'a1', 'wait', id, ...args], { encoding: 'utf8', env: { ...process.env, KANBAN_CONFIG: join(dir, 'none.json'), KANBAN_MANAGER_INBOX: join(dir, 'inbox.md') } })
}

// 11 of 19 Planner hand-backs since 26 Sep were a missing file or card sent as `issue`,
// which counted toward Owner and escalated Codex cards.
test('hkb wait on a missing file keeps the card in Planning, uncounted, and tells the manager', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-wait-'))
  try {
    const card = createCard(dir, { title: 'Edit the guide', brief: 'x' })
    const r = wait(dir, card.id, 'public/x/y.html', 'the page is created by another card')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(findCard(dir, card.id).column, 'planning')
    const saved = readWorkflow(dir)[card.id]
    assert.equal(saved.plannerIssues, undefined)
    assert.equal(saved.plannerEscalation, undefined)
    assert.deepEqual({ ...saved.waitFor, since: null }, { cards: [], files: ['public/x/y.html'], why: 'the page is created by another card', since: null })
    assert.throws(() => readFileSync(join(dir, 'codex-planner-failures.log')))
    const owner = readCardPlanners(dir)[card.id]
    assert.equal(owner.submitted, false)
    assert.equal(owner.correctionRequestedAt, undefined)
    assert.match(readFileSync(join(dir, 'inbox.md'), 'utf8'), new RegExp(`WAIT \\S+ ${card.id} \\(planning\\): needs public/x/y.html — the page is created by another card`))
    assert.match(readFileSync(join(dir, 'activity.log'), 'utf8'), new RegExp(`card=${card.id} event=planner-wait`))

    // The board starts no Planner while the file is missing, and one once it exists.
    let starts = 0
    const agents = []
    const io = {
      agentList: async () => agents, agentWorkspaceOr: async () => 'w', waitForPrompt: async () => {},
      tabCreate: async () => ({ root_pane: { pane_id: 'p2' } }),
      agentStart: async ({ name, paneId }) => { starts++; agents.push({ name, pane_id: paneId, agent_status: 'idle' }) },
      deliver: async () => {}, paneClose: async () => {}, paneRead: async () => '', recordUsageStart: () => {}, recordUsageFinish: async () => {},
    }
    const run = () => runCardPlanner({ project: 'P', projectPath: dir, tasksDir: dir, boardRoot: dir, model: 'gpt-5.5', io })
    assert.equal(await run(), null)
    assert.equal(starts, 0)
    mkdirSync(join(dir, 'public', 'x'), { recursive: true })
    writeFileSync(join(dir, 'public', 'x', 'y.html'), '<p>')
    assert.deepEqual((await run())?.cards, [card.id])
    assert.equal(starts, 1)
    assert.equal(readWorkflow(dir)[card.id].waitFor, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('hkb wait on a card adds it to Blocked by', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-wait-card-'))
  try {
    const needed = createCard(dir, { title: 'Makes the page', brief: 'x' })
    const card = createCard(dir, { title: 'Edits the page', brief: 'y' })
    const r = wait(dir, card.id, `public/x/y.html, ${needed.id.toLowerCase()}`, `needs the page from ${needed.id}`)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(findCard(dir, card.id).blockedBy, [needed.id])
    assert.deepEqual(readWorkflow(dir)[card.id].waitFor.cards, [needed.id])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
