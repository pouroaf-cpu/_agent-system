import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, utimesSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkStalls, laneTimes, recordHealthyPoll } from './lib/stall-watchdog.mjs'
import { findCard, readBoard } from './lib/cards.mjs'
import { autoSpawn, holdsFor } from './lib/autospawn.mjs'
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
  put('queue', 'T-7')
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents, holds: { ...holds, 'T-7': 'slots full' }, builderSlotsFree: 1, now: T + 90 * MIN }), [], "the scheduler's 'slots full' is a wait even when a slot freed since")
  assert.equal(findCard(tasks, 'T-7').column, 'queue')
})

test('a Planned card whose plan check waits on a live card\'s files is a wait (Tradeflow TF136)', t => {
  const { tasks, put } = board(t)
  put('queue', 'T-1')
  put('backlog', 'T-2') // Planned lives in backlog/
  put('backlog', 'T-3')
  const holds = { 'T-2': 'files busy, held by T-1 — app/page.tsx', 'T-3': 'files busy, held by T-99 — app/page.tsx' }
  checkStalls({ tasksDir: tasks, holds, now: T })
  const stalls = checkStalls({ tasksDir: tasks, holds, now: T + 25 * MIN })
  assert.deepEqual(stalls.map(s => s.id).filter(id => id !== 'T-1'), ['T-3'], 'a holder that no longer exists is still a stall')
  assert.equal(findCard(tasks, 'T-2').column, 'planned')
})

test('right after a restart, before holds are known, a Planned card is not a stall (Injectbuddy I701)', t => {
  const { tasks, put } = board(t)
  put('backlog', 'T-1')
  assert.deepEqual(checkStalls({ tasksDir: tasks, holdsKnown: false, now: T + 90 * MIN }), [])
  assert.equal(checkStalls({ tasksDir: tasks, now: T + 111 * MIN }).length, 1, 'once holds are known, an unexplained wait is a stall')
})

test('file holds survive passes that never try a Planned or Queue card (Injectbuddy I701)', async t => {
  const { root, tasks, put } = board(t)
  const scope = '## Files\n- `public/legacy/**/index.html`\n'
  put('working', 'T-1', scope)
  put('backlog', 'T-2', scope)
  put('queue', 'T-3', '**Blocked by:** T-1\n## Files\n- `other.js`\n')
  put('queue', 'T-4', '**Blocked by:** T-1\n## Files\n- `another.js`\n')
  put('queue', 'T-5', '## Files\n- `public/legacy/old/index.html`\n')
  writeFileSync(join(tasks, '.board-worktrees.json'), JSON.stringify({ 'T-1': {
    state: 'building', integrationWorkspace: root, files: [join(root, 'public/legacy/**/index.html').replaceAll('\\', '/').toLowerCase()],
  } }))
  writeFileSync(join(tasks, '.board.json'), JSON.stringify({ 'T-1': { pane_id: 'b1' } }))
  const agents = [{ pane_id: 'b1', agent_status: 'working' }]
  const args = { project: root, projectPath: root, tasksDir: tasks, max: 5, agents, onlyIds: ['T-3', 'T-4'], spawn: () => assert.fail('blocked queue must not spawn') }
  await autoSpawn(args)
  for (const id of ['T-2', 'T-5']) assert.match(holdsFor(root)[id], /^files busy, held by T-1/)
  await autoSpawn({ ...args, onlyIds: ['T-99'] }) // no selected cards: the scheduler clears its pass snapshot
  const holds = holdsFor(root)
  for (const id of ['T-2', 'T-5']) assert.match(holds[id], /^files busy, held by T-1/)
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents, holds, builderSlotsFree: 4, now: T + 25 * MIN }), [])
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents, holds: {}, builderSlotsFree: 4, now: T + 90 * MIN }), [], 'watchdog independently checks current file locks')
  assert.equal(findCard(tasks, 'T-2').column, 'planned')
  assert.equal(findCard(tasks, 'T-5').column, 'queue')
  mkdirSync(join(tasks, 'archive'), { recursive: true })
  renameSync(findCard(tasks, 'T-1').path, join(tasks, 'archive', 'T-1.md'))
  assert.equal(holdsFor(root)['T-2'], undefined, 'an archived holder releases the wait')
  assert.equal(holdsFor(root)['T-5'], undefined)
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
  const agents = [{ pane_id: 'b1', name: 'Builder T-1', agent_status: 'working' }, { pane_id: 'r1', name: 'Reviewer', agent_status: 'idle' }]
  const times = laneTimes({ tasksDir: tasks, board: readBoard(tasks), agents, claims })
  assert.deepEqual(times, {
    'T-1': { since: new Date(T - 10 * MIN).toISOString(), agentActive: true, agentRole: 'builder', agentName: 'Builder T-1' },
    'T-2': { since: new Date(T).toISOString(), agentActive: false, agentRole: 'reviewer', agentName: 'Reviewer' },
    'T-3': { since: new Date(T).toISOString(), agentActive: false, agentRole: null, agentName: null },
  }, 'Owner cards are not timed; a Planner pane that is gone is no agent')
})

test('time spent paused is not a stall: Start restarts the clock (Tradeflow, 15 cards to Owner on unpause)', t => {
  const { tasks, put } = board(t)
  put('queue', 'T-1')
  const resumedAt = new Date(T + 7 * 60 * MIN).toISOString()
  assert.deepEqual(checkStalls({ tasksDir: tasks, resumedAt, now: T + 7 * 60 * MIN + 19 * MIN }), [], 'within 20 minutes of Start')
  const [stall] = checkStalls({ tasksDir: tasks, resumedAt, now: T + 7 * 60 * MIN + 61 * MIN })
  assert.match(stall.reason, /no change for 61m/)
})

test('an agent appending to the card does not buy another retry in the same lane visit (Tradeflow T-38 Review loop)', t => {
  const { root, tasks, put } = board(t)
  put('review', 'T-1')
  recordOperationalFailure(tasks, findCard(tasks, 'T-1'), 'Reviewer ended without a verdict', root)
  const [first] = checkStalls({ tasksDir: tasks, now: T + 20 * MIN })
  assert.match(first.action, /lifted the operational hold/)
  const path = findCard(tasks, 'T-1').path
  appendFileSync(path, '\n## Reviewer evidence\nAC5 FAIL\n')
  stamp(path, T + 25 * MIN)
  recordOperationalFailure(tasks, findCard(tasks, 'T-1'), 'Reviewer ended without a verdict again', root)
  const [second] = checkStalls({ tasksDir: tasks, now: T + 46 * MIN })
  assert.equal(second.action, 'sent to the Planner')
  assert.equal(findCard(tasks, 'T-1').column, 'planning')
})

test('right after a restart, before holds are known, a queued card is not a stall (Injectbuddy I211)', t => {
  const { tasks, put } = board(t)
  put('queue', 'T-1', '**Blocked by:** T-9\n')
  put('archive', 'T-9')
  assert.deepEqual(checkStalls({ tasksDir: tasks, holdsKnown: false, now: T + 90 * MIN }), [])
  assert.equal(checkStalls({ tasksDir: tasks, now: T + 111 * MIN }).length, 1, 'once holds are known, an unexplained wait is a stall')
})

// Audit 2026-09-26 finding 3: herdr down, host asleep, board down or a global pause
// leaves no poll that could act. That gap is not a stall (Tradeflow 2026-09-24: 18 cards to Owner).
test('time the board could not act is not a stall; the clock restarts when polling resumes', t => {
  const { tasks, put } = board(t)
  put('queue', 'T-1')
  writeFileSync(join(tasks, '.workflow-state.json'), JSON.stringify({ 'T-1': { builder: { pane_id: 'old' } } }))
  const poll = m => checkStalls({ tasksDir: tasks, builderSlotsFree: 4, gapEndedAt: recordHealthyPoll(tasks, T + m * MIN), now: T + m * MIN })
  assert.deepEqual(poll(5), [])
  // No healthy poll from T+5 to T+185 (herdr down: pollProject returns before the watchdog).
  assert.deepEqual(poll(185), [], 'the first poll after the gap is not a stall')
  assert.equal(findCard(tasks, 'T-1').column, 'queue')
  for (let m = 186; m < 205; m++) assert.deepEqual(poll(m), [], `still inside the fresh window at +${m}m`)
  const [stall] = poll(205)
  assert.equal(stall.action, 'moved to Owner', '20 minutes of healthy polling still escalates as before')
  assert.match(stall.reason, /no change for 20m/)
})
test('Planning cards wait their turn while the one-per-poll Planner pass keeps starting others (Injectbuddy, 2026-10-02)', t => {
  const { tasks, put } = board(t)
  put('planning', 'T-1'); put('planning', 'T-2')
  const now = T + 70 * MIN // past the never-started grace of three windows
  writeFileSync(join(tasks, '.card-planners.json'), JSON.stringify({ 'T-2': { paneId: 'p2', createdAt: new Date(now - 5 * MIN).toISOString() } }))
  assert.deepEqual(checkStalls({ tasksDir: tasks, agents: [{ pane_id: 'p2', agent_status: 'working' }], plannerSlotsFree: 3, now }).map(s => s.id), [], 'a Planner started 5 min ago: T-1 is queued')
  // The card's own recent Planner, gone without a pane, is not its turn.
  assert.deepEqual(checkStalls({ tasksDir: tasks, plannerSlotsFree: 3, now: now + 61 * MIN }).map(s => s.id).sort(), ['T-1', 'T-2'], 'no Planner started for an hour: both are stuck')
})

test('an exited headless Planner is reported as no longer running by the stall watchdog', t => {
  const { tasks, put } = board(t)
  put('planning', 'T-1')
  writeFileSync(join(tasks, '.card-planners.json'), JSON.stringify({ 'T-1': { assignmentId: 'a', lifecycle: 'active', paneId: 'headless-proof', submitted: true } }))
  const agents = [{ pane_id: 'headless-proof', agent_status: 'done', backend: 'headless' }]
  checkStalls({ tasksDir: tasks, agents, now: T })
  const stalls = checkStalls({ tasksDir: tasks, agents, now: T + 20 * MIN })
  assert.equal(stalls.length, 1)
  checkStalls({ tasksDir: tasks, agents, now: T + 40 * MIN })
  assert.match(readFileSync(findCard(tasks, 'T-1').path, 'utf8'), /Planner headless-proof is no longer running and did not hand off/)
})
