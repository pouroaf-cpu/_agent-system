import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync, execFileSync } from 'node:child_process'
import { checkRunCap, enforceRunCaps, overCapNote } from './lib/run-cap.mjs'
import { maxTokensPerRun, maxStepsPerRun, DEFAULT_MAX_TOKENS_PER_RUN } from './lib/workflow-limits.mjs'
import { readUsage } from './lib/request-usage.mjs'
import { findCard, moveCard } from './lib/cards.mjs'
import { readWorkflow, updateWorkflow } from './lib/workflow-state.mjs'
import { writeBrief, historyPath } from './lib/card-history.mjs'
import { stopHookDecision } from './lib/board-stop-hook.mjs'

const ZERO = { input: 0, cachedInput: 0, uncachedInput: 0, output: 0, reasoningOutput: 0, total: 0 }
const T0 = Date.parse('2026-10-14T00:00:00Z')
const at = (min) => new Date(T0 + min * 60000).toISOString()
const hookPath = join(import.meta.dirname, 'scripts', 'run-cap-hook.mjs')

// One temp board: Proj/TASKS with card T-1 in `column`, a config with `limits` (plus `extra(dir)` keys), a fake Claude home.
function board(column, limits, extra = () => ({})) {
  const dir = mkdtempSync(join(tmpdir(), 'run-cap-'))
  const tasks = join(dir, 'Proj', 'TASKS'), inbox = join(dir, 'inbox.md'), claude = join(dir, 'claude')
  mkdirSync(join(tasks, column), { recursive: true })
  mkdirSync(join(claude, 'proj'), { recursive: true })
  writeFileSync(join(tasks, column, 'T-1-big.md'), '# T-1 — Big card\n\n## Approved brief\nDo the big thing.\n')
  const config = join(dir, 'board.config.json')
  writeFileSync(config, JSON.stringify({ projectsRoot: dir, projects: ['Proj'], projectSettings: { Proj: { manager: { chat: 'Proj chat', inbox } } }, ...(limits ? { workflowLimits: limits } : {}), ...extra(dir) }))
  process.env.KANBAN_CONFIG = config
  return { dir, tasks, inbox, claude, config, n: 0 }
}
// A run is open in the usage file; its Claude transcript grows by `step(b, sessionId, tokens)` rows.
function openRun(b, { role, sessionId = `sess-${++b.n}`, startAt = at(0), paneId = `pane-${b.n}` }) {
  const path = join(b.tasks, '.request-usage.json')
  const all = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { version: 1, runs: {} }
  const runId = `run-${sessionId}`
  all.runs[runId] = { runId, sessionId, project: 'Proj', requestId: 'T-1', cardIds: ['T-1'], role, paneId, status: 'running', start: { at: startAt, counters: { ...ZERO }, ordinal: -1 } }
  writeFileSync(path, JSON.stringify(all))
  const file = join(b.claude, 'proj', `${sessionId}.jsonl`)
  writeFileSync(file, '')
  let rows = 0
  return {
    runId, sessionId, file,
    step: (tokens = 1000000) => appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: at(1), uuid: `u${++rows}`, message: { id: `m${rows}`, usage: { input_tokens: 0, output_tokens: tokens } } }) + '\n'),
    run: () => readUsage(b.tasks).runs[runId],
  }
}
const check = (b, r, extra = {}) => checkRunCap({ tasksDir: b.tasks, project: 'Proj', run: r.run(), session: 'proj', root: b.claude, now: new Date(T0 + 60000), ...extra })

for (const [role, column] of [['planner', 'planning'], ['builder', 'working']]) {
  test(`AC1: a ${role} run is stopped at the first check at or past 4,000,000 when the key is missing`, async () => {
    const b = board(column)
    assert.equal(maxTokensPerRun(), DEFAULT_MAX_TOKENS_PER_RUN)
    const r = openRun(b, { role })
    for (let i = 1; i <= 3; i++) { r.step(); assert.equal((await check(b, r)).stopped, false, `row ${i}`) }
    assert.equal(r.run().finish, undefined)
    r.step()
    const result = await check(b, r)
    assert.deepEqual([result.stopped, result.tokens, result.limit], [true, 4000000, 4000000])
    assert.ok(r.run().finish, 'usage run is closed')
    assert.equal(findCard(b.tasks, 'T-1').column, 'planning')
    const events = readFileSync(historyPath(b.tasks, 'T-1'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    assert.equal(events.filter(e => e.event === 'run-cap-stop').length, 1)
  })
}

test('AC1: a configured maxTokensPerRun of 2,500,000 stops at the third row', async () => {
  const b = board('planning', { maxTokensPerRun: 2500000 })
  const r = openRun(b, { role: 'planner' })
  r.step(); assert.equal((await check(b, r)).stopped, false)
  r.step(); assert.equal((await check(b, r)).stopped, false)
  r.step(); assert.equal((await check(b, r)).stopped, true)
})

test('AC1: Reviewer runs and multi-card runs are never capped', async () => {
  const b = board('review')
  const r = openRun(b, { role: 'reviewer' })
  r.step(9000000)
  assert.equal((await check(b, r)).stopped, false)
  assert.equal(findCard(b.tasks, 'T-1').column, 'review')
})

test('AC2: with maxTokensPerRun null no run is stopped for tokens', async () => {
  const b = board('working', { maxTokensPerRun: null })
  assert.equal(maxTokensPerRun(), null)
  const r = openRun(b, { role: 'builder' })
  r.step(20000000)
  const closed = []
  await enforceRunCaps({ tasksDir: b.tasks, project: 'Proj', session: 'proj', closePane: (p) => closed.push(p), root: b.claude })
  assert.equal((await check(b, r)).stopped, false)
  assert.equal(r.run().finish, undefined)
  assert.equal(findCard(b.tasks, 'T-1').column, 'working')
  assert.deepEqual(closed, [])
})

test('AC3: a poll-path stop leaves the worktree, its modified, staged and untracked files exactly as they were', async () => {
  const b = board('working')
  const main = join(b.dir, 'main'), tree = join(b.dir, 'tree')
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', windowsHide: true })
  mkdirSync(main)
  git(main, 'init', '-q'); writeFileSync(join(main, 'a.txt'), 'one\n'); git(main, 'add', 'a.txt'); git(main, 'commit', '-qm', 'init')
  git(main, 'worktree', 'add', '-q', tree)
  writeFileSync(join(tree, 'a.txt'), 'changed\n'); writeFileSync(join(tree, 'b.txt'), 'staged\n'); git(tree, 'add', 'b.txt'); writeFileSync(join(tree, 'c.txt'), 'untracked\n')
  const snapshot = () => ({ status: git(tree, 'status', '--porcelain=v1', '-uall'), files: ['a.txt', 'b.txt', 'c.txt'].map(f => readFileSync(join(tree, f), 'utf8')), exists: existsSync(tree) })
  const before = snapshot()
  const r = openRun(b, { role: 'builder' })
  r.step(4500000)
  const closed = []
  await enforceRunCaps({ tasksDir: b.tasks, project: 'Proj', session: 'proj', closePane: (p, s) => closed.push([p, s]), root: b.claude, now: new Date(T0 + 60000) })
  assert.deepEqual(closed, [[`pane-1`, 'proj']])
  assert.ok(r.run().finish)
  assert.deepEqual(snapshot(), before)
})

test('AC4: the card returns to Planning, the next Planner brief carries the note, the Planner owner is set to relaunch fresh', async () => {
  for (const [role, column] of [['builder', 'working'], ['planner', 'planning']]) {
    const b = board(column)
    writeFileSync(join(b.tasks, '.card-planners.json'), JSON.stringify({ 'T-1': { paneId: 'pane-9', assignmentId: 'a1', lifecycle: 'active', submitted: true, noHandoffCount: 1, revokedPaneIds: [] } }))
    const r = openRun(b, { role })
    r.step(4100000)
    assert.equal((await check(b, r)).stopped, true)
    const card = findCard(b.tasks, 'T-1')
    assert.equal(card.column, 'planning')
    const brief = readFileSync(writeBrief(b.tasks, card, 'planner'), 'utf8')
    assert.ok(brief.includes('Over run cap:'))
    assert.ok(brief.includes(overCapNote(role, 'T-1', 4100000, 4000000)), brief)
    const owner = JSON.parse(readFileSync(join(b.tasks, '.card-planners.json'), 'utf8'))['T-1']
    assert.equal(owner.submitted, false)
    assert.equal(owner.startRetry, true)
    assert.equal(owner.noHandoffCount, undefined)
    assert.ok(owner.revokedPaneIds.includes('pane-9'))
    assert.equal(existsSync(b.inbox), false, 'a first stop is not an ASK')
  }
})

test('AC5: a second stop on the same card posts one ASK and starts no run; a reset makes it a first stop again', async () => {
  const b = board('planning')
  const first = openRun(b, { role: 'planner', startAt: at(0) })
  first.step(4000000)
  assert.equal((await check(b, first, { now: new Date(T0 + 60000) })).stopNumber, 1)
  assert.equal(findCard(b.tasks, 'T-1').column, 'planning')
  assert.equal(existsSync(b.inbox), false)

  const second = openRun(b, { role: 'planner', startAt: at(2) })
  second.step(4000000)
  const runsBefore = Object.keys(readUsage(b.tasks).runs).length
  const closed = []
  const result = await check(b, second, { now: new Date(T0 + 3 * 60000), closePane: (p) => closed.push(p) })
  assert.equal(result.stopNumber, 2)
  assert.equal(findCard(b.tasks, 'T-1').column, 'owner')
  const lines = readFileSync(b.inbox, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /ASK Proj T-1 \(owner\): Run over the token cap twice/)
  assert.equal(Object.keys(readUsage(b.tasks).runs).length, runsBefore, 'no new run recorded')
  assert.deepEqual(closed, [second.run().paneId], 'only the capped run is closed')

  moveCard(b.tasks, 'T-1', 'planning')
  updateWorkflow(b.tasks, 'T-1', { limitsResetAt: at(4) })
  const third = openRun(b, { role: 'planner', startAt: at(5) })
  third.step(4000000)
  assert.equal((await check(b, third, { now: new Date(T0 + 6 * 60000) })).stopNumber, 1)
  assert.equal(findCard(b.tasks, 'T-1').column, 'planning')
  assert.equal(readFileSync(b.inbox, 'utf8').split('\n').filter(Boolean).length, 1)
  assert.equal(readWorkflow(b.tasks)['T-1'].runCapStops.length, 3)
})

test('the same run is stopped once even if two checks race', async () => {
  const b = board('working')
  const r = openRun(b, { role: 'builder' })
  r.step(4000000)
  const stale = r.run()
  await checkRunCap({ tasksDir: b.tasks, project: 'Proj', run: stale, session: 'proj', root: b.claude, now: new Date(T0 + 60000) })
  moveCard(b.tasks, 'T-1', 'working')
  const again = await checkRunCap({ tasksDir: b.tasks, project: 'Proj', run: { ...stale, finish: undefined }, session: 'proj', root: b.claude, now: new Date(T0 + 120000) })
  assert.equal(again.repeated, true)
  assert.equal(readWorkflow(b.tasks)['T-1'].runCapStops.length, 1)
})

test('hook: bad input and a run below the limit print nothing; a run past it prints continue:false and routes the card', () => {
  const b = board('working')
  const env = { ...process.env, KANBAN_CONFIG: b.config, CLAUDE_CONFIG_DIR: b.claude + '-home' }
  const sessionId = 'hook-sess'
  const dir = join(b.claude + '-home', 'projects', 'proj')
  mkdirSync(dir, { recursive: true })
  const transcript = join(dir, `${sessionId}.jsonl`)
  const rows = [{ type: 'agent-name', agentName: 'b-t-1' }, { type: 'user', message: { role: 'user', content: `hkb --tasks '${b.tasks}' done T-1` } }]
  const write = (tokens) => writeFileSync(transcript, [...rows, { type: 'assistant', timestamp: at(1), uuid: 'u', message: { id: 'm', usage: { input_tokens: 0, output_tokens: tokens } } }].map(r => JSON.stringify(r)).join('\n') + '\n')
  writeFileSync(join(b.tasks, '.request-usage.json'), JSON.stringify({ version: 1, runs: { r1: { runId: 'r1', sessionId, project: 'Proj', cardIds: ['T-1'], role: 'builder', paneId: 'p1', start: { at: at(0), counters: { ...ZERO }, ordinal: -1 } } } }))
  const run = (input) => spawnSync(process.execPath, [hookPath], { input, env, encoding: 'utf8', windowsHide: true })
  const call = JSON.stringify({ tool_name: 'Read', transcript_path: transcript, session_id: sessionId })
  assert.deepEqual([run('not json').status, run('not json').stdout], [0, ''])
  write(3999999)
  assert.deepEqual([run(call).status, run(call).stdout], [0, ''])
  assert.equal(findCard(b.tasks, 'T-1').column, 'working')
  write(4000000)
  const out = run(call)
  assert.equal(out.status, 0)
  assert.equal(JSON.parse(out.stdout).continue, false)
  assert.equal(findCard(b.tasks, 'T-1').column, 'planning')
})

// Audit 2026-10-15 F4 AC3: a per-run step cap, off unless configured, with an alert line per stop.
test('F4 AC3: a run past maxStepsPerRun is stopped with a run-cap line in activity.log and one Token Manager inbox line; no step cap by default', async () => {
  const b = board('working', { maxStepsPerRun: 3 }, dir => ({ tokenManager: { inbox: join(dir, 'token-manager.md') } }))
  assert.equal(maxStepsPerRun(), 3)
  const r = openRun(b, { role: 'builder' })
  r.step(1000); r.step(1000)
  assert.equal((await check(b, r)).stopped, false, 'two steps are under a cap of three')
  r.step(1000)
  const result = await check(b, r)
  assert.deepEqual([result.stopped, result.tokens, result.limit, result.unit], [true, 3, 3, 'steps'])
  assert.ok(r.run().finish, 'usage run is closed')
  assert.equal(findCard(b.tasks, 'T-1').column, 'planning')
  const activity = readFileSync(join(b.tasks, 'activity.log'), 'utf8').split('\n').filter(l => l.includes('event=run-cap'))
  assert.equal(activity.length, 1)
  assert.match(activity[0], /project=Proj card=T-1 event=run-cap message=Builder run stopped at 3 steps \(cap 3 maxStepsPerRun\), stop 1 on this card/)
  const inbox = readFileSync(join(b.dir, 'token-manager.md'), 'utf8').split('\n').filter(Boolean)
  assert.equal(inbox.length, 1)
  assert.match(inbox[0], /^- TA \d+ .* RUN CAP Proj T-1 builder Builder run stopped at 3 steps \(cap 3 maxStepsPerRun\), stop 1 on this card$/)
  assert.equal(existsSync(b.inbox), false, 'a first stop is not an ASK')
  assert.match(readFileSync(findCard(b.tasks, 'T-1').path, 'utf8'), /Over run cap: the Builder run for T-1 was stopped by the board after 3 steps \(cap 3 steps per run\)/)
  const events = readFileSync(historyPath(b.tasks, 'T-1'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.event === 'run-cap-stop')
  assert.deepEqual([events.length, events[0].unit, events[0].tokens, events[0].limit], [1, 'steps', 3, 3])
  // The poll backstop logs the same stop once with its unit.
  const c = board('planning', { maxStepsPerRun: 2, maxTokensPerRun: null })
  const r2 = openRun(c, { role: 'planner' })
  r2.step(10); r2.step(10)
  const log = []
  await enforceRunCaps({ tasksDir: c.tasks, project: 'Proj', session: 'proj', root: c.claude, log: m => log.push(m), now: new Date(T0 + 60000) })
  assert.deepEqual(log, ['T-1 planner run stopped at 2 steps (cap 2)'])
  assert.equal(existsSync(join(c.dir, 'token-manager.md')), false, 'no Token Manager inbox configured on a temp board: no inbox write')
  // Absent key: no step cap at all.
  const d = board('planning')
  assert.equal(maxStepsPerRun(), null)
  const r3 = openRun(d, { role: 'planner' })
  for (let i = 0; i < 70; i++) r3.step(10)
  assert.equal((await check(d, r3)).stopped, false)
})

test('hook: the step whose tool call handed the card off ends the run, caps or not (audit 2026-10-15 F4)', () => {
  const b = board('working', { maxTokensPerRun: null })
  const env = { ...process.env, KANBAN_CONFIG: b.config, CLAUDE_CONFIG_DIR: b.claude + '-home' }
  const sessionId = 'hook-lane'
  const dir = join(b.claude + '-home', 'projects', 'proj')
  mkdirSync(dir, { recursive: true })
  const transcript = join(dir, `${sessionId}.jsonl`)
  const rows = [{ type: 'agent-name', agentName: 'b-t-1' }, { type: 'user', message: { role: 'user', content: `hkb --tasks '${b.tasks}' done T-1` } }, { type: 'assistant', timestamp: at(1), uuid: 'u', message: { id: 'm', usage: { input_tokens: 0, output_tokens: 10 } } }]
  writeFileSync(transcript, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  writeFileSync(join(b.tasks, '.request-usage.json'), JSON.stringify({ version: 1, runs: { r1: { runId: 'r1', sessionId, project: 'Proj', cardIds: ['T-1'], role: 'builder', paneId: 'p1', start: { at: at(0), counters: { ...ZERO }, ordinal: -1 } } } }))
  const run = (input) => spawnSync(process.execPath, [hookPath], { input, env, encoding: 'utf8', windowsHide: true })
  const call = JSON.stringify({ tool_name: 'Bash', transcript_path: transcript, session_id: sessionId })
  assert.deepEqual([run(call).status, run(call).stdout], [0, ''], 'card still in Working: the run goes on')
  moveCard(b.tasks, 'T-1', 'review')
  const out = run(call)
  assert.equal(out.status, 0)
  assert.deepEqual(JSON.parse(out.stdout), { continue: false, stopReason: 'T-1 is in review: the handoff is recorded, this run ends here' })
  assert.equal(findCard(b.tasks, 'T-1').column, 'review', 'the hook moves nothing')
  assert.equal(readUsage(b.tasks).runs.r1.finish, undefined, 'the usage run is closed by the board, not the hook')
  // A Planner whose card went to Planned: same end.
  const p = board('planning', { maxTokensPerRun: null })
  const penv = { ...process.env, KANBAN_CONFIG: p.config, CLAUDE_CONFIG_DIR: p.claude + '-home' }
  const pdir = join(p.claude + '-home', 'projects', 'proj'); mkdirSync(pdir, { recursive: true })
  const ptranscript = join(pdir, 'hook-plan.jsonl')
  writeFileSync(ptranscript, [{ type: 'agent-name', agentName: 'p-t-1' }, { type: 'user', message: { role: 'user', content: `hkb --tasks '${p.tasks}' move T-1 planned` } }].map(r => JSON.stringify(r)).join('\n') + '\n')
  const pcall = JSON.stringify({ tool_name: 'Bash', transcript_path: ptranscript, session_id: 'hook-plan' })
  assert.equal(spawnSync(process.execPath, [hookPath], { input: pcall, env: penv, encoding: 'utf8', windowsHide: true }).stdout, '')
  moveCard(p.tasks, 'T-1', 'planned')
  assert.match(spawnSync(process.execPath, [hookPath], { input: pcall, env: penv, encoding: 'utf8', windowsHide: true }).stdout, /"continue":false.*T-1 is in planned/)
})

test('both Claude settings files register the hook as a PostToolUse group for every tool', () => {
  for (const name of ['claude-agent-settings.json', 'claude-planner-settings.json']) {
    const groups = JSON.parse(readFileSync(join(import.meta.dirname, name), 'utf8')).hooks.PostToolUse
    const group = groups.find(g => g.hooks.some(h => h.command.includes('scripts/hooks/post.mjs')))
    assert.equal(group?.matcher, '*', name)
  }
})

test('the Stop hook stays silent for a run the board stopped at the cap', () => {
  const b = board('planning')
  const args = { tasksDir: b.tasks, id: 'T-1', role: 'p', name: 'p-t-1', start: at(0), stopHookActive: true, message: 'ok', hkbCommand: 'hkb' }
  mkdirSync(join(b.tasks, '.history'), { recursive: true })
  appendFileSync(historyPath(b.tasks, 'T-1'), JSON.stringify({ event: 'run-cap-stop', at: at(1) }) + '\n')
  assert.equal(stopHookDecision(args), null)
  assert.equal(existsSync(b.inbox), false, 'no "stopped without a handoff" ASK')
  assert.equal(stopHookDecision({ ...args, start: at(2) }), null)
  assert.match(readFileSync(b.inbox, 'utf8'), /stopped without a handoff/, 'an earlier cap stop does not silence a later run')
})
