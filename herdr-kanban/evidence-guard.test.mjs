import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { EVIDENCE_FILE_CAP, cardContext, commandRefusal, settleCommandOutput, truncateEvidenceFile, walkEvidence, writeRefusal } from './lib/evidence-guard.mjs'

const hook = join(import.meta.dirname, 'scripts', 'evidence-guard.mjs')
const runHook = (flag, input) => spawnSync(process.execPath, [hook, flag], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true })
const tmp = prefix => mkdtempSync(join(tmpdir(), prefix))

test('a Write into a cache folder under evidence is refused; the same folder outside evidence is not', () => {
  assert.match(writeRefusal({ path: 'C:/x/TASKS/.evidence/I1/node_modules/pkg/index.js', content: 'x' }), /cache folder/)
  assert.match(writeRefusal({ path: 'C:\\x\\TASKS\\.evidence\\I1\\.next\\cache.json', content: 'x' }), /cache folder/)
  assert.equal(writeRefusal({ path: 'C:/x/TASKS/.evidence/I1/report.md', content: 'ok' }), null)
  assert.equal(writeRefusal({ path: 'C:/x/herdr-kanban/node_modules/a.js', content: 'x' }), null)
})

test('a Write over the file cap is refused; an Edit carries only the changed text and is not measured', () => {
  const big = 'x'.repeat(EVIDENCE_FILE_CAP + 1)
  assert.match(writeRefusal({ path: 'C:/x/TASKS/.evidence/I1/base.json', content: big }), /capped at 10\.0 MB/)
  assert.equal(writeRefusal({ path: 'C:/x/TASKS/.evidence/I1/base.json', content: 'x' }), null)
  assert.equal(writeRefusal({ path: 'C:/x/TASKS/.evidence/I1/base.json', old_string: 'a', new_string: big }), null)
})

test('a shell command that copies a cache folder into evidence is refused', () => {
  assert.match(commandRefusal('cp -r C:/x/node_modules C:/x/TASKS/.evidence/I1/'), /copies a dependency/)
  assert.match(commandRefusal("Copy-Item -Recurse .next 'C:\\x\\TASKS\\.evidence\\I1'"), /copies/)
  assert.match(commandRefusal('robocopy app\\.next TASKS\\.evidence\\I1\\next /E'), /copies/)
  assert.equal(commandRefusal('cp report.txt C:/x/TASKS/.evidence/I1/'), null)
  assert.equal(commandRefusal('ls node_modules && cat .evidence/I1/log.txt'), null)
  assert.equal(commandRefusal('cp -r node_modules /tmp/x'), null)
})

test('walkEvidence reports a cache folder by path and does not descend into it', () => {
  const dir = tmp('ev-walk-')
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'pkg', 'i.js'), 'x')
  writeFileSync(join(dir, 'log.txt'), 'ok')
  const { files, caches, truncated } = walkEvidence(dir)
  assert.deepEqual(caches, [join(dir, 'node_modules')])
  assert.deepEqual(files.map(f => f.path), [join(dir, 'log.txt')])
  assert.equal(truncated, false)
})

test('truncateEvidenceFile keeps the head and tail of an over-cap file and marks the cut', () => {
  const file = join(tmp('ev-trunc-'), 'big.log')
  const body = Buffer.alloc(EVIDENCE_FILE_CAP + 1000, 'm')
  body.write('HEAD', 0)
  body.write('TAIL', body.length - 4)
  writeFileSync(file, body)
  assert.equal(truncateEvidenceFile(file), 1000)
  const out = readFileSync(file, 'utf8')
  assert.ok(out.startsWith('HEAD'))
  assert.ok(out.endsWith('TAIL'))
  assert.match(out, /the board cut/)
  assert.ok(statSync(file).size <= EVIDENCE_FILE_CAP + 300)
})

test('after a command, a new over-cap file is cut and a new cache folder deleted; older and pre-existing files are left alone', () => {
  const dir = tmp('ev-settle-')
  const old = join(dir, 'old.json'), pre = join(dir, 'pre.json'), fresh = join(dir, 'base.json')
  writeFileSync(old, Buffer.alloc(EVIDENCE_FILE_CAP + 10))
  const past = new Date(Date.now() - 3600000)
  utimesSync(old, past, past)
  // Birth times are creation times, so the old file must exist for over a second before the command starts.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100)
  writeFileSync(pre, Buffer.alloc(EVIDENCE_FILE_CAP + 10))
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'pkg', 'i.js'), 'x')
  const startedAt = Date.now()
  writeFileSync(fresh, Buffer.alloc(EVIDENCE_FILE_CAP + 10))
  const notes = settleCommandOutput({ folder: dir, startedAt, existing: [pre] })
  assert.equal(notes.length, 2)
  assert.ok(statSync(fresh).size <= EVIDENCE_FILE_CAP + 300)
  assert.equal(statSync(old).size, EVIDENCE_FILE_CAP + 10)
  assert.equal(statSync(pre).size, EVIDENCE_FILE_CAP + 10)
  assert.equal(existsSync(join(dir, 'node_modules')), false)
})

test('cardContext reads the card from the agent name and the TASKS folder from the transcript', () => {
  const dir = tmp('ev-ctx-')
  const file = join(dir, 't.jsonl')
  writeFileSync(file, [
    JSON.stringify({ type: 'agent-name', agentName: 'b-i149' }),
    JSON.stringify({ message: "hkb status --tasks 'C:/Users/PFrew/KanbanProjects/Injectbuddy/TASKS'" }),
  ].join('\n'))
  assert.deepEqual(cardContext(file), { id: 'I149', tasksDir: 'C:/Users/PFrew/KanbanProjects/Injectbuddy/TASKS' })
  assert.equal(cardContext(join(dir, 'missing.jsonl')), null)
})

test('the hook refuses a Bash command that copies node_modules into evidence and passes other commands', () => {
  const r = runHook('--pre', { session_id: 'evt1', tool_name: 'Bash', tool_input: { command: 'cp -r node_modules C:/x/TASKS/.evidence/I1/' } })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /copies a dependency/)
  const ok = runHook('--pre', { session_id: 'evt1', tool_name: 'Bash', tool_input: { command: 'npm test' } })
  assert.equal(ok.status, 0)
  assert.equal(ok.stdout, '')
})

test('the hook cuts an over-cap file a command wrote into the card evidence and tells the agent', () => {
  const tasks = tmp('ev-hook-')
  const folder = join(tasks, '.evidence', 'I149')
  mkdirSync(folder, { recursive: true })
  const transcript = join(tasks, 't.jsonl')
  writeFileSync(transcript, [
    JSON.stringify({ type: 'agent-name', agentName: 'b-i149' }),
    JSON.stringify({ message: `hkb status --tasks '${tasks.replaceAll('\\', '/')}'` }),
  ].join('\n'))
  const input = { session_id: 'evt2', tool_use_id: 'tu1', transcript_path: transcript, tool_name: 'Bash', tool_input: { command: 'make evidence' } }
  assert.equal(runHook('--pre', input).status, 0)
  writeFileSync(join(folder, 'base.json'), Buffer.alloc(EVIDENCE_FILE_CAP + 1))
  const post = runHook('--post', input)
  assert.equal(post.status, 0)
  const out = JSON.parse(post.stdout)
  assert.equal(out.decision, 'block')
  assert.match(out.reason, /Evidence limit/)
  assert.ok(statSync(join(folder, 'base.json')).size <= EVIDENCE_FILE_CAP + 300)
  assert.equal(runHook('--post', input).stdout, '')
})

test('the hook fails open on input it cannot read', () => {
  const r = spawnSync(process.execPath, [hook, '--pre'], { input: 'not json', encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('both board Claude settings files run the evidence guard before and after Write, Edit and shell tools', () => {
  for (const file of ['claude-agent-settings.json', 'claude-planner-settings.json']) {
    const hooks = JSON.parse(readFileSync(join(import.meta.dirname, file), 'utf8')).hooks
    // The guard runs inside the merged hooks (scripts/hooks/pre.mjs and post.mjs, lib/agent-hooks.mjs).
    for (const [event, file] of [['PreToolUse', 'pre.mjs'], ['PostToolUse', 'post.mjs']]) {
      const group = hooks[event].find(g => g.hooks.some(h => h.command.includes(`scripts/hooks/${file}`)))
      assert.equal(group?.matcher, event === 'PreToolUse' ? 'Write|Edit|MultiEdit|Bash|PowerShell' : '*', `${file} ${event}`)
    }
  }
})
