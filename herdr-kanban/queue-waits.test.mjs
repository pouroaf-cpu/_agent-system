// Tradeflow 2026-09-24: dependency drift in a card worktree, cards waiting behind a
// holder in Owner, and workspace-prefixed file paths that were doubled.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { appendReviewPass, findCard, moveCard, parseCard } from './lib/cards.mjs'
import { dependencyInstallHold, prepareCardWorktree, readWorktrees, reconcileCompletedWorktrees, startDependencyInstall } from './lib/worktrees.mjs'
import { autoSpawn, holdsFor } from './lib/autospawn.mjs'
import { checkStalls } from './lib/stall-watchdog.mjs'
import { readWorkflow } from './lib/workflow-state.mjs'

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
const norm = p => resolve(p).replaceAll('\\', '/').toLowerCase()
const tick = () => new Promise(r => setImmediate(r))
const cardText = (id, workspace, files) => `# ${id} — Card\n\n**Workflow:** card-owned\n**Workspace:** ${workspace}\n\n## Files\n\n${files.map(f => `- \`${f}\``).join('\n')}\n\n## Approved brief\n\nDo it.\n\n## Implementation plan\n\nChange it.\n\n## Acceptance criteria\n\n- AC1: done\n`

// A repo whose card workspace is the `site` subfolder, like Tradeflow's tradesflow-website.
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'hkb-waits-')), tasks = join(root, 'board', 'TASKS'), integration = join(root, 'integration')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const d of ['queue', 'working', 'completed', 'owner']) mkdirSync(join(tasks, d), { recursive: true })
  mkdirSync(join(integration, 'site'), { recursive: true })
  git(integration, 'init'); git(integration, 'config', 'user.name', 't'); git(integration, 'config', 'user.email', 't@e.x')
  writeFileSync(join(integration, 'site', 'app.js'), 'base\n')
  git(integration, 'add', '.'); git(integration, 'commit', '-m', 'base')
  const add = (id, files, column = 'queue') => {
    const path = join(tasks, column, `${id}-card.md`)
    writeFileSync(path, cardText(id, 'site', files))
    return parseCard(path, column)
  }
  return { root, tasks, integration, add, settings: { integrationPath: integration, worktreesRoot: join(root, 'cards') } }
}

test('dependency drift installs in the card workspace after detaching the junction; Owner only after two failures', async t => {
  const f = repo(t)
  const site = join(f.integration, 'site')
  writeFileSync(join(site, 'package.json'), '{"dependencies":{"dep":"1"}}')
  writeFileSync(join(site, 'package-lock.json'), '{"v":1}')
  writeFileSync(join(f.integration, '.gitignore'), 'node_modules/\n')
  git(f.integration, 'add', '.'); git(f.integration, 'commit', '-m', 'deps')
  mkdirSync(join(site, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(site, 'node_modules', 'dep', 'package.json'), '{}')
  const card = f.add('T-34', ['site/app.js'])
  const first = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
  const modules = join(first.workspacePath, 'node_modules')
  assert.ok(lstatSync(modules).isSymbolicLink(), 'shared junction to integration')

  // Integration merges a new dependency; the card worktree still has the old manifest.
  writeFileSync(join(site, 'package.json'), '{"dependencies":{"dep":"1","other":"2"}}')
  git(f.integration, 'commit', '-am', 'merge origin/master')
  const err = (() => { try { prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings }) } catch (e) { return e } })()
  assert.match(err.message, /package\.json differs from integration/)
  assert.equal(err.installIn, first.workspacePath)

  let settle, calls = 0
  const install = (folder) => { calls++; assert.equal(folder, first.workspacePath); return new Promise((ok, fail) => { settle = { ok, fail } }) }
  assert.equal(startDependencyInstall({ folder: err.installIn, tasksDir: f.tasks, install, free: () => 20 }), `installing dependencies in ${first.workspacePath}`)
  assert.equal(existsSync(modules), false, 'the junction is unlinked')
  assert.ok(existsSync(join(site, 'node_modules', 'dep', 'package.json')), 'nothing deleted through it')
  assert.equal(dependencyInstallHold({ card, projectPath: f.integration, tasksDir: f.tasks, gitSettings: f.settings }), `installing dependencies in ${first.workspacePath}`, 'an allowed wait while it runs')
  await tick(); settle.fail(new Error('ERESOLVE')); await tick()
  assert.match(startDependencyInstall({ folder: err.installIn, tasksDir: f.tasks, install, free: () => 20 }), /retry after: ERESOLVE/)
  await tick(); settle.fail(new Error('ERESOLVE again')); await tick()
  assert.equal(dependencyInstallHold({ card, projectPath: f.integration, tasksDir: f.tasks, gitSettings: f.settings }), `dependency install failed twice in ${first.workspacePath}: ERESOLVE again`)
  assert.equal(calls, 2)
})

test('a spawn that finds drift keeps the card in Queue installing, never Owner', async t => {
  const f = repo(t)
  const workspace = join(f.root, 'cardws')
  mkdirSync(workspace); writeFileSync(join(workspace, 'package-lock.json'), '{}')
  startDependencyInstall({ folder: workspace, tasksDir: f.tasks, install: () => new Promise(() => {}), free: () => 20 })
  f.add('T-34', ['site/app.js'])
  const spawn = async () => { throw Object.assign(new Error(`dependency setup needed: package.json differs from integration; installing dependencies in ${workspace}`), { installIn: workspace }) }
  await autoSpawn({ project: 'drift', projectPath: f.integration, tasksDir: f.tasks, boardRoot: f.root, model: 'm', agents: [], max: 5, spawn })
  assert.equal(findCard(f.tasks, 'T-34').column, 'queue')
  assert.equal(holdsFor('drift')['T-34'], `installing dependencies in ${workspace}`)
  assert.equal(readWorkflow(f.tasks)['T-34']?.operational ?? null, null, 'no operational hold for Owner')
})

test('cards waiting on files held by another live card stay in Queue; the stall watchdog agrees', async t => {
  const f = repo(t)
  // In Working: a card waiting in Owner holds no files since 2026-09-25 (Injectbuddy I164/I169).
  f.add('T-34', ['site/app.js', 'site/b.js'], 'working')
  const site = join(f.integration, 'site')
  // Registry as Tradeflow wrote it before the fix: doubled prefix alongside nothing else.
  writeFileSync(join(f.tasks, '.board-worktrees.json'), JSON.stringify({ 'T-34': { cardId: 'T-34', state: 'building', integrationWorkspace: site, files: [norm(join(site, 'site', 'app.js'))] } }))
  f.add('T-35', ['site/app.js'])
  f.add('T-37', ['b.js']) // workspace-relative listing must still collide with the prefixed one
  const args = { project: 'waits', projectPath: f.integration, tasksDir: f.tasks, boardRoot: f.root, model: 'm', agents: [], max: 5, gitSettings: {}, spawn: async () => { throw new Error('must not start') } }
  await autoSpawn(args)
  const holds = holdsFor('waits')
  assert.equal(holds['T-35'], 'files busy, held by T-34 — site/app.js', 'no doubled workspace prefix')
  assert.equal(holds['T-37'], 'files busy, held by T-34 — site/b.js')
  for (const id of ['T-35', 'T-37']) {
    assert.equal(findCard(f.tasks, id).column, 'queue')
    assert.equal(readWorkflow(f.tasks)[id]?.queueHoldSince ?? null, null, 'no expiry clock on an allowed wait')
  }
  assert.equal(findCard(f.tasks, 'T-34').column, 'working')
  assert.ok(readWorktrees(f.tasks)['T-34'].files.includes(norm(join(site, 'app.js'))))

  const T = Date.now() + 3600000
  for (const id of ['T-35', 'T-37']) utimesSync(findCard(f.tasks, id).path, new Date(T), new Date(T))
  checkStalls({ tasksDir: f.tasks, holds, now: T })
  assert.deepEqual(checkStalls({ tasksDir: f.tasks, holds, now: T + 30 * 60000 }).map(s => s.id).filter(id => id !== 'T-34'), [], 'a live holder is an allowed wait')
  rmSync(findCard(f.tasks, 'T-34').path)
  assert.deepEqual(checkStalls({ tasksDir: f.tasks, holds, now: T + 60 * 60000 }).map(s => s.id).sort(), ['T-35', 'T-37'], 'a holder that is no longer live is not')
})

test('a workspace-prefixed file list integrates the card commit', t => {
  const f = repo(t)
  const card = f.add('T-34', ['site/app.js'])
  const p = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
  writeFileSync(join(p.workspacePath, 'app.js'), 'changed\n')
  git(p.workspacePath, 'config', 'user.name', 't'); git(p.workspacePath, 'config', 'user.email', 't@e.x')
  git(p.workspacePath, 'commit', '-am', 'T-34')
  appendReviewPass(findCard(f.tasks, 'T-34'), 'Independent check passed.')
  moveCard(f.tasks, 'T-34', 'completed')
  const [result] = reconcileCompletedWorktrees({ tasksDir: f.tasks })
  assert.equal(result.status, 'integrated', result.reason)
  assert.match(readFileSync(join(f.integration, 'site', 'app.js'), 'utf8'), /^changed/)
})
