// HK71: hkb finish commits the staged files, writes the result and hands off in one command;
// a result with missing parts is refused once, naming every part, with nothing committed or written.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const CARD = `# T-1 — card
**Workflow:** card-owned
**Workflow version:** 2
**Category:** code
**Workspace:** .
**Auto-review:** no
## Acceptance criteria
- AC1: first
- AC2: second
## Files
- \`x.txt\`
## Implementation
<!-- Builder: placeholder -->
## Evidence
<!-- Builder: placeholder -->
`
const FULL = `## Implementation
AC1: node check.mjs a -> 1 passing
AC2: node check.mjs b -> 2 passing
Stage: builder
Outcome: PASS
Files: x.txt
## Evidence
Check: node check.mjs
Result: 3 passing
Evidence: TASKS/.evidence/T-1/log.txt
Blocker: none
`
const PARTIAL = `## Implementation
AC1: node check.mjs a -> 1 passing
AC2: node check.mjs b -> 2 passing
Stage: builder
Outcome: PASS
Files: x.txt
Check: node check.mjs
`

function board(t) {
  const root = mkdtempSync(join(tmpdir(), 'finish-command-')), repo = join(root, 'repo'), tasks = join(root, 'TASKS'), wt = join(root, 'wt')
  t.after(() => { spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt], { windowsHide: true }); rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })
  const git = (cwd, ...args) => { const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
  mkdirSync(repo); mkdirSync(join(tasks, 'working'), { recursive: true })
  git(repo, 'init', '-q'); writeFileSync(join(repo, 'x.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  const baseCommit = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'worktree', 'add', '-q', '-b', 'card/t-1', wt)
  writeFileSync(join(tasks, '.board-worktrees.json'), JSON.stringify({ 'T-1': { state: 'building', worktreePath: wt, repoRoot: repo, baseCommit, branch: 'card/t-1', workspacePath: wt, workspaceRel: '' } }))
  const path = join(tasks, 'working', 'T-1.md')
  writeFileSync(path, CARD)
  writeFileSync(join(wt, 'x.txt'), 'changed\n'); git(wt, 'add', 'x.txt')
  const input = join(root, 'result.md')
  const finish = (text, ...extra) => { writeFileSync(input, text); return spawnSync(process.execPath, [resolve('hkb.mjs'), '--tasks', tasks, 'finish', 'T-1', '--file', input, ...extra], { encoding: 'utf8', windowsHide: true }) }
  const log = () => git(wt, 'log', '--format=%s', `${baseCommit}..HEAD`)
  return { tasks, path, finish, log }
}

const column = (tasks) => ['completed', 'review', 'archive', 'working'].find(c => existsSync(join(tasks, c, 'T-1.md')))

test('AC1: one finish commits the staged file, records the result and hands off', t => {
  const { tasks, finish, log } = board(t)
  const r = finish(FULL, '-m', 'T-1 change x')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /committed 1 staged file/)
  assert.notEqual(column(tasks), 'working')
  assert.equal(log(), 'T-1 change x')
  const card = readFileSync(join(tasks, column(tasks), 'T-1.md'), 'utf8')
  assert.match(card, /Result: 3 passing/)
  assert.match(card, /Blocker: none/)
})

test('AC2: a result missing Blocker, Result and Evidence is refused once, naming all three, with nothing written', t => {
  const { tasks, path, finish, log } = board(t)
  const before = readFileSync(path, 'utf8')
  const r = finish(PARTIAL, '-m', 'T-1 change x')
  assert.equal(r.status, 1)
  const refusals = r.stderr.split(/\r?\n/).filter(l => /requires/.test(l))
  assert.equal(refusals.length, 1, r.stderr)
  for (const part of ['Result:', 'Blocker:', 'Evidence:', '## Evidence']) assert.ok(refusals[0].includes(part), `${part} missing from: ${r.stderr}`)
  assert.equal(log(), '', 'nothing committed')
  assert.equal(readFileSync(path, 'utf8'), before, 'card untouched')
  assert.equal(column(tasks), 'working')
})

test('AC3: a complete result is accepted on the first try with the default commit message', t => {
  const { tasks, finish, log } = board(t)
  const r = finish(FULL)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.doesNotMatch(r.stderr, /requires|refused/)
  assert.equal(log(), 'T-1: card')
  assert.notEqual(column(tasks), 'working')
})
