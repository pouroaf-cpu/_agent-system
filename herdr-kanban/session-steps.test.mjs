import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { sessionRollup, projectSessionRollup, median, percentile } from './lib/session-steps.mjs'
import { nzDay } from './lib/nz-time.mjs'

const now = Date.parse('2026-10-13T03:00:00Z') // 13 Oct 16:00 NZDT
const run = (role, finish, steps, total, extra = {}) => ({ role, cardIds: ['T-1'], status: 'complete', finish: { at: finish }, steps, delta: total == null ? null : { total }, ...extra })
const D13 = '2026-10-13T01:00:00Z' // NZ 13 Oct 14:00
const runs = [
  // Builder, 13 Oct NZ, not split: known 10/20/30/40 (even count -> 25), unknown null/undefined/shared.
  run('builder', D13, 10, 100), run('builder', D13, 20, 200), run('builder', D13, 30, 300),
  run('builder', '2026-10-12T12:30:00Z', 40, 400), // UTC 12 Oct, NZ 13 Oct 01:30
  run('builder', D13, null, 1000), run('builder', D13, undefined, 2000), run('builder', D13, 99, 5, { shared: true }),
  // Builder child of a split (also names the parent: child wins).
  run('builder', D13, 5, 10, { cardIds: ['t-2'] }), run('builder', D13, 7, 20, { cardIds: ['T-2'] }),
  run('builder', D13, 9, 30, { cardIds: ['T-2'] }), run('builder', D13, 11, 40, { cardIds: ['T-0', 'T-2'] }),
  run('builder', D13, 50, 500, { cardIds: ['T-0'] }), // split parent
  // Never counted.
  run('builder', D13, 1000, 1, { duplicateOf: 'x' }), { ...run('builder', D13, 1000, 1), finish: undefined },
  run('reviewer', D13, 1000, 1), run('finder', D13, 1000, 1), run('builder', 'garbage', 1000, 1),
  run('builder', '2026-10-11T10:00:00Z', 1000, 1), // NZ 11 Oct: outside a 2-day window
  // Planner: 13 Oct all unknown (Codex); 12 Oct NZ spans two UTC days.
  run('planner', D13, null, 60), run('planner', D13, undefined, 80),
  run('planner', '2026-10-12T10:30:00Z', 12, 120), run('planner', '2026-10-11T12:30:00Z', 14, 140),
]
const split = { children: new Set(['T-2']), parents: new Set(['T-0']) }

test('median and percentile use the average of two middles and nearest rank', () => {
  assert.equal(median([]), null)
  assert.equal(median([3]), 3)
  assert.equal(median([1, 2, 3, 4]), 2.5)
  assert.equal(percentile([], 0.9), null)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9)
  assert.equal(nzDay('2026-10-12T10:30:00Z'), '2026-10-12')
  assert.equal(nzDay('2026-10-12T12:30:00Z'), '2026-10-13')
})

test('sessionRollup groups by NZ day, role and split status; unknown steps never count as 0', () => {
  const rows = sessionRollup(runs, split, { days: 2, now })
  assert.deepEqual(rows.map(r => r.day), ['2026-10-13', '2026-10-12'])
  const [d13, d12] = rows
  assert.deepEqual(d13.builder.notSplit, { sessions: 7, unknown: 3, medianSteps: 25, p90Steps: 40, medianTokens: 350 })
  assert.deepEqual(d13.builder.child, { sessions: 4, unknown: 0, medianSteps: 8, p90Steps: 11, medianTokens: 25 })
  assert.deepEqual(d13.builder.parent, { sessions: 1, unknown: 0, medianSteps: 50, p90Steps: 50, medianTokens: 500 })
  assert.deepEqual(d13.builder.all, { sessions: 12, unknown: 3, medianSteps: 11, p90Steps: 50, medianTokens: 200 })
  assert.deepEqual(d13.planner.all, { sessions: 2, unknown: 2, medianSteps: null, p90Steps: null, medianTokens: 70 })
  assert.equal(d13.planner.notSplit.medianSteps, null)
  assert.deepEqual(d12.planner.all, { sessions: 2, unknown: 0, medianSteps: 13, p90Steps: 14, medianTokens: 130 })
  assert.deepEqual(d12.builder.all, { sessions: 0, unknown: 0, medianSteps: null, p90Steps: null, medianTokens: null })
  assert.equal(sessionRollup(runs, split, { days: 7, now }).length, 7)
})

test('projectSessionRollup reads split lines from cards, never writes, and the API serves it', async t => {
  mkdirSync(join(import.meta.dirname, 'tmp'), { recursive: true })
  const root = mkdtempSync(join(import.meta.dirname, 'tmp', 'steps-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const tasks = join(root, 'Proj', 'TASKS')
  for (const dir of ['archive', 'backlog']) mkdirSync(join(tasks, dir), { recursive: true })
  const card = (id, extra = '') => `# ${id} — ${id} title\n\n**Created:** 2026-10-13T00:00:00.000Z\n${extra}\n## Approved brief\nx\n`
  const files = {
    [join(tasks, 'archive', 'T-0.md')]: card('T-0'),
    [join(tasks, 'backlog', 'T-2.md')]: card('T-2', '**Split from:** T-0\n'),
    [join(tasks, 'backlog', 'T-3.md')]: card('T-3', '**split from:**   t-0\n'),
    [join(tasks, '.request-usage.json')]: JSON.stringify({ version: 1, runs: Object.fromEntries(runs.map((r, i) => [`r${i}`, r])) }, null, 2) + '\n',
  }
  for (const [path, text] of Object.entries(files)) writeFileSync(path, text)
  const rows = projectSessionRollup(tasks, 2, now)
  assert.deepEqual(rows[0].builder.child, { sessions: 4, unknown: 0, medianSteps: 8, p90Steps: 11, medianTokens: 25 })
  assert.equal(rows[0].builder.parent.sessions, 1)
  assert.equal(rows[0].builder.notSplit.sessions, 7)
  for (const [path, text] of Object.entries(files)) assert.equal(readFileSync(path, 'utf8'), text)
  assert.deepEqual(projectSessionRollup(join(root, 'Empty', 'TASKS'), 1, now)[0].builder.all.sessions, 0)

  // The API reads the same usage file; the day window ends on the real NZ today, so only the shape is asserted here.
  const socket = createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  const configPath = join(root, 'board.config.json')
  writeFileSync(configPath, JSON.stringify({ port, mode: 'manual', projectsRoot: root, projects: ['Proj'],
    maxConcurrentAgents: 0, agentPollMs: 3600000, engine: { kind: 'codex' }, models: {} }))
  const child = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname,
    env: { ...process.env, KANBAN_CONFIG: configPath, HERDR_BIN_PATH: 'missing-herdr-for-steps-test', KANBAN_LAN_HOST: '' }, stdio: 'ignore' })
  try {
    const base = `http://127.0.0.1:${port}`
    let response
    for (let i = 0; i < 80; i++) {
      try { response = await fetch(`${base}/api/session-steps?project=Proj`); break } catch {}
      if (child.exitCode !== null) throw new Error('fixture server exited')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(response, 'fixture server started')
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.timezone, 'Pacific/Auckland')
    assert.equal(payload.rollup.length, 7)
    assert.deepEqual(Object.keys(payload.rollup[0].builder), ['all', 'child', 'notSplit', 'parent'])
    assert.equal((await (await fetch(`${base}/api/session-steps?project=Proj&days=2`)).json()).rollup.length, 2)
    for (const query of ['project=../escape', 'project=Proj&days=0', 'project=Proj&days=no', 'project=Proj&days=1.5', 'project=Proj&days=367']) {
      assert.equal((await fetch(`${base}/api/session-steps?${query}`)).status, 400)
    }
    assert.match(await (await fetch(`${base}/metrics.js`)).text(), /api\/session-steps/)
    assert.match(await (await fetch(`${base}/metrics.html`)).text(), /New Zealand calendar day/)
  } finally {
    child.kill()
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))
  }
})
