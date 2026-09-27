import assert from 'node:assert/strict'
import { unmetBlockers, routeMutualHolds } from './lib/autospawn.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBoard } from './lib/cards.mjs'
const card = { blockedBy: ['T-1'] }
const completed = { id: 'T-1', column: 'completed' }
const board = { completed: [completed], archive: [], queue: [] }
assert.deepEqual(unmetBlockers(card, board), ['T-1'])
assert.deepEqual(unmetBlockers(card, board, { 'T-1': { state: 'integrated' } }), [])
board.queue.push({ id: 'T-1', column: 'queue' })
assert.deepEqual(unmetBlockers(card, board, { 'T-1': { state: 'integrated' } }), ['T-1'])
console.log('Only uniquely integrated Completed prerequisites release dependants')
const dir = mkdtempSync(join(tmpdir(), 'mutual-holds-'))
try {
  mkdirSync(join(dir, 'queue'))
  for (const id of ['T-1', 'T-2']) writeFileSync(join(dir, 'queue', `${id}.md`), `# ${id} — Test\n\n## Files\n- \`a.js\`\n`)
  assert.deepEqual(routeMutualHolds(dir, { 'T-1': 'files busy, held by T-2 — a.js', 'T-2': 'files busy, held by T-1 — a.js' }), ['T-1', 'T-2'])
  assert.equal(readBoard(dir).queue.length, 0)
  assert.equal(readBoard(dir).planning.length, 2)
} finally { rmSync(dir, { recursive: true, force: true }) }
