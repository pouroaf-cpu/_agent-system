import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { digest, guardScript, loadPolicy, guardEvent, operationPrefix, runOperation, prepareBuilderGuard, assertGuardActive, exactPath } from './lib/builder-guard.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'builder-guard-'))
  const path = join(root, '.builder-guard', 'T-1.json')
  mkdirSync(join(root, '.builder-guard'))
  const source = join(root, 'source.txt'), card = join(root, 'T-1.md'), script = join(root, 'check.mjs')
  writeFileSync(source, 'approved\n' + 'x'.repeat(9000)); writeFileSync(card, 'approved card'); writeFileSync(script, 'console.log("check output")')
  const module = fileURLToPath(new URL('./lib/builder-guard.mjs', import.meta.url))
  const pins = Object.fromEntries([guardScript, module, process.execPath, script].map(p => [p, digest(readFileSync(p))]))
  const policy = { version: 1, approvedBy: 'fixture operator', project: 'Fixture', cardId: 'T-1', authorizationId: 'fixture-only', workspace: root, cardHash: digest(readFileSync(card)), read: [source, card], write: [source], pins, commands: { check: { executable: process.execPath, args: [script], purpose: 'test', timeoutMs: 1000 } } }
  writeFileSync(path, JSON.stringify(policy))
  const hash = digest(readFileSync(path))
  const event = operation => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: operationPrefix(path, hash) + Buffer.from(JSON.stringify(operation)).toString('base64url') } })
  return { root, path, source, card, script, policy, hash, event }
}
const denied = result => result.hookSpecificOutput?.permissionDecision === 'deny'

test('bounded approved read/search, exact patch and full retained command output', async () => {
  const f = fixture()
  assert.equal(denied(guardEvent(f.path, f.hash, f.event({ op: 'read', path: f.source }))), false)
  const first = await runOperation(f.path, f.hash, { op: 'read', path: f.source })
  assert.equal(first.text.length, 8000); assert.equal(first.complete, false); assert.equal(first.nextOffset, 8000)
  const next = await runOperation(f.path, f.hash, { op: 'read', path: f.source, offset: first.nextOffset })
  assert.equal(next.nextOffset, null)
  assert.match((await runOperation(f.path, f.hash, { op: 'search', paths: [f.source], text: 'approved' })).text, /:1: approved/)
  await runOperation(f.path, f.hash, { op: 'patch', path: f.source, before: 'approved', after: 'changed', sha256: digest(readFileSync(f.source)) })
  assert.match(readFileSync(f.source, 'utf8'), /^changed/)
  const result = await runOperation(f.path, f.hash, { op: 'command', id: 'check' })
  assert.equal(result.code, 0); assert.match(readFileSync(result.log, 'utf8'), /check output/)
  assert.match((await runOperation(f.path, f.hash, { op: 'read', path: result.log })).text, /check output/)
})

test('denies unrelated paths, recursive search, alternate tools, dynamic and nested shell', () => {
  const f = fixture()
  for (const operation of [{ op: 'read', path: join(f.root, 'other') }, { op: 'search', paths: [f.root], text: 'x' }, { op: 'command', id: 'not-approved' }, { op: 'read', path: f.source, shell: 'evil' }]) assert.ok(denied(guardEvent(f.path, f.hash, f.event(operation))))
  for (const tool_name of ['apply_patch', 'mcp__filesystem__write', 'spawn_agent', 'js_repl', 'write_stdin']) assert.ok(denied(guardEvent(f.path, f.hash, { ...f.event({ op: 'read', path: f.source }), tool_name })))
  for (const suffix of ['; whoami', ' | powershell', '\nwhoami', ' $(whoami)', ' && echo x']) {
    const e = f.event({ op: 'read', path: f.source }); e.tool_input.command += suffix
    assert.ok(denied(guardEvent(f.path, f.hash, e)))
  }
})

test('rejects traversal, links and mutable check scripts', t => {
  const f = fixture()
  assert.throws(() => exactPath(`${f.root}/../source.txt`), /traversal/)
  const linked = join(f.root, 'junction')
  symlinkSync(f.root, linked, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => exactPath(join(linked, 'source.txt')), /links|redirected/)
  writeFileSync(f.script, 'console.log("modified")')
  assert.ok(denied(guardEvent(f.path, f.hash, f.event({ op: 'command', id: 'check' }))))
})

test('missing/changed policies and malformed hook input fail closed within the supported hook', () => {
  const f = fixture()
  assert.ok(denied(guardEvent(f.path, 'wrong', f.event({ op: 'read', path: f.source }))))
  assert.ok(denied(guardEvent(`${f.path}.missing`, f.hash, f.event({ op: 'read', path: f.source }))))
  const child = spawnSync(process.execPath, [guardScript, 'hook', f.path, f.hash], { input: '{', encoding: 'utf8' })
  assert.equal(child.status, 2)
})

test('native activation bound to policy/session; no stale authorization reuse or pause changes', async () => {
  const f = fixture(), config = join(f.root, 'board.config.json')
  writeFileSync(config, JSON.stringify({ maxConcurrentAgents: 0, projectsPaused: true }))
  const before = readFileSync(config, 'utf8')
  const guard = prepareBuilderGuard({ tasksDir: f.root, project: 'Fixture', card: { id: 'T-1', path: f.card }, workspacePath: f.root })
  assert.throws(() => assertGuardActive(guard, 'new'), /activation is missing/)
  assert.deepEqual(guardEvent(f.path, f.hash, { hook_event_name: 'SessionStart', cwd: f.root, session_id: 'new' }), {})
  assert.throws(() => assertGuardActive(guard, 'new'), /can fail open/)
  assert.throws(() => assertGuardActive(guard, 'old'), /does not match/)
  assert.throws(() => prepareBuilderGuard({ tasksDir: f.root, project: 'Fixture', card: { id: 'T-1', path: f.card }, workspacePath: f.root }), /already assigned/)
  assert.equal((await runOperation(f.path, f.hash, { op: 'gap', reason: 'Need one exact caller file to prove compatibility' })).status, 'awaiting-operator')
  assert.match(readFileSync(`${f.path}.events.jsonl`, 'utf8'), /scope-gap/)
  assert.equal(readFileSync(config, 'utf8'), before)
})
