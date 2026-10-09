import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

// IA97 (app) waits on web card I966 (operator 2026-10-09): Blocked by may name another board's card.
const root = mkdtempSync(join(tmpdir(), 'cross-board-'))
process.env.KANBAN_CONFIG = join(root, 'board.config.json')
writeFileSync(process.env.KANBAN_CONFIG, JSON.stringify({ projects: ['Web', 'App'], projectsRoot: root, cardPrefixes: { Web: 'W', App: 'A' } }))
const { createCard, readBoard, waitingOnPrerequisites, unmetBlockers } = await import('./lib/cards.mjs')

test('a card blocked by another board\'s card waits until that card lands', () => {
  try {
    const web = join(root, 'Web', 'TASKS'), app = join(root, 'App', 'TASKS')
    mkdirSync(web, { recursive: true }); mkdirSync(app, { recursive: true })
    const w = createCard(web, { title: 'Migration', brief: 'x', prefix: 'W' })
    assert.throws(() => createCard(app, { title: 'Bad', brief: 'x', prefix: 'A', blockedBy: ['W9'] }), /names no card/)
    const a = createCard(app, { title: 'Uses it', brief: 'x', prefix: 'A', blockedBy: [w.id] })
    assert.deepEqual(waitingOnPrerequisites(a, readBoard(app)), [w.id])
    mkdirSync(join(web, 'archive')); renameSync(w.path, join(web, 'archive', basename(w.path)))
    assert.deepEqual(unmetBlockers(a, readBoard(app)), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
