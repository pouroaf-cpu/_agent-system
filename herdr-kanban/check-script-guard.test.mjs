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
  const run = (flag, extra = {}) => spawnSync(process.execPath, [hook, flag], { input: JSON.stringify({ session_id, tool_use_id: 'toolu_1', transcript_path: transcript, ...extra }), encoding: 'utf8', windowsHide: true })
  mkdirSync(join(tasks, 'planning'), { recursive: true })
  const plan = join(tasks, 'planning', 'T-1-x.md')
  writeFileSync(plan, '# T-1\n')
  return { dir, run, plan }
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
  const bad = spawnSync(process.execPath, [hook, '--pre'], { input: 'not json', encoding: 'utf8', windowsHide: true })
  assert.equal(bad.status, 0)
  assert.equal(bad.stdout, '')
})

test('board Claude agents load the check-script guard for Bash and PowerShell', () => {
  const hooks = JSON.parse(readFileSync(new URL('./claude-agent-settings.json', import.meta.url), 'utf8')).hooks
  // The check runs inside the merged hook (scripts/hooks/pre.mjs and post.mjs, lib/agent-hooks.mjs).
  assert.equal(hooks.PreToolUse.find(h => JSON.stringify(h).includes('scripts/hooks/pre.mjs'))?.matcher, 'Write|Edit|MultiEdit|Bash|PowerShell')
  assert.equal(hooks.PostToolUse.find(h => JSON.stringify(h).includes('scripts/hooks/post.mjs'))?.matcher, '*')
})

test('AC1: a planner shell command that writes the plan file is refused, naming Edit or Write', t => {
  const { run, plan } = setup(t)
  for (const command of [`Set-Content -Path '${plan}' -Value x`, `echo x > ${plan}`, `echo x >> "${plan}"`, `sed -i s/a/b/ ${plan}`, `node -e "fs.writeFileSync('${plan}','x')"`, `rm ${plan}`]) {
    const out = run('--pre', { tool_input: { command } })
    assert.equal(out.status, 2, command)
    assert.match(out.stderr, /Edit or Write/, command)
  }
})

test('AC2: planner shell reads of the plan file still run', t => {
  const { run, plan } = setup(t)
  for (const command of [`cat ${plan}`, `sed -n '1,5p' ${plan}`, `Get-Content '${plan}'`, `cat ${plan} 2>&1`, `cp ${plan} /tmp/x.md`, 'node hkb.mjs show T-1']) {
    const out = run('--pre', { tool_input: { command } })
    assert.equal(out.status, 0, command)
    assert.equal(out.stdout + out.stderr, '', command)
  }
})

test('a slug word that looks like a verb does not refuse a read; other roles are not checked', t => {
  const { run, plan } = setup(t)
  const slugged = plan.replace('T-1-x', 'T-1-del-x')  // sorts before T-1-x.md, so it is the card file
  writeFileSync(slugged, '# T-1\n')
  assert.equal(run('--pre', { tool_input: { command: `cat ${slugged}` } }).status, 0)
  assert.equal(run('--pre', { tool_input: { command: `echo x > ${slugged}` } }).status, 2)
  const b = setup(t, 'b-t-1')
  assert.equal(b.run('--pre', { tool_input: { command: `echo x > ${b.plan}` } }).status, 0)
})

test('a script that changes the plan file without naming it is blocked after the run, but an hkb command is not', t => {
  const { run, plan } = setup(t)
  run('--pre', { tool_input: { command: 'node fix.mjs' } })
  writeFileSync(plan, '# damaged\n')
  const out = run('--post', { tool_input: { command: 'node fix.mjs' } })
  assert.equal(JSON.parse(out.stdout).decision, 'block')
  assert.match(JSON.parse(out.stdout).reason, /T-1-x\.md.*Edit or Write/s)
  run('--pre', { tool_input: { command: 'node hkb.mjs move T-1 queue' } })
  writeFileSync(plan, '# moved\n')
  assert.equal(run('--post', { tool_input: { command: 'node hkb.mjs move T-1 queue' } }).stdout, '')
  run('--pre', { tool_input: { command: 'node hkb.mjs move T-1 queue' } })
  rmSync(plan)
  assert.equal(run('--post', { tool_input: { command: 'node fix.mjs' } }).stdout, '')
})
