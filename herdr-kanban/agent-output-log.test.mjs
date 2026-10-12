import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendHistory, logAgentOutput } from './lib/card-history.mjs'

// Audit 2026-10-12 report #11: finished-output and completed-builder-retirement events stored
// the agent's whole pane output (107.5M + 52.5M chars/week on Injectbuddy alone; nothing read
// either event type back in 7 days). logAgentOutput keeps the full text on disk and hands back
// only a log path and a 2,000-char tail for the history event.
test('finished-output keeps the full agent output on disk and a short tail in history (AC1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'output-log-'))
  const output = 'x'.repeat(50000) + 'END OF RUN'
  const { log, outputTail } = logAgentOutput(dir, 'T-1', 'finished-output', output)
  assert(existsSync(log), 'full output is preserved on disk')
  assert.equal(readFileSync(log, 'utf8'), output)
  assert.equal(outputTail.length, 2000)
  assert(outputTail.endsWith('END OF RUN'))
  const event = appendHistory(dir, 'T-1', { event: 'finished-output', agent: 'b-t-1', run: 'session', log, outputTail })
  assert(JSON.stringify(event).length <= 4000, 'event stays at or below 4,000 characters')
  assert.match(event.log, /T-1-finished-output-\d+\.log$/, 'event names the agent log file')
})

test('completed-builder-retirement keeps the card snapshot and output on disk, not in history (AC2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'output-log-')), output = 'y'.repeat(50000)
  const retirementLog = logAgentOutput(dir, 'T-2', 'builder-retirement', `${'card text\n'.repeat(500)}\n\n=== output ===\n${output}`)
  const event = appendHistory(dir, 'T-2', {
    event: 'completed-builder-retirement', builder: { pane_id: 'b-t-2', name: 'b-t-2' }, sessionId: 'session',
    worktree: { workspacePath: dir, baseCommit: 'abc123' }, ...retirementLog
  })
  assert(JSON.stringify(event).length <= 4000, 'event stays at or below 4,000 characters')
  assert(existsSync(event.log), 'the card text and output are both preserved on disk')
})
