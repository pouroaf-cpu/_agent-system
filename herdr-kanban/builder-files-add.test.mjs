// Item 19: hkb files --add lets a Builder add up to two missing files to ## Files when they are tracked at the
// card's base and no other unintegrated card holds them. Everything else still hands back through [planning].
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { addBuilderFiles, missingFromFiles } from './lib/cards.mjs'

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}
const cardText = (id, files, eol = '\n') => [`# ${id} — card`, '**Workflow:** card-owned', '**Workflow version:** 2', '## Files', ...files.map(f => `- \`${f}\` — the change`), '## Acceptance criteria', '- AC1: first', '## Evidence', '<!-- none -->', ''].join(eol)
const norm = p => resolve(p).replaceAll('\\', '/').toLowerCase()

// A temp project: a git repo with lib/a.mjs and lib/b.mjs tracked at the base, and a TASKS folder.
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'builder-add-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'), tasks = join(root, 'TASKS')
  mkdirSync(join(repo, 'lib'), { recursive: true })
  writeFileSync(join(repo, 'lib', 'a.mjs'), 'export const a = 1\n')
  writeFileSync(join(repo, 'lib', 'b.mjs'), 'export const b = 1\n')
  git(repo, 'init', '-q')
  git(repo, 'add', 'lib')
  git(repo, 'commit', '-q', '-m', 'base')
  const card = (id, lane, files, eol) => {
    mkdirSync(join(tasks, lane), { recursive: true })
    const path = join(tasks, lane, `${id}.md`)
    writeFileSync(path, cardText(id, files, eol))
    return path
  }
  // A registry entry for a card whose worktree is the repo itself.
  const register = (id, extra = {}) => {
    const path = join(tasks, '.board-worktrees.json')
    const all = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
    all[id] = { cardId: id, repoRoot: repo, integrationWorkspace: repo, workspacePath: repo, branch: 'b', baseCommit: 'HEAD', files: [], state: 'building', ...extra }
    writeFileSync(path, JSON.stringify(all, null, 2))
  }
  return { root, repo, tasks, card, register }
}

const hkb = (tasks, ...args) => spawnSync(process.execPath, [resolve('hkb.mjs'), '--tasks', tasks, ...args], { encoding: 'utf8', windowsHide: true })
const output = r => `${r.stdout}${r.stderr}`

test('addBuilderFiles appends marked lines after the last ## Files bullet and keeps CRLF', t => {
  const { tasks, card } = setup(t)
  const path = card('T-1', 'working', ['lib/a.mjs'], '\r\n')
  addBuilderFiles(tasks, { id: 'T-1', path }, ['lib/b.mjs'], 'the change calls b')
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\r\n')
  const at = lines.indexOf('- `lib/b.mjs` — added by Builder: the change calls b')
  assert.equal(lines[at - 1], '- `lib/a.mjs` — the change')
  assert.equal(lines[at + 1], '## Acceptance criteria')
  assert.equal(text.split('\n').length, text.split('\r\n').length, 'every line keeps CRLF')
  assert.deepEqual(missingFromFiles(text, ['lib/b.mjs']), [])
})

test('files with no flag stays read-only: FILES OK for a listed file, exit 1 with the hand-back for a missing one', t => {
  const { tasks, card } = setup(t)
  const path = card('T-1', 'working', ['lib/a.mjs'])
  const before = readFileSync(path, 'utf8')
  const ok = hkb(tasks, 'files', 'T-1', 'lib/a.mjs')
  assert.equal(ok.status, 0, output(ok))
  assert.match(ok.stdout, /FILES OK T-1/)
  const missing = hkb(tasks, 'files', 'T-1', 'lib/b.mjs')
  assert.equal(missing.status, 1, output(missing))
  assert.match(missing.stdout, /FILES MISSING T-1: lib\/b\.mjs/)
  assert.match(missing.stdout, /Hand back now, before any edit/)
  assert.equal(readFileSync(path, 'utf8'), before, 'a check without --add writes nothing')
})

test('files --add adds a tracked, unheld file to ## Files and the registry lock, then the Builder edits', t => {
  const { tasks, repo, card, register } = setup(t)
  const path = card('T-1', 'working', ['lib/a.mjs'])
  register('T-1')
  const added = hkb(tasks, 'files', 'T-1', 'lib/b.mjs', '--add', 'the change calls b')
  assert.equal(added.status, 0, output(added))
  assert.match(added.stdout, /FILES ADDED T-1: lib\/b\.mjs/)
  assert.match(readFileSync(path, 'utf8'), /- `lib\/b\.mjs` — added by Builder: the change calls b/)
  const lock = JSON.parse(readFileSync(join(tasks, '.board-worktrees.json'), 'utf8'))['T-1'].files
  assert.ok(lock.includes(norm(join(repo, 'lib', 'b.mjs'))), JSON.stringify(lock))
  const again = hkb(tasks, 'files', 'T-1', 'lib/b.mjs')
  assert.equal(again.status, 0, output(again))
  assert.match(again.stdout, /FILES OK T-1/)
})

test('files --add refuses a new file that is not tracked at the base, and writes nothing', t => {
  const { tasks, card, register } = setup(t)
  const path = card('T-1', 'working', ['lib/a.mjs'])
  register('T-1')
  const before = readFileSync(path, 'utf8')
  const r = hkb(tasks, 'files', 'T-1', 'lib/new.mjs', '--add', 'a new helper')
  assert.equal(r.status, 1, output(r))
  assert.match(r.stdout, /Not added: lib\/new\.mjs is not a tracked file/)
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('files --add refuses a file another running card holds, and names that card', t => {
  const { tasks, card, register } = setup(t)
  const path = card('T-1', 'working', ['lib/a.mjs'])
  card('T-2', 'working', ['lib/b.mjs'])
  register('T-1')
  register('T-2')
  const before = readFileSync(path, 'utf8')
  const r = hkb(tasks, 'files', 'T-1', 'lib/b.mjs', '--add', 'the change calls b')
  assert.equal(r.status, 1, output(r))
  assert.match(r.stdout, /Not added: lib\/b\.mjs is held by T-2/)
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('files --add ignores a file held only by a card that is not running (planning)', t => {
  const { tasks, card, register } = setup(t)
  const path = card('T-1', 'working', ['lib/a.mjs'])
  card('T-2', 'planning', ['lib/b.mjs'])
  register('T-1')
  register('T-2')
  const r = hkb(tasks, 'files', 'T-1', 'lib/b.mjs', '--add', 'the change calls b')
  assert.equal(r.status, 0, output(r))
  assert.match(readFileSync(path, 'utf8'), /lib\/b\.mjs` — added by Builder/)
})

test('files --add takes at most two files, and needs a reason last', t => {
  const { tasks, card, register } = setup(t)
  const path = card('T-1', 'working', ['lib/a.mjs'])
  register('T-1')
  const before = readFileSync(path, 'utf8')
  const three = hkb(tasks, 'files', 'T-1', 'lib/b.mjs', 'lib/c.mjs', 'lib/d.mjs', '--add', 'the change')
  assert.equal(three.status, 1, output(three))
  assert.match(three.stdout, /at most two files/)
  const noWhy = hkb(tasks, 'files', 'T-1', 'lib/b.mjs', '--add')
  assert.equal(noWhy.status, 1, output(noWhy))
  assert.match(output(noWhy), /usage: hkb files/)
  assert.equal(readFileSync(path, 'utf8'), before)
})
