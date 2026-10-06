import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const reads = new Map(), directories = []
mock.module('node:fs', { namedExports: { ...fs,
  readFileSync: (path, ...args) => {
    reads.set(String(path), (reads.get(String(path)) || 0) + 1)
    return fs.readFileSync(path, ...args)
  },
  readdirSync: (path, ...args) => { directories.push(String(path)); return fs.readdirSync(path, ...args) },
} })
const { parseCard, readBoard, cycleFor, COLUMNS } = await import('./lib/cards.mjs')
const fixture = t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'card-cache-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const lane of [...COLUMNS.map(c => c.dir), 'archive']) fs.mkdirSync(join(root, lane))
  return root
}

test('card cache reads once, invalidates on mtime or size, and isolates nested data', t => {
  const root = fixture(t), path = join(root, 'queue', 'T-1.md')
  const text = '# T-1 — First\n**Builder model:** gpt-6-luna\n**Blocked by:** T-2\n\n**Needs you**\n\nAnswer me\n'
  fs.writeFileSync(path, text)
  const first = parseCard(path, 'queue'), before = reads.get(path)
  first.blockedBy.push('T-9'); first.agentSettings.working.model = 'changed'; first.ask.text = 'changed'
  const second = parseCard(path, 'planning')
  assert.equal(reads.get(path), before, 'unchanged file does not get read')
  assert.deepEqual(second.blockedBy, ['T-2'])
  assert.equal(second.agentSettings.working.model, 'gpt-6-luna')
  assert.equal(second.ask.text, 'Answer me')
  assert.equal(second.column, 'planning')
  fs.writeFileSync(path, text.replace('First', 'Other'))
  fs.utimesSync(path, new Date(), new Date(Date.now() + 2000))
  assert.equal(parseCard(path, 'queue').title, 'Other')
  assert.equal(reads.get(path), before + 1, 'mtime-only change gets read')
  const stat = fs.statSync(path)
  fs.appendFileSync(path, '\n**Build attempt** today\n')
  fs.utimesSync(path, stat.atime, stat.mtime)
  assert.equal(parseCard(path, 'queue').buildAttempts, 1)
  assert.equal(reads.get(path), before + 2, 'size-only change gets read')
})

test('live snapshots defer archive, full snapshots include it, and edits/moves appear on the next read', t => {
  const root = fixture(t), archived = join(root, 'archive', 'T-1.md')
  fs.writeFileSync(archived, '# T-1 — Old\n')
  directories.length = 0
  const board = readBoard(root)
  assert.equal(cycleFor({ id: 'T-2', blockedBy: [] }, board), false)
  assert.ok(!directories.includes(join(root, 'archive')))
  assert.equal(board.archive[0].title, 'Old')
  assert.equal(JSON.parse(JSON.stringify(board)).archive.length, 1)
  fs.writeFileSync(archived, '# T-1 — Updated\n')
  assert.equal(readBoard(root).archive[0].title, 'Updated', 'in-place archive edit is immediately visible')
  fs.renameSync(archived, join(root, 'queue', 'T-1.md'))
  const next = readBoard(root)
  assert.equal(next.queue[0].title, 'Updated')
  assert.equal(next.archive.length, 0)
})

test('column listing cache reuses unchanged directories and notices additions, removals and replacement', t => {
  const root = fixture(t), dir = join(root, 'queue'), path = join(dir, 'T-1.md')
  fs.writeFileSync(path, '# T-1 — First\n')
  const old = new Date(Date.now() - 60000); fs.utimesSync(dir, old, old) // settled: older than the 2 s same-tick window
  readBoard(root)
  const before = directories.filter(path => path === dir).length
  readBoard(root)
  assert.equal(directories.filter(path => path === dir).length, before)
  fs.writeFileSync(join(dir, 'T-2.md'), '# T-2 — Second\n')
  fs.utimesSync(dir, new Date(), new Date(Date.now() + 2000))
  assert.equal(readBoard(root).queue.length, 2)
  fs.unlinkSync(path)
  fs.utimesSync(dir, new Date(), new Date(Date.now() + 4000))
  assert.deepEqual(readBoard(root).queue.map(c => c.id), ['T-2'])
  fs.rmSync(dir, { recursive: true })
  assert.deepEqual(readBoard(root).queue, [])
  fs.mkdirSync(dir)
  fs.writeFileSync(path, '# T-1 — Replacement\n')
  assert.equal(readBoard(root).queue[0].title, 'Replacement')
})

test('a move inside the same timestamp tick is seen, even when the directory times did not change', t => {
  const root = fixture(t), dir = join(root, 'queue'), path = join(dir, 'T-1.md')
  fs.writeFileSync(path, '# T-1 — First\n')
  assert.equal(readBoard(root).queue.length, 1)
  const { atime, mtime } = fs.statSync(dir)
  fs.renameSync(path, join(root, 'working', 'T-1.md'))
  fs.utimesSync(dir, atime, mtime) // same tick: the directory looks untouched
  const board = readBoard(root)
  assert.equal(board.queue.length, 0)
  assert.equal(board.working.length, 1)
})
