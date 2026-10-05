import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { normalizeSession, joinSessions, classifySession, buildReport, formatReport, parseArgs, nzDate } from './scripts/usage-by-role.mjs'

const uuid = '11111111-2222-3333-4444-555555555555'
const cwd = 'C:\\Users\\PFrew\\KanbanProjects\\.worktrees\\demo\\cards\\d-3-build'
const rows = [
  normalizeSession({ sessionId: 'claude-builder', totalCost: 5, totalTokens: 500, lastActivity: '2026-10-04T23:00:00Z', modelBreakdowns: [{ modelName: 'opus', cost: 5 }] }, 'claude'),
  normalizeSession({ sessionId: `2026/10/04/rollout-2026-10-04T06-51-47-${uuid}`, costUSD: 3, totalTokens: 300, lastActivity: '2026-10-04T06:52:00Z', models: [{ modelName: 'gpt', costUSD: 3 }] }, 'codex', JSON.stringify({ type: 'session_meta', payload: { id: uuid, cwd: 'C:\\demo', timestamp: '2026-10-04T06:51:47Z' } })),
  normalizeSession({ sessionId: 'fallback', totalCost: 2, totalTokens: 200, firstActivity: '2026-10-04T08:00:30Z', lastActivity: '2026-10-04T08:02:00Z' }, 'claude', JSON.stringify({ cwd })),
  normalizeSession({ sessionId: 'km-chat', totalCost: 7, totalTokens: 700, lastActivity: '2026-10-04T08:00:00Z' }, 'claude', JSON.stringify({ message: 'SessionStart: You are the "Kanban Manager" chat' })),
  normalizeSession({ sessionId: 'fix', costUSD: 1, totalTokens: 100, cwd: 'C:\\Users\\PFrew\\Projects\\.claude\\worktrees\\km-usage-report', lastActivity: '2026-10-04T08:00:00Z' }, 'codex'),
  normalizeSession({ sessionId: 'other', totalCost: 4, totalTokens: 400, cwd: 'C:\\Other', lastActivity: '2026-10-04T08:00:00Z' }, 'claude'),
]
const boards = { demo: { cardUsage: {
  'D-1': { agents: [{ role: 'builder', runId: 'D-1:builder:pane:claude-builder:1' }] },
  'D-2': { agents: [{ role: 'reviewer', runId: `D-2:reviewer:pane:${uuid}:2` }] },
  'D-3': { agents: [{ role: 'planner', runId: 'D-3:planner:pane:unknown-session:3', startedAt: '2026-10-04T08:00:00Z' }] },
} } }
const stateMap = { km: { name: 'Kanban Manager' }, inject: { name: 'Injectbuddy work' }, trade: { name: 'Tradeflow project' }, wake: { name: 'Waker' } }
const period = { since: '2026-09-28', until: '2026-10-05' }

test('exact IDs, cwd/time fallback and chat classification count every session once', () => {
  const report = buildReport(rows, boards, stateMap, period, [{ totalCost: 18, totalTokens: 1800 }, { costUSD: 4, totalTokens: 400 }])
  assert.deepEqual(Object.fromEntries(report.rows.map(r => [r.role, [r.sessions, r.tokens, r.costUSD, r.project]])), {
    'Kanban Manager': [1, 700, 7, null], Builder: [1, 500, 5, 'demo'], 'Other Claude': [1, 400, 4, null],
    Reviewer: [1, 300, 3, 'demo'], Planner: [1, 200, 2, 'demo'], 'KM fix agents': [1, 100, 1, null],
  })
  assert.deepEqual(report.totals, { sessions: 6, tokens: 2200, costUSD: 22 })
  assert.equal(report.rows.reduce((n, r) => n + r.sessions, 0), rows.length)
  assert.equal(Object.values(report.days).reduce((n, d) => n + d.totals.sessions, 0), rows.length)
  assert.equal(report.days['2026-10-05'].totals.costUSD, 5)
  assert.equal(report.check.matches, true)
  assert.equal(report.rows.find(r => r.role === 'Reviewer').models.gpt, 3)
  assert.deepEqual(report.otherCwds['Other Claude'], [{ cwd: 'C:\\Other', costUSD: 4 }])
  assert.match(formatReport(report, true), /lastActivity date in Pacific\/Auckland/)
  assert.match(formatReport(report), /Builder \(demo\) \| 1 \| 0\.001 \| \$5\.00/)
  assert.equal(buildReport(rows, boards, stateMap, period, [{ totalCost: 40, totalTokens: 2200 }]).check.matches, false)
})

test('fallback takes nearest eligible start, reserves exact matches, enforces card/project and 120s boundary', () => {
  const agent = boards.demo.cardUsage['D-3'].agents[0]
  const variants = [rows[2], { ...rows[2], id: 'nearer', start: '2026-10-04T08:00:01Z' }, { ...rows[2], id: 'late', start: '2026-10-04T08:02:01Z' }, { ...rows[2], id: 'wrong', cwd: cwd.replace('d-3', 'd-4') }]
  assert.deepEqual(joinSessions(variants, boards).map(a => a?.role || null), [null, 'planner', null, null])
  const reserved = { demo: { cardUsage: { 'D-3': { agents: [agent, { role: 'builder', runId: 'D-3:builder:p:fallback:0' }] } } } }
  assert.deepEqual(joinSessions(variants, reserved).map(a => a?.role || null), ['builder', 'planner', null, null])
  assert.equal(classifySession(rows[2], null).role, 'Board agent (unmatched)')
  assert.equal(joinSessions([{ ...rows[2], cwd: '', projectPath: 'C--Users-PFrew-KanbanProjects--worktrees-demo-cards-d-3-build' }], boards)[0]?.role, 'planner')
  const visible = { demo: { cardUsage: { 'D-3': { agents: [{ ...agent, role: 'plancheck', cwd: 'C:\\review-workspaces\\snapshot' }] } } } }
  assert.equal(joinSessions([{ ...rows[2], cwd: 'C:\\review-workspaces\\snapshot' }], visible)[0]?.role, 'plancheck')
  assert.equal(classifySession(rows[2], joinSessions([{ ...rows[2], cwd: 'C:\\review-workspaces\\snapshot' }], visible)[0]).role, 'Plan check')
  for (const [name, role] of [['Injectbuddy work', 'Orchestrator: Injectbuddy'], ['Tradeflow project', 'Orchestrator: Tradeflow'], ['Waker', 'Waker']]) assert.equal(classifySession({ ...rows[3], head: JSON.stringify({ message: `You are the "${name}" chat.` }) }, null, stateMap).role, role)
  assert.equal(classifySession({ ...rows[4], cwd: 'C:\\Other' }, null).role, 'Other Codex')
})

test('NZ date default, strict dates, transcript head limit and empty totals', () => {
  assert.equal(nzDate('2026-10-04T12:00:00Z'), '2026-10-05')
  assert.equal(parseArgs([], new Date('2026-10-04T12:00:00Z')).since, '2026-09-28')
  for (const args of [['--since', '2026-02-30'], ['--until', 'bad'], ['--since', '2026-10-05', '--until', '2026-10-04'], ['--wat'], ['--claude-json']]) assert.throws(() => parseArgs(args))
  const session = normalizeSession({ sessionId: 'head' }, 'claude', `${'{}\n'.repeat(300)}Kanban Manager`)
  assert.equal(classifySession(session, null, stateMap).role, 'Other Claude')
  assert.equal(buildReport([], {}, {}, period, [{ totalCost: 0, totalTokens: 0 }]).check.matches, true)
})

test('CLI uses saved sources and boards without npx or board network', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-by-role-'))
  try {
    await mkdir(join(dir, 'boards'))
    await writeFile(join(dir, 'boards', 'demo.json'), JSON.stringify(boards.demo))
    await writeFile(join(dir, 'claude.json'), JSON.stringify({ sessions: [{ sessionId: 'claude-builder', projectPath: 'missing', totalCost: 5, totalTokens: 500, lastActivity: '2026-10-04T23:00:00Z' }], totals: { totalCost: 5, totalTokens: 500 } }))
    await writeFile(join(dir, 'codex.json'), JSON.stringify({ sessions: [], totals: { costUSD: 0, totalTokens: 0 } }))
    const args = [join(import.meta.dirname, 'scripts', 'usage-by-role.mjs'), '--claude-json', join(dir, 'claude.json'), '--codex-json', join(dir, 'codex.json'), '--boards-dir', join(dir, 'boards'), '--since', '2026-10-04', '--json']
    const report = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }))
    assert.equal(report.rows[0].role, 'Builder')
    assert.equal(report.check.matches, true)
    assert.equal(report.totals.sessions, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a chat is named only by its own SessionStart line, not by CLAUDE.md mentioning other chats', () => {
  const head = JSON.stringify({ message: 'CLAUDE.md: the chat titled "Kanban Manager" owns all board changes' }) + '\n' + JSON.stringify({ message: 'You are the "Injectbuddy work" chat.' })
  assert.equal(classifySession({ engine: 'claude', cwd: 'C:/Users/PFrew', head }, null, { a: { name: 'Kanban Manager' }, b: { name: 'Injectbuddy work' } }).role, 'Orchestrator: Injectbuddy')
})

test('Codex model rows with tokens only share the session cost by tokens', () => {
  const s = normalizeSession({ sessionId: '2026/10/04/rollout-x-01a102e4-b8ce-7aa2-859b-ced108efd9e9', costUSD: 3, totalTokens: 300, models: { a: { totalTokens: 100 }, b: { totalTokens: 200 } } }, 'codex')
  assert.deepEqual(s.models, { a: 1, b: 2 })
})
