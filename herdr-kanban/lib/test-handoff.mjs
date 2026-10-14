// A Builder hands a long test command to the board and ends its run (HK64).
// The board runs it detached (test-handoff-runner.mjs), saves the result next to the card's
// evidence, then starts one fresh short agent on that record. Short checks stay in the Builder.

import { spawn as nodeSpawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findCard } from './cards.mjs'
import { readWorkflow, updateWorkflow } from './workflow-state.mjs'
import { appendHistory } from './card-history.mjs'
import { bind, unbind, liveBindings } from './bindings.mjs'
import { spawnForCard } from './spawn.mjs'
import { routeBuilderNoHandoff, slotsFree } from './autospawn.mjs'
import { testResultPrompt } from './prompt.mjs'
import { engineKind } from './quota.mjs'
import { sessionOf } from './herdr.mjs'
import { recordUsageStart } from './request-usage.mjs'
import { builderDifficulty } from './difficulty.mjs'
import { writeRecord } from './test-handoff-runner.mjs'

export { parseCounts } from './test-handoff-runner.mjs'

const RUNNER = fileURLToPath(new URL('./test-handoff-runner.mjs', import.meta.url))
const MAX_DISPATCH_FAILURES = 3
const alive = pid => { try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' } }
const readRecord = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }

export const testRunPending = (tasksDir, cardId) => !!readWorkflow(tasksDir)[String(cardId).toUpperCase()]?.testRun

export function submitTestRun({ tasksDir, cardId, name, command, cwd, timeoutSeconds = 3600, start = nodeSpawn }) {
  const card = findCard(tasksDir, cardId)
  if (card.column !== 'working') throw new Error(`tests hands off a Builder's run; ${card.id} is in ${card.column}`)
  if (!/^[\w.-]{1,40}$/.test(String(name || ''))) throw new Error('test run name must be 1-40 characters of letters, digits, _ . -')
  if (!String(command || '').trim()) throw new Error('test run needs a command')
  if (!(timeoutSeconds > 0)) throw new Error('--timeout needs a positive number of seconds')
  const pending = readWorkflow(tasksDir)[card.id]?.testRun
  if (pending) throw new Error(`${card.id} already has a handed-off run (${pending.name}); wait for its result`)
  const dir = join(tasksDir, '.evidence', card.id)
  mkdirSync(dir, { recursive: true })
  const recordPath = join(dir, `testrun-${name}.json`), log = join(dir, `testrun-${name}.log`)
  const submittedAt = new Date().toISOString()
  const record = { state: 'running', name, command, cwd, timeoutSeconds, log, submittedAt }
  writeFileSync(log, '')
  writeRecord(recordPath, record)
  const child = start(process.execPath, [RUNNER, recordPath], { detached: true, stdio: 'ignore', windowsHide: true })
  child.on?.('error', () => {}) // a runner that never started is found by dispatchTestResults (dead pid)
  child.unref?.()
  if (!child.pid) throw new Error('could not start the test runner')
  updateWorkflow(tasksDir, card.id, { testRun: { name, record: recordPath, submittedAt } })
  appendHistory(tasksDir, card.id, { event: 'test-handoff-submitted', stage: 'working', name, command })
  return { ...record, pid: child.pid, record: recordPath }
}

// Module-level so two overlapping scheduler passes never start two agents for one result.
const dispatching = new Set()

export async function dispatchTestResults({ project, projectPath, tasksDir, boardRoot, model, engine, gitSettings, onChange, log, agents, max, spawn = spawnForCard }) {
  const started = []
  for (const [id, state] of Object.entries(readWorkflow(tasksDir))) {
    if (!state?.testRun || dispatching.has(id)) continue
    let card
    try { card = findCard(tasksDir, id) } catch { continue }
    if (card.column !== 'working') { updateWorkflow(tasksDir, id, { testRun: null }); continue } // the Builder finished by hand
    if (liveBindings(tasksDir, agents)[id] || slotsFree({ tasksDir, agents, max }) < 1) continue

    const recordPath = state.testRun.record
    let record = readRecord(recordPath)
    const lost = !record ? 'the test run record is missing'
      : record.state === 'running' && (record.pid ? !alive(record.pid) : Date.now() - Date.parse(record.submittedAt) > 60000) ? 'the test run stopped before finishing'
      : ''
    if (!record || lost) {
      record = { name: state.testRun.name, ...record, state: 'finished', exitCode: null, passed: null, failed: null, timedOut: false, error: lost, finishedAt: new Date().toISOString() }
      writeRecord(recordPath, record)
    }
    if (record.state !== 'finished') continue

    dispatching.add(id)
    try {
      const difficulty = builderDifficulty(card, state)
      const result = await spawn({
        project, projectPath, tasksDir, boardRoot, card, model, engine, gitSettings,
        shortPrompt: ({ workspacePath }) => testResultPrompt({ card, record, recordPath, workspacePath, boardRoot, tasksDir, engine }),
        onPane: (provisional) => {
          bind(tasksDir, id, { ...provisional, engine: engineKind(engine), model })
          try {
            recordUsageStart({ tasksDir, project, requestId: id, cardIds: [id], role: 'builder', paneId: provisional.pane_id, tabId: provisional.tab_id, model, name: provisional.name, difficulty, agentSession: provisional.agent_session })
          } catch {}
          onChange?.()
        },
      })
      const binding = { ...result, engine: engineKind(engine), model }
      bind(tasksDir, id, binding)
      updateWorkflow(tasksDir, id, { builder: binding, testRun: null })
      writeRecord(recordPath, { ...record, dispatchedAt: new Date().toISOString() })
      appendHistory(tasksDir, id, { event: 'test-handoff-dispatched', stage: 'working', record: recordPath })
      log?.(`${id}: test result handed to a fresh agent`)
      started.push(id)
    } catch (err) {
      unbind(tasksDir, id)
      if (err.paused) continue // nothing ran; try again next poll
      const failures = (record.dispatchFailures || 0) + 1
      writeRecord(recordPath, { ...record, dispatchFailures: failures })
      log?.(`${id}: test result dispatch failed (${failures}/${MAX_DISPATCH_FAILURES}) — ${err.message}`)
      if (err.movedAway || failures >= MAX_DISPATCH_FAILURES) {
        updateWorkflow(tasksDir, id, { testRun: null })
        if (!err.movedAway) routeBuilderNoHandoff({ tasksDir, cardId: id, reason: `test result could not be handed to an agent; result at ${recordPath}`, evidence: err.message, boardRoot, engine, model, session: sessionOf(project) })
      }
    } finally { dispatching.delete(id); onChange?.() }
  }
  return started
}
