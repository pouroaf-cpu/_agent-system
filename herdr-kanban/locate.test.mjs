// HK77: `hkb locate` prints file, line and window for every hit of every term in one run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { locateTerms, formatLocate } from './lib/locate.mjs'
import { plannerPrompt } from './lib/prompt.mjs'

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'locate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'a.txt'), 'one\nalpha here\nthree\nalpha again\n')
  writeFileSync(join(root, 'sub', 'b.txt'), 'x\nbeta and alpha\ny\n')
  const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8', windowsHide: true })
  assert.equal(git('init', '-q').status, 0)
  assert.equal(git('add', '.').status, 0)
  return root
}
const hkb = (cwd, ...args) => spawnSync(process.execPath, [resolve('hkb.mjs'), 'locate', 'T-1', ...args], { cwd, encoding: 'utf8', windowsHide: true })

test('AC1: locateTerms returns every hit of every term with its window', (t) => {
  const root = repo(t)
  const hits = locateTerms({ root, terms: ['alpha', 'beta'] })
  assert.deepEqual(hits.map(h => [h.term, h.file, h.line]), [['alpha', 'a.txt', 2], ['alpha', 'a.txt', 4], ['alpha', 'sub/b.txt', 2], ['beta', 'sub/b.txt', 2]])
  assert.deepEqual(hits[0].window, [{ line: 1, text: 'one' }, { line: 2, text: 'alpha here' }, { line: 3, text: 'three' }])
  assert.deepEqual(hits[1].window.map(w => w.line), [3, 4]) // window stops at end of file
  const text = formatLocate(hits, ['alpha', 'beta', 'gamma'])
  for (const at of ['a.txt:2', 'a.txt:4', 'sub/b.txt:2']) assert.ok(text.includes(at), at)
  assert.match(text, /# alpha: 3 hit\(s\)/)
  assert.match(text, /# gamma: no hits/)
  assert.match(text, /> 2\| alpha here/)
})

test('AC1: hkb locate prints the hits, --in limits them, no terms is a usage error', (t) => {
  const root = repo(t)
  const r = hkb(root, 'alpha', 'beta')
  assert.equal(r.status, 0, r.stderr)
  for (const at of ['a.txt:2', 'a.txt:4', 'sub/b.txt:2', '# beta: 1 hit(s)']) assert.ok(r.stdout.includes(at), at)
  const sub = hkb(root, 'alpha', '--in', 'sub')
  assert.equal(sub.status, 0, sub.stderr)
  assert.ok(sub.stdout.includes('sub/b.txt:2') && !sub.stdout.includes('a.txt:4'))
  const none = hkb(root)
  assert.equal(none.status, 1)
  assert.match(none.stdout + none.stderr, /usage: hkb locate/)
  assert.equal(hkb(root, 'alpha', '--in', '../x').status, 1)
})

test('AC2: the Planner startup prompt names the locate command', () => {
  const card = { id: 'IA999', category: 'ui', column: 'approved', path: 'C:/fake/card.md', trivial: false, title: 'Sample ui card' }
  const p = plannerPrompt({ cards: [card], projectPath: 'C:/fake/project', boardRoot: 'C:/Users/PFrew/Projects/herdr-kanban', tasksDir: null, engine: 'claude' })
  assert.match(p, / locate <ID> <term>/)
})
