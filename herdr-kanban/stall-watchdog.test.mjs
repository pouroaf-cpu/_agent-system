import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkStalls, laneTimes } from './lib/stall-watchdog.mjs'
import { findCard, readBoard } from './lib/cards.mjs'
import { readWorkflow, recordOperationalFailure } from './lib/workflow-state.mjs'
import { readCardPlanners } from './lib/card-planner.mjs'

const MIN = 60000
// The clock is durable (card mtime, history, usage), so tests run at real times: every
// card file is stamped at T and each check passes now = T + minutes.
const T = Math.floor(Date.now() / 1000) * 1000 + 60 * MIN
const stamp = (path, at) => utimesSync(path, new Date(at), new Date(at))
function board(t) {
  const root = mkdtempSync(join(tmpdir(), 'stall-watchdog-')), tasks = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (column, id, extra = '') => {
    mkdirSync(join(tasks, column), { recursive: true })
    writeFileSync(join(tasks, column, `${id}.md`), `# ${id} — card\n**Workflow:** card-owned\n${extra}`)
    stamp(join(tasks, column, `${id}.md`), T)
  }
  return { root, tasks, put, log: () => readFileSync(join(tasks, 'stalls.log'), 'utf8').trim().split('\n') }
}

test('a stalled card gets one automatic recovery, then Owner with a plain question; each stall is logged', t => {
  const { root, tasks, put, log } = board(t)
  put('planning', 'T-1')
  writeFileSync(join(tasks, '.card-planners.json'), JSON.stringify({ 'T-1': { assignmentId: 'a', lifecycle: 'active', paneId: 'p1', submitted: true } }))
  recordOperationalFailure(tasks, findCard(tasks, 'T-1'), 'Planner transport failed', root)
  const agents = [{ pane_id: 'p1', agent_status: 'idle' }]
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents, now: T }), [])
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents, now: T + 19 * MIN }), [], 'not before 20 minutes')

  const [first] = checkStalls({ tasksDir: tasks, agents, now: T + 20 * MIN })
  assert.match(first.action, /lifted the operational hold.*fresh Planner/)
  assert.equal(readWorkflow(tasks)['T-1'].operational, null)
  assert.equal(readCardPlanners(tasks)['T-1'].submitted, false, 'fresh Planner requested')
  assert.equal(findCard(tasks, 'T-1').column, 'planning')

  assert.deepEqual(checkStalls({ tasksDir: tasks, agents, now: T + 39 * MIN }), [], 'the recovery gets a full window')
  const [second] = checkStalls({ tasksDir: tasks, agents, now: T + 40 * MIN })
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
  checkStalls({ tasksDir: tasks, agents: working, now: T })
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents: working, now: T + 60 * MIN }), [])
  // Idle from 60m; the card file changes at 70m, so 85m is only 15 quiet minutes.
  checkStalls({ tasksDir: tasks, agents: [], now: T + 60 * MIN })
  appendFileSync(findCard(tasks, 'T-1').path, '\nprogress note\n')
  stamp(findCard(tasks, 'T-1').path, T + 70 * MIN)
  checkStalls({ tasksDir: tasks, agents: [], now: T + 70 * MIN })
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents: [], now: T + 85 * MIN }), [])
  const [stall] = checkStalls({ tasksDir: tasks, agents: [], now: T + 90 * MIN })
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
  put('queue', 'T-6')
  const holds = { 'T-4': 'files busy, held by T-3 — lib/a.mjs', 'T-6': 'installing dependencies in C:\\project' }
  checkStalls({ tasksDir: tasks, agents, holds, now: T })
  const stalls = checkStalls({ tasksDir: tasks, agents, holds, now: T + 25 * MIN })
  assert.deepEqual(stalls.map(s => s.id), ['T-5'], 'only the card waiting on a prerequisite that does not exist')
  assert.equal(findCard(tasks, 'T-5').column, 'owner')
  assert.equal(findCard(tasks, 'T-2').column, 'queue')
  assert.equal(findCard(tasks, 'T-4').column, 'queue')
  assert.equal(findCard(tasks, 'T-6').column, 'queue', 'a background dependency install is a wait')
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents, holds, builderSlotsFree: 0, now: T + 60 * MIN }), [], 'a full Builder cap is a wait, not a stall')
})

test('the low-disk pause is a wait and restarts every stall window', t => {
  const { tasks, put } = board(t)
  put('planning', 'T-1')
  checkStalls({ tasksDir: tasks, now: T })
  assert.deepEqual(checkStalls({ tasksDir: tasks, paused: true, now: T + 60 * MIN }), [])
  assert.deepEqual(checkStalls({ tasksDir: tasks, now: T + 70 * MIN }), [])
  assert.equal(findCard(tasks, 'T-1').column, 'planning')
})

test('a stopped Builder still stuck after T-11 recovery goes straight to Owner, hold kept', t => {
  const { root, tasks, put } = board(t)
  put('issues', 'T-1')
  recordOperationalFailure(tasks, findCard(tasks, 'T-1'), 'Session p9 is missing without a valid Builder handoff from Working', root)
  checkStalls({ tasksDir: tasks, now: T })
  const [stall] = checkStalls({ tasksDir: tasks, now: T + 20 * MIN })
  assert.equal(stall.action, 'moved to Owner')
  assert.match(readWorkflow(tasks)['T-1'].operational.reason, /Builder handoff/, 'T-11 evidence and hold are preserved')
})

test('cards queued behind a stalled prerequisite stay queued; only the prerequisite escalates; legacy Completed waits', t => {
  const { tasks, put } = board(t)
  put('planning', 'T-41')
  put('queue', 'T-42', '**Blocked by:** T-41\n')
  put('completed', 'T-25')
  checkStalls({ tasksDir: tasks, agents: [], now: T })
  const stalls = checkStalls({ tasksDir: tasks, agents: [], now: T + 60 * MIN })
  assert.deepEqual(stalls.map(s => s.id), ['T-41'])
  assert.equal(findCard(tasks, 'T-42').column, 'queue')
  assert.equal(findCard(tasks, 'T-25').column, 'completed')
})

test('with nothing recorded, the Owner note says what the board observed (Healthypets legacy cards)', t => {
  const { tasks } = board(t)
  mkdirSync(join(tasks, 'planning'), { recursive: true })
  writeFileSync(join(tasks, 'planning', 'T-01.md'), '# T-01 — legacy card\n\n## Goal\n\nOld TASKS.md entry.\n')
  stamp(join(tasks, 'planning', 'T-01.md'), T)
  checkStalls({ tasksDir: tasks, agents: [], now: T })
  // Never started, nothing recorded: three windows before Owner (Injectbuddy I193).
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents: [], now: T + 20 * MIN }), [])
  const [stall] = checkStalls({ tasksDir: tasks, agents: [], now: T + 60 * MIN })
  assert.equal(stall.action, 'moved to Owner')
  const text = readFileSync(findCard(tasks, 'T-01').path, 'utf8')
  assert.match(text, /Last hold\/error: none recorded; the board observed that no Planner was ever started for this card \(legacy card format, not card-owned\)\./)
})

const history = (tasks, id, entries) => {
  mkdirSync(join(tasks, '.history'), { recursive: true })
  writeFileSync(join(tasks, '.history', `${id}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n')
}

test('a board restart does not reset the stall clock (Tradeflow T-41)', async t => {
  const { tasks, put } = board(t)
  put('working', 'T-1')
  history(tasks, 'T-1', [{ event: 'transition', from: 'queue', to: 'working', at: new Date(T + 5 * MIN).toISOString() }])
  writeFileSync(join(tasks, '.board.json'), JSON.stringify({ 'T-1': { pane_id: 'b1' } }))
  // Last seen working at 10m by the running board...
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents: [{ pane_id: 'b1', agent_status: 'working' }], now: T + 10 * MIN }), [])
  // ...then the board restarts: a fresh module has no memory, yet the clock still runs from 10m.
  const restarted = await import('./lib/stall-watchdog.mjs?restart')
  assert.deepEqual(restarted.checkStalls({ tasksDir: tasks, agents: [], now: T + 29 * MIN }), [])
  const [stall] = restarted.checkStalls({ tasksDir: tasks, agents: [], now: T + 30 * MIN })
  assert.equal(stall.id, 'T-1')
  assert.match(stall.reason, /no change for 20m/)
})

test('a card idle since before the restart is caught on the first check; agent start/finish and lane entry count as activity', t => {
  const { tasks, put } = board(t)
  put('planning', 'T-1')
  put('review', 'T-2')
  history(tasks, 'T-2', [{ event: 'transition', from: 'completed', to: 'review', at: new Date(T + 30 * MIN).toISOString() }])
  put('queue', 'T-3')
  writeFileSync(join(tasks, '.request-usage.json'), JSON.stringify({ runs: {
    a: { cardIds: ['T-3'], role: 'builder', start: { at: new Date(T + 10 * MIN).toISOString() }, finish: { at: new Date(T + 35 * MIN).toISOString() } },
  } }))
  // First check ever, 40 minutes after T: only T-1 has been quiet for 20 minutes.
  // T-1 never had a Planner, so it waits three windows (Injectbuddy I193).
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents: [], now: T + 40 * MIN }).map(s => s.id), [])
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents: [], now: T + 50 * MIN }).map(s => s.id), ['T-2'])
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents: [], now: T + 55 * MIN }).map(s => s.id), ['T-3'])
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents: [], now: T + 60 * MIN }).map(s => s.id), ['T-1'])
})

test('lane times: since from the lane entry (else file mtime); agentActive only for a working bound agent', t => {
  const { tasks, put } = board(t)
  put('working', 'T-1')
  history(tasks, 'T-1', [
    { event: 'transition', from: 'planning', to: 'queue', at: new Date(T - 20 * MIN).toISOString() },
    { event: 'transition', from: 'queue', to: 'working', at: new Date(T - 10 * MIN).toISOString() },
  ])
  put('review', 'T-2')
  put('planning', 'T-3')
  put('owner', 'T-4')
  writeFileSync(join(tasks, '.board.json'), JSON.stringify({ 'T-1': { pane_id: 'b1' } }))
  writeFileSync(join(tasks, '.card-planners.json'), JSON.stringify({ 'T-3': { lifecycle: 'active', paneId: 'p3' } }))
  const claims = [{ tasksDir: tasks, cards: ['T-2'], paneId: 'r1' }]
  const agents = [{ pane_id: 'b1', agent_status: 'working' }, { pane_id: 'r1', agent_status: 'idle' }]
  const times = laneTimes({ tasksDir: tasks, board: readBoard(tasks), agents, claims })
  assert.deepEqual(times, {
    'T-1': { since: new Date(T - 10 * MIN).toISOString(), agentActive: true, agentRole: 'builder' },
    'T-2': { since: new Date(T).toISOString(), agentActive: false, agentRole: 'reviewer' },
    'T-3': { since: new Date(T).toISOString(), agentActive: false, agentRole: null },
  }, 'Owner cards are not timed; a Planner pane that is gone is no agent')
})
