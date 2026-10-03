import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { dailyMetrics } from './lib/metrics.mjs'

test('UTC metrics count fixture logs once, refresh appended/replaced files, and serve a read-only page/API', async t => {
  mkdirSync(join(import.meta.dirname, 'tmp'), { recursive: true })
  const root = mkdtempSync(join(import.meta.dirname, 'tmp', 'metrics-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const tasks = join(root, 'Proj', 'TASKS'), history = join(tasks, '.history')
  mkdirSync(history, { recursive: true })
  const now = Date.parse('2026-10-03T23:59:00Z'), at = '2026-10-03T12:00:00Z'
  const events = [
    { event: 'failure', stage: 'working', note: '[planning] wrong path' },
    { event: 'failure', stage: 'working', note: '[IMPLEMENTATION] fix it' },
    { event: 'failure', stage: 'working', note: '[evidence] missing check' },
    { event: 'failure', stage: 'working', note: '[operational] missing tool' },
    { event: 'failure', stage: 'working', note: 'no tag', category: 'evidence' },
    { event: 'handoff', stage: 'working', outcome: 'issue', note: '[planning] wrong path' }, // mirrored handoff
    { event: 'operational-failure', stage: 'working', reason: '[evidence] missing check' }, // mirrored hold
    { event: 'failure', stage: 'review', note: '[planning] Reviewer return' },
    { event: 'builder-delivery-failed' }, { event: 'builder-no-handoff' },
    { event: 'failure', stage: 'planning', note: '[planning] cannot plan' },
    { event: 'planner-delivery-failed' }, { event: 'planner-no-handoff' },
    { event: 'start-failed', role: 'planner', reason: 'start timeout' },
    { event: 'transition', from: 'working', to: 'owner' },
    { event: 'transition', from: 'owner', to: 'pou' }, // legacy Owner alias, no new escalation
    { event: 'transition', from: 'review', to: 'archive' },
    { event: 'transition', from: 'archive', to: 'archive' },
    { event: 'transition', from: 'review', to: 'archive' }, // count cards, not repeated transitions
    { event: 'stall-recovery' },
    { event: 'failure', stage: 'working', note: '[planning] yesterday', at: '2026-10-03T00:30:00+02:00' },
    { event: 'failure', stage: 'working', note: '[planning] invalid date', at: 'garbage' },
    { event: 'card-update', text: 'ignored saved card text '.repeat(50000) },
  ]
  const cardPath = join(history, 'T-1.jsonl')
  writeFileSync(cardPath, events.map(e => JSON.stringify({ at, ...e })).join('\n') + '\nnot json\n')
  writeFileSync(join(history, 'T-2.jsonl'), JSON.stringify({ at, event: 'transition', from: 'review', to: 'archive' }) + '\n')
  const activityPath = join(tasks, 'activity.log')
  const activity = (event, message, card = 'T-1') => `${at} project=Proj card=${card} event=${event} message=${message}\n`
  writeFileSync(activityPath, activity('integrated', 'commit abc') + activity('integrated', 'commit abc') +
    activity('move', 'review -> archive') + activity('builder-failure', 'working -> planning (issue)') +
    activity('planner-failure', 'planning -> planning (issue)') + activity('codex-planner-failure', '[planning] cannot plan') +
    activity('failure', 'planner: start timeout') + activity('failure', 'planner: tab creation failed', 'T-3') +
    activity('failure', 'agent list unavailable', '-') + activity('owner-alert', 'Pushover sent') + activity('stall', 'retry'))
  const stallsPath = join(tasks, 'stalls.log')
  writeFileSync(stallsPath, `${at}\tT-1\tworking\tidle\tretry\n${at}\tT-2\tqueue\tidle\tmoved to Owner\ninvalid\n`)
  let clock = Date.now()
  t.mock.method(Date, 'now', () => clock)
  const rows = await dailyMetrics(tasks, 7, now)
  assert.equal(rows.length, 7)
  assert.deepEqual(rows[0], { builderDifficulty: Object.fromEntries(['tiny', 'easy', 'medium', 'hard'].map(d => [d, { attempts: 0, kickBacks: 0 }])), day: '2026-10-03', integrated: 1, archived: 2, finished: 2,
    kickBacks: { planning: 1, implementation: 1, evidence: 1, operational: 1, untagged: 1, total: 5 },
    builderDeliveryFailed: 1, builderNoHandoff: 1, plannerFailures: 5, stalls: 2, ownerEscalations: 1, kickBacksPerFinishedCard: 2.5 })
  assert.equal(rows[1].day, '2026-10-02')
  assert.equal(rows[1].kickBacks.total, 1)
  assert.equal(rows[1].kickBacksPerFinishedCard, null)
  assert.equal(rows[6].kickBacks.total, 0)
  await assert.rejects(dailyMetrics(tasks, 0, now), /days/)
  await assert.rejects(dailyMetrics(tasks, 367, now), /days/)
  await assert.rejects(dailyMetrics(tasks, 1.5, now), /days/)
  // Split an appended UTF-8 JSON record across polls; never count its incomplete prefix.
  const partial = Buffer.from(JSON.stringify({ at, event: 'failure', stage: 'working', note: '[planning] café' }) + '\n')
  const split = partial.indexOf(Buffer.from('é')) + 1
  appendFileSync(cardPath, partial.subarray(0, split))
  assert.equal((await dailyMetrics(tasks, 1, now))[0].kickBacks.total, 5) // warm cache
  clock += 5001
  assert.equal((await dailyMetrics(tasks, 1, now))[0].kickBacks.total, 5)
  appendFileSync(cardPath, partial.subarray(split))
  clock += 5001
  assert.equal((await dailyMetrics(tasks, 1, now))[0].kickBacks.total, 6)
  assert.equal((await dailyMetrics(tasks, 1, now + 86400000))[0].day, '2026-10-04')
  writeFileSync(cardPath, JSON.stringify({ at, event: 'builder-no-handoff' }) + '\n') // truncation rebuilds
  rmSync(join(history, 'T-2.jsonl'))
  clock += 5001
  const replaced = (await dailyMetrics(tasks, 1, now))[0]
  assert.equal(replaced.kickBacks.total, 0)
  assert.equal(replaced.archived, 0)
  assert.equal(replaced.builderNoHandoff, 1)
  assert.equal((await dailyMetrics(join(root, 'Empty', 'TASKS'), 1, now))[0].finished, 0)

  const socket = createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  const configPath = join(root, 'board.config.json')
  writeFileSync(configPath, JSON.stringify({ port, mode: 'manual', projectsRoot: root, projects: ['Proj'],
    maxConcurrentAgents: 0, agentPollMs: 3600000, engine: { kind: 'codex' }, models: {} }))
  const child = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname,
    env: { ...process.env, KANBAN_CONFIG: configPath, HERDR_BIN_PATH: 'missing-herdr-for-metrics-test', KANBAN_LAN_HOST: '' }, stdio: 'ignore' })
  try {
    const base = `http://127.0.0.1:${port}`
    let response
    for (let i = 0; i < 80; i++) {
      try { response = await fetch(`${base}/api/metrics?project=Proj`); break } catch {}
      if (child.exitCode !== null) throw new Error('fixture server exited')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(response, 'fixture server started')
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.timezone, 'UTC')
    assert.equal(payload.metrics.length, 7)
    assert.equal((await (await fetch(`${base}/api/metrics?project=Proj&days=2`)).json()).metrics.length, 2)
    for (const query of ['project=../escape', 'project=Proj&days=0', 'project=Proj&days=no', 'project=Proj&days=1.5', 'project=Proj&days=367']) {
      assert.equal((await fetch(`${base}/api/metrics?${query}`)).status, 400)
    }
    assert.match(await (await fetch(`${base}/metrics.html`)).text(), /Daily board health/)
    assert.match(await (await fetch(`${base}/metrics.js`)).text(), /api\/metrics/)
    assert.match(await (await fetch(base)).text(), /href="\/metrics.html"/)
    assert.equal(readFileSync(cardPath, 'utf8'), JSON.stringify({ at, event: 'builder-no-handoff' }) + '\n')
  } finally {
    child.kill()
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))
  }
})
