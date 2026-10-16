// A Builder runs in its own workspace, which has no TASKS folder. bin/hkb and bin/hkb.cmd run the board's hkb.mjs
// from anywhere, and HKB_TASKS (set for each Builder by boardAgentEnv) names the card's task folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { boardAgentEnv } from './lib/headless.mjs'

const bin = resolve('bin')
const CARD = '# T-1 — card\n**Workflow:** card-owned\n**Workflow version:** 2\n## Files\n- `a.mjs` — the change\n## Acceptance criteria\n- AC1: first\n## Evidence\n<!-- none -->\n'

function board(t) {
  const root = mkdtempSync(join(tmpdir(), 'hkb-shim-')), tasks = join(root, 'TASKS'), workspace = join(root, 'worktree')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasks, 'working'), { recursive: true })
  mkdirSync(workspace)
  writeFileSync(join(tasks, 'working', 'T-1.md'), CARD)
  return { tasks, workspace, card: join(tasks, 'working', 'T-1.md') }
}

const env = tasks => ({ ...process.env, HKB_TASKS: tasks, KANBAN_CONFIG: join(tmpdir(), 'hkb-shim-no-config.json') })
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0

test('bin/hkb runs the board hkb from a workspace with no TASKS folder, using HKB_TASKS', { skip: !hasSh }, t => {
  const { tasks, workspace, card } = board(t)
  const r = spawnSync('sh', [join(bin, 'hkb'), 'show', 'T-1'], { cwd: workspace, encoding: 'utf8', windowsHide: true, env: env(tasks) })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, new RegExp(card.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&').replaceAll('\\\\', '[\\\\/]')))
})

test('bin/hkb.cmd runs the board hkb from a workspace with no TASKS folder, using HKB_TASKS', { skip: process.platform !== 'win32' }, t => {
  const { tasks, workspace, card } = board(t)
  const r = spawnSync('cmd', ['/d', '/c', join(bin, 'hkb.cmd'), 'show', 'T-1'], { cwd: workspace, encoding: 'utf8', windowsHide: true, env: env(tasks) })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.ok(r.stdout.toLowerCase().includes(resolve(card).toLowerCase()), r.stdout)
})

test('without HKB_TASKS, hkb still reads TASKS from the current folder', { skip: !hasSh }, t => {
  const { tasks, card } = board(t)
  const e = env(tasks)
  delete e.HKB_TASKS
  const r = spawnSync('sh', [join(bin, 'hkb'), 'show', 'T-1'], { cwd: join(tasks, '..'), encoding: 'utf8', windowsHide: true, env: e })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /T-1/)
  assert.ok(card)
})

test('boardAgentEnv hands the card task folder to a board agent and keeps bin/ first on PATH', () => {
  const withTasks = boardAgentEnv({ id: 'b-1', name: 'b-t-1', tasksDir: 'C:/projects/x/TASKS' })
  assert.equal(withTasks.HKB_TASKS, 'C:/projects/x/TASKS')
  assert.ok(withTasks.PATH.split(';')[0].endsWith(join('herdr-kanban', 'bin')) || withTasks.PATH.split(';')[0].endsWith('bin'), withTasks.PATH.split(';')[0])
  assert.equal(withTasks.BOARD_AGENT_ID, 'b-1')
  const without = boardAgentEnv({ id: 'p-1', name: 'p-t-1' })
  assert.equal('HKB_TASKS' in without, false)
})
