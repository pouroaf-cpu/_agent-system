import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const hook = join(import.meta.dirname, 'scripts', 'check-script-guard.mjs')

function setup(t, name = 'p-t-1') {
  const root = mkdtempSync(join(tmpdir(), 'check-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const tasks = join(root, 'TASKS'), dir = join(tasks, '.evidence', 'T-1'), transcript = join(root, 'session.jsonl')
  mkdirSync(dir, { recursive: true })
  writeFileSync(transcript, [
    { type: 'agent-name', agentName: name },
    { type: 'user', message: { role: 'user', content: `node 'hkb.mjs' --tasks '${tasks}' move T-1 queue` } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n')
  const session_id = `s${Date.now()}${Math.random().toString(36).slice(2)}`
  const run = (flag, extra = {}) => spawnSync(process.execPath, [hook, flag], { input: JSON.stringify({ session_id, tool_use_id: 'toolu_1', transcript_path: transcript, ...extra }), encoding: 'utf8' })
  return { dir, run }
}

test('a shell change to a planner check script is blocked, naming the file', t => {
  const { dir, run } = setup(t)
  writeFileSync(join(dir, 'check-a.mjs'), 'const rx = /\\d+/\n')
  assert.equal(run('--pre').stdout, '')
  writeFileSync(join(dir, 'check-a.mjs'), 'const rx = /d+/\n')
  const out = run('--post')
  assert.equal(out.status, 0)
  assert.equal(JSON.parse(out.stdout).decision, 'block')
  assert.match(JSON.parse(out.stdout).reason, /check-a\.mjs.*backslashes.*node --check.*Edit or Write/s)
})

test('no change means no output, and a new check script is blocked', t => {
  const { dir, run } = setup(t)
  writeFileSync(join(dir, 'check-a.mjs'), 'x\n')
  run('--pre')
  writeFileSync(join(dir, 'check-a.log'), 'a Check writes its own output on every run\n')
  assert.equal(run('--post').stdout, '')
  run('--pre')
  writeFileSync(join(dir, 'check-b.mjs'), 'y\n')
  assert.match(JSON.parse(run('--post').stdout).reason, /check-b\.mjs/)
  assert.equal(run('--post').stdout, '', 'snapshot is consumed')
})

test('other roles and garbage input are ignored', t => {
  const { dir, run } = setup(t, 'b-t-1')
  run('--pre')
  writeFileSync(join(dir, 'check-a.mjs'), 'x\n')
  assert.equal(run('--post').stdout, '')
  const bad = spawnSync(process.execPath, [hook, '--pre'], { input: 'not json', encoding: 'utf8' })
  assert.equal(bad.status, 0)
  assert.equal(bad.stdout, '')
})

test('board Claude agents load the check-script guard for Bash and PowerShell', () => {
  const hooks = JSON.parse(readFileSync(new URL('./claude-agent-settings.json', import.meta.url), 'utf8')).hooks
  for (const [event, flag] of [['PreToolUse', '--pre'], ['PostToolUse', '--post']])
    assert.equal(hooks[event].find(h => JSON.stringify(h).includes(`check-script-guard.mjs ${flag}`))?.matcher, 'Bash|PowerShell')
})
