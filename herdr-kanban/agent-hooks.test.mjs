import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, symlinkSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { runPre, runPost } from './lib/agent-hooks.mjs'

// audit 2026-10-16 F8: one Bash tool call used to start six hook processes. scripts/hooks/pre.mjs and
// post.mjs now run every guard in one process each. These tests pin that the merged hooks refuse and
// block exactly as the separate guards did, and that a tool call starts at most two hook processes.

const root = import.meta.dirname
const script = name => join(root, 'scripts', name)
const tmp = prefix => mkdtempSync(join(tmpdir(), prefix))
const runScript = (file, args, input) => spawnSync(process.execPath, [file, ...args], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true })

test('runPre gives the same refusal as the separate evidence guard, and nothing for an allowed command', () => {
  const refused = { session_id: 'mg-pre-1', tool_name: 'Bash', tool_input: { command: 'cp -r node_modules C:/x/TASKS/.evidence/I1/' } }
  const separate = runScript(script('evidence-guard.mjs'), ['--pre'], refused)
  assert.equal(separate.status, 2)
  assert.deepEqual(runPre(refused), [separate.stderr.trimEnd()])
  assert.deepEqual(runPre({ session_id: 'mg-pre-1', tool_name: 'Bash', tool_input: { command: 'npm test' } }), [])
  assert.deepEqual(runPre({ session_id: 'mg-pre-1', tool_name: 'Read', tool_input: { file_path: 'x' } }), [])
})

test('every PreToolUse guard runs: a PowerShell command that copies a cache into evidence and runs npm ci in a shared-install junction is refused twice', () => {
  const base = tmp('merge-pre-')
  mkdirSync(join(base, 'shared', 'node_modules'), { recursive: true })
  mkdirSync(join(base, 'card'), { recursive: true })
  symlinkSync(join(base, 'shared', 'node_modules'), join(base, 'card', 'node_modules'), 'junction')
  try {
    const reasons = runPre({ session_id: 'mg-pre-2', tool_name: 'PowerShell', cwd: join(base, 'card'), tool_input: { command: "Copy-Item -Recurse node_modules 'C:\\x\\TASKS\\.evidence\\I1'; npm ci" } })
    assert.equal(reasons.length, 2)
    assert.match(reasons[0], /copies a dependency/)
    assert.match(reasons[1], /^npm ci refused: node_modules here is the shared install link/)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('the merged pre hook exits 2 with every refusal on stderr, exits 0 silently otherwise, and fails open on bad input', () => {
  const refused = runScript(script(join('hooks', 'pre.mjs')), [], { session_id: 'mg-pre-3', tool_name: 'Bash', tool_input: { command: 'cp -r node_modules C:/x/TASKS/.evidence/I1/' } })
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /copies a dependency/)
  const allowed = runScript(script(join('hooks', 'pre.mjs')), [], { session_id: 'mg-pre-3', tool_name: 'Bash', tool_input: { command: 'npm test' } })
  assert.equal(allowed.status, 0)
  assert.equal(allowed.stdout + allowed.stderr, '')
  const bad = spawnSync(process.execPath, [script(join('hooks', 'pre.mjs'))], { input: 'not json', encoding: 'utf8', windowsHide: true })
  assert.equal(bad.status, 0)
  assert.equal(bad.stdout, '')
})

test('the merged post hook blocks an over-cap evidence file the same way the separate guard did, once', async () => {
  const tasks = tmp('merge-post-')
  const folder = join(tasks, '.evidence', 'I149')
  mkdirSync(folder, { recursive: true })
  const transcript = join(tasks, 't.jsonl')
  writeFileSync(transcript, [
    JSON.stringify({ type: 'agent-name', agentName: 'b-i149' }),
    JSON.stringify({ message: `hkb status --tasks '${tasks.replaceAll('\\', '/')}'` }),
  ].join('\n'))
  const input = { session_id: 'mg-post-1', tool_use_id: 'tu1', transcript_path: transcript, tool_name: 'Bash', tool_input: { command: 'make evidence' } }
  assert.deepEqual(runPre(input), [])
  writeFileSync(join(folder, 'base.json'), Buffer.alloc(10 * 1024 * 1024 + 1))
  const out = await runPost(input)
  assert.equal(out.decision, 'block')
  assert.match(out.reason, /Evidence limit/)
  assert.equal(out.continue, undefined)
  assert.ok(statSync(join(folder, 'base.json')).size <= 10 * 1024 * 1024 + 300)
  assert.deepEqual(await runPost(input), {})
})

test('the merged post hook ends a Builder run after its hkb handoff, with the handoff stop reason', async () => {
  const tasks = tmp('merge-handoff-')
  mkdirSync(join(tasks, '.history'), { recursive: true })
  const transcript = join(tasks, 'session.jsonl')
  writeFileSync(transcript, [
    JSON.stringify({ type: 'agent-name', agentName: 'b-t-1' }),
    JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 600000).toISOString(), message: { role: 'user', content: `hand off with node 'hkb.mjs' --tasks '${tasks}' done T-1` } }),
  ].join('\n') + '\n')
  appendFileSync(join(tasks, '.history', 'T-1.jsonl'), JSON.stringify({ event: 'handoff', stage: 'x', outcome: 'done', at: new Date().toISOString() }) + '\n')
  const input = { session_id: 'mg-post-2', tool_use_id: 'tu2', transcript_path: transcript, tool_name: 'Bash', tool_input: { command: `node 'C:\\x\\hkb.mjs' --tasks '${tasks}' done T-1` }, duration_ms: 1500 }
  const out = await runPost(input)
  assert.equal(out.continue, false)
  assert.match(out.stopReason, /T-1/)
  assert.equal(out.decision, undefined)
})

test('the merged post hook prints nothing for an ordinary tool call', async () => {
  assert.deepEqual(await runPost({ session_id: 'mg-post-3', tool_name: 'Read', tool_input: { file_path: 'x' } }), {})
  const r = runScript(script(join('hooks', 'post.mjs')), [], { session_id: 'mg-post-3', tool_name: 'Read', tool_input: { file_path: 'x' } })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

// Matcher semantics as Claude Code applies them: '*' or empty matches every tool, otherwise a list of exact names.
const matches = (matcher, tool) => !matcher || matcher === '*' || matcher.split('|').includes(tool)

test('both board Claude settings files start at most two hook processes for any tool call, and those are the merged hooks', () => {
  for (const file of ['claude-agent-settings.json', 'claude-planner-settings.json']) {
    const hooks = JSON.parse(readFileSync(join(root, file), 'utf8')).hooks
    for (const tool of ['Bash', 'PowerShell', 'Write', 'Edit', 'Read']) {
      const commands = ['PreToolUse', 'PostToolUse'].flatMap(event => (hooks[event] ?? []).filter(g => matches(g.matcher, tool)).flatMap(g => g.hooks.map(h => h.command)))
      assert.ok(commands.length <= 2, `${file} ${tool}: ${commands.length} hook processes`)
      if (['Bash', 'PowerShell'].includes(tool)) {
        assert.deepEqual(commands.map(c => c.match(/scripts\/hooks\/(pre|post)\.mjs/)?.[1]), ['pre', 'post'], `${file} ${tool}`)
      }
    }
  }
})
