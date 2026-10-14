import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sampleDelayMs, applyReading, newestBuilder, stopNewestBuilder, MEMORY_SAMPLE_MS, MEMORY_SAMPLE_LIVE_MS } from './lib/memory-gate.mjs'
import { bind, readBindings } from './lib/bindings.mjs'
import { findCard } from './lib/cards.mjs'

test('sample delay is 10 s while agents are live and 60 s otherwise', () => {
  assert.equal(sampleDelayMs(0), 60000)
  assert.equal(sampleDelayMs(3), 10000)
  assert.deepEqual([MEMORY_SAMPLE_MS, MEMORY_SAMPLE_LIVE_MS], [60000, 10000])
})

test('hysteresis: low under 4 GB, stays low at 5 GB, resumes over 6 GB; low-water mark kept', () => {
  let s = applyReading({ low: false }, 3.9)
  assert.deepEqual([s.low, s.event, s.minGb], [true, 'low', 3.9])
  s = applyReading(s, 5)
  assert.deepEqual([s.low, s.event, s.minGb], [true, 'none', 3.9])
  s = applyReading(s, 6.1)
  assert.deepEqual([s.low, s.event], [false, 'resume'])
  assert.equal(applyReading({ low: false }, 5).event, 'none')
})

const agent = (pane_id, agent_status, startedAt) => ({ pane_id, agent_status, startedAt })

test('newestBuilder picks the latest-started working bound agent, ignoring unbound and done ones', () => {
  const agents = [agent('p1', 'working', '2026-10-14T07:00:00Z'), agent('p2', 'working', '2026-10-14T07:10:00Z'), agent('p3', 'done', '2026-10-14T07:20:00Z'), agent('p4', 'working', '2026-10-14T07:30:00Z')]
  const bindings = { A: { pane_id: 'p1' }, B: { pane_id: 'p2' }, C: { pane_id: 'p3' } } // p4 is a Planner: no binding
  assert.equal(newestBuilder(agents, bindings).id, 'B')
  assert.equal(newestBuilder([agent('p3', 'done')], bindings), null)
  assert.equal(newestBuilder(agents, { A: { pane_id: 'p1', started: '2026-10-14T08:00:00Z' }, B: { pane_id: 'pX' } }).id, 'A')
})

function board(...ids) {
  const tasks = join(mkdtempSync(join(tmpdir(), 'memory-gate-')), 'TASKS')
  mkdirSync(join(tasks, 'working'), { recursive: true })
  for (const id of ids) writeFileSync(join(tasks, 'working', `${id}-card.md`), `# ${id} — Card\n\n## Approved brief\nDo it.\n`)
  return tasks
}

test('AC2: 3 GB free with two live Builders closes only the newer one and requeues its card', async () => {
  const tasks = board('T-1', 'T-2')
  bind(tasks, 'T-1', { pane_id: 'p1', started: '2026-10-14T07:00:00Z' })
  bind(tasks, 'T-2', { pane_id: 'p2', started: '2026-10-14T07:10:00Z' })
  const agents = [agent('p1', 'working'), agent('p2', 'working')]
  const closed = []
  const close = async (pane, session) => { closed.push([pane, session]) }
  const entries = [{ project: 'Proj', tasksDir: tasks, session: 'proj', agents }]
  const now = Date.parse('2026-10-14T07:22:00Z')

  const result = await stopNewestBuilder({ entries, close, now, lastStopAt: 0, gb: 3 })
  assert.deepEqual([result.stopped, result.id], [true, 'T-2'])
  assert.deepEqual(closed, [['p2', 'proj']])
  assert.equal(findCard(tasks, 'T-2').column, 'queue')
  assert.equal(findCard(tasks, 'T-1').column, 'working')
  assert.deepEqual(Object.keys(readBindings(tasks)), ['T-1'])

  // one stop per 30 s: the next sample inside the gap stops nothing
  assert.equal((await stopNewestBuilder({ entries, close, now: now + 10000, lastStopAt: now, gb: 3 })).stopped, false)
  assert.equal(closed.length, 1)
})
