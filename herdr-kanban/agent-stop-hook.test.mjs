import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const hook = join(import.meta.dirname, 'scripts', 'agent-stop-hook.mjs')

test('a board agent stopping on a question is blocked once, then routed to the manager, and released after a handoff', () => {
  const root = mkdtempSync(join(tmpdir(), 'stop-hook-'))
  const tasks = join(root, 'Proj', 'TASKS'), inbox = join(root, 'inbox', 'Proj-INBOX.md'), config = join(root, 'board.config.json')
  mkdirSync(join(tasks, 'planning'), { recursive: true })
  writeFileSync(join(tasks, 'planning', 'T-1.md'), '# T-1 — x\n')
  writeFileSync(config, JSON.stringify({ projectsRoot: root, projects: ['Proj'], projectSettings: { Proj: { manager: { chat: 'Proj chat', inbox } } } }))
  const transcript = join(root, 'session.jsonl')
  writeFileSync(transcript, [
    { type: 'agent-name', agentName: 'p-t-1' },
    { type: 'user', timestamp: new Date(Date.now() - 60000).toISOString(), message: { role: 'user', content: `hand off with node 'hkb.mjs' --tasks '${tasks}' move T-1 queue` } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Should the card use (a) or (b)?' }] } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n')
  const stop = active => spawnSync(process.execPath, [hook], { input: JSON.stringify({ transcript_path: transcript, stop_hook_active: active }), env: { ...process.env, KANBAN_CONFIG: config }, encoding: 'utf8' })

  const first = stop(false)
  assert.equal(JSON.parse(first.stdout).decision, 'block')
  assert.match(JSON.parse(first.stdout).reason, /owner T-1/)
  assert.equal(existsSync(inbox), false)

  assert.equal(stop(true).stdout, '')
  assert.match(readFileSync(inbox, 'utf8'), /ASK Proj T-1 \(planning\): p-t-1 stopped without a handoff\. Its last message: Should the card use \(a\) or \(b\)\?\n$/)

  mkdirSync(join(tasks, '.history'))
  appendFileSync(join(tasks, '.history', 'T-1.jsonl'), JSON.stringify({ event: 'handoff', stage: 'planning', outcome: 'move', at: new Date().toISOString() }) + '\n')
  assert.equal(stop(false).stdout, '')
  assert.equal(stop(true).stdout, '')
  assert.equal(readFileSync(inbox, 'utf8').split('\n').filter(Boolean).length, 1)
})
