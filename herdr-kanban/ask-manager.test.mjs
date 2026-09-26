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
    assert.match(readFileSync(inbox, 'utf8'), /ASK Proj T-1 \(planning\): \(a\) or \(b\)\?\n$/)
  } finally { delete process.env.KANBAN_CONFIG }
})
