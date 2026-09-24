import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { prepareReviewSnapshot } from './lib/review-claims.mjs'
import { cleanClosedReviewSnapshots } from './lib/review-snapshots.mjs'

const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout

test('a closed claim snapshot is removed with its evidence kept; an open one stays', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-snap-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  mkdirSync(join(project, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(project, 'node_modules', 'dep', 'package.json'), '{}')
  writeFileSync(join(project, 'package.json'), '{"dependencies":{"dep":"1"}}')
  writeFileSync(join(project, '.gitignore'), 'node_modules/\n.next/\n')
  writeFileSync(join(project, 'app.js'), 'base\n')
  git(project, 'init'); git(project, 'add', '.'); git(project, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'base')

  const closed = prepareReviewSnapshot(root, project, 'closed-claim').path
  const open = prepareReviewSnapshot(root, project, 'open-claim').path
  assert.ok(existsSync(join(closed, 'node_modules', 'dep', 'package.json')), 'junction to the live dependencies')
  mkdirSync(join(closed, 'evidence')); writeFileSync(join(closed, 'evidence', 'T-1.log'), 'passed')
  mkdirSync(join(closed, '.next')); writeFileSync(join(closed, '.next', 'cache.bin'), 'x')
  writeFileSync(join(closed, 'app.js'), 'reviewer edit\n')
  const claim = (id, closedAt) => ({ id, project: 'P', tasksDir: join(root, 'TASKS'), cards: ['T-1'], createdAt: 1, ...(closedAt ? { closedAt } : {}) })
  writeFileSync(join(root, '.review-claims.json'), JSON.stringify({ version: 1, claims: [claim('closed-claim', 2), claim('open-claim')] }))

  const logs = []
  const results = await cleanClosedReviewSnapshots(root, (c, message) => logs.push(message))
  assert.deepEqual(results.map(r => r.claimId), ['closed-claim'], logs.join('\n'))
  assert.ok(!existsSync(closed))
  assert.ok(existsSync(join(open, 'app.js')), 'open claim snapshot untouched')
  assert.ok(existsSync(join(project, 'node_modules', 'dep', 'package.json')), 'live dependencies untouched')
  const kept = join(root, 'review-evidence', 'closed-claim')
  assert.equal(readFileSync(join(kept, 'evidence', 'T-1.log'), 'utf8'), 'passed')
  assert.match(readFileSync(join(kept, 'diff.patch'), 'utf8'), /\+reviewer edit/)
  assert.ok(!existsSync(join(kept, '.next')), 'build output is not evidence')
  assert.doesNotMatch(git(project, 'worktree', 'list'), /closed-claim/)
})
