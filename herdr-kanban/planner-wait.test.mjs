import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createCard, findCard } from './lib/cards.mjs'
import { readCardPlanners, runCardPlanner, operatorRetry } from './lib/card-planner.mjs'
import { saveCardPlanners } from './lib/planner-state.mjs'
import { readWorkflow, updateWorkflow } from './lib/workflow-state.mjs'

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

// A decision is the manager's, not another Planner's: it must not count toward Owner or escalate.
test('hkb issue [decision] from Planning holds the card for the manager, uncounted and unescalated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'planner-decision-'))
  const dir = join(root, 'Proj', 'TASKS')
  try {
    mkdirSync(dir, { recursive: true })
    const config = join(root, 'board.config.json'), inbox = join(root, 'inbox.md')
    writeFileSync(config, JSON.stringify({ projectsRoot: root, projects: ['Proj'] }))
    const card = createCard(dir, { title: 'Pick a layout', brief: 'x' })
    const owners = readCardPlanners(dir)
    owners[card.id] = { assignmentId: 'a1', lifecycle: 'active', paneId: 'p1', submitted: true, revokedPaneIds: [], engine: 'codex' }
    saveCardPlanners(dir, owners)
    const r = spawnSync(process.execPath, [HKB, '--tasks', dir, '--planner-assignment', 'a1', 'issue', card.id, '[decision] one page or two? A: one page, B: two pages'],
      { encoding: 'utf8', env: { ...process.env, KANBAN_CONFIG: config, KANBAN_MANAGER_INBOX: inbox } })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(findCard(dir, card.id).column, 'planning')
    const saved = readWorkflow(dir)[card.id]
    assert.equal(saved.plannerIssues, undefined)
    assert.equal(saved.plannerEscalation, undefined)
    assert.equal(saved.waitFor.decision, true)
    assert.throws(() => readFileSync(join(dir, 'codex-planner-failures.log')))
    assert.match(readFileSync(findCard(dir, card.id).path, 'utf8'), /^Needs you: \[decision\] one page or two/m)
    assert.match(readFileSync(inbox, 'utf8'), new RegExp(`ASK Proj ${card.id} \\(planning\\): \\[decision\\] one page or two`))

    let starts = 0
    const agents = []
    const io = {
      agentList: async () => agents, agentWorkspaceOr: async () => 'w', waitForPrompt: async () => {},
      tabCreate: async () => ({ root_pane: { pane_id: 'p2' } }),
      agentStart: async ({ name, paneId }) => { starts++; agents.push({ name, pane_id: paneId, agent_status: 'idle' }) },
      deliver: async () => {}, paneClose: async () => {}, paneRead: async () => '', recordUsageStart: () => {}, recordUsageFinish: async () => {},
    }
    const run = () => runCardPlanner({ project: 'Proj', projectPath: dirname(dir), tasksDir: dir, boardRoot: root, model: 'gpt-5.5', io })
    assert.equal(await run(), null)
    assert.equal(starts, 0)
    // The manager's answer: /api/move of a decision-held Planning card runs operatorRetry.
    operatorRetry(dir, card.id, 'planning')
    assert.equal(readWorkflow(dir)[card.id].waitFor, null)
    assert.deepEqual((await run())?.cards, [card.id])
    assert.equal(starts, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('/api/move planning -> planning clears a missing-file wait and requests a Planner correction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'planner-wait-move-'))
  const dir = join(root, 'Proj', 'TASKS')
  let child
  try {
    mkdirSync(dir, { recursive: true })
    const card = createCard(dir, { title: 'Edit the missing guide', brief: 'x' })
    const owners = readCardPlanners(dir)
    owners[card.id] = { assignmentId: 'a1', lifecycle: 'active', paneId: 'p1', submitted: true, revokedPaneIds: [], engine: 'codex' }
    saveCardPlanners(dir, owners)
    updateWorkflow(dir, card.id, { waitFor: { files: ['missing.md'], cards: [], decision: false } })
    const s = createServer()
    await new Promise(resolve => s.listen(0, '127.0.0.1', resolve))
    const port = s.address().port
    await new Promise(resolve => s.close(resolve))
    const config = join(root, 'board.config.json')
    writeFileSync(config, JSON.stringify({ port, mode: 'auto', projectsRoot: root, projects: ['Proj'], maxConcurrentAgents: 0, agentPollMs: 3600000, engine: { kind: 'codex' }, models: { working: 'test', review: 'test', issues: 'test' } }))
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: new URL('.', import.meta.url),
      env: { ...process.env, KANBAN_CONFIG: config, HERDR_BIN_PATH: 'missing-herdr-for-wait-test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const base = `http://127.0.0.1:${port}`
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${base}/api/board?project=Proj`)).ok) break } catch {}
      if (i > 80 || child.exitCode !== null) throw new Error(`server did not start: ${output}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const response = await fetch(`${base}/api/move`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Proj', id: card.id, to: 'planning' }),
    })
    assert.equal(response.status, 200, JSON.stringify(await response.json()))
    assert.equal(findCard(dir, card.id).column, 'planning')
    assert.equal(readWorkflow(dir)[card.id].waitFor, null)
    assert.ok(readCardPlanners(dir)[card.id].correctionRequestedAt)
    assert.equal(readCardPlanners(dir)[card.id].submitted, false)
  } finally { child?.kill(); rmSync(root, { recursive: true, force: true }) }
})
