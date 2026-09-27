import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const hook = join(import.meta.dirname, 'scripts', 'codex-stop-hook.mjs')

// Codex's Stop hook input already carries last_assistant_message directly (confirmed
// empirically against codex-cli 0.156.1, 2026-09-27), unlike the Claude hook, which has
// to dig it out of the transcript. Only the card id, role and tasks dir still come from
// regexing the rollout transcript at transcript_path.
const rollout = (root, tasks) => join(root, 'rollout.jsonl')
const stop = (hookPath, transcriptPath, message, active, config) => spawnSync(process.execPath, [hookPath], {
  input: JSON.stringify({ transcript_path: transcriptPath, stop_hook_active: active, last_assistant_message: message }),
  env: { ...process.env, ...(config ? { KANBAN_CONFIG: config } : {}) },
  encoding: 'utf8',
})

test('a board Codex agent stopping on a question is blocked once, then routed to the manager, and released after a handoff', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-stop-hook-'))
  const tasks = join(root, 'Proj', 'TASKS'), inbox = join(root, 'inbox', 'Proj-INBOX.md'), config = join(root, 'board.config.json')
  mkdirSync(join(tasks, 'planning'), { recursive: true })
  writeFileSync(join(tasks, 'planning', 'T-1.md'), '# T-1 — x\n')
  writeFileSync(config, JSON.stringify({ projectsRoot: root, projects: ['Proj'], projectSettings: { Proj: { manager: { chat: 'Proj chat', inbox } } } }))
  const transcript = rollout(root, tasks)
  writeFileSync(transcript, [
    `{"timestamp":"${new Date(Date.now() - 60000).toISOString()}","type":"session_meta"}`,
    `Read PLANNER.md and hand off with node 'hkb.mjs' --tasks '${tasks}' move T-1 planned or move T-1 queue`,
  ].join('\n') + '\n')

  const first = stop(hook, transcript, 'Should the card use (a) or (b)?', false, config)
  assert.equal(JSON.parse(first.stdout).decision, 'block')
  assert.match(JSON.parse(first.stdout).reason, /owner T-1/)
  assert.equal(existsSync(inbox), false)

  assert.equal(stop(hook, transcript, 'Should the card use (a) or (b)?', true, config).stdout, '')
  assert.match(readFileSync(inbox, 'utf8'), /ASK Proj T-1 \(planning\): p-t-1 stopped without a handoff\. Its last message: Should the card use \(a\) or \(b\)\?\n$/)

  mkdirSync(join(tasks, '.history'))
  appendFileSync(join(tasks, '.history', 'T-1.jsonl'), JSON.stringify({ event: 'handoff', stage: 'planning', outcome: 'move', at: new Date().toISOString() }) + '\n')
  assert.equal(stop(hook, transcript, 'Should the card use (a) or (b)?', false, config).stdout, '')
  assert.equal(stop(hook, transcript, 'done, no more questions', true, config).stdout, '')
  assert.equal(readFileSync(inbox, 'utf8').split('\n').filter(Boolean).length, 1)
})

test('a Codex agent with no board card (the operator\'s own chat) stops normally even on a question', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-stop-hook-'))
  const transcript = join(root, 'rollout.jsonl')
  writeFileSync(transcript, 'plain conversation, no --tasks and no role file here\n')
  const result = stop(hook, transcript, 'Should I continue?', false)
  assert.equal(result.stdout, '')
})
