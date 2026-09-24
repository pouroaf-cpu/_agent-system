// node --test worktrees.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { appendReviewPass, findCard, moveCard, parseCard, readBoard } from './lib/cards.mjs'
import { overlapHoldReason, prepareCardWorktree, readWorktrees, reconcileCompletedWorktrees, recoverAbandonedWorktree, completeUnchangedWorktree, semanticDirtyFiles, integrationStartHoldReason, normalizeGuardedEol } from './lib/worktrees.mjs'
import { startHoldReason, preflightBlocks } from './lib/autospawn.mjs'
import { workerPrompt } from './lib/prompt.mjs'
import { activityLog } from './lib/activity.mjs'

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hkb-worktree-'))
  const integration = join(root, 'integration')
  const tasks = join(root, 'board', 'TASKS')
  const worktreesRoot = join(root, 'cards')
  mkdirSync(integration, { recursive: true })
  for (const dir of ['queue', 'working', 'completed', 'issues']) mkdirSync(join(tasks, dir), { recursive: true })
  git(integration, 'init')
  git(integration, 'config', 'user.name', 'test')
  git(integration, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(integration, 'app.js'), 'base\n')
  git(integration, 'add', 'app.js')
  git(integration, 'commit', '-m', 'base')
  const settings = { integrationPath: integration, worktreesRoot }
  const addCard = (id, file = 'app.js') => {
    const path = join(tasks, 'queue', `${id}-card.md`)
    writeFileSync(path, `# ${id} — Card\n\n**Workflow:** card-owned\n**Workspace:** .\n\n## Files\n\n- \`${file}\` — change\n\n## Approved brief\n\nDo it.\n\n## Implementation plan\n\nChange it.\n\n## Acceptance criteria\n\n1. Done.\n`)
    return parseCard(path, 'queue')
  }
  const complete = (id) => { appendReviewPass(findCard(tasks, id), 'Independent check passed.'); return moveCard(tasks, id, 'completed') }
  return { root, integration, tasks, settings, addCard, complete }
}

test('activity log is timestamped, single-line, and fail-open', () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-activity-'))
  const tasks = join(root, 'TASKS')
  mkdirSync(tasks)
  activityLog({ tasksDir: tasks, project: 'Test', cardId: 'T-1', event: 'retry', message: 'first\nsecond', now: new Date('2026-09-14T00:00:00Z') })
  const first = '2026-09-14T00:00:00.000Z project=Test card=T-1 event=retry message=first second\n'
  assert.equal(readFileSync(join(tasks, 'activity.log'), 'utf8'), first)
  activityLog({ tasksDir: tasks, project: 'Test', cardId: 'T-2', event: 'hold', message: 'safe\nline', now: new Date('2026-09-15T00:00:00Z') })
  const log = readFileSync(join(tasks, 'activity.log'), 'utf8')
  assert.equal(log, first + '2026-09-15T00:00:00.000Z project=Test card=T-2 event=hold message=safe line\n')
  assert.doesNotThrow(() => activityLog({ tasksDir: join(root, 'missing', 'TASKS'), project: 'Test', cardId: '-', event: 'hold', message: 'safe' }))
  assert.doesNotThrow(() => activityLog({ tasksDir: tasks, project: 'Test', cardId: '-', event: 'hold', message: 'safe', now: 'invalid' }))
  rmSync(root, { recursive: true, force: true })
})

test('a completed card commit is validated, integrated serially, and cleaned', () => {
  const f = fixture()
  try {
    const card = f.addCard('T-1')
    const prepared = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
    writeFileSync(join(prepared.workspacePath, 'app.js'), 'card one\n')
    git(prepared.workspacePath, 'add', 'app.js')
    git(prepared.workspacePath, 'commit', '-m', 'T-1 change')
    f.complete('T-1')

    assert.deepEqual(reconcileCompletedWorktrees({ tasksDir: f.tasks }).map(({ id, status }) => ({ id, status })), [
      { id: 'T-1', status: 'integrated' },
    ])
    assert.equal(readFileSync(join(f.integration, 'app.js'), 'utf8').replaceAll('\r\n', '\n'), 'card one\n')
    assert.equal(readWorktrees(f.tasks)['T-1'].cleaned, true)
    assert.equal(readWorktrees(f.tasks)['T-1'].state, 'integrated')
    assert.equal(existsSync(prepared.entry.worktreePath), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('exact overlapping card files are held while unrelated files are free', () => {
  const f = fixture()
  try {
    const first = f.addCard('T-1')
    prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: first, gitSettings: f.settings })
    const second = f.addCard('T-2')
    assert.match(overlapHoldReason({ tasksDir: f.tasks, card: second, projectPath: f.integration }), /held by T-1/)
    writeFileSync(join(f.integration, 'other.js'), 'other\n')
    const third = f.addCard('T-3', 'other.js')
    assert.equal(overlapHoldReason({ tasksDir: f.tasks, card: third, projectPath: f.integration }), null)
    moveCard(f.tasks, 'T-1', 'archive', { operatorArchive: true })
    assert.equal(overlapHoldReason({ tasksDir: f.tasks, card: second, projectPath: f.integration }), null)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('an integration conflict aborts cleanly and preserves the card worktree', () => {
  const f = fixture()
  try {
    const card = f.addCard('T-1')
    const prepared = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
    writeFileSync(join(prepared.workspacePath, 'app.js'), 'builder\n')
    git(prepared.workspacePath, 'add', 'app.js')
    git(prepared.workspacePath, 'commit', '-m', 'T-1 change')
    writeFileSync(join(f.integration, 'app.js'), 'integration\n')
    git(f.integration, 'add', 'app.js')
    git(f.integration, 'commit', '-m', 'parallel integration')
    f.complete('T-1')

    const commit = git(prepared.workspacePath, 'rev-parse', 'HEAD')
    const [result] = reconcileCompletedWorktrees({ tasksDir: f.tasks })
    assert.equal(result.status, 'conflict')
    assert.deepEqual(result.files, ['app.js'])
    assert.match(result.hunks, /<<<<<<<|builder/)
    assert.equal(existsSync(prepared.entry.worktreePath), true)
    assert.equal(git(prepared.workspacePath, 'rev-parse', 'HEAD'), commit, 'the rebase attempt was aborted cleanly')
    assert.equal(git(prepared.workspacePath, 'status', '--porcelain'), '')
    assert.equal(readWorktrees(f.tasks)['T-1'].state, 'conflict')
    assert.equal(git(f.integration, 'status', '--porcelain'), '')
    assert.deepEqual(reconcileCompletedWorktrees({ tasksDir: f.tasks }), [], 'a conflict is never retried in a loop')

    // The Builder resolves it in its own worktree, then hands off again: it integrates.
    const head = git(f.integration, 'rev-parse', 'HEAD')
    assert.notEqual(spawnSync('git', ['-C', prepared.workspacePath, 'rebase', '--onto', head, prepared.entry.baseCommit]).status, 0)
    writeFileSync(join(prepared.workspacePath, 'app.js'), 'integration\nbuilder\n')
    git(prepared.workspacePath, 'add', 'app.js')
    git(prepared.workspacePath, '-c', 'core.editor=true', 'rebase', '--continue')
    const entries = JSON.parse(readFileSync(join(f.tasks, '.board-worktrees.json'), 'utf8'))
    entries['T-1'].state = 'building' // prepareCardWorktree resumes a returned card this way
    writeFileSync(join(f.tasks, '.board-worktrees.json'), JSON.stringify(entries))
    assert.equal(reconcileCompletedWorktrees({ tasksDir: f.tasks })[0].status, 'integrated')
    assert.equal(readFileSync(join(f.integration, 'app.js'), 'utf8').replaceAll('\r\n', '\n'), 'integration\nbuilder\n')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a commit outside the exact card files is rejected and preserved', () => {
  const f = fixture()
  try {
    const card = f.addCard('T-1')
    const prepared = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
    writeFileSync(join(prepared.workspacePath, 'app.js'), 'card one\n')
    writeFileSync(join(prepared.workspacePath, 'extra.js'), 'not on card\n')
    git(prepared.workspacePath, 'add', 'app.js', 'extra.js')
    git(prepared.workspacePath, 'commit', '-m', 'T-1 change')
    f.complete('T-1')

    const [result] = reconcileCompletedWorktrees({ tasksDir: f.tasks })
    assert.equal(result.status, 'issue')
    assert.match(result.reason, /only card-listed files/)
    assert.equal(existsSync(prepared.entry.worktreePath), true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('abandoned unchanged work cleans and requeues; dirty work is preserved for Issues', () => {
  const f = fixture()
  try {
    const cleanCard = f.addCard('T-1')
    const cleanPrepared = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: cleanCard, gitSettings: f.settings })
    assert.equal(recoverAbandonedWorktree({ tasksDir: f.tasks, cardId: 'T-1' }).status, 'requeue')
    assert.equal(existsSync(cleanPrepared.entry.worktreePath), false)

    const dirtyCard = f.addCard('T-2')
    const dirtyPrepared = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: dirtyCard, gitSettings: f.settings })
    writeFileSync(join(dirtyPrepared.workspacePath, 'app.js'), 'unfinished\n')
    const result = recoverAbandonedWorktree({ tasksDir: f.tasks, cardId: 'T-2' })
    assert.equal(result.status, 'issue')
    assert.equal(existsSync(dirtyPrepared.entry.worktreePath), true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('Builder handoff names the live central TASKS directory from an isolated workspace', () => {
  const text = workerPrompt({
    card: { id: 'T-1', title: 'Card', path: 'C:\\board\\TASKS\\working\\T-1.md', workspace: '.' },
    projectPath: 'C:\\integration',
    workspacePath: 'C:\\cards\\T-1',
    tasksDir: 'C:\\board\\TASKS',
    boardRoot: 'C:\\board-app',
  })
  assert.match(text, /Workspace root: C:\/cards\/T-1/)
  assert.match(text, /hkb\.mjs' --tasks 'C:\\board\\TASKS' done T-1/)
})

test('crash after cherry-pick resumes without a duplicate integration and stale empty lock recovers', () => {
  const f = fixture()
  try {
    const card = f.addCard('T-1')
    const prepared = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
    writeFileSync(join(prepared.workspacePath, 'app.js'), 'recovered\n')
    git(prepared.workspacePath, 'add', 'app.js')
    git(prepared.workspacePath, 'commit', '-m', 'T-1')
    const commit = git(prepared.workspacePath, 'rev-parse', 'HEAD')
    const integrationBase = git(f.integration, 'rev-parse', 'HEAD')
    git(f.integration, 'cherry-pick', '-x', commit)
    const after = git(f.integration, 'rev-parse', 'HEAD')
    writeFileSync(join(f.tasks, '.board-worktrees.json'), JSON.stringify({ 'T-1': { ...prepared.entry, state: 'integrating', commit, integrationBase } }))
    f.complete('T-1')
    const lock = join(f.tasks, '.board-integration.lock')
    writeFileSync(lock, '')
    utimesSync(lock, new Date(0), new Date(0))
    assert.equal(reconcileCompletedWorktrees({ tasksDir: f.tasks })[0].status, 'integrated')
    assert.equal(git(f.integration, 'rev-parse', 'HEAD'), after)
    reconcileCompletedWorktrees({ tasksDir: f.tasks })
    assert.equal(readWorktrees(f.tasks)['T-1'].cleaned, true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('corrupt registry fails closed and revised card file lists acquire new locks', () => {
  const f = fixture()
  try {
    const card = f.addCard('T-1')
    prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
    writeFileSync(card.path, readFileSync(card.path, 'utf8').replace('`app.js`', '`other.js`'))
    assert.match(overlapHoldReason({ tasksDir: f.tasks, card: f.addCard('T-2', 'other.js'), projectPath: f.integration }), /held by T-1/)
    writeFileSync(join(f.tasks, '.board-worktrees.json'), '{')
    assert.throws(() => readWorktrees(f.tasks))
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('unconfigured Git projects receive isolated worktrees', () => {
  const f = fixture()
  try {
    const result = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: f.addCard('T-1') })
    assert.equal(result.git, true)
    assert.notEqual(result.workspacePath, f.integration)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('matching installed dependencies are available in isolation and preserved on cleanup', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.integration, 'package.json'), '{"name":"fixture"}')
    writeFileSync(join(f.integration, '.gitignore'), 'node_modules/\n')
    git(f.integration, 'add', 'package.json', '.gitignore')
    git(f.integration, 'commit', '-m', 'environment')
    mkdirSync(join(f.integration, 'node_modules'))
    writeFileSync(join(f.integration, 'node_modules', 'proof.txt'), 'keep')
    const result = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: f.addCard('T-1'), gitSettings: f.settings })
    assert.equal(readFileSync(join(result.workspacePath, 'node_modules', 'proof.txt'), 'utf8'), 'keep')
    assert.equal(recoverAbandonedWorktree({ tasksDir: f.tasks, cardId: 'T-1' }).status, 'requeue')
    assert.equal(readFileSync(join(f.integration, 'node_modules', 'proof.txt'), 'utf8'), 'keep')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('explicit checked no-op records completion without a fabricated commit; dirty no-op rejects', () => {
  const f = fixture()
  try {
    const card = f.addCard('T-1')
    const p = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
    const before = git(f.integration, 'rev-parse', 'HEAD')
    const original = readFileSync(join(p.workspacePath, 'app.js'))
    assert.throws(() => completeUnchangedWorktree({ tasksDir: f.tasks, cardId: 'T-1' }), /evidence/)
    writeFileSync(join(p.workspacePath, 'app.js'), 'unfinished\n')
    assert.throws(() => completeUnchangedWorktree({ tasksDir: f.tasks, cardId: 'T-1', evidence: 'check' }), /unchanged/)
    writeFileSync(join(p.workspacePath, 'app.js'), original)
    assert.equal(completeUnchangedWorktree({ tasksDir: f.tasks, cardId: 'T-1', evidence: 'asserted existing base content' }).noOp, true)
    assert.equal(git(f.integration, 'rev-parse', 'HEAD'), before)
    assert.equal(readWorktrees(f.tasks)['T-1'].noOp, true)
    assert.equal(completeUnchangedWorktree({ tasksDir: f.tasks, cardId: 'T-1', evidence: 'same verified receipt after interrupted handoff' }).noOp, true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('an empty dependency directory fails readiness before Builder launch', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.integration, 'package.json'), '{"dependencies":{"missing-proof-package":"1.0.0"}}')
    writeFileSync(join(f.integration, '.gitignore'), 'node_modules/\n')
    git(f.integration, 'add', 'package.json', '.gitignore')
    git(f.integration, 'commit', '-m', 'dependency fixture')
    mkdirSync(join(f.integration, 'node_modules'))
    assert.throws(() => prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: f.addCard('T-1'), gitSettings: f.settings }), /dependency setup needed: missing missing-proof-package/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('Git-normalized EOL noise clears spawn/preflight and backed-up normalization allows real integration', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.integration, '.gitattributes'), '*.js text eol=lf\n')
    writeFileSync(join(f.integration, 'app.js'), 'base\nsecond\n')
    git(f.integration, 'add', '.gitattributes', 'app.js')
    git(f.integration, 'commit', '-m', 'normalized fixture')
    const card = f.addCard('T-1')
    writeFileSync(join(f.integration, 'app.js'), 'base\r\nsecond\n')
    assert.match(git(f.integration, 'status', '--porcelain'), /app.js/)
    const bytes = readFileSync(join(f.integration, 'app.js'))
    assert.deepEqual(semanticDirtyFiles(f.integration), [])
    mkdirSync(join(f.integration, 'scripts'))
    writeFileSync(join(f.integration, 'scripts', 'preflight.mjs'), 'process.exit(1)')
    assert.equal(preflightBlocks({ projectPath: f.integration, card, gitSettings: f.settings }), false)
    writeFileSync(join(f.integration, 'scripts', 'preflight.mjs'), 'process.exit(2)')
    assert.equal(preflightBlocks({ projectPath: f.integration, card, gitSettings: f.settings }).kind, 'card not ready')
    rmSync(join(f.integration, 'scripts'), { recursive: true })
    assert.equal(startHoldReason({ card, board: readBoard(f.tasks), projectPath: f.integration, tasksDir: f.tasks, gitSettings: f.settings }), null)
    assert.deepEqual(readFileSync(join(f.integration, 'app.js')), bytes)
    const p = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
    writeFileSync(join(p.workspacePath, 'app.js'), 'builder\nsecond\n')
    git(p.workspacePath, 'add', 'app.js')
    git(p.workspacePath, 'commit', '-m', 'T-1')
    f.complete('T-1')
    const [result] = reconcileCompletedWorktrees({ tasksDir: f.tasks })
    assert.equal(result.status, 'integrated', result.reason)
    assert.equal(readWorktrees(f.tasks)['T-1'].cleaned, true)
    assert.equal(git(f.integration, 'show', ':app.js'), 'builder\nsecond')
    const backups = join(f.integration, '.git', 'kanban-eol-backups')
    const backup = join(backups, readdirSync(backups)[0])
    const manifest = JSON.parse(readFileSync(join(backup, 'manifest.json')))
    assert.equal(manifest.files[0].path, 'app.js')
    assert.deepEqual(readFileSync(join(backup, manifest.files[0].backup)), bytes)
    const restored = join(f.root, 'restored-original')
    writeFileSync(restored, readFileSync(join(backup, manifest.files[0].backup)))
    assert.deepEqual(readFileSync(restored), bytes)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('independent Builder uses committed snapshot; dirty integration bytes/index and overlap remain protected', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.integration, 'other.js'), 'committed\n')
    git(f.integration, 'add', 'other.js')
    git(f.integration, 'commit', '-m', 'other')
    const base = git(f.integration, 'rev-parse', 'HEAD')
    writeFileSync(join(f.integration, 'app.js'), 'staged\n')
    git(f.integration, 'add', 'app.js')
    writeFileSync(join(f.integration, 'app.js'), 'base\n') // cancels staged change only against HEAD
    const bytes = readFileSync(join(f.integration, 'app.js'))
    const index = readFileSync(join(f.integration, '.git', 'index'))
    assert.throws(() => normalizeGuardedEol(f.integration), /requires no staged/)
    const blocked = f.addCard('T-1')
    assert.match(integrationStartHoldReason({ repoRoot: f.integration, card: blocked }), /substantive/)
    assert.throws(() => prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: blocked, gitSettings: f.settings }), /substantive/)
    const card = f.addCard('T-2', 'other.js')
    assert.equal(startHoldReason({ card, board: readBoard(f.tasks), projectPath: f.integration, tasksDir: f.tasks, gitSettings: f.settings }), null)
    const p = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
    assert.equal(p.entry.baseCommit, base)
    assert.equal(git(p.workspacePath, 'show', 'HEAD:app.js'), 'base')
    writeFileSync(join(p.workspacePath, 'other.js'), 'builder\n')
    git(p.workspacePath, 'add', 'other.js')
    git(p.workspacePath, 'commit', '-m', 'T-2')
    f.complete('T-2')
    assert.equal(reconcileCompletedWorktrees({ tasksDir: f.tasks })[0].status, 'held')
    assert.deepEqual(readFileSync(join(f.integration, 'app.js')), bytes)
    assert.deepEqual(readFileSync(join(f.integration, '.git', 'index')), index)
    assert.equal(git(f.integration, 'rev-parse', 'HEAD'), base)
    assert.match(overlapHoldReason({ tasksDir: f.tasks, card: f.addCard('T-3', 'other.js'), projectPath: f.integration }), /T-2/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('semantic guard preserves untracked, staged, deleted, renamed, mode and unmerged states and fails closed', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.integration, 'new.js'), 'new\n')
    assert.throws(() => normalizeGuardedEol(f.integration), /untracked/)
    assert.ok(semanticDirtyFiles(f.integration).includes('new.js'))
    git(f.integration, 'add', 'new.js')
    assert.ok(semanticDirtyFiles(f.integration).includes('new.js'))
    git(f.integration, 'commit', '-m', 'new')
    git(f.integration, 'mv', 'new.js', 'renamed.js')
    assert.deepEqual(semanticDirtyFiles(f.integration).sort(), ['new.js', 'renamed.js'])
    git(f.integration, 'commit', '-m', 'rename')
    rmSync(join(f.integration, 'renamed.js'))
    assert.ok(semanticDirtyFiles(f.integration).includes('renamed.js'))
    git(f.integration, 'add', '-u')
    git(f.integration, 'commit', '-m', 'delete')
    git(f.integration, 'update-index', '--chmod=+x', 'app.js')
    assert.ok(semanticDirtyFiles(f.integration).includes('app.js'))
    git(f.integration, 'commit', '-m', 'mode')
    const base = git(f.integration, 'rev-parse', 'HEAD')
    git(f.integration, 'checkout', '-b', 'conflict')
    writeFileSync(join(f.integration, 'app.js'), 'branch\n')
    git(f.integration, 'add', 'app.js'); git(f.integration, 'commit', '-m', 'branch')
    git(f.integration, 'checkout', '-b', 'main-conflict', base)
    writeFileSync(join(f.integration, 'app.js'), 'main\n')
    git(f.integration, 'add', 'app.js'); git(f.integration, 'commit', '-m', 'main')
    assert.notEqual(spawnSync('git', ['-C', f.integration, 'merge', 'conflict']).status, 0)
    assert.ok(semanticDirtyFiles(f.integration).includes('app.js'))
    assert.match(integrationStartHoldReason({ repoRoot: f.integration, card: f.addCard('T-1', 'independent.js') }), /operation in progress/)
    assert.throws(() => semanticDirtyFiles(f.root), /git/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('guarded EOL normalization refuses custom filters and real edits, preserves index and durable original', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.integration, '.gitattributes'), '*.js text eol=lf filter=example\n')
    git(f.integration, 'add', '.gitattributes'); git(f.integration, 'commit', '-m', 'attrs')
    writeFileSync(join(f.integration, 'app.js'), 'base\r\n')
    const original = readFileSync(join(f.integration, 'app.js'))
    assert.throws(() => normalizeGuardedEol(f.integration), /custom transforms/)
    assert.deepEqual(readFileSync(join(f.integration, 'app.js')), original)
    writeFileSync(join(f.integration, '.gitattributes'), '*.js text eol=lf\n')
    git(f.integration, 'add', '.gitattributes'); git(f.integration, 'commit', '-m', 'native attrs')
    writeFileSync(join(f.integration, 'app.js'), 'real edit\r\n')
    assert.throws(() => normalizeGuardedEol(f.integration), /substantive/)
    assert.equal(readFileSync(join(f.integration, 'app.js'), 'utf8'), 'real edit\r\n')
    writeFileSync(join(f.integration, 'app.js'), original)
    const index = readFileSync(join(f.integration, '.git', 'index'))
    const head = git(f.integration, 'rev-parse', 'HEAD')
    const result = normalizeGuardedEol(f.integration)
    assert.deepEqual(result.files, ['app.js'])
    assert.deepEqual(readFileSync(join(result.backupDir, '0.original')), original)
    assert.deepEqual(readFileSync(join(f.integration, '.git', 'index')), index)
    assert.equal(git(f.integration, 'rev-parse', 'HEAD'), head)
    assert.equal(readFileSync(join(f.integration, 'app.js'), 'utf8'), 'base\n')
    assert.equal(git(f.integration, 'status', '--porcelain'), '')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('autocrlf true without attributes recovers both mixed EOL and LF retry then refreshes and cherry-picks', () => {
  for (const original of ['base\r\nsecond\n', 'base\nsecond\n']) {
    const f = fixture()
    try {
      git(f.integration, 'config', 'core.autocrlf', 'true')
      writeFileSync(join(f.integration, 'app.js'), 'base\r\nsecond\r\n')
      git(f.integration, 'add', 'app.js'); git(f.integration, 'commit', '-m', 'two lines')
      const card = f.addCard('T-1')
      const p = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
      writeFileSync(join(p.workspacePath, 'app.js'), 'builder\r\nsecond\r\n')
      git(p.workspacePath, 'add', 'app.js'); git(p.workspacePath, 'commit', '-m', 'T-1')
      writeFileSync(join(f.integration, 'app.js'), original)
      const index = readFileSync(join(f.integration, '.git', 'index'))
      const recovery = normalizeGuardedEol(f.integration)
      assert.deepEqual(readFileSync(join(f.integration, '.git', 'index')), index)
      assert.equal(readFileSync(join(recovery.backupDir, '0.original'), 'utf8'), original)
      assert.equal(readFileSync(join(f.integration, 'app.js'), 'utf8'), 'base\r\nsecond\r\n')
      git(f.integration, 'update-index', '--refresh')
      assert.equal(git(f.integration, 'status', '--porcelain'), '')
      f.complete('T-1')
      const [result] = reconcileCompletedWorktrees({ tasksDir: f.tasks })
      assert.equal(result.status, 'integrated', result.reason)
      assert.equal(git(f.integration, 'show', 'HEAD:app.js'), 'builder\nsecond')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  }
})
