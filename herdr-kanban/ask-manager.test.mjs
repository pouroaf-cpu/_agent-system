import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeCurrentFeedback } from './lib/card-history.mjs'

test('a Needs you question goes to the project manager inbox, other feedback does not', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-'))
  const tasks = join(root, 'Proj', 'TASKS'), inbox = join(root, 'inbox', 'Proj-INBOX.md')
  mkdirSync(join(tasks, 'planning'), { recursive: true })
  const card = { id: 'T-1', path: join(tasks, 'planning', 'T-1-x.md') }
  writeFileSync(card.path, '# T-1 x\n')
  writeFileSync(join(root, 'board.config.json'), JSON.stringify({ projectsRoot: root, projects: ['Proj'], projectSettings: { Proj: { manager: { chat: 'Proj chat', inbox } } } }))
  process.env.KANBAN_CONFIG = join(root, 'board.config.json')
  try {
    writeCurrentFeedback(tasks, card, 'Kicked back', 'fix the test')
    assert.equal(existsSync(inbox), false)
    writeCurrentFeedback(tasks, card, 'Needs you', 'Needs you: (a) or (b)?')
    assert.match(readFileSync(inbox, 'utf8'), /^- AS \d{5,} .* ASK Proj T-1 \(planning\): \(a\) or \(b\)\?\n$/)
  } finally { delete process.env.KANBAN_CONFIG }
})

// Audit 2026-10-15 F9: a [board] issue already flags the Kanban Manager with its BOARD line;
// the Needs-you note stays on the card without a second ASK line.
test('a Needs you note written with ask: false stays on the card and writes no inbox line', () => {
  const root = mkdtempSync(join(tmpdir(), 'ask-board-'))
  const tasks = join(root, 'Proj', 'TASKS'), inbox = join(root, 'inbox', 'Proj-INBOX.md')
  mkdirSync(join(tasks, 'planning'), { recursive: true })
  const card = { id: 'T-1', path: join(tasks, 'planning', 'T-1-x.md') }
  writeFileSync(card.path, '# T-1 x\n')
  writeFileSync(join(root, 'board.config.json'), JSON.stringify({ projectsRoot: root, projects: ['Proj'], projectSettings: { Proj: { manager: { chat: 'Proj chat', inbox } } } }))
  process.env.KANBAN_CONFIG = join(root, 'board.config.json')
  try {
    writeCurrentFeedback(tasks, card, 'Needs you', '[board] plan check demands an AC3 FAIL line', { ask: false })
    assert.equal(existsSync(inbox), false)
    assert.match(readFileSync(card.path, 'utf8'), /^## Current feedback\nNeeds you: \[board\] plan check demands an AC3 FAIL line/m)
  } finally { delete process.env.KANBAN_CONFIG }
})

// Overnight 15-16 Oct 2026: I1339 got the same "Approve the investigation" question four times in six minutes.
// The same question on the same card is one ASK until its text changes; a different card or question is still asked.
test('the same Needs you question on the same card is asked once; a changed question or another card is asked', async () => {
  const { askManager } = await import('./lib/card-history.mjs')
  const root = mkdtempSync(join(tmpdir(), 'ask-once-'))
  const tasks = join(root, 'Proj', 'TASKS'), inbox = join(root, 'inbox', 'Proj-INBOX.md')
  mkdirSync(join(tasks, 'owner'), { recursive: true })
  const card = { id: 'I1339', path: join(tasks, 'owner', 'I1339-x.md') }
  writeFileSync(card.path, '# I1339 x\n')
  writeFileSync(join(root, 'board.config.json'), JSON.stringify({ projectsRoot: root, projects: ['Proj'], projectSettings: { Proj: { manager: { chat: 'Proj chat', inbox } } } }))
  process.env.KANBAN_CONFIG = join(root, 'board.config.json')
  try {
    const question = 'Approve the investigation for I1339? The plan is ready.'
    for (let i = 0; i < 4; i++) askManager(tasks, card, `Needs you: ${question}`)
    assert.equal(readFileSync(inbox, 'utf8').split('\n').filter(l => l.includes('ASK Proj I1339')).length, 1)
    askManager(tasks, card, 'Needs you: Approve the investigation for I1339? The plan changed.')
    askManager(tasks, { ...card, id: 'I1340' }, `Needs you: ${question}`)
    assert.equal(readFileSync(inbox, 'utf8').split('\n').filter(l => l.includes('ASK Proj')).length, 3)
  } finally { delete process.env.KANBAN_CONFIG }
})
