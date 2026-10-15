// Tradeflow 2026-09-24: dependency drift in a card worktree, cards waiting behind a
// holder in Owner, and workspace-prefixed file paths that were doubled.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { appendReviewPass, clearLandedBlockers, findCard, moveCard, parseCard } from './lib/cards.mjs'
import { dependencyInstallHold, forgetInstallFailures, prepareCardWorktree, readWorktrees, reconcileCompletedWorktrees, startDependencyInstall, updateWorktree } from './lib/worktrees.mjs'
import { autoSpawn, fileHoldDetails, holdsFor, idleDispatchReason } from './lib/autospawn.mjs'
import { checkStalls } from './lib/stall-watchdog.mjs'
import { readWorkflow } from './lib/workflow-state.mjs'

// Running installs are recorded beside the board config. Without this the tests read the live
// board's record and queue behind its real npm install (2026-09-27: failed only while it ran).
const stateDir = mkdtempSync(join(tmpdir(), 'hkb-waits-state-'))
process.env.KANBAN_CONFIG = join(stateDir, 'board.config.json')
copyFileSync(new URL('./board.config.json', import.meta.url), process.env.KANBAN_CONFIG)
process.on('exit', () => rmSync(stateDir, { recursive: true, force: true }))

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
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
  writeFileSync(join(site, 'node_modules', '.package-lock.json'), '{}') // what a finished install leaves
  const card = f.add('T-34', ['site/app.js'])
  const first = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
  const modules = join(first.workspacePath, 'node_modules')
  assert.ok(lstatSync(modules).isSymbolicLink(), 'shared junction to integration')

  // Integration merges a new dependency; the card worktree still has the old manifest.
  writeFileSync(join(site, 'package.json'), '{"dependencies":{"dep":"1","other":"2"}}')
  git(f.integration, 'commit', '-am', 'merge origin/master')
  const err = (() => { try { prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings }) } catch (e) { return e } })()
  // The empty worktree is fast-forwarded to integration first, so the new dependency shows as missing.
  assert.match(err.message, /package\.json differs from integration|missing other/)
  assert.equal(err.installIn, first.workspacePath)

  let settle, calls = 0
  const install = (folder) => { calls++; assert.equal(folder, first.workspacePath); return new Promise((ok, fail) => { settle = { ok, fail } }) }
  assert.equal(startDependencyInstall({ folder: err.installIn, tasksDir: f.tasks, install, free: () => 20 }), `installing dependencies in ${first.workspacePath}`)
  assert.equal(existsSync(modules), false, 'the junction is unlinked')
  assert.ok(existsSync(join(site, 'node_modules', 'dep', 'package.json')), 'nothing deleted through it')
  assert.equal(dependencyInstallHold({ card, projectPath: f.integration, tasksDir: f.tasks, gitSettings: f.settings }), `installing dependencies in ${first.workspacePath}`, 'an allowed wait while it runs')
  // One install at a time: a second folder queues behind it (Injectbuddy I246's parallel npm ci crashes).
  const other = mkdtempSync(join(tmpdir(), 'second-install-')); t.after(() => rmSync(other, { recursive: true, force: true }))
  writeFileSync(join(other, 'package-lock.json'), '{}')
  assert.match(startDependencyInstall({ folder: other, tasksDir: f.tasks, install, free: () => 20 }), /^installing dependencies in .*queued behind another install/)
  await tick(); settle.fail(new Error('ERESOLVE')); await tick()
  assert.match(startDependencyInstall({ folder: err.installIn, tasksDir: f.tasks, install, free: () => 20 }), /retry after: ERESOLVE/)
  await tick(); settle.fail(new Error('ERESOLVE again')); await tick()
  assert.equal(dependencyInstallHold({ card, projectPath: f.integration, tasksDir: f.tasks, gitSettings: f.settings }), `dependency install failed twice in ${first.workspacePath}: ERESOLVE again`)
  assert.equal(calls, 2)
  // The operator moving it out of Owner is the retry: the failures are forgotten (IA120).
  forgetInstallFailures(f.tasks, card.id)
  assert.doesNotMatch(String(dependencyInstallHold({ card, projectPath: f.integration, tasksDir: f.tasks, gitSettings: f.settings, install, free: () => 20 })), /failed twice/)
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

// Audit 2026-10-16 F2 AC1/AC3: /api/board names each file-held card's holder, file and minutes
// held, and once the holder lands the card that has waited longest starts first even when a newer
// card sorts ahead of it in the queue (T-61 sorts before T-62 by name).
test('F2 AC1/AC3: a file-held card reports its holder and minutes, and the longest wait starts first when the file frees', async t => {
  const f = repo(t)
  f.add('T-60', ['site/app.js'])
  f.add('T-62', ['site/app.js'])
  const started = []
  const spawn = async ({ card, projectPath, tasksDir, gitSettings }) => {
    prepareCardWorktree({ projectPath, tasksDir, card, gitSettings })
    started.push(card.id)
    return { pane_id: `pane-${card.id}`, tab_id: `tab-${card.id}`, name: `b-${card.id.toLowerCase()}` }
  }
  const args = { project: 'f2', projectPath: f.integration, tasksDir: f.tasks, boardRoot: f.root, model: 'm', agents: [], max: 1, gitSettings: f.settings, spawn }
  await autoSpawn(args)
  assert.deepEqual(started, ['T-60'])
  const details = fileHoldDetails('f2', holdsFor('f2'))
  assert.equal(details.length, 1)
  assert.deepEqual([details[0].card, details[0].holder, details[0].file, details[0].minutes], ['T-62', 'T-60', 'site/app.js', 0])
  assert.match(details[0].since, /^\d{4}-\d{2}-\d{2}T/)

  const move = (id, column) => { const c = findCard(f.tasks, id); mkdirSync(join(f.tasks, column), { recursive: true }); renameSync(c.path, join(f.tasks, column, c.file)) }
  updateWorktree(f.tasks, 'T-60', { state: 'integrated', cleaned: true })
  move('T-60', 'archive')
  f.add('T-61', ['site/app.js'])
  await autoSpawn(args)
  assert.deepEqual(started, ['T-60', 'T-62'], 'the card that waited since the first pass takes the free slot, not the newer T-61')
  assert.equal(findCard(f.tasks, 'T-61').column, 'queue')
  assert.deepEqual(fileHoldDetails('f2', holdsFor('f2')).map(d => [d.card, d.holder]), [['T-61', 'T-62']], 'T-61 now waits on the card that took the file')
})

// Audit 2026-10-16 F6: a blocker whose card has landed comes off a queued card once (the scheduler
// does this each pass), and an idle Planned or Queue card names its cause instead of none.
test('F6: a landed blocker comes off a queued card, and an idle card names why it has not started', async t => {
  const f = repo(t)
  mkdirSync(join(f.tasks, 'archive'), { recursive: true })
  f.add('T-80', ['site/app.js'], 'archive')
  const queued = f.add('T-81', ['site/other.js'])
  writeFileSync(queued.path, readFileSync(queued.path, 'utf8').replace('**Workspace:** site\n', '**Workspace:** site\n**Blocked by:** T-80\n'))
  assert.deepEqual(findCard(f.tasks, 'T-81').blockedBy, ['T-80'])
  assert.deepEqual(clearLandedBlockers(f.tasks, {}), [['T-81', ['T-80']]])
  assert.deepEqual(findCard(f.tasks, 'T-81').blockedBy, [])
  assert.deepEqual(clearLandedBlockers(f.tasks, {}), [], 'a second pass finds nothing to clear')

  assert.equal(idleDispatchReason({ column: 'queue', paused: true }), 'board paused')
  assert.equal(idleDispatchReason({ column: 'queue', slotsOff: true }), 'Builder slots are off (maxConcurrentAgents is 0)')
  assert.equal(idleDispatchReason({ column: 'queue', breakerTripped: true }), 'auto-spawn breaker tripped')
  assert.equal(idleDispatchReason({ column: 'planned', autoQueue: false }), 'auto-queue is off: move it to Queue to start it')
  assert.equal(idleDispatchReason({ column: 'planned', autoQueue: true }), 'waiting for the next queue pass')
  assert.equal(idleDispatchReason({ column: 'queue' }), 'queued; waiting for the next dispatch pass')
  assert.equal(idleDispatchReason({ column: 'working' }), null)
})

// InjectbuddyApp 2026-10-06: IA19 moved working -> planning at .889; the scheduler's next
// pass at .919 read the board column by column and caught IA19 between columns, so IA19 was
// in no live lane at all. IA21's file hold still named IA19 (overlapHoldReason keeps a lock
// for a removed or ambiguous card on purpose), but autospawn required the holder to appear
// in that same torn snapshot and sent IA21 to Owner instead of leaving it waiting.
test('a card held by files of a card missing from the board snapshot stays in Queue, not Owner (InjectbuddyApp IA21/IA19)', async t => {
  const f = repo(t)
  // The holder (IA19) has a recorded lock in the worktree registry but no card on the board
  // at all — not in any column — exactly what a torn column-by-column read can produce.
  writeFileSync(join(f.tasks, '.board-worktrees.json'), JSON.stringify({
    'IA19': { cardId: 'IA19', state: 'building', integrationWorkspace: join(f.integration, 'site'), files: [norm(join(f.integration, 'site', 'app.js'))] },
  }))
  f.add('IA21', ['site/app.js'])
  const args = { project: 'torn', projectPath: f.integration, tasksDir: f.tasks, boardRoot: f.root, model: 'm', agents: [], max: 5, gitSettings: {}, spawn: async () => { throw new Error('must not start') } }
  await autoSpawn(args)
  assert.equal(holdsFor('torn')['IA21'], 'files busy, held by IA19 — site/app.js')
  assert.equal(findCard(f.tasks, 'IA21').column, 'queue', 'stays waiting, not escalated to Owner')
  assert.equal(readWorkflow(f.tasks)['IA21']?.queueHoldSince ?? null, null, 'no expiry clock on an allowed wait')
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

test('an empty or partial shared node_modules is reinstalled, not treated as installed (Tradeflow, Injectbuddy)', async t => {
  const f = repo(t)
  const site = join(f.integration, 'site')
  writeFileSync(join(site, 'package.json'), '{"dependencies":{"dep":"1","other":"2"}}')
  writeFileSync(join(site, 'package-lock.json'), '{"v":1}')
  mkdirSync(join(site, 'node_modules', 'dep'), { recursive: true }) // "other" is missing
  writeFileSync(join(site, 'node_modules', 'dep', 'package.json'), '{}')
  const card = f.add('T-40', ['site/app.js'])
  let started = null
  const hold = dependencyInstallHold({ card, projectPath: f.integration, tasksDir: f.tasks, gitSettings: f.settings, install: folder => { started = folder; return new Promise(() => {}) }, free: () => 20 })
  assert.ok(hold.startsWith(`installing dependencies in ${site}`), hold) // may queue behind another test's install
})

// Injectbuddy 2026-09-26: the integration checkout's node_modules was half-installed while the
// main checkout's was complete. The hold said "may start", but the spawn falls back to the main
// checkout only when integration has no node_modules, so each card failed at start with
// "dependency setup needed". They must agree: one integration install holds the queue.
test('a partial integration node_modules holds the queue once even when the main checkout is installed (throughput audit F3)', async t => {
  const f = repo(t)
  writeFileSync(join(f.integration, 'package.json'), '{"dependencies":{"dep":"1","other":"2"}}')
  writeFileSync(join(f.integration, 'package-lock.json'), '{"v":1}')
  writeFileSync(join(f.integration, '.gitignore'), 'node_modules/\n')
  git(f.integration, 'add', '.'); git(f.integration, 'commit', '-m', 'deps')
  for (const name of ['dep', 'other']) {
    mkdirSync(join(f.integration, 'node_modules', name), { recursive: true })
    writeFileSync(join(f.integration, 'node_modules', name, 'package.json'), '{}')
  }
  const integration = join(f.root, 'integration-wt')
  git(f.integration, 'worktree', 'add', '-q', '-b', 'integration', integration)
  mkdirSync(join(integration, 'node_modules', 'dep'), { recursive: true }) // "other" is missing
  writeFileSync(join(integration, 'node_modules', 'dep', 'package.json'), '{}')
  const settings = { integrationPath: integration, worktreesRoot: join(f.root, 'cards') }
  const path = join(f.tasks, 'queue', 'T-41-card.md')
  writeFileSync(path, cardText('T-41', '.', ['site/app.js']))
  const card = parseCard(path, 'queue')
  const hold = dependencyInstallHold({ card, projectPath: f.integration, tasksDir: f.tasks, gitSettings: settings, install: () => new Promise(() => {}), free: () => 20 })
  const spawnError = (() => { try { prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: settings }) } catch (e) { return e.message } })()
  assert.match(spawnError || '', /dependency setup needed/, 'the spawn cannot use the partial install')
  assert.ok(hold?.startsWith(`installing dependencies in ${integration}`), `the queue holds for one integration install, got: ${hold}`)
})

test('workspace . links node_modules into installed package subfolders (Tradeflow TF118)', t => {
  const f = repo(t)
  const site = join(f.integration, 'site')
  writeFileSync(join(site, 'package.json'), '{"dependencies":{"dep":"1"}}')
  mkdirSync(join(f.integration, 'other'))
  writeFileSync(join(f.integration, 'other', 'package.json'), '{"dependencies":{"x":"1"}}')
  writeFileSync(join(f.integration, '.gitignore'), 'node_modules/' + String.fromCharCode(10))
  git(f.integration, 'add', '.'); git(f.integration, 'commit', '-m', 'deps')
  mkdirSync(join(site, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(site, 'node_modules', 'dep', 'package.json'), '{}')
  const path = join(f.tasks, 'queue', 'TF118-card.md')
  writeFileSync(path, cardText('TF118', '.', ['site/app.js']))
  const entry = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: parseCard(path, 'queue'), gitSettings: f.settings })
  assert.ok(lstatSync(join(entry.workspacePath, 'site', 'node_modules')).isSymbolicLink(), 'site gets the shared junction')
  assert.ok(!existsSync(join(entry.workspacePath, 'other', 'node_modules')), 'uninstalled folder is left alone')
})

// Audit 2026-10-15 F8: two queued cards list the same file, which is not a parallel file. The
// scheduler starts one and holds the other as files busy until the first has integrated and
// archived; it never lets them build together to meet as a rebase conflict.
test('F8 AC1/AC2: the second of two queued cards editing the same file waits as files busy and starts once the first archives', async t => {
  const f = repo(t)
  f.add('T-40', ['site/app.js'])
  f.add('T-41', ['site/app.js'])
  const started = []
  // Like spawnForCard: the card worktree, whose registry entry carries the plan Files, is
  // prepared before the Builder starts.
  const spawn = async ({ card, projectPath, tasksDir, gitSettings }) => {
    prepareCardWorktree({ projectPath, tasksDir, card, gitSettings })
    started.push(card.id)
    return { pane_id: `pane-${card.id}`, tab_id: `tab-${card.id}`, name: `b-${card.id.toLowerCase()}` }
  }
  const args = { project: 'f8', projectPath: f.integration, tasksDir: f.tasks, boardRoot: f.root, model: 'm', agents: [], max: 5, gitSettings: f.settings, spawn }
  await autoSpawn(args)
  assert.deepEqual(started, ['T-40'], 'AC1: one dispatched')
  assert.equal(findCard(f.tasks, 'T-40').column, 'working')
  assert.equal(findCard(f.tasks, 'T-41').column, 'queue')
  assert.equal(holdsFor('f8')['T-41'], 'files busy, held by T-40 — site/app.js', 'AC1: the other held with the files-busy reason')

  // Still held while the first sits in Completed waiting to integrate.
  const move = (id, column) => { const c = findCard(f.tasks, id); mkdirSync(join(f.tasks, column), { recursive: true }); renameSync(c.path, join(f.tasks, column, c.file)) }
  move('T-40', 'completed')
  await autoSpawn(args)
  assert.deepEqual(started, ['T-40'])
  assert.equal(holdsFor('f8')['T-41'], 'files busy, held by T-40 — site/app.js')

  // Integrated and archived: the held card starts on the next pass.
  updateWorktree(f.tasks, 'T-40', { state: 'integrated', cleaned: true })
  move('T-40', 'archive')
  await autoSpawn(args)
  assert.deepEqual(started, ['T-40', 'T-41'], 'AC2: the held card dispatches once the first archives')
  assert.equal(findCard(f.tasks, 'T-41').column, 'working')
  assert.equal(holdsFor('f8')['T-41'], undefined)
})
