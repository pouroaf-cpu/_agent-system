// node --test worktrees.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { appendReviewPass, findCard, moveCard, parseCard, readBoard } from './lib/cards.mjs'
import { overlapHoldReason, recordedOverlapBlockers, prepareCardWorktree, readWorktrees, reconcileCompletedWorktrees, recoverAbandonedWorktree, completeUnchangedWorktree, semanticDirtyFiles, integrationStartHoldReason, normalizeGuardedEol, formatChangeError, filesBusyHolder } from './lib/worktrees.mjs'
import { startHoldReason, preflightBlocks } from './lib/autospawn.mjs'
import { workerPrompt } from './lib/prompt.mjs'
import { activityLog } from './lib/activity.mjs'
import { reconcileCompletedHandoffs, runShell } from './lib/completed-handoff.mjs'
import { alertOwnerCards } from './lib/owner-alerts.mjs'

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
    const files = [].concat(file).map(f => f.includes('`') ? f : `- \`${f}\` — change`).join('\n')
    writeFileSync(path, `# ${id} — Card\n\n**Workflow:** card-owned\n**Workspace:** .\n\n## Files\n\n${files}\n\n## Approved brief\n\nDo it.\n\n## Implementation plan\n\nChange it.\n\n## Acceptance criteria\n\n1. Done.\n`)
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
    // Queued with an empty checkout, T-1 has no work to protect (Tradeflow T-36).
    assert.equal(overlapHoldReason({ tasksDir: f.tasks, card: second, projectPath: f.integration }), null)
    moveCard(f.tasks, 'T-1', 'working')
    assert.match(overlapHoldReason({ tasksDir: f.tasks, card: second, projectPath: f.integration }), /held by T-1/)
    // A project's parallelFiles may be built on at once; integration serializes them.
    assert.equal(overlapHoldReason({ tasksDir: f.tasks, card: second, projectPath: f.integration, parallelFiles: ['app.js'] }), null)
    writeFileSync(join(f.integration, 'other.js'), 'other\n')
    const third = f.addCard('T-3', 'other.js')
    assert.equal(overlapHoldReason({ tasksDir: f.tasks, card: third, projectPath: f.integration }), null)
    moveCard(f.tasks, 'T-1', 'archive', { operatorArchive: true })
    assert.equal(overlapHoldReason({ tasksDir: f.tasks, card: second, projectPath: f.integration }), null)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

// 2026-09-25: most Owner cards were board problems, each a phone alert. Automatic routes
// stay in Owner for the Kanban Manager; only a deliberate board move reaches Pou, which alerts.
test('an automatic move to Owner sends no alert; a board move to Pou alerts and holds no locks', async () => {
  const f = fixture()
  try {
    prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: f.addCard('T-1'), gitSettings: f.settings })
    moveCard(f.tasks, 'T-1', 'working')
    const second = f.addCard('T-2')
    assert.match(overlapHoldReason({ tasksDir: f.tasks, card: second, projectPath: f.integration }), /held by T-1/)
    const sent = [], send = async (title) => { sent.push(title) }
    assert.equal(moveCard(f.tasks, 'T-1', 'owner').column, 'owner')
    assert.deepEqual(await alertOwnerCards({ project: 'P', tasksDir: f.tasks, send }), [])
    assert.equal(sent.length, 0, 'Owner never alerts')
    assert.equal(moveCard(f.tasks, 'T-1', 'pou').column, 'pou') // what POST /api/move does
    assert.deepEqual(await alertOwnerCards({ project: 'P', tasksDir: f.tasks, send }), ['T-1'])
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
    // No Builder resume needed: a hand-resolved conflict moved back to Completed integrates (Injectbuddy I387).
    assert.equal(reconcileCompletedWorktrees({ tasksDir: f.tasks })[0].status, 'integrated')
    assert.equal(readFileSync(join(f.integration, 'app.js'), 'utf8').replaceAll('\r\n', '\n'), 'integration\nbuilder\n')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

for (const key of ['app.js', '*.js']) test(`generated files (${key}) never hold another card`, () => {
  const f = fixture()
  try {
    const generatedFiles = { [key]: `node -e "require('fs').writeFileSync('app.js', 'generated')"` }
    prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: f.addCard('T-1'), gitSettings: { ...f.settings, generatedFiles } })
    moveCard(f.tasks, 'T-1', 'working')
    const card = f.addCard('T-2')
    assert.equal(overlapHoldReason({ tasksDir: f.tasks, card, projectPath: f.integration, generatedFiles }), null)
    assert.deepEqual(recordedOverlapBlockers(card, f.integration, readWorktrees(f.tasks), [], generatedFiles), [])
    assert.equal(startHoldReason({ tasksDir: f.tasks, card, projectPath: f.integration, board: readBoard(f.tasks), gitSettings: { ...f.settings, generatedFiles } }), null)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

for (const mixed of [false, true]) test(mixed ? 'a non-generated conflict alongside generated globs aborts without running commands' : 'generated globs integrate with distinct commands in config order and all generated changes staged', async () => {
  const f = fixture()
  try {
    const html = ['a', 'b', 'c', 'd'].map(name => `public/legacy/${name}/index.html`)
    const css = 'public/aa.css' // Git reports this conflict before the HTML files.
    const log = join(f.root, 'commands.log')
    for (const file of html.slice(0, 3)) {
      mkdirSync(join(f.integration, file, '..'), { recursive: true })
      writeFileSync(join(f.integration, file), 'base')
    }
    writeFileSync(join(f.integration, css), 'base')
    writeFileSync(join(f.integration, 'stamp.mjs'), `import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
      for (const file of ${JSON.stringify(html.slice(0, 2))}) {
        if (readFileSync(file, 'utf8').includes('<<<<<<<')) throw new Error('checkout must finish before regeneration')
      }
      for (const file of ${JSON.stringify(html)}) {
        mkdirSync(file + '/..', { recursive: true })
        writeFileSync(file, 'generated html')
      }
      appendFileSync(${JSON.stringify(log)}, 'html\\n')
    `)
    writeFileSync(join(f.integration, 'build.mjs'), `import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
      if (readFileSync(${JSON.stringify(html[0])}, 'utf8') !== 'generated html') throw new Error('stamp must run first')
      writeFileSync(${JSON.stringify(css)}, 'generated css')
      appendFileSync(${JSON.stringify(log)}, 'css\\n')
    `)
    git(f.integration, 'add', '.')
    git(f.integration, 'commit', '-m', 'generated fixtures')
    f.settings.generatedFiles = {
      'public/legacy/*/index.html': 'node stamp.mjs',
      [html[1]]: 'node stamp.mjs',
      [css]: 'node build.mjs',
      'public/extra.css': `node -e "require('fs').writeFileSync('public/extra.css', 'generated extra')"`,
    }
    const scope = [...html, css, 'public/extra.css', ...(mixed ? ['app.js'] : [])]
    const cards = ['T-1', 'T-2'].map(id => prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: f.addCard(id, scope), gitSettings: f.settings }))
    for (const [i, card] of cards.entries()) {
      for (const file of [...html.slice(0, 2), css, ...(mixed ? ['app.js'] : [])]) writeFileSync(join(card.workspacePath, file), `card ${i}`)
      git(card.workspacePath, 'commit', '-am', `T-${i + 1} change`)
      f.complete(`T-${i + 1}`)
    }
    const commit = git(cards[1].workspacePath, 'rev-parse', 'HEAD')
    const results = reconcileCompletedWorktrees({ tasksDir: f.tasks })
    assert.deepEqual(results.map(r => r.status), ['integrated', mixed ? 'conflict' : 'rebased'])
    if (mixed) {
      assert.equal(existsSync(log), false)
      assert.equal(git(cards[1].workspacePath, 'rev-parse', 'HEAD'), commit)
      assert.equal(git(cards[1].workspacePath, 'status', '--porcelain'), '')
    } else {
      assert.equal(readFileSync(log, 'utf8'), 'html\ncss\n', 'each distinct command runs once, in config order')
      assert.deepEqual([...results[1].regenerated].sort(), [...html, css, 'public/extra.css'].sort())
      assert.equal(git(cards[1].workspacePath, 'status', '--porcelain'), '')
      const integrated = await reconcileCompletedHandoffs({ tasksDir: f.tasks, project: 'Test', onlyIds: ['T-2'], io: {
        agentList: async () => [], reconcile: reconcileCompletedWorktrees,
        runCheck: async () => ({ ok: true, output: 'PASS' }),
      } })
      assert.equal(integrated[0].status, 'integrated')
      for (const file of html) assert.equal(readFileSync(join(f.integration, file), 'utf8'), 'generated html')
      assert.equal(readFileSync(join(f.integration, css), 'utf8'), 'generated css')
      assert.equal(readFileSync(join(f.integration, 'public/extra.css'), 'utf8'), 'generated extra')
      assert.equal(git(f.integration, 'status', '--porcelain'), '')
    }
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('two cards changing a generated file integrate after regeneration and the recorded check', async () => {
  const f = fixture()
  try {
    f.settings.generatedFiles = { 'app.js': `node -e "require('fs').writeFileSync('app.js', 'generated')"` }
    const cards = ['T-1', 'T-2'].map(id => prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: f.addCard(id), gitSettings: f.settings }))
    for (const [i, card] of cards.entries()) {
      writeFileSync(join(card.workspacePath, 'app.js'), `card ${i}`)
      git(card.workspacePath, 'commit', '-am', `T-${i + 1} change`)
      f.complete(`T-${i + 1}`)
    }
    const results = reconcileCompletedWorktrees({ tasksDir: f.tasks })
    assert.deepEqual(results.map(r => r.status), ['integrated', 'rebased'])
    assert.deepEqual(results[1].regenerated, ['app.js'])
    assert.match(readWorktrees(f.tasks)['T-2'].reason, /regenerated app.js/)
    assert.equal(readFileSync(join(f.integration, 'app.js'), 'utf8'), 'card 0', 'the rebased card waits for its recorded check')
    let checks = 0
    const integrated = await reconcileCompletedHandoffs({ tasksDir: f.tasks, project: 'Test', onlyIds: ['T-2'], io: {
      agentList: async () => [], reconcile: reconcileCompletedWorktrees,
      runCheck: async (card, entry) => {
        checks++
        assert.equal(card.id, 'T-2')
        assert.equal(readFileSync(join(entry.worktreePath, 'app.js'), 'utf8'), 'generated')
        return { ok: true, output: 'PASS' }
      },
    } })
    assert.equal(checks, 1)
    assert.equal(integrated[0].status, 'integrated')
    assert.equal(readFileSync(join(f.integration, 'app.js'), 'utf8'), 'generated')
    assert.equal(git(f.integration, 'status', '--porcelain'), '')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

for (const failing of [false, true]) test(failing ? 'a failing regeneration command preserves the conflict' : 'a non-generated conflict is not regenerated', () => {
  const f = fixture()
  try {
    f.settings.generatedFiles = failing
      ? { 'app.js': 'node -e "process.exit(1)"' }
      : { 'other.js': `node -e "require('fs').writeFileSync('other.js', 'generated')"` }
    const card = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: f.addCard('T-1'), gitSettings: f.settings })
    writeFileSync(join(card.workspacePath, 'app.js'), 'builder')
    git(card.workspacePath, 'commit', '-am', 'card change')
    const commit = git(card.workspacePath, 'rev-parse', 'HEAD')
    writeFileSync(join(f.integration, 'app.js'), 'integration')
    git(f.integration, 'commit', '-am', 'parallel change')
    f.complete('T-1')
    const [result] = reconcileCompletedWorktrees({ tasksDir: f.tasks })
    assert.equal(result.status, 'conflict')
    assert.deepEqual(result.files, ['app.js'])
    assert.match(result.hunks, /<<<<<<<|builder/)
    if (failing) assert.match(result.hunks, /regenerating app.js failed/)
    assert.equal(git(card.workspacePath, 'rev-parse', 'HEAD'), commit)
    assert.equal(git(card.workspacePath, 'status', '--porcelain'), '')
    assert.equal(git(f.integration, 'status', '--porcelain'), '')
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
    const working = moveCard(f.tasks, 'T-1', 'working')
    writeFileSync(working.path, readFileSync(working.path, 'utf8').replace('`app.js`', '`other.js`'))
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

test('integrationCheck: rebased card passes and integrates, a failure returns to a Builder, a second failure asks Owner', async () => {
  const f = fixture()
  try {
    const t1 = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: f.addCard('T-1', 'app.js'), gitSettings: f.settings })
    const t2 = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: f.addCard('T-2', 'lib.js'), gitSettings: f.settings })
    // The check exists only on master: it passes only if the card was rebased first.
    writeFileSync(join(f.integration, 'check.mjs'), "import fs from 'node:fs'\nfor (const f of ['app.js', 'lib.js']) if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('bad')) { console.log('found bad in ' + f); process.exit(1) }\n")
    git(f.integration, 'add', 'check.mjs')
    git(f.integration, 'commit', '-m', 'suite')
    const handoff = (dir, file, text) => { writeFileSync(join(dir, file), text); git(dir, 'add', file); git(dir, 'commit', '-m', 'card') }
    const run = () => reconcileCompletedHandoffs({ tasksDir: f.tasks, project: 'Test', integrationCheck: 'node check.mjs' })
    const evidence = () => readdirSync(join(f.tasks, '.evidence')).map(name => readFileSync(join(f.tasks, '.evidence', name), 'utf8'))

    handoff(t1.workspacePath, 'app.js', 'good\n'); f.complete('T-1')
    assert.equal((await run()).find(r => r.id === 'T-1').status, 'integrated')
    assert.equal(readFileSync(join(f.integration, 'app.js'), 'utf8').replaceAll('\r\n', '\n'), 'good\n')
    assert.match(evidence().join(), /result: PASS/)

    const master = git(f.integration, 'rev-parse', 'HEAD')
    handoff(t2.workspacePath, 'lib.js', 'bad\n'); f.complete('T-2')
    const [failed] = (await run()).filter(r => r.id === 'T-2')
    assert.deepEqual([failed.status, failed.to], ['returned', 'queue'])
    assert.equal(git(f.integration, 'rev-parse', 'HEAD'), master, 'nothing integrated')
    assert.equal(git(f.integration, 'status', '--porcelain'), '', 'master checkout untouched')
    assert.equal(existsSync(join(t2.workspacePath, 'check.mjs')), true, 'the card worktree was rebased onto master')
    assert.match(readFileSync(findCard(f.tasks, 'T-2').path, 'utf8'), /integration check node check\.mjs failed[\s\S]*found bad in lib\.js/)
    assert.match(evidence().join(), /result: FAIL[\s\S]*found bad in lib\.js/)

    // The Builder hands off again without a fix: one plain question to Owner.
    const entries = JSON.parse(readFileSync(join(f.tasks, '.board-worktrees.json'), 'utf8'))
    entries['T-2'].state = 'building' // prepareCardWorktree resumes a returned card this way
    writeFileSync(join(f.tasks, '.board-worktrees.json'), JSON.stringify(entries))
    f.complete('T-2')
    const [second] = (await run()).filter(r => r.id === 'T-2')
    assert.equal(second.to, 'owner')
    assert.match(readFileSync(findCard(f.tasks, 'T-2').path, 'utf8'), /Needs you[\s\S]*T-2 still does not integrate with master after 2 tries[\s\S]*\?/)
    assert.equal(git(f.integration, 'rev-parse', 'HEAD'), master)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('integrationCheck timeout kills the whole process tree and fails', async () => {
  const started = Date.now()
  const result = await runShell('node -e "setTimeout(() => {}, 60000)"', tmpdir(), 1500)
  assert.equal(result.ok, false)
  assert.match(result.output, /timed out after 1\.5s/)
  assert.ok(Date.now() - started < 20000, 'the grandchild node process did not hold the check open')
})

test('commits a card branch picked up from integration are not counted as card commits', () => {
  const f = fixture()
  try {
    const card = f.addCard('T-1')
    const prepared = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
    writeFileSync(join(f.integration, 'other.js'), 'other card\n')
    git(f.integration, 'add', 'other.js'); git(f.integration, 'commit', '-m', 'other card landed')
    const wt = prepared.entry.worktreePath
    git(wt, 'merge', '--ff-only', git(f.integration, 'rev-parse', 'HEAD')) // brought up to date by hand
    writeFileSync(join(wt, 'app.js'), 'card one\n'); git(wt, 'commit', '-am', 'T-1 change')
    f.complete('T-1')
    const results = reconcileCompletedWorktrees({ tasksDir: f.tasks })
    assert.equal(results[0].status, 'integrated', JSON.stringify(results))
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('an untracked evidence log in the card worktree does not hold integration', () => {
  const f = fixture()
  try {
    const card = f.addCard('T-1')
    const prepared = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
    const wt = prepared.entry.worktreePath
    writeFileSync(join(wt, 'app.js'), 'card one\n'); git(wt, 'commit', '-am', 'T-1 change')
    writeFileSync(join(wt, 'builder-e2e.log'), 'evidence\n')
    f.complete('T-1')
    assert.equal(reconcileCompletedWorktrees({ tasksDir: f.tasks })[0].status, 'integrated')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a build-regenerated tracked file outside the card holds nothing; a dirty card file still does', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.integration, 'sitemap.xml'), 'base\n'); git(f.integration, 'add', 'sitemap.xml'); git(f.integration, 'commit', '-m', 'sitemap')
    for (const [id, dirty, status] of [['T-1', 'sitemap.xml', 'integrated'], ['T-2', 'app.js', null]]) {
      const card = f.addCard(id)
      const wt = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings }).entry.worktreePath
      writeFileSync(join(wt, 'app.js'), `${id}\n`); git(wt, 'commit', '-am', `${id} change`)
      writeFileSync(join(wt, dirty), 'regenerated\n')
      f.complete(id)
      const result = reconcileCompletedWorktrees({ tasksDir: f.tasks }).find(r => r.id === id)
      if (status) {
        assert.equal(result.status, status)
        // Integrated: leftovers are kept under TASKS/.leftovers and the checkout is removed.
        assert.equal(readWorktrees(f.tasks)[id].cleaned, true)
        assert.equal(existsSync(wt), false)
        assert.equal(readFileSync(join(f.tasks, '.leftovers', id, dirty), 'utf8'), 'regenerated\n')
      } else assert.notEqual(result?.status, 'integrated')
    }
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

// Injectbuddy I184 waited in Queue for hours while its saved work held 34 cards.
test('a card waiting in Queue, Planned or Planning holds no file locks; its saved work stays on its branch (Injectbuddy I184)', () => {
  const f = fixture()
  try {
    const [wt1] = [f.addCard('T-1'), f.addCard('T-2')].map((card) => {
      const wt = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings }).entry.worktreePath
      writeFileSync(join(wt, 'app.js'), `${card.id}
`); git(wt, 'commit', '-am', `${card.id} work`)
      return wt
    })
    const hold = (id) => overlapHoldReason({ tasksDir: f.tasks, card: findCard(f.tasks, id), projectPath: f.integration })
    // Neither waiting card holds the other (Tradeflow T-38 and TF56 each held the other forever).
    for (const column of ['planning', 'planned', 'queue']) {
      moveCard(f.tasks, 'T-1', column)
      assert.equal(hold('T-2'), null, column)
      assert.equal(hold('T-1'), null, column)
    }
    // Running, a card locks its files again.
    moveCard(f.tasks, 'T-1', 'working')
    assert.match(hold('T-2'), /held by T-1 — app.js/)
    // T-2 lands first; T-1's saved work is kept and returned as a conflict, never lost.
    moveCard(f.tasks, 'T-1', 'queue')
    f.complete('T-2')
    assert.equal(reconcileCompletedWorktrees({ tasksDir: f.tasks }).find(r => r.id === 'T-2').status, 'integrated')
    prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: moveCard(f.tasks, 'T-1', 'working'), gitSettings: f.settings })
    f.complete('T-1')
    assert.equal(reconcileCompletedWorktrees({ tasksDir: f.tasks }).find(r => r.id === 'T-1').status, 'conflict')
    assert.equal(git(wt1, 'show', 'HEAD:app.js'), 'T-1')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('hkb done refuses a commit with out-of-scope files while the Builder can fix it', () => {
  const f = fixture()
  try {
    const card = f.addCard('T-1')
    const wt = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings }).entry.worktreePath
    moveCard(f.tasks, 'T-1', 'working')
    writeFileSync(join(wt, 'app.js'), 'card\n'); writeFileSync(join(wt, 'llms.txt'), 'out of scope\n')
    git(wt, 'add', '-A'); git(wt, 'commit', '-m', 'T-1 change')
    const run = spawnSync(process.execPath, [resolve('hkb.mjs'), '--tasks', f.tasks, 'done', 'T-1'], { encoding: 'utf8' })
    // Tradeflow TF51: the out-of-scope file was only caught at integration, on every poll.
    assert.equal(run.status, 1)
    assert.match(run.stderr, /done refused: commit must change only card-listed files/)
    assert.equal(findCard(f.tasks, 'T-1').column, 'working')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

// Injectbuddy I302: one script regenerates 141 guide pages, listed as one glob line.
const GUIDES = ['- `gen.mjs` — the generator', '- `public/legacy/guides/*/index.html` — generated by `gen.mjs`']

test('hkb done accepts committed files matching a generated-files glob and refuses others', () => {
  const f = fixture()
  try {
    const card = f.addCard('T-1', GUIDES)
    const wt = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings }).entry.worktreePath
    moveCard(f.tasks, 'T-1', 'working')
    writeFileSync(join(wt, 'gen.mjs'), 'gen\n')
    for (const g of ['a', 'b', 'TRT-Guide']) { mkdirSync(join(wt, 'public', 'legacy', 'guides', g), { recursive: true }); writeFileSync(join(wt, 'public', 'legacy', 'guides', g, 'index.html'), g) }
    git(wt, 'add', '-A'); git(wt, 'commit', '-m', 'T-1 change')
    const done = () => spawnSync(process.execPath, [resolve('hkb.mjs'), '--tasks', f.tasks, 'done', 'T-1'], { encoding: 'utf8' })
    // Nested deeper than one segment, or outside the glob: out of scope.
    mkdirSync(join(wt, 'public', 'legacy', 'other'), { recursive: true }); writeFileSync(join(wt, 'public', 'legacy', 'other', 'x.html'), 'x')
    git(wt, 'add', '-A'); git(wt, 'commit', '--amend', '-m', 'T-1 change')
    let run = done()
    assert.equal(run.status, 1)
    assert.match(run.stderr, /done refused: commit must change only card-listed files/)
    git(wt, 'rm', '-q', 'public/legacy/other/x.html'); git(wt, 'commit', '--amend', '-m', 'T-1 change')
    run = done()
    assert.doesNotMatch(run.stderr, /card-listed files/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a card holding a generated-files glob blocks cards listing a matching path only', () => {
  const f = fixture()
  try {
    prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: f.addCard('T-1', GUIDES), gitSettings: f.settings })
    moveCard(f.tasks, 'T-1', 'working')
    assert.match(overlapHoldReason({ tasksDir: f.tasks, card: f.addCard('T-2', 'public/legacy/guides/trt-guide/index.html'), projectPath: f.integration }), /held by T-1/)
    assert.equal(overlapHoldReason({ tasksDir: f.tasks, card: f.addCard('T-3', 'public/legacy/other/x.html'), projectPath: f.integration }), null)
    assert.match(overlapHoldReason({ tasksDir: f.tasks, card: f.addCard('T-4', ['- `gen2.mjs` — x', '- `public/legacy/**/*.html` — generated by `gen2.mjs`']), projectPath: f.integration }), /held by T-1/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('agent tool output in the integration checkout never blocks integration', () => {
  const f = fixture()
  try {
    const card = f.addCard('T-1')
    const wt = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings }).entry.worktreePath
    writeFileSync(join(wt, 'app.js'), 'card one\n'); git(wt, 'commit', '-am', 'T-1 change')
    // Injectbuddy 2026-09-25: a Planner's Playwright MCP wrote here and held every merge.
    mkdirSync(join(f.integration, '.playwright-mcp'), { recursive: true })
    writeFileSync(join(f.integration, '.playwright-mcp', 'console.log'), 'x\n')
    f.complete('T-1')
    assert.equal(reconcileCompletedWorktrees({ tasksDir: f.tasks })[0].status, 'integrated')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a card waiting in Owner does not hold its files against queued cards', () => {
  const f = fixture()
  try {
    const holder = f.addCard('T-1')
    const wt = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: holder, gitSettings: f.settings }).entry.worktreePath
    writeFileSync(join(wt, 'app.js'), 'saved work\n'); git(wt, 'commit', '-am', 'T-1 work')
    moveCard(f.tasks, 'T-1', 'working')
    const queued = f.addCard('T-2')
    assert.match(overlapHoldReason({ tasksDir: f.tasks, card: queued, projectPath: f.integration }), /held by T-1/)
    // Injectbuddy I164/I169 sat in Owner overnight holding files for 7 queued cards.
    moveCard(f.tasks, 'T-1', 'owner')
    assert.equal(overlapHoldReason({ tasksDir: f.tasks, card: queued, projectPath: f.integration }), null)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

// Injectbuddy I195: a re-planned card reused its stale, dirty worktree from the last plan.
test('an empty worktree made while the card waited is fast-forwarded to integration before the Builder starts (Injectbuddy I195)', () => {
  const f = fixture()
  try {
    const card = f.addCard('T-1')
    const first = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
    writeFileSync(join(f.integration, 'fix.js'), 'prerequisite fix\n')
    git(f.integration, 'add', 'fix.js'); git(f.integration, 'commit', '-m', 'prerequisite lands')
    const again = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: findCard(f.tasks, 'T-1'), gitSettings: f.settings })
    assert.equal(again.workspacePath, first.workspacePath, 'same checkout, dependencies kept')
    assert.equal(git(again.workspacePath, 'rev-parse', 'HEAD'), git(f.integration, 'rev-parse', 'HEAD'))
    assert.equal(readWorktrees(f.tasks)['T-1'].baseCommit, git(f.integration, 'rev-parse', 'HEAD'))
    assert.ok(existsSync(join(again.workspacePath, 'fix.js')))
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a worktree from an earlier plan is saved to a recovery branch and replaced; the same plan resumes it', () => {
  const f = fixture()
  try {
    f.addCard('T-1')
    moveCard(f.tasks, 'T-1', 'planning')
    moveCard(f.tasks, 'T-1', 'queue') // plan A
    const first = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: moveCard(f.tasks, 'T-1', 'working'), gitSettings: f.settings })
    writeFileSync(join(first.workspacePath, 'saved.js'), 'failed builder work\n')
    // Same plan, re-dispatched from Queue: the saved work is resumed in place.
    moveCard(f.tasks, 'T-1', 'queue')
    const again = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card: moveCard(f.tasks, 'T-1', 'working'), gitSettings: f.settings })
    assert.equal(again.created, false)
    assert.equal(again.workspacePath, first.workspacePath)
    // Integration moves on; the card is re-planned (plan B).
    writeFileSync(join(f.integration, 'other.js'), 'newer\n')
    git(f.integration, 'add', 'other.js')
    git(f.integration, 'commit', '-m', 'newer integration')
    moveCard(f.tasks, 'T-1', 'planning')
    moveCard(f.tasks, 'T-1', 'queue')
    const card = moveCard(f.tasks, 'T-1', 'working')
    const fresh = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
    assert.equal(fresh.created, true)
    assert.notEqual(fresh.workspacePath, first.workspacePath)
    assert.equal(existsSync(first.workspacePath), false)
    assert.equal(git(fresh.workspacePath, 'rev-parse', 'HEAD'), git(f.integration, 'rev-parse', 'HEAD'))
    assert.deepEqual(semanticDirtyFiles(fresh.workspacePath), [])
    const recovery = git(f.integration, 'branch', '--list', `recovery/${first.entry.branch}-*`, '--format=%(refname:short)')
    assert.match(recovery, /^recovery\/kanban\/t-1-/)
    assert.equal(git(f.integration, 'show', `${recovery}:saved.js`), 'failed builder work')
    assert.ok(readFileSync(card.path, 'utf8').includes(recovery))
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('an empty folder Windows kept after Git removed the worktree is cleared, not sent to Owner (Injectbuddy I238)', () => {
  const f = fixture()
  try {
    const card = f.addCard('T-1')
    const first = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
    const old = readWorktrees(f.tasks)['T-1'].worktreePath
    // What `git worktree remove` leaves when a handle holds the folder: no registration, no files.
    git(f.integration, 'worktree', 'remove', '--force', old)
    mkdirSync(join(old, 'nested'), { recursive: true })
    const again = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
    assert.ok(existsSync(join(again.workspacePath, 'app.js')))
    assert.equal(readWorktrees(f.tasks)['T-1'].worktreePath, again.workspacePath)
    assert.ok(first.workspacePath)
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('a missing worktree whose branch holds a commit is still refused, never silently replaced', () => {
  const f = fixture()
  try {
    const card = f.addCard('T-1')
    const prepared = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings })
    writeFileSync(join(prepared.workspacePath, 'app.js'), 'work\n')
    git(prepared.workspacePath, 'commit', '-am', 'T-1 work')
    git(f.integration, 'worktree', 'remove', '--force', readWorktrees(f.tasks)['T-1'].worktreePath)
    assert.throws(() => prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings }), /missing path/)
  } finally {
    rmSync(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// Injectbuddy I692: a script joined ib-calc.css into one line, then PowerShell Set-Content
// rewrote it; every card sharing the file would have conflicted.
test('formatChangeError catches whole-file rewrites and allows normal edits', () => {
  const css = Array.from({ length: 40 }, (_, i) => `.a${i} { color: red; }`).join('\n') + '\n'
  const b = s => Buffer.from(s, 'utf8')
  assert.equal(formatChangeError('x.css', b(css), b(css.replace('.a3 {', '.b3 {'))), null)
  assert.equal(formatChangeError('x.css', b(css), b(css.split('\n').slice(0, 10).join('\n'))), null, 'deleting rules is fine')
  assert.match(formatChangeError('x.css', b(css), b(css.replaceAll('\n', ' '))), /41 lines became 1/)
  assert.match(formatChangeError('x.css', b(css), b(css.replaceAll('\n', '\r\n'))), /line endings changed to CRLF/)
  assert.match(formatChangeError('x.css', b(css), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b(css)])), /byte-order mark added/)
  assert.match(formatChangeError('x.css', b(css), Buffer.from(css, 'utf16le')), /encoding changed/)
  assert.equal(formatChangeError('x.css', null, b(css)), null, 'new file')
})

test('hkb done refuses a commit that collapses a file into one line', () => {
  const f = fixture()
  try {
    const card = f.addCard('T-1')
    const wt = prepareCardWorktree({ projectPath: f.integration, tasksDir: f.tasks, card, gitSettings: f.settings }).entry.worktreePath
    moveCard(f.tasks, 'T-1', 'working')
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n'
    writeFileSync(join(wt, 'app.js'), lines); git(wt, 'add', '-A'); git(wt, 'commit', '-m', 'base lines')
    // The fixture's base commit is the worktree's start: make the 30-line file part of it.
    const entry = readWorktrees(f.tasks)['T-1']
    const tasksFile = join(f.tasks, '.board-worktrees.json')
    const all = JSON.parse(readFileSync(tasksFile, 'utf8')); all['T-1'].baseCommit = git(wt, 'rev-parse', 'HEAD'); writeFileSync(tasksFile, JSON.stringify(all))
    writeFileSync(join(wt, 'app.js'), lines.replaceAll('\n', ' ')); git(wt, 'add', '-A'); git(wt, 'commit', '-m', 'T-1 change')
    const run = spawnSync(process.execPath, [resolve('hkb.mjs'), '--tasks', f.tasks, 'done', 'T-1'], { encoding: 'utf8' })
    assert.ok(entry)
    assert.equal(run.status, 1)
    assert.match(run.stderr, /commit rewrites file format \(app\.js: 31 lines became 1\)/)
    assert.equal(findCard(f.tasks, 'T-1').column, 'working')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

// Injectbuddy I694 read "stuck" for an hour behind I693's Builder (2026-10-03): /api/stuck
// reads the holder back out of the hold text, so the two must stay in step.
test('filesBusyHolder reads the holder from an overlap hold', () => {
  assert.equal(filesBusyHolder('files busy, held by I693 — lib/calc-classes.mjs'), 'I693')
  assert.equal(filesBusyHolder('files busy, held by T-1 — app.js'), 'T-1')
  assert.equal(filesBusyHolder('slots full'), null)
  assert.equal(filesBusyHolder(undefined), null)
})
