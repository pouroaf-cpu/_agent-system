import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const hook = join(import.meta.dirname, 'scripts', 'agent-handoff-hook.mjs')

// One temp board per case: a transcript for `agent`, an optional handoff event `ageMs` old, then the hook run.
function setup(agent, handoff) {
  const root = mkdtempSync(join(tmpdir(), 'handoff-hook-'))
  const tasks = join(root, 'Proj', 'TASKS')
  mkdirSync(join(tasks, '.history'), { recursive: true })
  const transcript = join(root, 'session.jsonl')
  writeFileSync(transcript, [
    { type: 'agent-name', agentName: agent },
    { type: 'user', timestamp: new Date(Date.now() - 600000).toISOString(), message: { role: 'user', content: `hand off with node 'hkb.mjs' --tasks '${tasks}' done T-1` } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n')
  if (handoff) appendFileSync(join(tasks, '.history', 'T-1.jsonl'), JSON.stringify({ event: 'handoff', stage: 'x', outcome: handoff.outcome, at: new Date(Date.now() - (handoff.ageMs ?? 0)).toISOString() }) + '\n')
  const run = (command, input = {}) => spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, duration_ms: 1500, transcript_path: transcript, ...input }), encoding: 'utf8', windowsHide: true,
  })
  return { tasks, run, hkb: `node 'C:\\x\\hkb.mjs' --tasks '${tasks}' done T-1` }
}

test('AC1: a Planner whose hkb call just wrote a handoff event gets continue:false', () => {
  const { run, hkb } = setup('p-t-1', { outcome: 'move' })
  const r = run(hkb.replace(' done T-1', ' move T-1 planned'))
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.equal(out.continue, false)
  assert.match(out.stopReason, /T-1/)
})

for (const outcome of ['done', 'unchanged', 'issue']) {
  test(`AC2: a Builder ${outcome} handoff gets continue:false`, () => {
    const { run, hkb } = setup('b-t-1', { outcome })
    const r = run(hkb)
    assert.equal(r.status, 0)
    assert.equal(JSON.parse(r.stdout).continue, false)
  })
}

test('AC3: a refused hkb call (no handoff event) leaves the agent running', () => {
  const { run, hkb } = setup('b-t-1')
  const r = run(hkb)
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('AC3: a handoff event from an earlier turn of a resumed session does not end the session', () => {
  const { run, hkb } = setup('b-t-1', { outcome: 'done', ageMs: 60000 })
  assert.equal(run(hkb).stdout, '')
})

test('AC3: a non-hkb command, a Reviewer, and garbage stdin all leave the agent running', () => {
  assert.equal(setup('b-t-1', { outcome: 'done' }).run('npm test').stdout, '')
  const reviewer = setup('r-t-1', { outcome: 'done' })
  assert.equal(reviewer.run(reviewer.hkb).stdout, '')
  const r = spawnSync(process.execPath, [hook], { input: 'not json', encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('both Claude settings files run the handoff check inside the merged PostToolUse hook (scripts/hooks/post.mjs)', () => {
  for (const file of ['claude-agent-settings.json', 'claude-planner-settings.json']) {
    const groups = JSON.parse(readFileSync(join(import.meta.dirname, file), 'utf8')).hooks.PostToolUse
    const group = groups.find(g => g.hooks.some(h => h.command.includes('scripts/hooks/post.mjs')))
    assert.equal(group?.matcher, '*', file)
    assert.equal(groups.filter(g => g.hooks.some(h => h.command.includes('agent-handoff-hook.mjs'))).length, 0, `${file}: no separate handoff process`)
  }
})
