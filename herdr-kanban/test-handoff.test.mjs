import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { submitTestRun, dispatchTestResults, testRunPending, parseCounts } from './lib/test-handoff.mjs'
import { writeRecord } from './lib/test-handoff-runner.mjs'
import { readWorkflow, updateWorkflow } from './lib/workflow-state.mjs'
import { readBindings, unbind } from './lib/bindings.mjs'
import { routeBuilderNoHandoff } from './lib/autospawn.mjs'

const ACS = ['- AC1: first outcome is observable', '- AC2: second outcome is observable']
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const read = path => JSON.parse(readFileSync(path, 'utf8'))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'test-handoff-')), tasks = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasks, 'working'), { recursive: true })
  writeFileSync(join(tasks, 'working', 'T-1.md'), `# T-1 — card\n**Workflow:** card-owned\n\n## Acceptance criteria\n${ACS.join('\n')}\n\n## Evidence\n`)
  const submit = (name, command, timeoutSeconds) => submitTestRun({ tasksDir: tasks, cardId: 'T-1', name, command, cwd: root, timeoutSeconds })
  const finished = async (recordPath) => {
    for (let i = 0; i < 300; i++) { const r = read(recordPath); if (r.state === 'finished') return r; await sleep(100) }
    throw new Error('record never finished')
  }
  // Stub spawn: captures the prompt and model the fresh agent would get, then reports a bound pane.
  // Defaults: the card's Builder assignment is Claude, and the agent is live.
  const claudeBuilder = () => ({ engine: 'claude', model: 'claude-sonnet-5-5', reasoning: 'high' })
  const dispatch = async ({ spawn: stub, confirmLive = async () => true, log, assignmentForCard = claudeBuilder } = {}) => {
    const prompts = [], spawned = []
    const spawn = stub || (async opts => {
      prompts.push(opts.shortPrompt({ workspacePath: root }))
      spawned.push({ model: opts.model, engine: opts.engine })
      return { pane_id: 'p-fixture', tab_id: 't-fixture', name: 'fixture' }
    })
    const started = await dispatchTestResults({ project: 'fixture', projectPath: root, tasksDir: tasks, boardRoot: root, assignmentForCard, agents: [], max: 4, spawn, confirmLive, log })
    unbind(tasks, 'T-1') // the stub's pane is not a live agent; free the slot for the next run
    return { started, prompts, spawned }
  }
  return { root, tasks, submit, finished, dispatch }
}

test('parseCounts reads Playwright/vitest and node:test summaries, null when absent', () => {
  assert.deepEqual(parseCounts('2 failed\n18 passed (3.1m)'), { passed: 18, failed: 2 })
  assert.deepEqual(parseCounts('# pass 7\n# fail 1'), { passed: 7, failed: 1 })
  assert.deepEqual(parseCounts('nothing here'), { passed: null, failed: null })
})

test('AC1: submit returns while a longer command is still running', async t => {
  const { tasks, submit, finished } = fixture(t)
  const run = submit('long', 'node -e "setTimeout(()=>{},4000)"')
  assert.equal(run.state, 'running')
  assert.ok(alive(run.pid), 'the runner outlives the submit call')
  assert.equal(read(run.record).state, 'running')
  assert.ok(testRunPending(tasks, 'T-1'))
  assert.equal(readWorkflow(tasks)['T-1'].testRun.record, run.record)
  assert.throws(() => submit('second', 'node -e "0"'), /already has a handed-off run/)
  await finished(run.record)
})

test('AC2: a finished command is saved with exit code, counts and log path in the evidence folder', async t => {
  const { tasks, submit, finished } = fixture(t)
  const run = submit('counts', `node -e "console.log('3 passed');console.log('1 failed');process.exit(1)"`)
  const rec = await finished(run.record)
  assert.equal(run.record, join(tasks, '.evidence', 'T-1', 'testrun-counts.json'))
  assert.ok(existsSync(run.record))
  assert.equal(rec.exitCode, 1)
  assert.equal(rec.passed, 3)
  assert.equal(rec.failed, 1)
  assert.equal(rec.timedOut, false)
  assert.ok(existsSync(rec.log) && /3 passed/.test(readFileSync(rec.log, 'utf8')))
})

test('AC3: one fresh agent starts on the saved result; its brief has the record path and ACs, not the log', async t => {
  const { tasks, submit, finished, dispatch } = fixture(t)
  const run = submit('brief', `node -e "console.log('LOGONLY-MARKER-9137');console.log('2 passed')"`)
  await finished(run.record)
  const { started, prompts } = await dispatch()
  assert.deepEqual(started, ['T-1'])
  assert.equal(prompts.length, 1)
  const [p] = prompts
  assert.ok(p.includes(run.record.replaceAll('\\', '/')))
  for (const ac of ACS) assert.ok(p.includes(ac), `brief lost ${ac}`)
  assert.ok(!p.includes('LOGONLY-MARKER-9137'), 'the log text must stay out of the brief')
  assert.ok(!/\n/.test(p), 'single line')
  assert.equal(readWorkflow(tasks)['T-1'].testRun, null)
  assert.equal(readBindings(tasks)['T-1'], undefined) // unbound by the fixture after the stub bound it
  assert.match(readFileSync(join(tasks, '.history', 'T-1.jsonl'), 'utf8'), /test-handoff-dispatched/)
  assert.ok(read(run.record).dispatchedAt)
  assert.deepEqual((await dispatch()).started, [], 'nothing left to dispatch')
})

test('AC4: failed, timed-out and lost runs are saved and the agent receives the failure', async t => {
  const { root, tasks, submit, finished, dispatch } = fixture(t)

  const failing = submit('fail', 'node -e "process.exit(2)"')
  assert.equal((await finished(failing.record)).exitCode, 2)
  assert.match((await dispatch()).prompts[0], /exit code 2/)

  const pidFile = join(root, 'child.pid').replaceAll('\\', '/')
  const slow = submit('slow', `node -e "require('fs').writeFileSync('${pidFile}',String(process.pid));setTimeout(()=>{},30000)"`, 1)
  const timedOut = await finished(slow.record)
  assert.equal(timedOut.timedOut, true)
  assert.ok(!alive(Number(readFileSync(pidFile, 'utf8'))), 'the timed-out process tree is gone')
  assert.match((await dispatch()).prompts[0], /timed out true/)

  // A runner that died without writing a result: record left running with a dead pid.
  const lostPath = join(tasks, '.evidence', 'T-1', 'testrun-lost.json')
  writeRecord(lostPath, { state: 'running', name: 'lost', command: 'x', cwd: root, log: lostPath, submittedAt: new Date().toISOString(), pid: 2147483000 })
  updateWorkflow(tasks, 'T-1', { testRun: { name: 'lost', record: lostPath } })
  assert.match((await dispatch()).prompts[0], /stopped before finishing/)
  assert.equal(read(lostPath).state, 'finished')
})

test('a Working card with a handed-off run stays in Working when its Builder exits', async t => {
  const { tasks, submit, finished } = fixture(t)
  const run = submit('wait', 'node -e "setTimeout(()=>{},1500)"')
  const card = routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-1', reason: 'Builder ended after handing off a test run' })
  assert.equal(card.column, 'working')
  assert.ok(testRunPending(tasks, 'T-1'))
  assert.equal(readBindings(tasks)['T-1'], undefined)
  await finished(run.record)
})

test('IA235: the test-result agent gets the card Builder model and engine; a gpt name never reaches a Claude spawn', async t => {
  const { submit, finished, dispatch } = fixture(t)
  const run = submit('model', `node -e "console.log('1 passed')"`)
  await finished(run.record)
  const { started, spawned } = await dispatch()
  assert.deepEqual(started, ['T-1'])
  assert.deepEqual(spawned, [{ model: 'claude-sonnet-5-5', engine: { kind: 'claude', effort: 'high' } }])
  assert.ok(!spawned.some(s => /gpt/i.test(s.model)))
})

test('IA235: a test-result agent that is not running is not logged as handed off and the run stays queued', async t => {
  const { tasks, submit, finished, dispatch } = fixture(t)
  const run = submit('dead', `node -e "console.log('1 passed')"`)
  await finished(run.record)
  const log = []
  const { started } = await dispatch({ log: m => log.push(m), confirmLive: async () => false })
  assert.deepEqual(started, [])
  assert.ok(!log.some(m => /handed to a fresh agent/.test(m)), 'no success line for a dead agent')
  assert.ok(log.some(m => /dispatch failed \(1\/3\).*is not running/.test(m)), log.join('\n'))
  assert.ok(testRunPending(tasks, 'T-1'), 'the run stays queued for the next poll')
  assert.doesNotMatch(readFileSync(join(tasks, '.history', 'T-1.jsonl'), 'utf8'), /test-handoff-dispatched/)
  assert.equal(readBindings(tasks)['T-1'], undefined)
})

test('IA235: the success line is written only after the fresh agent is confirmed live', async t => {
  const { submit, finished, dispatch } = fixture(t)
  const run = submit('live', `node -e "console.log('1 passed')"`)
  await finished(run.record)
  const order = []
  const { started } = await dispatch({
    log: m => order.push(`log: ${m}`),
    confirmLive: async () => { order.push('confirm'); return true },
  })
  assert.deepEqual(started, ['T-1'])
  assert.deepEqual(order, ['confirm', 'log: T-1: test result handed to a fresh agent'])
})

test('IA235: no Builder assignment for the card means nothing spawns and the failure is logged', async t => {
  const { submit, finished, dispatch } = fixture(t)
  const run = submit('noassign', `node -e "console.log('1 passed')"`)
  await finished(run.record)
  const log = []
  const { started, spawned } = await dispatch({ log: m => log.push(m), assignmentForCard: () => null })
  assert.deepEqual(started, [])
  assert.deepEqual(spawned, [])
  assert.match(log.join('\n'), /test result dispatch failed/)
})

test('IA235: no spawn site reads config.models, so a legacy gpt name cannot reach a Claude spawn', () => {
  for (const f of ['server.mjs', 'lib/card-runner.mjs', 'lib/test-handoff.mjs', 'lib/autospawn.mjs']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
    assert.doesNotMatch(src, /config\.models\??\.\w+|model:\s*config\.models/, `${f} reads config.models`)
  }
})
