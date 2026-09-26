// node --test test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync, utimesSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { readBoard, moveCard, parseCard, createCard, columnByKey, setAutoReview, COLUMNS, findCard, isParked, appendBuildAttempt, appendReviewPass, canArchive, hasCurrentReviewPass, currentReviewDecision, appendDirtySnapshot, dirtySnapshotForCard } from './lib/cards.mjs'
import { bind, readBindings, unbind, liveBindings, reap } from './lib/bindings.mjs'
import { promoteAutoReview, promotePlanned, routeReviewVerdicts, missionIssueHandoff, slotsFree, reviewerRunning, spawnReviewer, spawnIssuesSweeper, autoSpawn, autoReview, closeFinished, unmetBlockers, preflightBlocks, startHoldReason, holdsFor } from './lib/autospawn.mjs'
import { workerPrompt, reviewerPrompt, issuesSweeperPrompt, agentName, isBoardAgent, paneLabel } from './lib/prompt.mjs'
import { recordFailure, coolingDown, attemptsFor, clearRetries } from './lib/retries.mjs'
import { findWorkspace, agentWorkspace, parseAgentList, agentStartArgs, assertManagedModel, sessionServerArgs } from './lib/herdr.mjs'
import { recordSpawn, recordSpawnFailure, breakerState, resetBreaker } from './lib/breaker.mjs'
import { computeReviewPlan, cardFiles, cardEstimates, REVIEW_BATCH_CAP_MINUTES } from './lib/review-plan.mjs'
import { deliverWith } from './lib/spawn.mjs'
import { parseManagerTasks } from './lib/manager-tasks.mjs'
import { isHardHold, notifyManagerException, resolveManagerException, ownerAgeing } from './lib/manager-alerts.mjs'
import { latestTokenSnapshot, recordUsageFinish, recordUsageStart, tokenSnapshots, usageDelta, usageSummary } from './lib/request-usage.mjs'

const CARD = `# T-04 — Money calc pages fail mobile LCP (TRT 4.23s / Sema 4.26s)

**Priority** 7/10 · **Status:** open — partly done · **Surface:** pwa/mobile

Migrated from root TASKS.md.
`

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hkb-'))
  const tasks = join(root, 'TASKS')
  for (const d of ['backlog', 'queue', 'archive']) mkdirSync(join(tasks, d), { recursive: true })
  writeFileSync(join(tasks, 'queue', 'T-04-calc-mobile-lcp.md'), CARD)
  writeFileSync(join(tasks, 'backlog', 'T-17-vitals.md'), '# T-17 — Vitals widget\n\n**Priority** 8/10\n')
  writeFileSync(join(tasks, 'backlog', 'README.md'), 'not a card')
  writeFileSync(join(tasks, 'backlog', 'PROJECT-WORKSPACES.md'), 'not a card')
  writeFileSync(join(tasks, 'TASK-TEMPLATE.md'), 'not a card either')
  return { root, tasks }
}

test('parses title, id, priority, status and surface out of the heading block', () => {
  const { tasks, root } = fixture()
  const card = parseCard(join(tasks, 'queue', 'T-04-calc-mobile-lcp.md'), 'queue')
  assert.equal(card.id, 'T-04')
  assert.equal(card.title, 'Money calc pages fail mobile LCP (TRT 4.23s / Sema 4.26s)')
  assert.equal(card.priority, 7)
  assert.equal(card.status, 'open — partly done')
  assert.equal(card.surface, 'pwa/mobile')
  assert.equal(card.workspace, '.')

  // real cards carry bold inside the metadata line; the board renders text, not markdown
  writeFileSync(join(tasks, 'queue', 'T-30-bold.md'),
    '# T-30 — Bold status\n\n**Priority** 8/10 · **Status:** open — **operator action** · **Surface:** both\n')
  assert.equal(parseCard(join(tasks, 'queue', 'T-30-bold.md'), 'queue').status, 'open — operator action')
  rmSync(root, { recursive: true, force: true })
})

test('README and TASK-TEMPLATE are not cards, and missing columns read as empty', () => {
  const { tasks, root } = fixture()
  const board = readBoard(tasks)
  assert.equal(board.planned.length, 1, 'README.md must not appear as a card')
  assert.equal(board.queue.length, 1)
  assert.deepEqual(board.working, [], 'a folder that does not exist yet reads as an empty column')
  rmSync(root, { recursive: true, force: true })
})

test('moving a card moves the file and creates the destination folder', () => {
  const { tasks, root } = fixture()
  const moved = moveCard(tasks, 'T-04', 'working')
  assert.equal(moved.column, 'working')
  assert.ok(existsSync(join(tasks, 'working', 'T-04-calc-mobile-lcp.md')))
  assert.ok(!existsSync(join(tasks, 'queue', 'T-04-calc-mobile-lcp.md')))
  assert.equal(readBoard(tasks).working.length, 1)
  rmSync(root, { recursive: true, force: true })
})

test('moving to an unknown column or an unknown card throws instead of silently doing nothing', () => {
  const { tasks, root } = fixture()
  assert.throws(() => moveCard(tasks, 'T-04', 'nowhere'), /unknown column/)
  assert.throws(() => moveCard(tasks, 'T-99', 'working'), /unknown card/)
  rmSync(root, { recursive: true, force: true })
})

test('a dead pane does not hold a concurrency slot', () => {
  const { tasks, root } = fixture()
  bind(tasks, 'T-04', { pane_id: 'w9:p7', model: 'sonnet' })
  bind(tasks, 'T-17', { pane_id: 'w9:p8', model: 'sonnet' })
  assert.equal(Object.keys(readBindings(tasks)).length, 2)

  const agents = [{ pane_id: 'w9:p7', agent_status: 'working' }] // p8 crashed
  assert.deepEqual(Object.keys(liveBindings(tasks, agents)), ['T-04'])
  assert.deepEqual(reap(tasks, agents), ['T-17'])
  assert.deepEqual(Object.keys(readBindings(tasks)), ['T-04'])

  unbind(tasks, 'T-04')
  assert.deepEqual(readBindings(tasks), {})
  rmSync(root, { recursive: true, force: true })
})

test('auto-review is stored in the card, and toggling it survives a re-read', () => {
  const { tasks, root } = fixture()
  assert.equal(readBoard(tasks).queue[0].autoReview, false, 'off unless the card says otherwise')

  setAutoReview(tasks, 'T-04', true)
  assert.equal(readBoard(tasks).queue[0].autoReview, true)
  assert.match(readFileSync(join(tasks, 'queue', 'T-04-calc-mobile-lcp.md'), 'utf8'), /\*\*Auto-review:\*\* yes/)

  setAutoReview(tasks, 'T-04', false)
  assert.equal(readBoard(tasks).queue[0].autoReview, false, 'toggling off must not leave a stale yes')

  const text = readFileSync(join(tasks, 'queue', 'T-04-calc-mobile-lcp.md'), 'utf8')
  assert.equal(text, CARD, 'on then off must leave the card byte-identical, not a marker saying no')
  rmSync(root, { recursive: true, force: true })
})

test('only auto-review cards are promoted out of Completed', () => {
  const { tasks, root } = fixture()
  mkdirSync(join(tasks, 'completed'), { recursive: true })
  writeFileSync(join(tasks, 'completed', 'T-20-auto.md'), '# T-20 — auto\n\n**Auto-review:** yes\n')
  writeFileSync(join(tasks, 'completed', 'T-21-manual.md'), '# T-21 — manual\n')

  assert.deepEqual(promoteAutoReview(tasks), ['T-20'])
  const board = readBoard(tasks)
  assert.deepEqual(board.review.map((c) => c.id), ['T-20'])
  assert.deepEqual(board.completed.map((c) => c.id), ['T-21'], 'a card without the flag waits for you')
  rmSync(root, { recursive: true, force: true })
})

test('free slots never display below zero while a project is paused', () => {
  const { tasks, root } = fixture()
  bind(tasks, 'T-04', { pane_id: 'w9:p7', model: 'sonnet' })
  assert.equal(slotsFree({ tasksDir: tasks, agents: [{ pane_id: 'w9:p7', agent_status: 'working' }], max: 0 }), 0)
  rmSync(root, { recursive: true, force: true })
})

test('audit templates create evidence-gated cards directly in Review', () => {
  const { tasks, root } = fixture()
  assert.throws(() => createCard(tasks, { title: 'Design audit', brief: 'Audit /calculator', audit: 'design' }), /require exact tools/i)
  const card = createCard(tasks, {
    title: 'Design audit', brief: 'Audit /calculator', workspace: 'TASKS/workspaces/webapp', audit: 'design', tools: 'browser automation MCP',
  })
  const text = readFileSync(card.path, 'utf8')
  assert.equal(card.column, 'review')
  assert.equal(card.audit, 'design')
  assert.equal(card.workspace, 'TASKS/workspaces/webapp')
  assert.match(text, /390px, 768px, and 1440px/)
  assert.match(text, /scrollWidth.*clientWidth/)
  assert.match(text, /Status: CLEAR, FINDINGS, or INCOMPLETE/)
  rmSync(root, { recursive: true, force: true })
})

test('trivial mission cards may complete without independent review', () => {
  const { tasks, root } = fixture()
  mkdirSync(join(tasks, 'completed'), { recursive: true })
  writeFileSync(join(tasks, 'completed', 'T-20-trivial.md'), '# T-20 — trivial\n\n**Mission:** CURRENT\n**Auto-review:** yes\n**Trivial:** yes\n')

  assert.deepEqual(promoteAutoReview(tasks), [])
  const board = readBoard(tasks)
  assert.deepEqual(board.completed.map((c) => c.id), ['T-20'])
  assert.deepEqual(board.archive, [])
  rmSync(root, { recursive: true, force: true })
})

test('the concurrency cap counts only panes herdr still lists', () => {
  const { tasks, root } = fixture()
  bind(tasks, 'T-04', { pane_id: 'w9:p7' })
  bind(tasks, 'T-17', { pane_id: 'w9:p8' })

  const both = [{ pane_id: 'w9:p7' }, { pane_id: 'w9:p8' }]
  assert.equal(slotsFree({ tasksDir: tasks, agents: both, max: 3 }), 1)
  assert.equal(slotsFree({ tasksDir: tasks, agents: both, max: 2 }), 0, 'cap reached')
  // p8 crashed: its slot must come back, not stay held by the stale binding
  assert.equal(slotsFree({ tasksDir: tasks, agents: [{ pane_id: 'w9:p7' }], max: 2 }), 1)
  rmSync(root, { recursive: true, force: true })
})

test('the operator ask is read back off the card, newest wins', () => {
  const { tasks, root } = fixture()
  const file = join(tasks, 'queue', 'T-04-calc-mobile-lcp.md')

  assert.equal(readBoard(tasks).queue[0].ask, null, 'a card nobody has handed back has no ask')

  appendFileSync(file, '\n\n---\n\n**Kicked back** 2026-08-10T01:00:00Z\n\nfailed at 390px\n')
  let card = readBoard(tasks).queue[0]
  assert.equal(card.ask.kind, 'Kicked back')
  assert.equal(card.ask.text, 'failed at 390px')

  appendFileSync(file, '\n\n---\n\n**Needs you** 2026-08-10T02:00:00Z\n\nneeds the production database URL\n')
  card = readBoard(tasks).queue[0]
  assert.equal(card.ask.kind, 'Needs you', 'the latest handover is the one shown')
  assert.equal(card.ask.text, 'needs the production database URL')
  rmSync(root, { recursive: true, force: true })
})

test('review rounds are counted from the card, so the loop cannot run forever', () => {
  const { tasks, root } = fixture()
  const file = join(tasks, 'queue', 'T-04-calc-mobile-lcp.md')
  assert.equal(readBoard(tasks).queue[0].reviewRounds, 0)

  appendFileSync(file, '\n\n---\n\n**Review feedback** 2026-08-10T01:00:00Z\n\ncriterion 2 fails at 390px\n')
  let card = readBoard(tasks).queue[0]
  assert.equal(card.reviewRounds, 1)
  assert.equal(card.ask.kind, 'Review feedback', 'the builder sees the feedback as its brief')
  assert.equal(card.ask.text, 'criterion 2 fails at 390px')

  appendFileSync(file, '\n\n---\n\n**Review feedback** 2026-08-10T02:00:00Z\n\nstill fails\n')
  assert.equal(readBoard(tasks).queue[0].reviewRounds, 2)
  rmSync(root, { recursive: true, force: true })
})

test('the reviewer prompt stays inside card-listed files and one proportional check', () => {
  const cards = [{ id: 'T-04', title: 'x', path: 'C:\\p\\TASKS\\review\\T-04-x.md' }]
  const text = reviewerPrompt({ cards, projectPath: 'C:\\p', boardRoot: 'C:\\board' })
  assert.ok(text.includes('pass T-04'), 'passes go through hkb pass so reviewer evidence is written')
  assert.ok(text.includes('rework T-04'), 'failures use hkb rework')
  assert.match(text, /Only planning errors return to Planner; implementation errors return to the responsible Builder/)
  assert.match(text, /Read .*REVIEWER\.md.*focused briefings.*mandatory project\/safety/i)
  assert.match(text, /one proportional check type/i)
  assert.doesNotMatch(text, /ORCHESTRATION\.md|CLAUDE\.md|browser behaviour|journal step/i)
  assert.match(text, /Chrome navigation.*checks are allowed/i)
  assert.ok(!/\n/.test(text))
})

test('audit cards use the evidence-gated Auditor prompt and status-aware handoff', () => {
  const cards = [{ id: 'T-18', title: 'Design audit', audit: 'design', path: 'C:\\p\\TASKS\\review\\T-18-audit-design.md' }]
  const text = reviewerPrompt({ cards, projectPath: 'C:\\p', boardRoot: 'C:\\board' })
  assert.match(text, /AUDITOR-CARD-WORKFLOW\.md/)
  assert.match(text, /missing tooling or evidence is INCOMPLETE, never CLEAR/i)
  assert.match(text, /audit <ID>/)
  assert.match(text, /FINDINGS goes to the responsible Planner/)
  assert.doesNotMatch(text, /pass <ID>|rework <ID>/)
})

test('the worker prompt stays inside the card scope and one proportional check', () => {
  const card = { id: 'T-04', title: 'x', workspace: 'TASKS/workspaces/android', path: 'C:\\p\\TASKS\\queue\\T-04-x.md' }
  const text = workerPrompt({ card, projectPath: 'C:\\p', boardRoot: 'C:\\board' })
  assert.match(text, /Read .*BUILDER\.md.*exact listed files/i)
  assert.match(text, /one proportional check type/i)
  assert.match(text, /Rerun the same check after fixing implementation, setup, or harness errors/i)
  assert.match(text, /Stop after three identical unresolved failures/i)
  assert.match(text, /login:false.*never prefix bare -NoProfile/)
  assert.match(text, /Workspace root: C:\/p\/TASKS\/workspaces\/android/i)
  assert.match(text, /git -C '?C:\/p\/TASKS\/workspaces\/android/i)
  assert.doesNotMatch(text, /ORCHESTRATION\.md|CLAUDE\.md|browser behaviour|journal step/i)
  assert.match(text, /Browser checks are allowed only when explicitly required by the card/i)
  assert.match(text, /stage only the exact implementation files/i)
  assert.match(text, /Never push/i)
  assert.ok(text.indexOf('create one local commit') < text.indexOf('done T-04'), 'the commit precedes done')
  assert.match(text, /leave the work uncommitted and use issue or owner/i)
  assert.match(text, /stop immediately/i)
})

test('a live card wins over an archived one with the same id, and two live ones are an error', () => {
  const { tasks, root } = fixture()
  // real repos reuse task numbers over time
  writeFileSync(join(tasks, 'archive', 'T-04-old-thing.md'), '# T-04 — An older, archived T-04\n')

  const found = findCard(tasks, 'T-04')
  assert.equal(found.column, 'queue', 'the archived copy must never shadow the live one')
  assert.equal(found.file, 'T-04-calc-mobile-lcp.md')

  mkdirSync(join(tasks, 'issues'), { recursive: true })
  writeFileSync(join(tasks, 'issues', 'T-04-duplicate.md'), '# T-04 — A second live T-04\n')
  assert.throws(() => findCard(tasks, 'T-04'), /ambiguous/,
    'two live cards sharing an id must not be resolved by luck')
  rmSync(root, { recursive: true, force: true })
})

test('a card that fails to start is retried twice, then parked in Issues', () => {
  const { tasks, root } = fixture()
  const id = 'T-04'

  // attempts 1 and 2 keep it in the run
  let r = recordFailure(tasks, id, 1000)
  assert.equal(r.attempts, 1)
  assert.ok(coolingDown(tasks, id, 1000), 'it waits before the next go')
  assert.ok(!coolingDown(tasks, id, 1000 + 20000), 'and is eligible once the backoff passes')

  r = recordFailure(tasks, id, 100000)
  assert.equal(r.attempts, 2)
  assert.equal(attemptsFor(tasks, id), 2)

  // the third is the one that gives up
  r = recordFailure(tasks, id, 200000)
  assert.equal(r.attempts, 3, 'three strikes, then it belongs on the board')

  clearRetries(tasks, id)
  assert.equal(attemptsFor(tasks, id), 0, 'a successful start wipes the history')
  rmSync(root, { recursive: true, force: true })
})

test('a booting pane keeps its slot, but not forever', () => {
  const { tasks, root } = fixture()
  const now = 1000000

  // provisional claim taken the instant the tab exists, before the agent boots
  bind(tasks, 'T-04', { pane_id: 'w9:p7', spawning: true, started: new Date(now).toISOString() })
  assert.equal(slotsFree({ tasksDir: tasks, agents: [], max: 3, now: now + 60000 }), 2,
    'a pane whose agent has not booted yet still holds its slot')
  assert.equal(slotsFree({ tasksDir: tasks, agents: [], max: 3, now: now + 600000 }), 3,
    'once the grace period lapses the slot comes back')
  assert.deepEqual(reap(tasks, [], now + 60000), [], 'and is not reaped while it is still booting')

  // a server that died mid-spawn must not leak the slot indefinitely
  assert.deepEqual(reap(tasks, [], now + 600000), ['T-04'])
  assert.deepEqual(readBindings(tasks), {})
  rmSync(root, { recursive: true, force: true })
})

test('backoff grows, so three attempts are not spent in one polling tick', () => {
  const { tasks, root } = fixture()
  const first = recordFailure(tasks, 'T-04', 0).nextAt
  const second = recordFailure(tasks, 'T-04', 0).nextAt
  assert.ok(second > first, `second wait (${second}) must exceed the first (${first})`)
  assert.ok(first >= 10000, 'the first wait is long enough to outlast a 2s poll')
  rmSync(root, { recursive: true, force: true })
})

test('Pou is the first column; Owner has its own folder', () => {
  assert.equal(COLUMNS[0].key, 'pou')
  assert.equal(columnByKey('owner').dir, 'owner')
  const { tasks, root } = fixture()
  moveCard(tasks, 'T-04', 'owner')
  assert.equal(readBoard(tasks).owner.length, 1)
  assert.ok(existsSync(join(tasks, 'owner', 'T-04-calc-mobile-lcp.md')))
  rmSync(root, { recursive: true, force: true })
})

test('the worker prompt offers owner as well as issue, and explains the difference', () => {
  const card = { id: 'T-04', title: 'x', path: 'C:\\p\\TASKS\\queue\\T-04-x.md' }
  const text = workerPrompt({ card, projectPath: 'C:\\p', boardRoot: 'C:\\board' })
  assert.ok(text.includes('owner T-04'), 'agents must know the owner handover exists')
  assert.ok(/only the human can supply/.test(text), 'and when to use it rather than issue')
})

test('prompts are single-line, because a newline is the submit key', () => {
  const card = { id: 'T-04', title: 'Fix the thing', path: 'C:\\p\\TASKS\\queue\\T-04-x.md' }
  const worker = workerPrompt({ card, projectPath: 'C:\\p', boardRoot: 'C:\\board' })
  const reviewer = reviewerPrompt({ cards: [card], projectPath: 'C:\\p', boardRoot: 'C:\\board' })

  for (const [name, text] of [['worker', worker], ['reviewer', reviewer]]) {
    assert.ok(!/\n/.test(text), `${name} prompt must not contain a newline`)
    assert.ok(text.includes('hkb.mjs'), `${name} prompt must tell the agent how to report back`)
  }
  assert.ok(worker.includes('TASKS/queue/T-04-x.md'), 'card path is relative and forward-slashed')
  assert.ok(worker.includes('done T-04'), 'worker is told the exact done command')
})

test('board-spawned agents are recognisable so only they get auto-closed', () => {
  assert.equal(agentName('builder', 'T-04'), 'b-t-04')
  assert.ok(isBoardAgent({ name: 'b-i149' }))
  assert.ok(isBoardAgent({ name: 'kb-t-04-injectbuddy' }), 'agents started before role names are still ours')
  assert.ok(!isBoardAgent({ name: 'planner-injectbuddy' }), 'a hand-started agent is never ours to close')
})

test('agent names satisfy the rules herdr actually enforces', () => {
  // lowercase letters, digits, - or _, starting with a letter, 1-32 chars
  const ok = (n) => /^[a-z][a-z0-9_-]{0,31}$/.test(n)
  for (const role of ['planner', 'builder', 'reviewer', 'issues', 'auditor']) {
    assert.ok(ok(agentName(role, 'T-100')) && ok(agentName(role, 'LTS100')), role)
  }
  assert.ok(agentName('reviewer', 'HK14').startsWith('r-'), 'reviewerRunning matches on this role letter')
})

test('closeFinished never reaps an idle reviewer/sweeper mid-run, only a genuinely done one', async () => {
  // Regression for a real incident: the reviewer vanished mid-run (review count
  // unchanged) because it is unbound for its whole lifetime by design, and an
  // ordinary idle blip between tool calls used to read as "finished".
  const { root, tasks } = fixture()
  const idleReviewer = { name: 'kb-review-injectbuddy-we-p1', pane_id: 'wE:p1', agent_status: 'idle' }
  const idleSweeper = { name: 'kb-sweep-injectbuddy-we-p2', pane_id: 'wE:p2', agent_status: 'idle' }
  const doneReviewer = { name: 'kb-review-injectbuddy-we-p3', pane_id: 'wE:p3', agent_status: 'done' }

  // The done one has been done since well before now: `done` must be SUSTAINED to
  // count, or a reviewer pausing between cards gets reaped mid-run (see below).
  const t0 = Date.now()
  await closeFinished({ tasksDir: tasks, agents: [doneReviewer], now: t0 })

  const closed = await closeFinished({
    tasksDir: tasks, agents: [idleReviewer, idleSweeper, doneReviewer], now: t0 + 3 * 60 * 1000,
  })
  assert.ok(!closed.includes('wE:p1'), 'an idle reviewer mid-review must not be closed')
  assert.ok(!closed.includes('wE:p2'), 'an idle sweeper mid-sweep must not be closed')
  assert.ok(closed.includes('wE:p3'), 'a genuinely done reviewer is still closed')
  rmSync(root, { recursive: true, force: true })
})

test('closeFinished gives an unbound builder a short grace before reaping it', async () => {
  // Unbound still means hkb ran, but an idle/done blip gets one grace window before
  // the pane is retired.
  const { root, tasks } = fixture()
  const idleBuilder = { name: 'kb-t04-injectbuddy-wa-p1', pane_id: 'wA:p1', agent_status: 'idle' }
  const t0 = Date.now()
  assert.deepEqual(await closeFinished({ tasksDir: tasks, agents: [idleBuilder], now: t0 }), [])
  const closed = await closeFinished({ tasksDir: tasks, agents: [idleBuilder], now: t0 + 3 * 60 * 1000 })
  assert.ok(closed.includes('wA:p1'), 'an idle unbound builder is reaped after the grace')
  rmSync(root, { recursive: true, force: true })
})

test('closeFinished keeps a Builder pane only while its card can still use it', async () => {
  const { root, tasks } = fixture()
  for (const [lane, id] of [['planning', 'T-05'], ['working', 'T-06']]) {
    mkdirSync(join(tasks, lane), { recursive: true })
    writeFileSync(join(tasks, lane, `${id}.md`), `# ${id} — Card\n`)
  }
  writeFileSync(join(tasks, '.workflow-state.json'), JSON.stringify({ 'T-05': { builder: { pane_id: 'zZ:p98' } }, 'T-06': { builder: { pane_id: 'zZ:p99' } } }))
  const agents = [{ name: 'b-t-05', pane_id: 'zZ:p98', agent_status: 'idle' }, { name: 'b-t-06', pane_id: 'zZ:p99', agent_status: 'idle' }]
  const t0 = Date.now()
  await closeFinished({ tasksDir: tasks, agents, now: t0 })
  const closed = await closeFinished({ tasksDir: tasks, agents, now: t0 + 3 * 60 * 1000 })
  assert.deepEqual(closed, ['zZ:p98'], 'back in Planning the old Builder is closed (Tradeflow TF51); Working keeps its Builder')
  rmSync(root, { recursive: true, force: true })
})

test('server gates finished-pane retirement to hourly housekeeping', () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.match(source, /CLEANUP_INTERVAL_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/)
  assert.match(source, /lastCleanup\s*=\s*new Map\(\)/)
  assert.match(source, /closeFinished\(\{[\s\S]{0,180}retire:\s*cleanupDue\(project,\s*now\)/)
})

test('review dispatch without eligible cards fails closed', async () => {
  // herdr registers an agent only once it has booted, so reviewerRunning() is
  // false for the whole spawn, so two clicks could otherwise start two reviewers.
  const { root, tasks } = fixture()
  const args = { project: 'test', projectPath: root, tasksDir: tasks, boardRoot: root, model: 'sonnet' }
  const results = await Promise.allSettled([spawnReviewer(args), spawnReviewer(args)])
  const busy = results.filter((r) => r.status === 'rejected' && r.reason.busy)
  assert.equal(busy.length, 0, 'both reject absent cards before reserving slots')
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 0, 'no herdr here, so neither can succeed')
  rmSync(root, { recursive: true, force: true })
})

test('reviewers start from the poll tick through the existing reviewer path', () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  const tick = source.slice(source.indexOf('async function tick'), source.indexOf('// --- SSE'))
  assert.match(source, /autoReview\(\{[\s\S]+config\.models\.review/, 'polling uses the configured review model')
  assert.doesNotMatch(tick, /spawnReviewer/, 'tick still does not grow a second reviewer implementation')
  assert.match(source, /url\.pathname === '\/api\/review'[\s\S]+?spawnReviewer\(/,
    'the confirmed Review action remains available')
})

test('autoReview starts one planned review batch and skips while a reviewer is busy', async () => {
  const { root, tasks } = fixture()
  mkdirSync(join(tasks, 'review'), { recursive: true })
  writeFileSync(join(tasks, 'review', 'T-20-review.md'), '# T-20 — Review\n\n## Files\n- `a.js`\n')
  writeFileSync(join(tasks, 'review', 'T-21-review.md'), '# T-21 — Review\n\n## Files\n- `a.js`\n')
  let calls = 0

  const result = await autoReview({
    project: 'test',
    projectPath: root,
    tasksDir: tasks,
    boardRoot: root,
    model: 'gpt-5.5',
    engine: { kind: 'codex' },
    agents: [],
    inventory: async () => [{ project: 'test', tasksDir: tasks, known: true, agents: [] }],
    spawn: async ({ cardIds }) => {
      calls++
      return { pane_id: 'w1:p1', cards: cardIds }
    },
  })
  assert.deepEqual(result.cards, ['T-20', 'T-21'])

  const busy = await autoReview({
    project: 'test',
    projectPath: root,
    tasksDir: tasks,
    boardRoot: root,
    model: 'gpt-5.5',
    engine: { kind: 'codex' },
    agents: [{ pane_id: 'w1:p1', name: 'kb-review-test-w1-p1', agent_status: 'working' }],
    inventory: async () => [{ project: 'test', tasksDir: tasks, known: true, agents: [{ pane_id: 'w1:p1', name: 'kb-review-test-w1-p1', agent_status: 'working' }] }],
    spawn: async () => { calls++ },
  })
  assert.equal(busy, null)
  assert.equal(calls, 1, 'busy reviewer prevents duplicate dispatch')
  rmSync(root, { recursive: true, force: true })
})

test('a missing or malformed herdr agent-list response is unknown, not "nothing running"', () => {
  // The bug shape: a falsy/absent field silently reads as "safe to spawn".
  // Both the builder and the reviewer read off this one function, so fixing it
  // here fixes it for whichever path hits a malformed response.
  assert.throws(() => parseAgentList(null), /malformed/)
  assert.throws(() => parseAgentList({}), /malformed/, 'no agents field at all')
  assert.throws(() => parseAgentList({ agents: null }), /malformed/)
  assert.throws(() => parseAgentList({ agents: 'not-an-array' }), /malformed/)
  assert.throws(() => parseAgentList({ agents: [{ name: 'kb-review-x' }] }), /malformed/,
    'an entry with no pane_id cannot be matched by liveBindings or reviewerRunning')
  assert.deepEqual(parseAgentList({ agents: [] }), [], 'a genuinely empty list is fine')
  const ok = [{ pane_id: 'w1:p1', name: 'kb-t-04' }]
  assert.deepEqual(parseAgentList({ agents: ok }), ok)
})

test('the circuit breaker counts consecutive failures, not healthy launches, and cools down', () => {
  const project = 'proof'
  const cap = 4
  const threshold = Math.max(3, cap)
  resetBreaker(project)
  const t0 = 1_000_000
  for (let i = 0; i < 20; i++) recordSpawn({ project, now: t0 + i })
  assert.equal(breakerState(project, t0 + 20).breakerTripped, false, 'healthy launches never trip it')
  for (let i = 0; i < threshold - 1; i++) recordSpawnFailure({ project, cap, now: t0 + 100 + i, reason: 'boot' })
  assert.equal(breakerState(project, t0 + 102).breakerTripped, false)
  const state = recordSpawnFailure({ project, cap, now: t0 + 200, reason: 'boot' })
  assert.equal(state.breakerTripped, true)
  assert.equal(state.count, threshold)
  assert.equal(breakerState(project, state.resetsAt).breakerTripped, false, 'cooldown restores the project')
  resetBreaker(project)
})

test('a successful launch clears prior failures and projects stay isolated', () => {
  resetBreaker()
  const t0 = 2_000_000
  recordSpawnFailure({ project: 'alpha', cap: 3, now: t0, reason: 'boot' })
  recordSpawnFailure({ project: 'alpha', cap: 3, now: t0 + 1, reason: 'boot' })
  recordSpawn({ project: 'alpha', now: t0 + 2 })
  recordSpawnFailure({ project: 'alpha', cap: 3, now: t0 + 3, reason: 'boot' })
  recordSpawnFailure({ project: 'alpha', cap: 3, now: t0 + 4, reason: 'boot' })
  assert.equal(breakerState('alpha', t0 + 4).breakerTripped, false, 'success reset the sequence')
  for (let i = 0; i < 3; i++) recordSpawnFailure({ project: 'beta', cap: 3, now: t0 + i, reason: 'boot' })
  assert.equal(breakerState('beta', t0 + 3).breakerTripped, true)
  assert.equal(breakerState('alpha', t0 + 4).breakerTripped, false)
  resetBreaker()
})

test('a zero builder cap prevents further spawns', async () => {
  const { root, tasks } = fixture()
  const started = await autoSpawn({
    project: 'test', projectPath: root, tasksDir: tasks, boardRoot: root,
    model: 'sonnet', agents: [], max: 0, // what a tripped breaker forces
  })
  assert.deepEqual(started, [])
  assert.equal(readBoard(tasks).queue.length, 1, 'the card never left Queue')
  rmSync(root, { recursive: true, force: true })
})

test('Blocked by parses a comma list of ids, and defaults to empty when absent', () => {
  const { tasks, root } = fixture()
  assert.deepEqual(parseCard(join(tasks, 'queue', 'T-04-calc-mobile-lcp.md'), 'queue').blockedBy, [])

  writeFileSync(join(tasks, 'queue', 'T-09-gated.md'),
    '# T-09 — Gated card\n\n**Priority** 5/10 · **Blocked by:** T-08, t-07\n')
  assert.deepEqual(parseCard(join(tasks, 'queue', 'T-09-gated.md'), 'queue').blockedBy, ['T-08', 'T-07'])
  rmSync(root, { recursive: true, force: true })
})

test('Blocked by only matches a real metadata line, not the same words inside a blockquote or prose', () => {
  // Real incident (T-59, 2026-08-11): a dependency note explained "a line like
  // **Blocked by:** nothing would be read as an unresolvable ID" — and was
  // itself read as exactly that, self-blocking a card forever with no real
  // **Blocked by:** field anywhere on it.
  const { tasks, root } = fixture()
  writeFileSync(join(tasks, 'queue', 'T-59-no-real-blocker.md'),
    '# T-59 — Card that only mentions the field in prose\n\n' +
    '**Priority** 7/10\n\n' +
    '> Note: a line like `**Blocked by:** nothing` would be read as an unresolvable id.\n')
  assert.deepEqual(parseCard(join(tasks, 'queue', 'T-59-no-real-blocker.md'), 'queue').blockedBy, [])
  // Prose after the field is not a card id (Injectbuddy I228 sat in Planned on "none. No deployment…").
  writeFileSync(join(tasks, 'queue', 'I228-prose.md'), '# I228 — Card\n\n- **Blocked by:** none. No deployment or live-site acceptance check.\n')
  assert.deepEqual(parseCard(join(tasks, 'queue', 'I228-prose.md'), 'queue').blockedBy, [])
  writeFileSync(join(tasks, 'queue', 'I229-real.md'), '# I229 — Card\n\n**Blocked by:** I227 (dashboard reorder), TF46\n')
  assert.deepEqual(parseCard(join(tasks, 'queue', 'I229-real.md'), 'queue').blockedBy, ['I227', 'TF46'])
  rmSync(root, { recursive: true, force: true })
})

test('T-9 routes a missing Queue prerequisite to Planning with the reason', async () => {
  const { tasks, root } = fixture()
  moveCard(tasks, 'T-04', 'working')
  writeFileSync(join(tasks, 'queue', 'T-09-gated.md'),
    '# T-09 — Gated card\n\n**Priority** 9/10 · **Blocked by:** T-08\n')
  const started = await autoSpawn({
    project: 'test', projectPath: root, tasksDir: tasks, boardRoot: root,
    model: 'sonnet', agents: [], max: 5,
  })
  assert.deepEqual(started, [])
  const routed = findCard(tasks, 'T-09')
  assert.equal(routed.column, 'planning')
  assert.match(readFileSync(routed.path, 'utf8'), /waiting for unique integrated or archived prerequisite T-08/)
  rmSync(root, { recursive: true, force: true })
})

test('T-9 routes both duplicate live IDs from their exact files without overwriting either', async () => {
  const { tasks, root } = fixture()
  moveCard(tasks, 'T-04', 'working')
  writeFileSync(join(tasks, 'queue', 'T-09-first.md'), '# T-09 — First copy\n')
  writeFileSync(join(tasks, 'queue', 'T-09-second.md'), '# T-09 — Second copy\n')
  await autoSpawn({ project: 'test', projectPath: root, tasksDir: tasks, boardRoot: root, model: 'sonnet', agents: [], max: 5 })
  const routed = readBoard(tasks).planning.filter(c => c.id === 'T-09')
  assert.equal(routed.length, 2)
  assert.deepEqual(new Set(routed.map(c => readFileSync(c.path, 'utf8').match(/First copy|Second copy/)[0])), new Set(['First copy', 'Second copy']))
  assert.equal(readBoard(tasks).queue.some(c => c.id === 'T-09'), false)
  rmSync(root, { recursive: true, force: true })
})

test('T-9 keeps an allowed Owner prerequisite wait visible in Queue', async () => {
  const { tasks, root } = fixture()
  moveCard(tasks, 'T-04', 'working')
  moveCard(tasks, 'T-17', 'working')
  mkdirSync(join(tasks, 'owner'), { recursive: true })
  writeFileSync(join(tasks, 'owner', 'T-08-owner.md'), '# T-08 — Owner decision\n')
  writeFileSync(join(tasks, 'queue', 'T-09-gated.md'), '# T-09 — Gated\n\n**Blocked by:** T-08\n')
  writeFileSync(join(tasks, 'queue', 'T-10-gated.md'), '# T-10 — Gated\n\n**Blocked by:** T-17\n')
  await autoSpawn({ project: 'test', projectPath: root, tasksDir: tasks, boardRoot: root, model: 'sonnet', agents: [], max: 5 })
  assert.ok(readBoard(tasks).queue.some(c => c.id === 'T-09'))
  assert.match(holdsFor('test')['T-09'], /waiting for unique integrated or archived prerequisite T-08/)
  assert.ok(readBoard(tasks).queue.some(c => c.id === 'T-10'))
  assert.match(holdsFor('test')['T-10'], /waiting for unique integrated or archived prerequisite T-17/)
  // One prerequisite archived, one still building: still an allowed wait (Injectbuddy I195).
  mkdirSync(join(tasks, 'archive'), { recursive: true })
  writeFileSync(join(tasks, 'archive', 'T-06-done.md'), '# T-06 — Done\n')
  writeFileSync(join(tasks, 'queue', 'T-11-gated.md'), '# T-11 — Gated\n\n**Blocked by:** T-06, T-17\n')
  await autoSpawn({ project: 'test', projectPath: root, tasksDir: tasks, boardRoot: root, model: 'sonnet', agents: [], max: 5 })
  assert.ok(readBoard(tasks).queue.some(c => c.id === 'T-11'))
  rmSync(root, { recursive: true, force: true })
})

test('T-9 routes an Issues prerequisite to Owner with a decision', async () => {
  const { tasks, root } = fixture()
  moveCard(tasks, 'T-04', 'working')
  mkdirSync(join(tasks, 'issues'), { recursive: true })
  writeFileSync(join(tasks, 'issues', 'T-08-issue.md'), '# T-08 — Issue\n')
  writeFileSync(join(tasks, 'queue', 'T-09-gated.md'), '# T-09 — Gated\n\n**Blocked by:** T-08\n')
  await autoSpawn({ project: 'test', projectPath: root, tasksDir: tasks, boardRoot: root, model: 'sonnet', agents: [], max: 5 })
  const routed = findCard(tasks, 'T-09')
  assert.equal(routed.column, 'owner')
  assert.match(readFileSync(routed.path, 'utf8'), /Decision needed: resolve this hold or authorize a recovery path/)
  rmSync(root, { recursive: true, force: true })
})

test('T-9 sends a continuous full-slot hold to Issues only after three stall windows', async () => {
  const { tasks, root } = fixture()
  moveCard(tasks, 'T-17', 'working')
  bind(tasks, 'T-17', { pane_id: 'w1:p1' })
  const args = { project: 'test', projectPath: root, tasksDir: tasks, boardRoot: root, model: 'sonnet', agents: [{ pane_id: 'w1:p1', agent_status: 'working' }], max: 1, stallSeconds: 1 }
  await autoSpawn({ ...args, now: 1000 })
  await autoSpawn({ ...args, now: 4000 })
  assert.equal(findCard(tasks, 'T-04').column, 'queue', 'exactly three windows stays in Queue')
  await autoSpawn({ ...args, now: 4001 })
  const routed = findCard(tasks, 'T-04')
  assert.equal(routed.column, 'issues')
  assert.match(readFileSync(routed.path, 'utf8'), /continuously held for 3 seconds/)
  rmSync(root, { recursive: true, force: true })
})

test('a preserved pane reservation consumes the remaining autoSpawn slot for the tick', async () => {
  const { tasks, root } = fixture()
  writeFileSync(join(tasks, 'queue', 'T-18-second.md'), '# T-18 — Second\n\n**Priority** 6/10\n')
  let calls = 0
  const started = await autoSpawn({
    project: 'test',
    projectPath: root,
    tasksDir: tasks,
    boardRoot: root,
    model: 'sonnet',
    agents: [],
    max: 1,
    spawn: async ({ card, onPane }) => {
      calls++
      onPane?.({ pane_id: `w1:p${calls}`, tab_id: 'w1:t1', model: 'sonnet', name: `kb-${card.id}`, spawning: true })
      throw Object.assign(new Error('manual Enter needed'), { preservePane: true })
    },
  })

  const board = readBoard(tasks)
  assert.deepEqual(started, [], 'manual-recovery panes are not counted as successful starts')
  assert.equal(calls, 1, 'the preserved first pane consumes the only slot')
  assert.deepEqual(board.working.map((c) => c.id), ['T-04'])
  assert.ok(board.queue.some((c) => c.id === 'T-18'), 'the second queued card waits for the next tick')
  assert.equal(readBindings(tasks)['T-04'].pane_id, 'w1:p1', 'the recoverable pane binding is retained')
  rmSync(root, { recursive: true, force: true })
})

test('unmetBlockers: satisfied only by one unique Archive card', () => {
  const board = {
    completed: [{ id: 'T-08' }],
    archive: [{ id: 'T-06' }],
    working: [{ id: 'T-07' }],
  }
  assert.deepEqual(unmetBlockers({ blockedBy: ['T-08'] }, board), ['T-08'], 'Completed is not reviewed Done')
  assert.deepEqual(unmetBlockers({ blockedBy: ['T-06'] }, board), [], 'Archive satisfies the blocker')
  assert.deepEqual(unmetBlockers({ blockedBy: ['T-07'] }, board), ['T-07'], 'Working does not — not actually finished')
  assert.deepEqual(unmetBlockers({ blockedBy: ['T-08', 'T-99'] }, board), ['T-08', 'T-99'], 'only archived ids are met')
  assert.deepEqual(unmetBlockers({ blockedBy: [] }, board), [], 'no blockers named is never gated')
})

test('preflightBlocks: no script means no check; the script decides by exit code; it is called with the card PATH not its id', () => {
  const { root, tasks } = fixture()
  const card = parseCard(join(tasks, 'queue', 'T-04-calc-mobile-lcp.md'), 'queue')
  assert.equal(preflightBlocks({ projectPath: root, card }), false, 'most repos have no preflight.mjs yet')

  mkdirSync(join(root, 'scripts'), { recursive: true })
  // Asserts the exact contract preflight.mjs documents at its own top: it is
  // invoked with a path it can fs.existsSync, not a bare "T-04" id — the bug
  // this test exists to catch (autoSpawn originally called it with card.id).
  writeFileSync(join(root, 'scripts', 'preflight.mjs'),
    'import fs from "node:fs"; process.exit(fs.existsSync(process.argv[2]) ? 1 : 2)')
  assert.ok(preflightBlocks({ projectPath: root, card }), 'non-zero exit blocks the card')

  writeFileSync(join(root, 'scripts', 'preflight.mjs'), 'process.exit(0)')
  assert.equal(preflightBlocks({ projectPath: root, card }), false, 'zero exit clears the card')

  // exit 2 is returned distinctly so autoSpawn can route it to its Planner.
  writeFileSync(join(root, 'scripts', 'preflight.mjs'), 'process.exit(2)')
  assert.equal(preflightBlocks({ projectPath: root, card }).kind, 'card not ready')
  rmSync(root, { recursive: true, force: true })
})

test('autoSpawn routes malformed preflight cards to Planning once and never starts a Builder', async () => {
  const { root, tasks } = fixture()
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'preflight.mjs'), 'console.error("exact malformed reason"); process.exit(2)')
  const logged = []
  let spawns = 0
  const args = {
    project: 'test', projectPath: root, tasksDir: tasks, boardRoot: root,
    model: 'test', agents: [], max: 1, log: (line) => logged.push(line),
    spawn: async () => { spawns++; throw new Error('must not spawn') },
  }
  await autoSpawn(args)
  await autoSpawn(args)
  assert.equal(spawns, 0)
  assert.deepEqual(readBoard(tasks).planning.map(c => c.id), ['T-04'])
  assert.equal(logged.length, 1, 'the unchanged error is routed and logged only once')
  assert.match(logged[0], /routed to planning.*exact malformed reason/)
  assert.match(readFileSync(readBoard(tasks).planning[0].path, 'utf8'), /Kicked back[\s\S]*exact malformed reason/)
  rmSync(root, { recursive: true, force: true })
})

test('preflight permits unchanged same-card dirty snapshot and rejects changed content', () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-dirty-'))
  try {
    const tasks = join(root, 'TASKS')
    mkdirSync(join(tasks, 'queue'), { recursive: true })
    mkdirSync(join(root, 'scripts'), { recursive: true })
    writeFileSync(join(root, 'app.js'), 'clean\n')
    writeFileSync(join(root, 'scripts', 'preflight.mjs'), 'process.exit(1)')
    spawnSync('git', ['init'], { cwd: root })
    spawnSync('git', ['add', 'app.js'], { cwd: root })
    spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { cwd: root })
    writeFileSync(join(root, 'app.js'), 'dirty\n')
    const cardPath = join(tasks, 'queue', 'T-55-dirty.md')
    writeFileSync(cardPath, '# T-55 — Dirty\n\n**Workflow:** card-owned\n**Workspace:** .\n\n## Files\n\n- `app.js` — code\n')
    let card = parseCard(cardPath, 'queue')
    appendDirtySnapshot(card, dirtySnapshotForCard(card, root, { listedOnly: true }), new Date(0))
    spawnSync('git', ['add', 'scripts/preflight.mjs', 'TASKS/queue/T-55-dirty.md'], { cwd: root })
    spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'card'], { cwd: root })
    card = parseCard(cardPath, 'queue')

    writeFileSync(join(root, 'unrelated.txt'), 'legacy dirt\n')
    assert.equal(preflightBlocks({ projectPath: root, card }), false)
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'assets', 'new.txt'), 'new\n')
    assert.deepEqual(dirtySnapshotForCard(card, root).files.find((f) => f.path === 'assets/'), {
      path: 'assets/',
      status: '??',
      sha256: null,
    })
    writeFileSync(join(root, 'app.js'), 'changed\n')
    assert.equal(preflightBlocks({ projectPath: root, card }).kind, 'files busy')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('column keys and folder names stay in step with the plan', () => {
  assert.equal(columnByKey('planned').dir, 'backlog', 'existing backlog/ folder must be reused as-is')
  assert.equal(columnByKey('queue').dir, 'queue', 'existing queue/ folder is the auto-spawn lane')
  assert.equal(columnByKey('archive').label, 'Archive')
})

test('the agent workspace is found by label, and recreated once it is gone', async () => {
  const listed = [{ label: 'planner', workspace_id: 'wC' }, { label: ' Agents ', workspace_id: 'wD' }]
  // Labels are what the operator sees and types, so whitespace and case cannot decide this.
  assert.equal(findWorkspace(listed, 'agents'), 'wD')
  assert.equal(findWorkspace(listed, 'AGENTS'), 'wD')
  assert.equal(findWorkspace([], 'agents'), null)

  const found = await agentWorkspace('agents', { list: async () => listed })
  assert.deepEqual(found, { id: 'wD', created: false }, 'an existing workspace is reused, never duplicated')

  // The operator closing it mid-session must not leave a stale id in play.
  let created = 0
  const gone = await agentWorkspace('agents', {
    list: async () => [{ label: 'planner', workspace_id: 'wC' }],
    create: async (label) => { created++; return { workspace: { label, workspace_id: 'wE' } } },
  })
  assert.deepEqual(gone, { id: 'wE', created: true })
  assert.equal(created, 1)
})

test('the Lead Planner prompt is single-line, specialist-scoped, and returns ready cards to Planned', () => {
  const card = { id: 'T-06', title: 'x', category: 'ui', path: 'C:\\p\\TASKS\\issues\\T-06-x.md' }
  const text = issuesSweeperPrompt({ cards: [card], projectPath: 'C:\\p', boardRoot: 'C:\\board' })
  assert.ok(!/\n/.test(text), 'planner prompt must not contain a newline')
  assert.match(text, /_roles\/PLANNER\.md/, 'the spawned Planner role is explicit')
  assert.ok(text.includes('hkb.mjs'), 'planner prompt must tell the agent how to report back')
  assert.ok(text.includes('move <ID> planned'), 'ready plans return to Planned, not Queue')
  assert.ok(/owner <ID>/.test(text), 'underdetermined cards go to owner, not a forced fix')
  assert.match(text, /Projects\/_roles\/PLANNER\.md/, 'planner uses the compact shared role')
  assert.match(text, /Projects\/_roles\/PLANNER-UI\.md/, 'planner receives only its category overlay')
  assert.doesNotMatch(text, /PLANNER-AUTH-SECURITY/, 'unrelated specialist overlays stay out of context')
})

test('trivial cards use the lightweight builder model and engine', async () => {
  const { tasks, root } = fixture()
  const path = join(tasks, 'queue', 'T-04-calc-mobile-lcp.md')
  writeFileSync(path, readFileSync(path, 'utf8') + '\n**Trivial:** yes\n')
  let seen
  await autoSpawn({
    project: 'test', projectPath: root, tasksDir: tasks, boardRoot: root,
    model: 'gpt-5.5', engine: { kind: 'codex', reasoningArgs: ['high'] },
    trivialModel: 'gpt-5.6-luna', trivialEngine: { kind: 'codex', reasoningArgs: ['low'] },
    agents: [], max: 1,
    spawn: async (args) => { seen = args; return { pane_id: 'w1:p1', name: 'kb-t-04' } },
  })
  assert.equal(seen.model, 'gpt-5.6-luna')
  assert.deepEqual(seen.engine.reasoningArgs, ['low'])
  rmSync(root, { recursive: true, force: true })
})

test('Lead Planner (Issues sweeper) agent names use the i- role prefix', () => {
  const name = agentName('issues', 'T-7')
  assert.ok(name.startsWith('i-'), 'sweeperRunning matches on this prefix')
  assert.ok(isBoardAgent({ name }), 'the generic close/board-agent check must also recognise it')
})

test('only one sweeper can be in flight, however many callers ask at once', async () => {
  const { root, tasks } = fixture()
  const previousConfig = process.env.KANBAN_CONFIG
  const temporaryConfig = join(root, 'board.config.json')
  writeFileSync(temporaryConfig, JSON.stringify({ projects: ['test'], maxConcurrentAgents: 1 }))
  process.env.KANBAN_CONFIG = temporaryConfig
  const args = { project: 'test', projectPath: root, tasksDir: tasks, boardRoot: root, model: 'sonnet' }
  const results = await Promise.allSettled([spawnIssuesSweeper(args), spawnIssuesSweeper(args)])
  if (previousConfig === undefined) delete process.env.KANBAN_CONFIG
  else process.env.KANBAN_CONFIG = previousConfig
  const busy = results.filter((r) => r.status === 'rejected' && r.reason.busy)
  assert.equal(busy.length, 1, 'the second caller is turned away, not run')
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 0, 'no herdr here, so neither can succeed')
  rmSync(root, { recursive: true, force: true })
})

test('Auto-Manager sweeps unparked Owner cards too; Auto sweeps Issues only', () => {
  const { root, tasks } = fixture()
  for (const d of ['issues', 'owner']) mkdirSync(join(tasks, d), { recursive: true })
  writeFileSync(join(tasks, 'issues', 'T-40-blocked.md'), '# T-40 — Blocked\n')
  writeFileSync(join(tasks, 'owner', 'T-41-question.md'), '# T-41 — A question\n')
  writeFileSync(join(tasks, 'owner', 'T-42-parked.md'), '# T-42 — Parked\n\n**Parked** needs your bank details\n')

  const board = readBoard(tasks)
  const auto = board.issues.map((c) => c.id)
  const manager = [...board.issues, ...board.owner.filter((c) => !isParked(c))].map((c) => c.id)
  assert.deepEqual(auto, ['T-40'], 'auto mode never touches the Owner column')
  assert.deepEqual(manager.sort(), ['T-40', 'T-41'], 'manager mode adds Owner but skips a parked card')

  // Parking is what stops an unanswerable card being re-read every 15 minutes.
  assert.equal(isParked(findCard(tasks, 'T-42')), true)
  assert.equal(isParked(findCard(tasks, 'T-41')), false)
  rmSync(root, { recursive: true, force: true })
})

test('a tab label leads with the card id and flags how many cards it holds up', () => {
  const card = { id: 'T-23', title: 'Steroid injectable path adopts the Hormone reference package' }
  assert.match(paneLabel(card), /^T-23 · Steroid/, 'the id leads — it is what survives truncation')
  assert.match(paneLabel(card, 2), /^T-23 ⛔2 · /, 'and a card blocking others says so')
  assert.equal(paneLabel(card, 2).length <= 48, true, 'herdr truncates past 48 chars')
  assert.equal(paneLabel(card).includes('builder'), false, 'the role no longer eats the front of every tab')
})

test('a reviewer pausing between cards is not reaped; only sustained done counts', async () => {
  const { root, tasks } = fixture()
  const reviewer = { name: 'kb-review-test-w1-p9', pane_id: 'w1:p9', agent_status: 'done' }
  const t0 = Date.now()
  const poll = (status, at) => closeFinished({ tasksDir: tasks, agents: [{ ...reviewer, agent_status: status }], project: 'test', now: at })

  // Boot: done because nothing has happened yet. Reaping here killed two reviewers.
  assert.deepEqual(await poll('done', t0), [])
  assert.deepEqual(await poll('working', t0 + 5000), [])

  // Finishes a card and waits for the next: done again, briefly. Still not finished.
  assert.deepEqual(await poll('done', t0 + 60000), [])
  assert.deepEqual(await poll('done', t0 + 90000), [], 'a 30s pause between cards is not the end of the run')
  assert.deepEqual(await poll('working', t0 + 95000), [], 'and it proves that by carrying on')

  // Genuinely finished: done, and it stays done.
  assert.deepEqual(await poll('done', t0 + 100000), [])
  assert.deepEqual(await poll('done', t0 + 100000 + 2 * 60 * 1000), ['w1:p9'], 'sustained done is a finished agent')
  rmSync(root, { recursive: true, force: true })
})

test('Auto-Manager promotion uses the shared Planned helper', () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  const tick = source.slice(source.indexOf('async function tick'), source.indexOf('// --- SSE'))
  assert.match(tick, /config\.mode === 'manager' \|\| config\.autoQueuePlanned === true[\s\S]{0,200}promotePlanned\(tasksDir/,
    'the tick moves Planned cards through the shared helper — no agent, no judgement')

  // A blocked card stays Planned until its prerequisite is integrated or archived.
  const { root, tasks } = fixture()
  writeFileSync(join(tasks, 'backlog', 'T-18-blocked.md'), '# T-18 — Blocked\n\n**Priority** 9/10\n\n**Blocked by:** T-99\n')
  const board = readBoard(tasks)
  const blocked = board.planned.find((c) => c.id === 'T-18')
  assert.deepEqual(unmetBlockers(blocked, board), ['T-99'])
  assert.ok(!promotePlanned(tasks).includes('T-18'))
  assert.ok(readBoard(tasks).planned.some(c => c.id === 'T-18'))
  mkdirSync(join(tasks, 'archive'), { recursive: true })
  writeFileSync(join(tasks, 'archive', 'T-99-done.md'), '# T-99 — Landed\n')
  assert.ok(promotePlanned(tasks).includes('T-18'), 'promotion resumes after the prerequisite reaches Archive')

  // And the sweeper no longer carries any promotion instructions.
  const prompt = issuesSweeperPrompt({ cards: board.queue, projectPath: root, boardRoot: root, manager: true })
  assert.match(prompt, /move <ID> planned/)
  assert.match(prompt, /After the handoff succeeds, stop that card immediately/)
  assert.equal(prompt.includes('\n'), false, 'prompts are delivered as a single line')
  rmSync(root, { recursive: true, force: true })
})

test('the poll tick caps builders at maxConcurrentAgents in every mode', () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  const tick = source.slice(source.indexOf('async function tick'), source.indexOf('// --- SSE'))
  // Manager mode used to clamp this to 1, which starved the board of builders
  // (operator, 2026-08-18). Slots are counted from card bindings, so the cap is
  // builders only and the operator's own panes never consume one.
  assert.match(tick, /const max = config.maxConcurrentAgents/,
    'every mode runs up to the configured builder cap')
  assert.doesNotMatch(tick, /'manager' ? 1/, 'no one-card-at-a-time clamp')
  assert.match(tick, /max,/, 'and the tick must actually pass that cap to autoSpawn')
})

test('Lead Planner reuses the sweep endpoint and one poll path', () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  const tick = source.slice(source.indexOf('async function tick'), source.indexOf('// --- SSE'))
  assert.match(tick, /config\.leadPlanner\?\.autoIssues[\s\S]+spawnIssuesSweeper/, 'polling uses the existing Issues planner path when enabled')
  assert.match(source, /url\.pathname === '\/api\/sweep-issues'[\s\S]+?spawnIssuesSweeper\(/,
    'the confirmed Sweep action remains available')
})

// --- review plan (T-53: postman batching) -----------------------------

function planFixture() {
  const root = mkdtempSync(join(tmpdir(), 'hkb-plan-'))
  const tasks = join(root, 'TASKS')
  for (const d of ['review', 'working']) mkdirSync(join(tasks, d), { recursive: true })
  return { root, tasks }
}

function reviewCard(id, { files = [], estBuild, estReview } = {}) {
  const meta = ['**Priority** 5/10', '**Status:** open', '**Surface:** pwa']
  if (estBuild != null) meta.push(`**Est build:** ${estBuild}m`)
  if (estReview != null) meta.push(`**Est review:** ${estReview}m`)
  const fileLines = files.map((f) => `- \`${f}\` — some prose mentioning \`OtherThing\` inline`).join('\n')
  return `# ${id} — Title\n\n${meta.join(' · ')}\n\n## Files\n\n${fileLines}\n\n## Acceptance criteria\n\n1. x\n`
}

test('cardFiles skips Files lines the plan marks unchanged or read-only, so they take no lock (Tradeflow TF54)', () => {
  const { root, tasks } = planFixture()
  const path = join(tasks, 'review', 'T-01.md')
  writeFileSync(path, `# T-01 — card\n\n## Files\n- \`components/site/PartnerCTA.tsx\` — change the sidebar branch only.\n- \`app/globals.css\` — unchanged global \`.btn-cta\` rules.\n- \`app/page.tsx\` (read-only) caller.\n- \`lib/new.ts\` (new) — helper.\n\n## Implementation plan\n`)
  assert.deepEqual(cardFiles(path), ['components/site/PartnerCTA.tsx', 'lib/new.ts'])
  rmSync(root, { recursive: true, force: true })
})

test('cardFiles takes only the first backtick token per Files bullet, not inline prose', () => {
  const { root, tasks } = planFixture()
  const path = join(tasks, 'review', 'T-01.md')
  writeFileSync(path, reviewCard('T-01', { files: ['public/app.js', 'public/ib-calc.css'] }))
  assert.deepEqual(cardFiles(path), ['public/app.js', 'public/ib-calc.css'])
  rmSync(root, { recursive: true, force: true })
})

test('cardEstimates falls back to a default review minutes, never crashes on a missing value', () => {
  const { root, tasks } = planFixture()
  const path = join(tasks, 'review', 'T-01.md')
  writeFileSync(path, '# T-01 — No estimates\n\n**Priority** 5/10\n\n## Files\n\n- `public/app.js`\n')
  const est = cardEstimates(path)
  assert.equal(est.build, null)
  assert.equal(est.review, 5, 'a card with no Est review value gets a sane fallback, not a crash')
  rmSync(root, { recursive: true, force: true })
})

test('review cards sharing a file are grouped into one batch; a solo card is bundled separately', () => {
  const { root, tasks } = planFixture()
  writeFileSync(join(tasks, 'review', 'T-01.md'), reviewCard('T-01', { files: ['public/app.js'], estReview: 5 }))
  writeFileSync(join(tasks, 'review', 'T-02.md'), reviewCard('T-02', { files: ['public/app.js'], estReview: 5 }))
  writeFileSync(join(tasks, 'review', 'T-03.md'), reviewCard('T-03', { files: ['public/other.js'], estReview: 5 }))

  const plan = computeReviewPlan({ tasksDir: tasks })
  const joint = plan.batches.find((b) => b.cards.includes('T-01'));
  assert.deepEqual(joint.cards.sort(), ['T-01', 'T-02'])
  assert.match(joint.reason, /public\/app\.js/, 'the reason names the shared file')

  const solo = plan.batches.find((b) => b.cards.includes('T-03'))
  assert.deepEqual(solo.cards, ['T-03'])
  assert.match(solo.reason, /no shared files, bundled to fill the batch/)
  rmSync(root, { recursive: true, force: true })
})

test('a joint group over the minute cap splits into multiple batches, in card order', () => {
  const { root, tasks } = planFixture()
  for (const id of ['T-01', 'T-02', 'T-03', 'T-04']) {
    writeFileSync(join(tasks, 'review', `${id}.md`), reviewCard(id, { files: ['public/app.js'], estReview: 8 }))
  }
  const plan = computeReviewPlan({ tasksDir: tasks })
  assert.equal(plan.batches.length, 2, '4 cards x 8m = 32m, over the 25m cap, so it must split')
  assert.deepEqual(plan.batches[0].cards, ['T-01', 'T-02', 'T-03'], '24m fits in the first batch')
  assert.deepEqual(plan.batches[1].cards, ['T-04'])
  assert.ok(plan.batches.every((b) => b.estMinutes <= REVIEW_BATCH_CAP_MINUTES))
  rmSync(root, { recursive: true, force: true })
})

test('an almost-finished Working card holds back its Review sibling; a far-from-done or no-estimate one does not', () => {
  const { root, tasks } = planFixture()
  const now = 1_000_000_000

  // T-10: 30m estimated build, started 25m ago -> 5m remaining, under the 10m threshold -> holds back
  writeFileSync(join(tasks, 'working', 'T-10.md'), reviewCard('T-10', { files: ['public/app.js'], estBuild: 30 }))
  bind(tasks, 'T-10', { pane_id: 'w1:p1', started: new Date(now - 25 * 60000).toISOString() })
  writeFileSync(join(tasks, 'review', 'T-11.md'), reviewCard('T-11', { files: ['public/app.js'], estReview: 5 }))

  // T-20: 30m estimated build, started 5m ago -> 25m remaining, well over the threshold -> does not hold back
  writeFileSync(join(tasks, 'working', 'T-20.md'), reviewCard('T-20', { files: ['public/other.js'], estBuild: 30 }))
  bind(tasks, 'T-20', { pane_id: 'w1:p2', started: new Date(now - 5 * 60000).toISOString() })
  writeFileSync(join(tasks, 'review', 'T-21.md'), reviewCard('T-21', { files: ['public/other.js'], estReview: 5 }))

  // T-30: no Est build at all -> never holds back, however long it has been running
  writeFileSync(join(tasks, 'working', 'T-30.md'), reviewCard('T-30', { files: ['public/legacy.js'] }))
  bind(tasks, 'T-30', { pane_id: 'w1:p3', started: new Date(now - 500 * 60000).toISOString() })
  writeFileSync(join(tasks, 'review', 'T-31.md'), reviewCard('T-31', { files: ['public/legacy.js'], estReview: 5 }))

  const plan = computeReviewPlan({ tasksDir: tasks, now })
  assert.deepEqual(plan.heldBack.map((h) => h.card), ['T-11'], 'only the almost-done sibling holds its card back')
  assert.equal(plan.heldBack[0].waitingOn, 'T-10')

  const planned = plan.batches.flatMap((b) => b.cards)
  assert.ok(!planned.includes('T-11'), 'T-11 must not appear in any batch this round')
  assert.ok(planned.includes('T-21'), 'T-21 is not held back — its sibling has plenty of time left')
  assert.ok(planned.includes('T-31'), 'T-31 is not held back — its sibling has no Est build at all')
  rmSync(root, { recursive: true, force: true })
})

test('spawnReviewer accepts an explicit cardIds subset, filtering the Review column rather than reviewing all of it', () => {
  const source = readFileSync(new URL('./lib/autospawn.mjs', import.meta.url), 'utf8')
  assert.match(source, /spawnReviewer\(\{[^}]*cardIds/, 'spawnReviewer must accept a cardIds param')
  assert.match(source, /wanted\.has\(c\.id\)/, 'when given, cardIds filters the Review column to that subset')
})

test('sweep-issues is wired through the circuit breaker exactly like Review', () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  const route = source.slice(source.indexOf("url.pathname === '/api/sweep-issues'"), source.indexOf("url.pathname === '/api/pane'"))
  assert.match(route, /breakerState\(p\)\.breakerTripped/, 'a tripped project breaker must refuse the sweep, same shape as Review')
  assert.match(route, /recordSpawn\(\{ project: p, cap: config\.maxConcurrentAgents \}\)/, 'a successful spawn must count toward its project breaker window')
  assert.match(route, /tripBreakerIfNeeded\(p\)/, 'a run of sweeps must be able to trip its project breaker like builders and the reviewer')
  assert.match(route, /config\.models\.issues/, 'the sweeper uses the configured issues model')
})

test('request usage records start and finish deltas by Codex session id', async () => {
  const { root, tasks } = fixture()
  const codex = join(root, '.codex')
  const logs = join(codex, 'sessions', '2026', '09', '10')
  mkdirSync(logs, { recursive: true })
  const session = '01usage-test'
  const log = join(logs, `rollout-${session}.jsonl`)
  writeFileSync(log,
    JSON.stringify({ timestamp: '2026-09-10T00:00:00.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 110 } } } }) + '\n')

  recordUsageStart({
    tasksDir: tasks, project: 'Injectbuddy', requestId: 'T-04', cardIds: ['T-04'], role: 'builder',
    paneId: 'w1:p1', model: 'gpt-5.5', agentSession: { agent: 'codex', value: session }, root: codex,
  })
  appendFileSync(log,
    JSON.stringify({ timestamp: '2026-09-10T00:01:00.000Z', ordinal: 2, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 250, cached_input_tokens: 120, output_tokens: 40, reasoning_output_tokens: 9, total_tokens: 290 } } } }) + '\n' +
    JSON.stringify({ timestamp: '2026-09-10T00:01:01.000Z', ordinal: 3, type: 'event_msg', payload: { type: 'task_complete' } }) + '\n')
  await recordUsageFinish({
    tasksDir: tasks, paneId: 'w1:p1', agent: { agent_session: { agent: 'codex', value: session } },
    status: 'complete', root: codex,
  })

  assert.deepEqual(usageSummary(tasks)[0].tokens, {
    input: 150, cachedInput: 60, uncachedInput: 90, output: 30, reasoningOutput: 6, total: 180,
  })
  rmSync(root, { recursive: true, force: true })
})

test('request usage keeps reused Codex sessions as separate request runs', async () => {
  const { root, tasks } = fixture()
  const codex = join(root, '.codex')
  const logs = join(codex, 'sessions')
  mkdirSync(logs, { recursive: true })
  const session = '01usage-reused'
  const log = join(logs, `${session}.jsonl`)
  const row = (ordinal, input, cached, output) =>
    JSON.stringify({ timestamp: `2026-09-10T00:0${ordinal}:00.000Z`, ordinal, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } } } }) + '\n'

  writeFileSync(log, row(1, 100, 50, 10))
  const first = recordUsageStart({ tasksDir: tasks, project: 'Kanban', requestId: 'REQ-1', role: 'manager', paneId: 'p1', agentSession: { agent: 'codex', value: session }, root: codex })
  appendFileSync(log, row(2, 160, 80, 20) + JSON.stringify({ timestamp: '2026-09-10T00:02:01.000Z', ordinal: 3, payload: { type: 'task_complete' } }) + '\n')
  await recordUsageFinish({ tasksDir: tasks, runId: first.runId, status: 'complete', root: codex })

  const second = recordUsageStart({ tasksDir: tasks, project: 'Kanban', requestId: 'REQ-2', role: 'manager', paneId: 'p1', agentSession: { agent: 'codex', value: session }, root: codex })
  appendFileSync(log, row(4, 260, 120, 50) + JSON.stringify({ timestamp: '2026-09-10T00:04:01.000Z', ordinal: 5, payload: { type: 'task_complete' } }) + '\n')
  await recordUsageFinish({ tasksDir: tasks, runId: second.runId, status: 'complete', root: codex })

  const rows = usageSummary(tasks)
  assert.deepEqual(rows.map((r) => r.requestId), ['REQ-1', 'REQ-2'])
  assert.equal(rows[0].tokens.total, 70)
  assert.equal(rows[1].tokens.total, 130)
  rmSync(root, { recursive: true, force: true })
})

test('request usage records unknown sessions instead of dropping assignments', () => {
  const { root, tasks } = fixture()
  recordUsageStart({ tasksDir: tasks, project: 'Kanban', requestId: 'REQ-unknown', role: 'manual', paneId: 'p1' })
  const [row] = usageSummary(tasks)
  assert.equal(row.requestId, 'REQ-unknown')
  assert.equal(row.active, 1)
  assert.equal(row.agents[0].status, 'unknown_session')
  rmSync(root, { recursive: true, force: true })
})



test('request usage finish keeps missing-session usage unknown instead of zero', async () => {
  const { root, tasks } = fixture()
  const run = recordUsageStart({ tasksDir: tasks, project: 'Kanban', requestId: 'REQ-missing-session', role: 'manual', paneId: 'p1' })
  await recordUsageFinish({ tasksDir: tasks, runId: run.runId, status: 'complete' })
  const [row] = usageSummary(tasks)
  assert.equal(row.tokens, null)
  assert.equal(row.unknown, 1)
  assert.equal(row.agents[0].tokens, null)
  rmSync(root, { recursive: true, force: true })
})

test('request usage does not use a missing start snapshot as a zero baseline', async () => {
  const { root, tasks } = fixture()
  const codex = join(root, '.codex')
  const logs = join(codex, 'sessions')
  mkdirSync(logs, { recursive: true })
  const session = '01usage-missing-start'
  const log = join(logs, `${session}.jsonl`)
  const run = recordUsageStart({ tasksDir: tasks, project: 'Kanban', requestId: 'REQ-missing-start', role: 'manager', paneId: 'p1', agentSession: { agent: 'codex', value: session }, root: codex })
  writeFileSync(log,
    JSON.stringify({ timestamp: '2026-09-10T00:01:00.000Z', ordinal: 1, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 400, output_tokens: 25, reasoning_output_tokens: 5, total_tokens: 525 } } } }) + '\n' +
    JSON.stringify({ timestamp: '2026-09-10T00:01:01.000Z', ordinal: 2, payload: { type: 'task_complete' } }) + '\n')
  await recordUsageFinish({ tasksDir: tasks, runId: run.runId, status: 'complete', root: codex })
  const [row] = usageSummary(tasks, { root: codex })
  assert.equal(row.tokens, null)
  assert.equal(row.unknown, 1)
  assert.equal(row.agents[0].tokens, null)
  rmSync(root, { recursive: true, force: true })
})

test('request usage marks counter resets instead of inventing a negative delta', () => {
  const start = { counters: { input: 50, cachedInput: 20, uncachedInput: 30, output: 10, reasoningOutput: 1, total: 60 } }
  const finish = { counters: { input: 20, cachedInput: 10, uncachedInput: 10, output: 3, reasoningOutput: 1, total: 23 } }
  assert.deepEqual(usageDelta(start, finish), { status: 'counter_reset', counters: null })
})

test('tokenSnapshots reads cumulative token_count rows in JSONL order', () => {
  const { root } = fixture()
  const codex = join(root, '.codex')
  const logs = join(codex, 'sessions')
  mkdirSync(logs, { recursive: true })
  const session = '01usage-order'
  writeFileSync(join(logs, `${session}.jsonl`), [
    JSON.stringify({ timestamp: '2026-09-10T00:00:00.000Z', ordinal: 7, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 11, cached_input_tokens: 5, output_tokens: 2, reasoning_output_tokens: 1, total_tokens: 13 } } } }),
    JSON.stringify({ timestamp: '2026-09-10T00:02:00.000Z', ordinal: 9, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 20, cached_input_tokens: 6, output_tokens: 4, reasoning_output_tokens: 1, total_tokens: 24 } } } }),
  ].join('\n'))
  assert.equal(tokenSnapshots(session, { root: codex }).length, 2)
  assert.equal(latestTokenSnapshot(session, { root: codex, beforeOrdinal: 7 }).counters.uncachedInput, 6)
  rmSync(root, { recursive: true, force: true })
})





test('request usage maps a card assignment to its explicit parent REQ reference', () => {
  const { root, tasks } = fixture()
  const dir = join(tasks, 'backlog')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'T-81-render-blocking-rail-css-on-mobile.md'), '# T-81\n\nREQ-20260910-015 authorizes this existing plan.\n')
  const run = recordUsageStart({ tasksDir: tasks, project: 'Injectbuddy', requestId: 'T-81', cardIds: ['T-81'], role: 'builder', paneId: 'p1' })
  assert.equal(run.requestId, 'REQ-20260910-015')
  assert.equal(run.sourceRequestId, 'T-81')
  assert.deepEqual(usageSummary(tasks).map((r) => r.requestId), ['REQ-20260910-015'])
  rmSync(root, { recursive: true, force: true })
})



test('request usage keeps same-parent card batches attributable to that REQ', async () => {
  const { root, tasks } = fixture()
  const codex = join(root, '.codex')
  const logs = join(codex, 'sessions')
  const dir = join(tasks, 'review')
  mkdirSync(logs, { recursive: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'T-1-a.md'), '# T-1\n\nREQ-20260910-001 source.\n')
  writeFileSync(join(dir, 'T-2-b.md'), '# T-2\n\nREQ-20260910-001 source.\n')
  const session = '01usage-sameparent'
  const log = join(logs, `${session}.jsonl`)
  writeFileSync(log, JSON.stringify({ timestamp: '2026-09-10T00:00:00.000Z', ordinal: 1, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 10 } } } }) + '\n')
  const run = recordUsageStart({ tasksDir: tasks, project: 'Injectbuddy', requestId: 'review:T-1,T-2', cardIds: ['T-1', 'T-2'], role: 'reviewer', paneId: 'p1', agentSession: { agent: 'codex', value: session }, root: codex })
  appendFileSync(log,
    JSON.stringify({ timestamp: '2026-09-10T00:00:01.000Z', ordinal: 2, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 40, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 1, total_tokens: 45 } } } }) + '\n' +
    JSON.stringify({ timestamp: '2026-09-10T00:00:02.000Z', ordinal: 3, payload: { type: 'task_complete' } }) + '\n')
  await recordUsageFinish({ tasksDir: tasks, runId: run.runId, status: 'complete', root: codex })
  const [row] = usageSummary(tasks, { root: codex })
  assert.equal(row.requestId, 'REQ-20260910-001')
  assert.equal(row.tokens.total, 35)
  assert.equal(row.sharedTokens, null)
  rmSync(root, { recursive: true, force: true })
})

test('request usage treats mixed known and unknown parent batches as shared unattributed', async () => {
  const { root, tasks } = fixture()
  const codex = join(root, '.codex')
  const logs = join(codex, 'sessions')
  const dir = join(tasks, 'review')
  mkdirSync(logs, { recursive: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'T-1-a.md'), '# T-1\n\nREQ-20260910-001 source.\n')
  writeFileSync(join(dir, 'T-2-b.md'), '# T-2\n\nNo parent request recorded.\n')
  const session = '01usage-mixedparent'
  const log = join(logs, `${session}.jsonl`)
  writeFileSync(log, JSON.stringify({ timestamp: '2026-09-10T00:00:00.000Z', ordinal: 1, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 10 } } } }) + '\n')
  const run = recordUsageStart({ tasksDir: tasks, project: 'Injectbuddy', requestId: 'review:T-1,T-2', cardIds: ['T-1', 'T-2'], role: 'reviewer', paneId: 'p1', agentSession: { agent: 'codex', value: session }, root: codex })
  appendFileSync(log,
    JSON.stringify({ timestamp: '2026-09-10T00:00:01.000Z', ordinal: 2, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 40, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 1, total_tokens: 45 } } } }) + '\n' +
    JSON.stringify({ timestamp: '2026-09-10T00:00:02.000Z', ordinal: 3, payload: { type: 'task_complete' } }) + '\n')
  await recordUsageFinish({ tasksDir: tasks, runId: run.runId, status: 'complete', root: codex })
  const [row] = usageSummary(tasks, { root: codex })
  assert.equal(row.requestId, 'review:T-1,T-2')
  assert.equal(row.tokens, null)
  assert.equal(row.sharedTokens.total, 35)
  assert.equal(row.agents[0].sharedReason, 'unknown_parent_batch')
  rmSync(root, { recursive: true, force: true })
})

test('request usage reports multi-parent batches as shared overhead under each REQ', async () => {
  const { root, tasks } = fixture()
  const codex = join(root, '.codex')
  const logs = join(codex, 'sessions')
  const dir = join(tasks, 'review')
  mkdirSync(logs, { recursive: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'T-1-a.md'), '# T-1\n\nREQ-20260910-001 source.\n')
  writeFileSync(join(dir, 'T-2-b.md'), '# T-2\n\nREQ-20260910-002 source.\n')
  const session = '01usage-multiparent'
  const log = join(logs, `${session}.jsonl`)
  writeFileSync(log, JSON.stringify({ timestamp: '2026-09-10T00:00:00.000Z', ordinal: 1, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 10 } } } }) + '\n')
  const run = recordUsageStart({ tasksDir: tasks, project: 'Injectbuddy', requestId: 'review:T-1,T-2', cardIds: ['T-1', 'T-2'], role: 'reviewer', paneId: 'p1', agentSession: { agent: 'codex', value: session }, root: codex })
  appendFileSync(log,
    JSON.stringify({ timestamp: '2026-09-10T00:00:01.000Z', ordinal: 2, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 40, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 1, total_tokens: 45 } } } }) + '\n' +
    JSON.stringify({ timestamp: '2026-09-10T00:00:02.000Z', ordinal: 3, payload: { type: 'task_complete' } }) + '\n')
  await recordUsageFinish({ tasksDir: tasks, runId: run.runId, status: 'complete', root: codex })
  const rows = usageSummary(tasks, { root: codex })
  assert.deepEqual(rows.map((r) => r.requestId), ['REQ-20260910-001', 'REQ-20260910-002'])
  assert.equal(rows[0].tokens, null)
  assert.equal(rows[0].sharedTokens.total, 35)
  assert.equal(rows[1].tokens, null)
  assert.equal(rows[1].sharedTokens.total, 35)
  assert.equal(rows[0].agents[0].sharedReason, 'cross_request_batch')
  rmSync(root, { recursive: true, force: true })
})

test('request usage waits for task_complete before closing a complete run', async () => {
  const { root, tasks } = fixture()
  const codex = join(root, '.codex')
  const logs = join(codex, 'sessions')
  mkdirSync(logs, { recursive: true })
  const session = '01usage-late-final'
  const log = join(logs, `${session}.jsonl`)
  const token = (ordinal, input, cached, output) =>
    JSON.stringify({ timestamp: `2026-09-10T00:00:0${ordinal}.000Z`, ordinal, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } } } }) + '\n'
  writeFileSync(log, token(1, 100, 10, 5))
  const run = recordUsageStart({ tasksDir: tasks, project: 'Kanban', requestId: 'REQ-late', role: 'manager', paneId: 'p1', agentSession: { agent: 'codex', value: session }, root: codex })
  appendFileSync(log, token(2, 150, 20, 15))

  await recordUsageFinish({ tasksDir: tasks, runId: run.runId, status: 'complete', root: codex })
  let [row] = usageSummary(tasks, { root: codex })
  assert.equal(row.tokens, null)
  assert.equal(row.pending, 1)
  assert.equal(row.unknown, 1)

  appendFileSync(log, token(3, 175, 25, 35) + JSON.stringify({ timestamp: '2026-09-10T00:00:04.000Z', ordinal: 4, payload: { type: 'task_complete' } }) + '\n')
  row = usageSummary(tasks, { root: codex })[0]
  assert.equal(row.pending, 0)
  assert.equal(row.tokens.total, 105)
  assert.equal(row.tokens.output, 30)
  rmSync(root, { recursive: true, force: true })
})

test('request usage excludes overlapping shared runs from attributable request totals', async () => {
  const { root, tasks } = fixture()
  const codex = join(root, '.codex')
  const logs = join(codex, 'sessions')
  mkdirSync(logs, { recursive: true })
  const session = '01usage-shared'
  const log = join(logs, `${session}.jsonl`)
  const token = (ordinal, total) =>
    JSON.stringify({ timestamp: `2026-09-10T00:00:0${ordinal}.000Z`, ordinal, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total } } } }) + '\n'
  writeFileSync(log, token(1, 100))
  const first = recordUsageStart({ tasksDir: tasks, project: 'Kanban', requestId: 'REQ-A', role: 'manager', paneId: 'p1', agentSession: { agent: 'codex', value: session }, root: codex })
  appendFileSync(log, token(2, 120))
  const second = recordUsageStart({ tasksDir: tasks, project: 'Kanban', requestId: 'REQ-B', role: 'manager', paneId: 'p2', agentSession: { agent: 'codex', value: session }, root: codex })
  appendFileSync(log, token(3, 180) + JSON.stringify({ timestamp: '2026-09-10T00:00:04.000Z', ordinal: 4, payload: { type: 'task_complete' } }) + '\n')

  await recordUsageFinish({ tasksDir: tasks, runId: first.runId, status: 'complete', root: codex })
  await recordUsageFinish({ tasksDir: tasks, runId: second.runId, status: 'complete', root: codex })
  const rows = usageSummary(tasks, { root: codex })
  assert.equal(rows[0].tokens, null)
  assert.equal(rows[0].sharedTokens.total, 80)
  assert.equal(rows[1].tokens, null)
  assert.equal(rows[1].sharedTokens.total, 60)
  rmSync(root, { recursive: true, force: true })
})

test('Manager Tasks screen has a sortable usage column and expandable agent rows', () => {
  const source = readFileSync(new URL('./public/board.js', import.meta.url), 'utf8')
  assert.match(source, /\['usage', 'Usage'\]/)
  assert.match(source, /managerTaskOpen/)
  assert.match(source, /formatAgentUsage/)
  assert.match(source, /if \(!u \|\| !u\.tokens\) return 'Unknown'/)
  assert.doesNotMatch(source, /u\.tokens\?\.total \?\? 0/)
  assert.match(source, /key === 'usage'[\s\S]{0,140}tokens \? taskUsage\(task\)\.tokens.total : -1/)
})



test('tracked HERDR assignment wrapper fails closed before prompt if usage start fails', () => {
  const source = readFileSync('C:/Users/PFrew/herdr-roles.ps1', 'utf8')
  assert.match(source, /request usage start failed before prompt; assignment was not sent/)
  assert.match(source, /assignment ended \$status but usage finish logging failed/)
  assert.ok(source.indexOf("Invoke-HerdrUsageApi -Path '/api/request-usage/start'") < source.indexOf("agent', 'prompt'"))
})

test('Manager Tasks API carries usage summaries without hiding unknown attribution', () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.match(source, /usageSummary\(tasksDirOf\(p\)\)/)
  assert.match(source, /url\.pathname === '\/api\/request-usage\/start'/)
  assert.match(source, /requestId is required/)
  assert.match(source, /url\.pathname === '\/api\/request-usage\/finish'/)
})

test('cycle hold is reported before generic unmet dependency', () => {
  const board = {
    queue: [
      { id: 'T-01', file: 'T-01.md', column: 'queue', blockedBy: ['T-02'] },
      { id: 'T-02', file: 'T-02.md', column: 'queue', blockedBy: ['T-01'] },
    ],
    archive: [],
  }
  const reason = startHoldReason({
    card: board.queue[0], board, projectPath: 'C:\\tmp\\Proj', tasksDir: 'C:\\missing',
  })
  assert.equal(reason, 'dependency cycle detected')
})

test('duplicate issue keys hold both live cards without merging them', () => {
  const board = {
    queue: [
      { id: 'T-01', file: 'T-01.md', column: 'queue', blockedBy: [], issueKey: 'route|click|boom' },
      { id: 'T-02', file: 'T-02.md', column: 'queue', blockedBy: [], issueKey: 'route|click|boom' },
    ],
    archive: [],
  }
  assert.match(startHoldReason({
    card: board.queue[0], board, projectPath: 'C:\\tmp\\Proj', tasksDir: 'C:\\missing',
  }), /duplicate issue key route\|click\|boom/)
})

test('mission Planned promotion is scoped to project and exact Mission id', () => {
  const { root, tasks } = fixture()
  writeFileSync(join(tasks, 'backlog', 'T-18-mission.md'),
    '# T-18 — Mission\n\n**Mission:** IB-AUDIT-20260908\n')
  writeFileSync(join(tasks, 'backlog', 'T-19-other.md'),
    '# T-19 — Other\n\n**Mission:** OTHER\n')

  assert.deepEqual(promotePlanned(tasks, {
    project: 'Tradeflow',
    mission: { id: 'IB-AUDIT-20260908', project: 'Injectbuddy' },
  }), [])
  assert.deepEqual(promotePlanned(tasks, {
    project: 'Injectbuddy',
    mission: { id: 'IB-AUDIT-20260908', project: 'Injectbuddy' },
  }), ['T-18'])
  assert.ok(readBoard(tasks).queue.some((c) => c.id === 'T-18'))
  assert.ok(readBoard(tasks).planned.some((c) => c.id === 'T-19'))
  rmSync(root, { recursive: true, force: true })
})

test('mission build attempts are durable and total budget is recomputed from cards', () => {
  const { root, tasks } = fixture()
  writeFileSync(join(tasks, 'queue', 'T-18-mission.md'),
    '# T-18 — Mission\n\n**Mission:** IB-AUDIT-20260908\n')
  appendBuildAttempt(findCard(tasks, 'T-18'))
  const after = readBoard(tasks)
  const card = Object.values(after).flat().find((c) => c.id === 'T-18')
  assert.equal(card.buildAttempts, 1, 'failed startup still consumes the reserved attempt')
  assert.match(startHoldReason({ card, board: after, projectPath: root, tasksDir: tasks, mission: { id: 'IB-AUDIT-20260908', maxBuilds: 1 } }),
    /mission build budget exhausted/)
  rmSync(root, { recursive: true, force: true })
})

test('mission issue handoff moves only matching Issues to Planning and leaves Owner alone', () => {
  const { root, tasks } = fixture()
  for (const d of ['issues', 'owner', 'planning']) mkdirSync(join(tasks, d), { recursive: true })
  writeFileSync(join(tasks, 'issues', 'T-20-mission.md'), '# T-20 — Mission issue\n\n**Mission:** IB-AUDIT-20260908\n')
  writeFileSync(join(tasks, 'issues', 'T-21-old.md'), '# T-21 — Old issue\n')
  writeFileSync(join(tasks, 'owner', 'T-22-owner.md'), '# T-22 — Owner\n\n**Mission:** IB-AUDIT-20260908\n')

  assert.deepEqual(missionIssueHandoff(tasks, { id: 'IB-AUDIT-20260908' }), ['T-20'])
  const board = readBoard(tasks)
  assert.ok(board.planning.some((c) => c.id === 'T-20'))
  assert.ok(board.issues.some((c) => c.id === 'T-21'))
  assert.ok(board.owner.some((c) => c.id === 'T-22'))
  rmSync(root, { recursive: true, force: true })
})

test('mission cards cannot be archived without reviewer evidence and PASS', () => {
  const { root, tasks } = fixture()
  mkdirSync(join(tasks, 'review'), { recursive: true })
  writeFileSync(join(tasks, 'review', 'T-20-mission.md'), '# T-20 — Mission\n\n**Mission:** IB-AUDIT-20260908\n')
  assert.throws(() => moveCard(tasks, 'T-20', 'archive'), /Reviewer evidence/)

  appendReviewPass(findCard(tasks, 'T-20'), 'Ran browser check, screenshot: artifacts/t20.png')
  moveCard(tasks, 'T-20', 'archive')
  assert.ok(readBoard(tasks).archive.some((c) => c.id === 'T-20'))
  rmSync(root, { recursive: true, force: true })
})

test('older PASS is stale after later review feedback or build attempt', () => {
  const { root, tasks } = fixture()
  mkdirSync(join(tasks, 'review'), { recursive: true })
  const path = join(tasks, 'review', 'T-78-stale-pass.md')
  writeFileSync(path, `# T-78 - Stale pass

**Mission:** IB-AUDIT-20260908

---

## Reviewer evidence

old pass evidence

**Review verdict:** PASS 2026-09-08T00:00:00.000Z

---

**Review feedback** 2026-09-08T01:00:00.000Z

later criterion fails

---

## Evidence

builder changed after the failed review
`)
  assert.equal(canArchive(findCard(tasks, 'T-78')), false)
  assert.throws(() => moveCard(tasks, 'T-78', 'archive'), /Reviewer evidence/)

  appendReviewPass(findCard(tasks, 'T-78'), 'Fresh independent check after the later build.')
  assert.equal(canArchive(findCard(tasks, 'T-78')), true)
  rmSync(root, { recursive: true, force: true })
})

test('hkb pass requires an already-current PASS on a Review card and does not write proof from its note', () => {
  const { root, tasks } = fixture()
  mkdirSync(join(tasks, 'review'), { recursive: true })
  writeFileSync(join(tasks, 'review', 'T-20-mission.md'), '# T-20 — Mission\n\n**Mission:** IB-AUDIT-20260908\n')

  let result = spawnSync(process.execPath, [join(process.cwd(), 'hkb.mjs'), 'pass', 'T-20', 'note is not proof'], {
    cwd: root, encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /current nonempty Reviewer evidence/)
  assert.doesNotMatch(readFileSync(join(tasks, 'review', 'T-20-mission.md'), 'utf8'), /note is not proof/)

  appendReviewPass(findCard(tasks, 'T-20'), 'Independent browser evidence exists before hkb pass.')
  result = spawnSync(process.execPath, [join(process.cwd(), 'hkb.mjs'), 'pass', 'T-20'], {
    cwd: root, encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(readBoard(tasks).completed.some((c) => c.id === 'T-20'))
  rmSync(root, { recursive: true, force: true })
})

test('review verdict routing completes only current evidenced PASS and is idempotent', () => {
  const { root, tasks } = fixture()
  mkdirSync(join(tasks, 'review'), { recursive: true })
  writeFileSync(join(tasks, 'review', 'T-20-pass.md'), '# T-20 — Pass\n\n**Mission:** IB-AUDIT-20260908\n')
  appendReviewPass(findCard(tasks, 'T-20'), 'Independent browser evidence covers the acceptance criteria.')

  assert.deepEqual(routeReviewVerdicts(tasks), [{ id: 'T-20', to: 'completed', verdict: 'PASS' }])
  assert.ok(readBoard(tasks).completed.some((c) => c.id === 'T-20'))
  assert.deepEqual(routeReviewVerdicts(tasks), [], 'a restart/repeated tick does not route it twice')
  rmSync(root, { recursive: true, force: true })
})

test('review verdict routing sends evidenced planning FAIL to Planning with actionable feedback', () => {
  const { root, tasks } = fixture()
  mkdirSync(join(tasks, 'review'), { recursive: true })
  writeFileSync(join(tasks, 'review', 'T-20-fail.md'), `# T-20 — Fail

**Mission:** IB-AUDIT-20260908

---

## Reviewer evidence

[planning] Plan omitted the required mobile flow.

**Review verdict:** FAIL 2026-09-10T00:00:00.000Z
`)

  assert.deepEqual(routeReviewVerdicts(tasks), [{ id: 'T-20', to: 'planning', verdict: 'FAIL' }])
  const card = findCard(tasks, 'T-20')
  assert.equal(card.column, 'planning')
  assert.match(readFileSync(card.path, 'utf8'), /\*\*Review feedback\*\*/)
  rmSync(root, { recursive: true, force: true })
})

test('review verdict routing preserves UNKNOWN in Review or explicit Owner without inventing FAIL', () => {
  const { root, tasks } = fixture()
  mkdirSync(join(tasks, 'review'), { recursive: true })
  writeFileSync(join(tasks, 'review', 'T-20-unknown.md'), `# T-20 — Unknown

**Mission:** IB-AUDIT-20260908

## Reviewer evidence

Evidence is insufficient to prove persistence; another agent can rerun the browser proof.

**Review verdict:** UNKNOWN 2026-09-10T00:00:00.000Z
`)
  writeFileSync(join(tasks, 'review', 'T-21-owner.md'), `# T-21 — Owner

**Mission:** IB-AUDIT-20260908

## Reviewer evidence

Only the operator can grant staging account access. Verified missing permission; approved methods exhausted. Evidence: approved staging helper returned permission denied.

**Review verdict:** UNKNOWN 2026-09-10T00:00:00.000Z
`)
  writeFileSync(join(tasks, 'review', 'T-22-negated-owner.md'), `# T-22 — Negated

**Mission:** IB-AUDIT-20260908

## Reviewer evidence

It is not true that only the operator can grant staging account access needed to verify this criterion.

**Review verdict:** UNKNOWN 2026-09-10T00:00:00.000Z
`)

  assert.deepEqual(routeReviewVerdicts(tasks), [
    { id: 'T-21', to: 'owner', verdict: 'UNKNOWN' },
  ])
  const issues = findCard(tasks, 'T-20')
  const owner = findCard(tasks, 'T-21')
  assert.equal(issues.column, 'review')
  assert.equal(owner.column, 'owner')
  assert.match(readFileSync(issues.path, 'utf8'), /Review verdict:\*\* UNKNOWN/)
  assert.doesNotMatch(readFileSync(issues.path, 'utf8'), /Review verdict:\*\* FAIL/)
  assert.match(readFileSync(owner.path, 'utf8'), /\*\*Needs you\*\*/)
  assert.equal(findCard(tasks, 'T-22').column, 'review')
  rmSync(root, { recursive: true, force: true })
})

test('review verdict routing leaves missing evidence, blank verdict and stale verdicts in Review', () => {
  const { root, tasks } = fixture()
  mkdirSync(join(tasks, 'review'), { recursive: true })
  writeFileSync(join(tasks, 'review', 'T-21-missing.md'), `# T-21 — Missing

**Mission:** IB-AUDIT-20260908

## Reviewer evidence

TODO

**Review verdict:** PASS 2026-09-10T00:00:00.000Z
`)
  writeFileSync(join(tasks, 'review', 'T-22-blank.md'), `# T-22 — Blank

**Mission:** IB-AUDIT-20260908

## Reviewer evidence

Real notes, but no terminal verdict.
`)
  writeFileSync(join(tasks, 'review', 'T-23-stale.md'), `# T-23 — Stale

**Mission:** IB-AUDIT-20260908

## Reviewer evidence

Old independent proof.

**Review verdict:** PASS 2026-09-10T00:00:00.000Z

---

**Review feedback** 2026-09-10T01:00:00.000Z

Later failure resets the verdict.
`)

  assert.deepEqual(routeReviewVerdicts(tasks), [])
  assert.deepEqual(readBoard(tasks).review.map((c) => c.id).sort(), ['T-21', 'T-22', 'T-23'])
  rmSync(root, { recursive: true, force: true })
})

test('review verdict routing skips ambiguous duplicate live ids instead of archiving by luck', () => {
  const { root, tasks } = fixture()
  mkdirSync(join(tasks, 'review'), { recursive: true })
  mkdirSync(join(tasks, 'issues'), { recursive: true })
  writeFileSync(join(tasks, 'review', 'T-20-pass.md'), '# T-20 — Pass\n\n**Mission:** IB-AUDIT-20260908\n')
  writeFileSync(join(tasks, 'issues', 'T-20-duplicate.md'), '# T-20 — Duplicate\n')
  appendReviewPass(parseCard(join(tasks, 'review', 'T-20-pass.md'), 'review'), 'Independent proof exists.')

  const logs = []
  assert.deepEqual(routeReviewVerdicts(tasks, { log: (msg) => logs.push(msg) }), [])
  assert.match(logs.join('\n'), /ambiguous/)
  assert.ok(readBoard(tasks).review.some((c) => c.id === 'T-20'))
  rmSync(root, { recursive: true, force: true })
})

const pollDirs = ['owner', 'planning', 'backlog', 'queue', 'working', 'issues', 'completed', 'review', 'archive']

async function waitUntil(fn, label) {
  const deadline = Date.now() + 5000
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await delay(50)
  }
  assert.fail(`${label} timed out; last=${JSON.stringify(last)}`)
}

async function startPollServer({ cards, extra = {}, agents = [], mode = 'auto', autoQueuePlanned = false, maxConcurrentAgents = 0, cardColumn = 'review', leadPlanner = { autoIssues: false } }) {
  const root = mkdtempSync(join(tmpdir(), 'hkb-server-'))
  const projectsRoot = join(root, 'projects')
  const tasks = join(projectsRoot, 'TASKS')
  const herdrState = join(root, 'herdr-state.json')
  const resolvedAgents = typeof agents === 'function' ? agents({ root, projectsRoot, tasks }) : agents
  for (const d of pollDirs) mkdirSync(join(tasks, d), { recursive: true })
  for (const [file, text] of Object.entries(cards)) writeFileSync(join(tasks, cardColumn, file), text)
  for (const [dir, files] of Object.entries(extra)) {
    mkdirSync(join(tasks, dir), { recursive: true })
    for (const [file, text] of Object.entries(files)) writeFileSync(join(tasks, dir, file), text)
  }
  writeFileSync(herdrState, JSON.stringify({ agents: resolvedAgents, panes: {}, events: [], nextPane: 1, nextTab: 1 }))

  writeFileSync(join(root, 'agent'),
    `import { readFileSync, writeFileSync } from 'node:fs';\n` +
    `const statePath = ${JSON.stringify(herdrState)};\n` +
    `const state = JSON.parse(readFileSync(statePath, 'utf8'));\n` +
    `const args = process.argv.slice(2);\n` +
    `if (args[0] === 'list') console.log(JSON.stringify({ result: { agents: state.agents } }));\n` +
    `else if (args[0] === 'start') { const name = args[1]; const pane = args[args.indexOf('--pane') + 1]; state.agents.push({ pane_id: pane, name, cwd: state.panes[pane]?.cwd || process.cwd(), agent_status: 'idle', workspace_id: 'wa' }); state.events.push(['agent start', name, pane]); writeFileSync(statePath, JSON.stringify(state)); console.log(JSON.stringify({ result: {} })); }\n` +
    `else if (args[0] === 'prompt') { const target = args[1]; for (const a of state.agents) if (a.pane_id === target || a.name === target) a.agent_status = 'working'; state.events.push(['agent prompt', target]); writeFileSync(statePath, JSON.stringify(state)); console.log(JSON.stringify({ result: {} })); }\n` +
    `else console.log(JSON.stringify({ result: {} }));\n`)
  writeFileSync(join(root, 'workspace'),
    `if (process.argv[2] === 'list') console.log(JSON.stringify({ result: { workspaces: [{ label: 'agents', workspace_id: 'wa' }] } }));\n` +
    `else console.log(JSON.stringify({ result: { workspace: { workspace_id: 'wa' } } }));\n`)
  writeFileSync(join(root, 'tab'),
    `import { readFileSync, writeFileSync } from 'node:fs';\n` +
    `const statePath = ${JSON.stringify(herdrState)};\n` +
    `const state = JSON.parse(readFileSync(statePath, 'utf8'));\n` +
    `const args = process.argv.slice(2);\n` +
    `const pane = 'w1:p' + state.nextPane++;\n` +
    `const tab = 'w1:t' + state.nextTab++;\n` +
    `state.panes[pane] = { cwd: args[args.indexOf('--cwd') + 1] || process.cwd() };\n` +
    `state.events.push(['tab create', pane]);\n` +
    `writeFileSync(statePath, JSON.stringify(state));\n` +
    `console.log(JSON.stringify({ result: { root_pane: { pane_id: pane, tab_id: tab }, tab: { tab_id: tab } } }));\n`)
  writeFileSync(join(root, 'pane'),
    `const args = process.argv.slice(2);\n` +
    `if (args[0] === 'read') console.log(JSON.stringify({ result: { output: 'PS test>' } }));\n` +
    `else console.log(JSON.stringify({ result: {} }));\n`)
  writeFileSync(join(root, 'log'), `console.log(JSON.stringify({ result: {} }));\n`)

  const port = 22000 + Math.floor(Math.random() * 20000)
  const configPath = join(root, 'board.config.json')
  writeFileSync(configPath, JSON.stringify({
    port,
    mode,
    autoQueuePlanned,
    projectsRoot,
    projects: [''],
    maxConcurrentAgents,
    agentWorkspace: 'agents',
    stallSeconds: 300,
    agentPollMs: 50,
    engine: { kind: 'codex' },
    models: { planning: 'gpt-5.6-luna', working: 'gpt-5.6-luna', issues: 'gpt-5.6-luna', review: 'gpt-5.6-luna' },
    leadPlanner,
  }))

  const server = spawn(process.execPath, [join(process.cwd(), 'server.mjs')], {
    cwd: root,
    env: { ...process.env, KANBAN_CONFIG: configPath, HERDR_BIN_PATH: process.execPath, HERDR_TEST_AGENTS: JSON.stringify(resolvedAgents) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  server.stdout.on('data', (d) => { output += d })
  server.stderr.on('data', (d) => { output += d })
  const stop = async () => {
    if (server.exitCode == null) {
      server.kill()
      await Promise.race([new Promise((r) => server.once('exit', r)), delay(1000)])
    }
    // In-flight mock CLI children can briefly retain the fixture cwd on Windows.
    await delay(200)
  }

  try {
    await waitUntil(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/api/board`)).ok
      } catch {
        if (server.exitCode != null) assert.fail(output)
        return false
      }
    }, 'server start')
  } catch (err) {
    await stop()
    rmSync(root, { recursive: true, force: true })
    throw err
  }
  return { root, tasks, projectsRoot, configPath, port, stop, output: () => output, herdrState }
}

async function restartPollServer(run, agents = []) {
  const server = spawn(process.execPath, [join(process.cwd(), 'server.mjs')], {
    cwd: run.root,
    env: { ...process.env, KANBAN_CONFIG: run.configPath, HERDR_BIN_PATH: process.execPath, HERDR_TEST_AGENTS: JSON.stringify(agents) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  server.stdout.on('data', (d) => { output += d })
  server.stderr.on('data', (d) => { output += d })
  const stop = async () => {
    if (server.exitCode == null) {
      server.kill()
      await Promise.race([new Promise((r) => server.once('exit', r)), delay(1000)])
    }
  }
  try {
    await waitUntil(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${run.port}/api/board`)).ok
      } catch {
        if (server.exitCode != null) assert.fail(output)
        return false
      }
    }, 'server restart')
  } catch (err) {
    await stop()
    throw err
  }
  return stop
}

const reviewText = (id, evidence, verdict = 'UNKNOWN') => `# ${id} — Review

**Mission:** IB-AUDIT-20260908

---

## Reviewer evidence

${evidence}

${verdict ? `**Review verdict:** ${verdict} 2026-09-10T00:00:00.000Z\n` : ''}`

test('running manager poll with cap zero leaves disposable Planned and Completed cards untouched', async () => {
  const run = await startPollServer({
    mode: 'manager',
    maxConcurrentAgents: 0,
    cardColumn: 'completed',
    cards: { 'T-40-done.md': '# T-40 — Done\n\n## Evidence\n\nBuilder notes.\n' },
    extra: { backlog: { 'T-41-planned.md': '# T-41 — Planned\n\n**Priority** 9/10\n' } },
  })
  try {
    await delay(250)
    const board = readBoard(run.tasks)
    assert.deepEqual(board.completed.map((c) => c.id), ['T-40'])
    assert.deepEqual(board.planned.map((c) => c.id), ['T-41'])
    assert.deepEqual(JSON.parse(readFileSync(run.herdrState, 'utf8')).events, [])
  } finally {
    await run.stop()
    rmSync(run.root, { recursive: true, force: true })
  }
})

test('running manager poll promotes Planned to Builder and Completed to independent Review on disposable cards', async () => {
  const run = await startPollServer({
    mode: 'manager',
    maxConcurrentAgents: 1,
    cardColumn: 'completed',
    cards: { 'T-40-done.md': '# T-40 — Done\n\n**Workflow:** card-owned\n**Auto-review:** yes\n\n## Evidence\n\nBuilder notes.\n' },
    extra: { backlog: { 'T-41-planned.md': '# T-41 — Planned\n\n**Priority** 9/10\n' } },
  })
  try {
    await waitUntil(() => {
      const board = readBoard(run.tasks)
      return board.review.some((c) => c.id === 'T-40') && board.working.some((c) => c.id === 'T-41')
    }, 'manager automatic progression')

    const starts = await waitUntil(() => {
      const state = JSON.parse(readFileSync(run.herdrState, 'utf8'))
      const names = state.events.filter((e) => e[0] === 'agent start').map((e) => e[1])
      return names.some((name) => name.startsWith('r-')) && names.some((name) => name === 'b-t-41')
        ? names
        : false
    }, 'manager automatic agent starts')
    assert.equal(starts.filter((name) => name.startsWith('r-')).length, 1)
    assert.equal(starts.filter((name) => name === 'b-t-41').length, 1)
  } finally {
    await run.stop()
    rmSync(run.root, { recursive: true, force: true })
  }
})

test('autoQueuePlanned promotes Planned in auto mode without auto-reviewing Completed', async () => {
  const run = await startPollServer({
    mode: 'auto',
    autoQueuePlanned: true,
    maxConcurrentAgents: 1,
    cardColumn: 'completed',
    cards: { 'T-40-done.md': '# T-40 — Done\n\n## Evidence\n\nBuilder notes.\n' },
    extra: { backlog: { 'T-41-planned.md': '# T-41 — Planned\n\n**Priority** 9/10\n' } },
  })
  try {
    await waitUntil(() => readBoard(run.tasks).working.some((c) => c.id === 'T-41'), 'autoQueuePlanned promotion')
    const board = readBoard(run.tasks)
    assert.deepEqual(board.completed.map((c) => c.id), ['T-40'])
    assert.deepEqual(board.review.map((c) => c.id), [])
  } finally {
    await run.stop()
    rmSync(run.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('running server poll routes terminal UNKNOWN, Owner, PASS and FAIL and preserves stale/duplicate/idempotence', async () => {
  const run = await startPollServer({
    maxConcurrentAgents: 1,
    cards: {
      'T-20-unknown.md': reviewText('T-20', 'Missing proof can be resolved by rerunning the mobile browser check.'),
      'T-21-owner.md': reviewText('T-21', 'Only the operator can grant staging account access. Verified missing permission; approved methods exhausted. Evidence: approved staging helper returned permission denied.'),
      'T-29-negated-owner.md': reviewText('T-29', 'It is not true that only the operator can grant staging account access needed to verify this criterion.'),
      'T-22-pass.md': reviewText('T-22', 'Independent test and screenshot cover each criterion.', 'PASS'),
      'T-23-fail.md': reviewText('T-23', 'Criterion 2 still fails at 390px.', 'FAIL'),
      'T-24-stale.md': reviewText('T-24', 'Old unresolved evidence.', 'UNKNOWN') +
        '\n---\n\n**Review feedback** 2026-09-10T01:00:00.000Z\n\nLater feedback resets the verdict.\n',
      'T-25-blank.md': reviewText('T-25', 'Reviewer wrote notes but no verdict.', ''),
      'T-26-template.md': reviewText('T-26', 'TODO', 'UNKNOWN'),
      'T-27-duplicate.md': reviewText('T-27', 'Duplicate live id must not move by luck.'),
    },
    extra: {
      issues: { 'T-27-other.md': '# T-27 — Existing duplicate\n' },
      completed: { 'T-28-completed.md': reviewText('T-28', 'Missing proof in this terminal path; another agent can re-run this check.') },
    },
  })
  try {
    await waitUntil(() => {
        const board = readBoard(run.tasks)
        return board.review.some((c) => c.id === 'T-20') &&
          board.owner.some((c) => c.id === 'T-21') &&
          !board.owner.some((c) => c.id === 'T-29') &&
          board.completed.some((c) => c.id === 'T-22') &&
          board.review.some((c) => c.id === 'T-29') &&
          board.review.some((c) => c.id === 'T-23') &&
          board.completed.some((c) => c.id === 'T-28')
    }, 'server verdict routing')

    let board = readBoard(run.tasks)
    assert.deepEqual(board.owner.map((c) => c.id), ['T-21'])
    assert.ok(board.review.some((c) => c.id === 'T-20'))
    assert.ok(board.review.some((c) => c.id === 'T-29'))
    assert.ok(board.review.some((c) => c.id === 'T-23'))
    assert.ok(board.completed.some((c) => c.id === 'T-28'))
    assert.ok(board.completed.some((c) => c.id === 'T-22'))
    assert.deepEqual(board.review.map((c) => c.id).sort(), ['T-20', 'T-23', 'T-24', 'T-25', 'T-26', 'T-27', 'T-29'])

    const unknown = findCard(run.tasks, 'T-20')
    const before = (readFileSync(unknown.path, 'utf8').match(/\*\*Review feedback\*\*/g) || []).length
    assert.equal(before, 0)
    assert.match(readFileSync(unknown.path, 'utf8'), /Review verdict:\*\* UNKNOWN/)
    assert.doesNotMatch(readFileSync(unknown.path, 'utf8'), /Review verdict:\*\* FAIL/)

    await run.stop()
    const stopRestart = await restartPollServer(run)
    await delay(150)
    await stopRestart()
    board = readBoard(run.tasks)
    assert.equal((readFileSync(unknown.path, 'utf8').match(/\*\*Review feedback\*\*/g) || []).length, before)
    assert.deepEqual(board.review.map((c) => c.id).sort(), ['T-20', 'T-23', 'T-24', 'T-25', 'T-26', 'T-27', 'T-29'])
  } finally {
    await run.stop()
    rmSync(run.root, { recursive: true, force: true })
  }
})

test('running server poll leaves verdicts alone while a reviewer is active', async () => {
  const run = await startPollServer({
    maxConcurrentAgents: 1,
    agents: ({ projectsRoot }) => [
      { pane_id: 'w1:p1', name: 'kb-review-test-w1-p1', cwd: projectsRoot, agent_status: 'working' },
    ],
    cards: { 'T-30-unknown.md': reviewText('T-30', 'Missing proof can be resolved by another browser check.') },
  })
  try {
    await delay(250)
    assert.deepEqual(readBoard(run.tasks).review.map((c) => c.id), ['T-30'])
    assert.deepEqual(readBoard(run.tasks).issues, [])
  } finally {
    await run.stop()
    rmSync(run.root, { recursive: true, force: true })
  }
})

test('running server poll auto-starts one Lead Planner for Issues, then hkb returns the plan to Planned', async () => {
  const run = await startPollServer({
    maxConcurrentAgents: 1,
    cardColumn: 'issues',
    leadPlanner: { autoIssues: true },
    cards: { 'T-50-proof.md': '# T-50 — Proof issue\n\n**Priority** 9/10\n\n**Review feedback** 2026-09-10T00:00:00.000Z\n\nMissing proof.\n' },
  })
  try {
    await waitUntil(() => readBoard(run.tasks).planning.some((c) => c.id === 'T-50'), 'Issue moved to Planning')
    const starts = await waitUntil(() => {
      const state = JSON.parse(readFileSync(run.herdrState, 'utf8'))
      const names = state.events.filter((e) => e[0] === 'agent start').map((e) => e[1])
      return names.filter((name) => name.startsWith('i-')).length === 1 ? names : false
    }, 'Lead Planner start')
    assert.equal(starts.filter((name) => name.startsWith('i-')).length, 1)
    assert.match(readFileSync(findCard(run.tasks, 'T-50').path, 'utf8'), /Lead Planner accepted ownership/)

    await run.stop()
    const stopRestart = await restartPollServer(run)
    await delay(150)
    await stopRestart()
    const restartedStarts = JSON.parse(readFileSync(run.herdrState, 'utf8')).events
      .filter((e) => e[0] === 'agent start' && e[1].startsWith('i-'))
    assert.equal(restartedStarts.length, 1, 'restart does not spawn a duplicate for a Planning card')

    const result = spawnSync(process.execPath, [join(process.cwd(), 'hkb.mjs'), 'move', 'T-50', 'planned'], {
      cwd: run.projectsRoot, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(readBoard(run.tasks).planned.some((c) => c.id === 'T-50'))
  } finally {
    await run.stop()
    rmSync(run.root, { recursive: true, force: true })
  }
})

test('review PASS parser ignores instructional mentions, quotes and code examples', () => {
  const text = `# T-45 - Handoff

Write current \`## Reviewer evidence\` and \`**Review verdict:** PASS\` before pass.

> ## Reviewer evidence
> quoted evidence
> **Review verdict:** PASS

\`\`\`
## Reviewer evidence
example evidence
**Review verdict:** PASS
\`\`\`
`
  assert.equal(hasCurrentReviewPass(text), false)
})

test('review PASS parser rejects blank or template-only evidence', () => {
  assert.equal(hasCurrentReviewPass(`## Reviewer evidence


**Review verdict:** PASS
`), false)
  assert.equal(hasCurrentReviewPass(`## Reviewer evidence

TODO

**Review verdict:** PASS
`), false)
  assert.equal(hasCurrentReviewPass(`## Reviewer evidence

[fill this in]

**Review verdict:** PASS
`), false)
})

test('review PASS parser accepts a dated heading and a bulleted verdict (Tradeflow T-35)', () => {
  assert.equal(hasCurrentReviewPass(`## Reviewer evidence — 2026-09-24 20:16 UTC

- **AC1 PASS:** guide openings verified at 390 and 1280
- **Review verdict:** PASS
`), true)
})

test('review PASS parser requires latest real verdict after latest build or rework', () => {
  assert.equal(hasCurrentReviewPass(`## Reviewer evidence

real current proof

**Review verdict:** PASS

**Build attempt** 2026-09-08T01:00:00.000Z
`), false)
  assert.equal(hasCurrentReviewPass(`**Build attempt** 2026-09-08T01:00:00.000Z

## Reviewer evidence

real current proof

**Review verdict:** PASS

**Review verdict:** FAIL
`), false)
  assert.equal(hasCurrentReviewPass(`**Review feedback** 2026-09-08T01:00:00.000Z

## Reviewer evidence

real current proof after feedback

**Review verdict:** PASS
`), true)
})

test('hkb ambiguous rework preserves Review for evidence diagnosis', () => {
  const { root, tasks } = fixture()
  mkdirSync(join(tasks, 'review'), { recursive: true })
  writeFileSync(join(tasks, 'review', 'T-20-review.md'), '# T-20 — Review\n')
  const result = spawnSync(process.execPath, [join(process.cwd(), 'hkb.mjs'), 'rework', 'T-20', 'criterion fails'], {
    cwd: root, encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(readBoard(tasks).review.some((c) => c.id === 'T-20'))
  rmSync(root, { recursive: true, force: true })
})

test('manual spawn endpoint reuses autoSpawn and refuses non-Queue starts', () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  const route = source.slice(source.indexOf("url.pathname === '/api/spawn'"), source.indexOf("// Settings are applied"))
  assert.match(route, /card\.column !== 'queue'/, 'explicit starts are Queue-only')
  assert.match(route, /if \(!polled\.herdrUp\)/, 'unknown herdr state is not free capacity')
  assert.match(route, /autoSpawn\(/, 'manual starts use the same guard and lock as poll ticks')
  assert.doesNotMatch(route, /spawnForCard\(/, 'there is no second implementation')
})

test('Codex agent args use Codex bypass and update suppression without Claude flags', () => {
  const args = agentStartArgs({
    name: 'kb-t-01', paneId: 'w1:p1', model: 'gpt-5.6-luna',
    engine: { kind: 'codex', reasoningArgs: ['-c', 'model_reasoning_effort="high"'] },
  })
  assert.ok(args.includes('codex'))
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.ok(args.includes('check_for_update_on_startup=false'))
  assert.ok(args.includes('gpt-5.6-luna'))
  assert.ok(args.includes('model_reasoning_effort="high"'))
  assert.ok(!args.includes('--dangerously-skip-permissions'))
})

test('managed HERDR launches reject wrong or Astra models before agent start args are built', () => {
  assert.throws(() => assertManagedModel({ name: 'kb-t-01', model: 'gpt-5.5' }), /must use model/)
  assert.doesNotThrow(() => assertManagedModel({ name: 'kb-t-01', model: 'gpt-5.6-luna' }))
  assert.doesNotThrow(() => assertManagedModel({ name: 'kb-review-injectbuddy-w1-p1', model: 'gpt-5.6-luna' }))
  assert.doesNotThrow(() => assertManagedModel({ name: 'kb-plan-injectbuddy-w1-p1', model: 'gpt-5.6-luna' }))
  assert.throws(() => assertManagedModel({ name: 'kb-review-injectbuddy-w1-p1', model: 'gpt-6-astra' }), /must use model gpt-5\.6-luna/)
  assert.throws(() => assertManagedModel({ name: 'kb-t-01', model: 'gpt-6-astra' }), /must use model gpt-5\.6-luna/)
  assert.throws(() => agentStartArgs({ name: 'kb-review-injectbuddy-w1-p1', paneId: 'w1:p1', model: 'gpt-6-astra', engine: { kind: 'codex' } }), /must use model gpt-5\.6-luna/)
})

test('Claude remains the default engine and keeps Claude-only flags', () => {
  const args = agentStartArgs({ name: 'manual-01', paneId: 'w1:p1', model: 'sonnet' })
  assert.ok(args.includes('claude'))
  assert.ok(args.includes('--dangerously-skip-permissions'))
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'))
})

test('deliver does not resend a full prompt when the pane already shows Pasted Content', async () => {
  let sends = 0
  await assert.rejects(() => deliverWith({
    paneId: 'w1:p1',
    text: 'long task prompt',
    session: 'test',
    prompt: async () => { sends++; throw new Error('agent_prompt_stalled') },
    read: async () => 'Pasted Content',
    sendKeys: async () => {},
    list: async () => [],
    confirmMs: 1,
  }), /unsubmitted .* after 3 Enter presses/)
  assert.equal(sends, 1, 'the recovery is Enter, never a duplicate paste')
})

test('deliver presses Enter once for staged Pasted Content and accepts confirmed working state', async () => {
  let keys = 0
  await deliverWith({
    paneId: 'w1:p1',
    text: 'long task prompt',
    session: 'test',
    prompt: async () => { throw new Error('agent_prompt_stalled') },
    read: async () => 'Pasted Content',
    sendKeys: async (_pane, sent) => {
      keys++
      assert.deepEqual(sent, ['enter'])
    },
    list: async () => [{ pane_id: 'w1:p1', agent_status: keys ? 'working' : 'idle' }],
  })
  assert.equal(keys, 1)
})

test('spawnForCard preserves a pane when delivery reports manual Pasted Content recovery', () => {
  const src = readFileSync(new URL('./lib/spawn.mjs', import.meta.url), 'utf8')
  assert.match(src, /if \(!err\.preservePane\) await paneClose\(paneId, session\)/,
    'manual-recovery panes must not be closed by spawnForCard')
})

// Each project has its own herdr session; a call with no --session hits the default
// one, which is how a Tradeflow builder could open inside the Injectbuddy window.
test('every project-scoped herdr call is session-scoped, and the session is the lowercased project', async () => {
  const { sessionOf } = await import('./lib/herdr.mjs')
  assert.equal(sessionOf('Tradeflow'), 'tradeflow')
  assert.equal(sessionOf('Last Tahi Standing'), 'last-tahi-standing')
  assert.equal(sessionOf(undefined), null, 'no project means no --session, i.e. the default session')
  assert.deepEqual(sessionServerArgs('tradeflow'), ['--session', 'tradeflow', 'server'],
    'background startup uses a session server, not an interactive attach')

  const herdrSrc = readFileSync(new URL('./lib/herdr.mjs', import.meta.url), 'utf8')
  assert.match(herdrSrc, /spawn\(HERDR, sessionServerArgs\(session\)/,
    'missing sessions are started in the background before assignment')
  assert.doesNotMatch(herdrSrc.slice(0, herdrSrc.indexOf('export async function focusAgent')), /session['"],\s*['"]attach|attach['"],\s*['"]session/,
    'automatic startup must not nest an interactive session attach')

  const spawnSrc = readFileSync(new URL('./lib/spawn.mjs', import.meta.url), 'utf8')
  assert.match(spawnSrc, /const session = sessionOf\(project\)/, 'a card spawn resolves its own session')
  for (const call of ['agentWorkspaceOr(projectPath, session)', 'workspace, session', 'waitForPrompt(paneId, { session })']) {
    assert.ok(spawnSrc.includes(call), `spawn.mjs must pass the session to ${call}`)
  }
  assert.ok(!/paneClose\(paneId\)\.catch/.test(spawnSrc), 'closing a pane must name the session that owns it')
})

test('manager task parser consolidates repeated request sections and keeps newest status', () => {
  const rows = parseManagerTasks(`
### REQ-20260910-016 - read-only Manager Tasks page
- Assigned Manager: kanban-observer.
- Acceptance: simple table.
- Requested at: 2026-09-10T12:01:00+12:00
- Status: handed off.
- Manager pickup 2026-09-10T12:00:00+12:00: delegated to Builder.

### Tabled idea - orchestration issue log
- REQ-20260910-099 is mentioned here but is not an approved task row.

### NOTIFY-20260910-001 - REQ-20260910-016
- User notified.

### REQ-20260910-016 - read-only Manager Tasks page correction
- Result 2026-09-10T12:30:00+12:00: completed.

### Priority release after discussion - REQ-20260910-018 then REQ-20260910-016
- This priority note is not a task row.
`)
  assert.deepEqual(rows.map((r) => r.id), ['REQ-20260910-016'])
  assert.equal(rows[0].description, 'read-only Manager Tasks page')
  assert.equal(rows[0].assignedTo, 'kanban-observer')
  assert.equal(rows[0].status, 'done')
  assert.equal(rows[0].updatedAt, '2026-09-10T12:30:00+12:00')
  assert.equal(rows[0].time, '2026-09-10T12:01:00+12:00')
})

test('manager task parser sorts newest request first and reports unknown request time honestly', () => {
  const rows = parseManagerTasks(`
### REQ-20260909-010 - release
- Status: completed.

### Builder model selection - REQ-20260910-012
- User request: Recorded 2026-09-10T09:15:00+12:00 by root.
- Status: handed off.

### REQ-20260910-018 - Restore automatic board progression
- Status: handed off, acceptance not yet confirmed.
- Manager result 2026-09-10T12:38+12:00: independent reviewer recorded PASS.
`)
  assert.deepEqual(rows.map((r) => r.id), ['REQ-20260910-018', 'REQ-20260910-012', 'REQ-20260909-010'])
  assert.equal(rows[0].timeKnown, false)
  assert.equal(rows[0].date, '2026-09-10')
  assert.equal(rows[1].description, 'Builder model selection')
  assert.equal(rows[1].timeKnown, false)
})

test('manager task parser keeps user-issued product-card requests but merges downstream headings', () => {
  const rows = parseManagerTasks(`
### REQ-20260910-011 - return T-80 to Planning
- Manager kanban-observer owns the guarded move.
- Status: handed off.

### REQ-20260910-011 - reviewer follow-up heading
- Result 2026-09-10T23:20:00+12:00: completed.

### NOTIFY-20260910-011 - REQ-20260910-011
- User notified.
`)
  assert.deepEqual(rows.map((r) => r.id), ['REQ-20260910-011'])
  assert.equal(rows[0].description, 'return T-80 to Planning')
  assert.equal(rows[0].assignedTo, 'kanban-observer')
  assert.equal(rows[0].status, 'done')
})

test('manager task parser treats result lines as terminal even when they mention Working siblings', () => {
  const rows = parseManagerTasks(`
### REQ-20260910-011 - return T-80 to Planning
- Status: handed off.
- Final result 2026-09-10T23:20:00+12:00: completed via guarded command. T-81 remains in queue; active mobile T-90 remains Working.
`)
  assert.equal(rows[0].status, 'done')
  assert.equal(rows[0].updatedAt, '2026-09-10T23:20:00+12:00')
})

test('manager task parser treats completed result lines as done despite failed/blocked context', () => {
  const rows = parseManagerTasks(`
### REQ-20260910-020 - exception handling
- Manager result 2026-09-10T15:41:40+12:00: completed with independent review PASS. Idle exception wakeup was not fabricated. Independent review initially failed because Tradeflow was running; correction stopped Tradeflow.
`)
  assert.equal(rows[0].status, 'done')
})

test('manager task parser does not turn completed verified-outcome lines into decision requests', () => {
  const rows = parseManagerTasks(`
### REQ-20260909-005 - mobile board UX
- Status: completed; independent review PASS.
- Verified outcome or decision needed: implementation completed 2026-09-09; independent visual/browser review PASS 2026-09-09.
- Notified/acknowledged state: verified completion recorded; user notification prepared.
`)
  assert.equal(rows[0].status, 'done')
})
test('manager task parser treats a later blocker checkpoint as blocked after prior working evidence', () => {
  const rows = parseManagerTasks(`
### REQ-20260910-015 - reconcile dispatch
- Dispatch checkpoint 2026-09-10T23:59:00+12:00: actual live Builder status working.
- Blocker checkpoint 2026-09-10T11:46:00+12:00: hit the approved Builder model usage limit before final evidence/routing.
`)
  assert.equal(rows[0].status, 'blocked')
  assert.equal(rows[0].updatedAt, '2026-09-10T11:46:00+12:00')
})
test('manager task parser honors explicit project lines before prose inference', () => {
  const rows = parseManagerTasks(`
### REQ-20260909-009 - product card correction
- Project: Injectbuddy.
- User request: Fix the product card while the Kanban Manager coordinates review.
- Status: handed off.
`)
  assert.equal(rows[0].project, 'InjectBuddy')
})

test('managed Codex can retain workspace sandbox and validates unsafe overrides', () => {
  const options = { name: 'kb-t-01', paneId: 'w1:p1', model: 'gpt-5.6-luna', engine: { kind: 'codex', sandbox: 'workspace-write' } }
  const args = agentStartArgs(options)
  assert.ok(args.includes('--sandbox'))
  assert.ok(args.includes('workspace-write'))
  assert.ok(args.includes('on-request'))
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.throws(() => agentStartArgs({ ...options, engine: { kind: 'codex', sandbox: 'danger-full-access' } }), /unsupported managed sandbox/)
  assert.throws(() => agentStartArgs({ ...options, engine: { ...options.engine, approvalPolicy: 'invalid' } }), /unsupported managed approval policy/)
})

test('blocked managed startup retains the real pane screen instead of a blind retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-startup-'))
  try {
    writeFileSync(join(root, 'agent'), `console.log(JSON.stringify({error:{code:'agent_not_ready',message:'blocked during startup'}}))`)
    writeFileSync(join(root, 'pane'), `console.log('Do you trust the contents of this directory?')`)
    const moduleUrl = new URL('./lib/herdr.mjs', import.meta.url).href
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {agentStart} from ${JSON.stringify(moduleUrl)};
      await assert.rejects(() => agentStart({name:'kb-t-01',paneId:'w1:p1',model:'gpt-5.6-luna',engine:{kind:'codex',sandbox:'workspace-write'}}), e => e.preservePane === true && /trust the contents/.test(e.message));
    `], {cwd: root, env: {...process.env, HERDR_BIN_PATH: process.execPath}, encoding:'utf8'})
    assert.equal(result.status, 0, result.stderr)
  } finally { rmSync(root, {recursive:true,force:true}) }
})

test('explicit operator pause survives a later circuit breaker reset', async () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  const start = source.indexOf("  if (req.method === 'POST' && url.pathname === '/api/config')")
  const end = source.indexOf("  if (req.method === 'POST' && url.pathname === '/api/priority')", start)
  let response
  // The file on disk was hand-edited after startup; a settings save must keep that edit.
  const onDisk = JSON.stringify({maxConcurrentAgents:0, projects:[], workflowLimits:{maxRunsPerStage:25}})
  const route = new Function('json', 'writeFileSync', 'readFileSync', 'resetBreaker', `
    const CONFIG_PATH = 'unused'; const clients = []; const res = {}; const announcedBreakers = new Set();
    let config = {maxConcurrentAgents:0};
    return async (req, url) => { ${source.slice(start, end)} };
  `)((_res, _status, value) => { response = structuredClone(value) }, () => {}, () => onDisk, () => {})
  await route({method:'POST', async *[Symbol.asyncIterator]() {yield '{"maxConcurrentAgents":0}'}}, {pathname:'/api/config'})
  assert.equal(response.config.maxConcurrentAgents, 0)
  assert.equal(response.config.workflowLimits.maxRunsPerStage, 25)
  await route({method:'POST'}, {pathname:'/api/breaker-reset'})
  assert.equal(response.config.maxConcurrentAgents, 0)
})

test('finished reviewer stops blocking the next batch after existing done grace', () => {
  const agents = [{name:'kb-review-proof',pane_id:'test-review-finished',agent_status:'done'}]
  assert.equal(reviewerRunning(agents, 1000), true)
  assert.equal(reviewerRunning(agents, 121001), false)
  agents[0].agent_status = 'working'
  assert.equal(reviewerRunning(agents, 121002), true)
  agents[0].agent_status = 'done'
  assert.equal(reviewerRunning(agents, 121003), true)
})

test('paused agent polling does not start stopped HERDR sessions', () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  const poll = source.slice(source.indexOf('async function pollAgentsNow('), source.indexOf('function boardPayload('))
  assert.match(poll, /ensureSession: !controlState\(project, CONFIG_PATH\)\.paused && config\.maxConcurrentAgents > 0 && missionAllowsProject\(project\)/)
  const herdrSource = readFileSync(new URL('./lib/herdr.mjs', import.meta.url), 'utf8')
  assert.match(herdrSource, /agentList\(session, options\)/)
  assert.match(herdrSource, /herdr\(\['agent', 'list'\], \{ \.\.\.options, session \}\)/)
})

test('mission project scope also gates session startup and automatic review', () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  const declaration = source.match(/^const missionAllowsProject = .+$/m)[0]
  const allows = new Function('config', `${declaration}; return missionAllowsProject`)({mission:{project:'Injectbuddy'}})
  assert.equal(allows('InjectBuddy'), true)
  assert.equal(allows('Tradeflow'), false)
  assert.match(source, /ensureSession: !controlState\(project, CONFIG_PATH\)\.paused && config\.maxConcurrentAgents > 0 && missionAllowsProject\(project\)/)
  assert.match(source, /const autoEnabled = !controlState\(project, CONFIG_PATH\)\.paused && config\.maxConcurrentAgents > 0 && missionAllowsProject\(project\)/)
})

// Audit 2026-09-26 finding 4: alerts went to a herdr agent that no longer exists, and
// through herdr, so a herdr outage could never be reported.
test('manager exception alerts push and append to the inbox without herdr, once per key per cooldown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-alert-'))
  try {
    const sent = [], inbox = join(root, 'roles', 'KANBAN_MANAGER-INBOX.md')
    const args = {
      boardRoot: root, inbox, now: 1000,
      key: 'herdr',
      title: 'HERDR unavailable',
      detail: 'Injectbuddy: {"error":{"code":"server_not_running"}}',
      send: async (title, message) => sent.push({ title, message }),
      log: () => {},
    }
    assert.deepEqual(await notifyManagerException(args), { sent: true })
    assert.equal(sent.length, 1)
    assert.match(sent[0].title, /HERDR unavailable/)
    assert.match(sent[0].message, /server_not_running/)
    assert.match(readFileSync(inbox, 'utf8'), /HERDR unavailable: Injectbuddy: .*server_not_running/)
    // Seven projects report the same outage with different text: still one push.
    assert.equal((await notifyManagerException({ ...args, detail: 'Tradeflow: agent list failed', now: 2000 })).reason, 'cooldown')
    assert.equal(sent.length, 1)
    // Recovery clears the key, so the next outage alerts again.
    resolveManagerException(root, 'herdr')
    assert.deepEqual(await notifyManagerException({ ...args, now: 3000 }), { sent: true })
    assert.equal(sent.length, 2)
    // A persisting condition reminds only after its cooldown.
    assert.equal((await notifyManagerException({ ...args, now: 3000 + 60 * 60 * 1000 })).reason, 'cooldown')
    assert.deepEqual(await notifyManagerException({ ...args, now: 3000 + 4 * 60 * 60 * 1000 }), { sent: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed manager push is not repeated (ambiguous timeout) but still reaches the inbox', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-alert-'))
  try {
    let tries = 0
    const args = {
      boardRoot: root, inbox: join(root, 'INBOX.md'), now: 1000,
      key: 'circuit-breaker', title: 'Kanban circuit breaker tripped', detail: 'auto-spawn halted',
      send: async () => { tries++; throw new Error('timeout') }, log: () => {},
    }
    assert.equal((await notifyManagerException(args)).reason, 'failed')
    assert.equal((await notifyManagerException({ ...args, now: 5000 })).reason, 'cooldown')
    assert.equal(tries, 1)
    assert.match(readFileSync(args.inbox, 'utf8'), /circuit breaker tripped: auto-spawn halted/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Owner ageing: an old Owner card or a burst of arrivals is reported with the cards it blocks', () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-owner-age-'))
  try {
    const HOUR = 3600000, now = Date.now()
    const put = (column, id, at, extra = '') => {
      mkdirSync(join(root, column), { recursive: true })
      const file = join(root, column, `${id}.md`)
      writeFileSync(file, `# ${id} — card ${id}\n${extra}`)
      utimesSync(file, new Date(at), new Date(at))
    }
    put('owner', 'T-1', now - 2 * HOUR)
    put('queue', 'T-9', now, '**Blocked by:** T-1\n')
    assert.equal(ownerAgeing(root, { now }), null, 'one card for two hours is neither old nor a burst')
    put('owner', 'T-2', now - 5 * HOUR)
    const old = ownerAgeing(root, { now })
    assert.match(old.title, /1 Owner card waiting over 4h/)
    assert.match(old.detail, /T-2/)
    assert.match(old.detail, /Blocked behind them: T-9/)
    rmSync(join(root, 'owner', 'T-2.md'))
    put('owner', 'T-3', now - 30 * 60000); put('owner', 'T-4', now - 10 * 60000); put('owner', 'T-5', now - 5 * 60000)
    assert.match(ownerAgeing(root, { now }).title, /3 cards reached Owner within an hour/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('server poll uses existing hard-hold exceptions but skips routine holds', () => {
  assert.equal(isHardHold('duplicate issue key IB-1: T-1 in queue, T-2 in planned'), true)
  assert.equal(isHardHold('dependency cycle detected'), true)
  assert.equal(isHardHold('waiting for unique archived prerequisite T-80'), false)
  assert.equal(isHardHold('files busy, likely held by T-91'), false)
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
  assert.match(source, /notifyManagerException\(\{[\s\S]+key: `hold:\$\{project\}:\$\{id\}`/)
  assert.match(source, /notifyManagerException\(\{[\s\S]+key: 'circuit-breaker'/)
  assert.match(source, /if \(missionAllowsProject\(project\) && [\s\S]+key: 'herdr'/)
  assert.match(source, /resolveManagerException\(HERE, 'herdr'\)/)
  assert.match(source, /ownerAgeing\(tasksDir\)[\s\S]+key: `owner:\$\{project\}`/)
})

test('managed Codex launches do not inject broad shared context policy', () => {
  const args = agentStartArgs({ name: 'kb-t-01', paneId: 'test:p1', model: 'gpt-5.6-luna', engine: { kind: 'codex' } })
  assert.ok(!args.some(x => x.includes('AGENT-CONTEXT.md')))
})

test('parseCard reuses a parse only while the file is unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parse-cache-'))
  try {
    const card = createCard(dir, { title: 'Cache', brief: 'x' })
    const first = parseCard(card.path, 'planning')
    first.blockedBy.push('T-99')
    assert.deepEqual(parseCard(card.path, 'planning').blockedBy, [], 'callers get their own copy')
    assert.equal(parseCard(card.path, 'queue').column, 'queue')
    appendFileSync(card.path, '\n**Build attempt** 2026-09-24T00:00:00Z\n')
    assert.equal(parseCard(card.path, 'planning').buildAttempts, 1, 'a changed file is parsed again')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a Codex agent whose card does not browse starts without browser MCPs', () => {
  const lean = agentStartArgs({ name: 'b-t-1', paneId: 'p', model: 'gpt-6-luna', engine: { kind: 'codex' }, browser: false })
  for (const server of ['chrome-devtools', 'playwright', 'node_repl']) assert.ok(lean.includes(`mcp_servers.${server}.enabled=false`))
  assert.ok(!agentStartArgs({ name: 'b-t-1', paneId: 'p', model: 'gpt-6-luna', engine: { kind: 'codex' } }).some(a => /mcp_servers/.test(a)), 'browser cards keep them')
})
