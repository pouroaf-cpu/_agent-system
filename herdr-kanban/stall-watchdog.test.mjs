import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkStalls } from './lib/stall-watchdog.mjs'
import { findCard } from './lib/cards.mjs'
import { readWorkflow, recordOperationalFailure } from './lib/workflow-state.mjs'
import { readCardPlanners } from './lib/card-planner.mjs'

const MIN = 60000
function board(t) {
  const root = mkdtempSync(join(tmpdir(), 'stall-watchdog-')), tasks = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (column, id, extra = '') => {
    mkdirSync(join(tasks, column), { recursive: true })
    writeFileSync(join(tasks, column, `${id}.md`), `# ${id} — card\n**Workflow:** card-owned\n${extra}`)
  }
  return { root, tasks, put, log: () => readFileSync(join(tasks, 'stalls.log'), 'utf8').trim().split('\n') }
}

test('a stalled card gets one automatic recovery, then Owner with a plain question; each stall is logged', t => {
  const { root, tasks, put, log } = board(t)
  put('planning', 'T-1')
  writeFileSync(join(tasks, '.card-planners.json'), JSON.stringify({ 'T-1': { assignmentId: 'a', lifecycle: 'active', paneId: 'p1', submitted: true } }))
  recordOperationalFailure(tasks, findCard(tasks, 'T-1'), 'Planner transport failed', root)
  const agents = [{ pane_id: 'p1', agent_status: 'idle' }]
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents, now: 0 }), [])
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents, now: 19 * MIN }), [], 'not before 20 minutes')

  const [first] = checkStalls({ tasksDir: tasks, agents, now: 20 * MIN })
  assert.match(first.action, /lifted the operational hold.*fresh Planner/)
  assert.equal(readWorkflow(tasks)['T-1'].operational, null)
  assert.equal(readCardPlanners(tasks)['T-1'].submitted, false, 'fresh Planner requested')
  assert.equal(findCard(tasks, 'T-1').column, 'planning')

  assert.deepEqual(checkStalls({ tasksDir: tasks, agents, now: 39 * MIN }), [], 'the recovery gets a full window')
  const [second] = checkStalls({ tasksDir: tasks, agents, now: 40 * MIN })
  assert.equal(second.action, 'moved to Owner')
  const card = findCard(tasks, 'T-1')
  assert.equal(card.column, 'owner')
  assert.match(readFileSync(card.path, 'utf8'), /Needs you: T-1 sat in Planning for 20 minutes[\s\S]*Planner transport failed[\s\S]*already ran[\s\S]*\?/)
  const lines = log()
  assert.equal(lines.length, 2)
  assert.match(lines[0], /\tT-1\tplanning\t.*Planner transport failed\tlifted the operational hold/)
  assert.match(lines[1], /\tT-1\tplanning\t.*\tmoved to Owner$/)
})

test('a working agent or a changed card file is not a stall', t => {
  const { tasks, put } = board(t)
  put('working', 'T-1')
  writeFileSync(join(tasks, '.board.json'), JSON.stringify({ 'T-1': { pane_id: 'b1' } }))
  const working = [{ pane_id: 'b1', agent_status: 'working' }]
  checkStalls({ tasksDir: tasks, agents: working, now: 0 })
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents: working, now: 60 * MIN }), [])
  // Idle from 60m; the card file changes at 70m, so 85m is only 15 quiet minutes.
  checkStalls({ tasksDir: tasks, agents: [], now: 60 * MIN })
  appendFileSync(findCard(tasks, 'T-1').path, '\nprogress note\n')
  checkStalls({ tasksDir: tasks, agents: [], now: 70 * MIN })
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents: [], now: 85 * MIN }), [])
  const [stall] = checkStalls({ tasksDir: tasks, agents: [], now: 90 * MIN })
  assert.equal(stall.action, 'moved to Owner', 'no automatic recovery applies to an idle Builder here')
})

test('Queue cards waiting on a prerequisite in Owner or still moving are allowed waits', t => {
  const { tasks, put } = board(t)
  put('owner', 'T-1')
  put('queue', 'T-2', '**Blocked by:** T-1\n')
  put('working', 'T-3')
  put('queue', 'T-4')
  put('queue', 'T-5', '**Blocked by:** T-99\n')
  writeFileSync(join(tasks, '.board.json'), JSON.stringify({ 'T-3': { pane_id: 'b3' } }))
  const agents = [{ pane_id: 'b3', agent_status: 'working' }]
  const holds = { 'T-4': 'files busy, held by T-3 — lib/a.mjs' }
  checkStalls({ tasksDir: tasks, agents, holds, now: 0 })
  const stalls = checkStalls({ tasksDir: tasks, agents, holds, now: 25 * MIN })
  assert.deepEqual(stalls.map(s => s.id), ['T-5'], 'only the card waiting on a prerequisite that does not exist')
  assert.equal(findCard(tasks, 'T-5').column, 'owner')
  assert.equal(findCard(tasks, 'T-2').column, 'queue')
  assert.equal(findCard(tasks, 'T-4').column, 'queue')
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents, holds, builderSlotsFree: 0, now: 60 * MIN }), [], 'a full Builder cap is a wait, not a stall')
})

test('a stopped Builder still stuck after T-11 recovery goes straight to Owner, hold kept', t => {
  const { root, tasks, put } = board(t)
  put('issues', 'T-1')
  recordOperationalFailure(tasks, findCard(tasks, 'T-1'), 'Session p9 is missing without a valid Builder handoff from Working', root)
  checkStalls({ tasksDir: tasks, now: 0 })
  const [stall] = checkStalls({ tasksDir: tasks, now: 20 * MIN })
  assert.equal(stall.action, 'moved to Owner')
  assert.match(readWorkflow(tasks)['T-1'].operational.reason, /Builder handoff/, 'T-11 evidence and hold are preserved')
})
