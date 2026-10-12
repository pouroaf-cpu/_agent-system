import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, appendFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCard } from './lib/cards.mjs'
import { appendHistory, writeCurrentFeedback, historyPath } from './lib/card-history.mjs'
import { updateWorkflow } from './lib/workflow-state.mjs'
import { runCardPlanner, amendment } from './lib/card-planner.mjs'

// Token audit 2026-10-12, finding 8: amend mode fired in 0 of 461 real sessions because the
// old test required every clause to mention a section (including "Check", which amend mode
// never edits) and an action word. amendment() now reads the note as a whole.
test('amendment() returns amend mode for a note naming one missing file (F8 AC1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amendment-ac1-'))
  try {
    const card = createCard(dir, { title: 'Existing plan', brief: 'Keep the approved outcome' })
    updateWorkflow(dir, card.id, { correction: { category: 'planning', note: '[planning] Add missing fixtures.json to ## Files' } })
    appendHistory(dir, card.id, { event: 'transition', from: 'working', to: 'planning' })
    assert.equal(amendment(dir, { ...card, column: 'planning' }), '[planning] Add missing fixtures.json to ## Files')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('amendment() returns a full plan (null) for a note mentioning acceptance criteria or behaviour (F8 AC2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amendment-ac2-'))
  try {
    const card = createCard(dir, { title: 'Existing plan', brief: 'Keep the approved outcome' })
    updateWorkflow(dir, card.id, { correction: { category: 'planning', note: '[planning] Add output.json to Files and change acceptance criteria' } })
    appendHistory(dir, card.id, { event: 'transition', from: 'working', to: 'planning' })
    assert.equal(amendment(dir, { ...card, column: 'planning' }), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Builder planning returns amend only Files/Prerequisites; other returns fully re-plan', async () => {
  for (const [note, amend, from = 'working', category = 'planning'] of [
    ['[planning] Add generated output.json to ## Files', true],
    // F8: "Check" is no longer a section amend mode edits; a note naming only Check gets a full plan.
    ['[planning] Correct the Check command to node test.mjs', false],
    ['[planning] Prerequisites names missing fixtures.json', true],
    ['[planning] Add output.json to Files; correct Check command', true],
    ['[planning] Redesign the implementation', false],
    ['[planning] Add output.json to Files and change acceptance criteria', false],
    ['[planning] Check fails because the implementation plan is wrong', false],
    ['[planning] Add output.json to Files', false, 'review'],
    ['[implementation] Add output.json to Files', false, 'working', 'implementation'],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'planner-amend-'))
    try {
      const card = createCard(dir, { title: 'Existing plan', brief: 'Keep the approved outcome' })
      appendFileSync(card.path, '\n## Implementation plan\nKeep this exact step.\nCheck: node old.mjs\n')
      updateWorkflow(dir, card.id, { correction: { category, note } })
      appendHistory(dir, card.id, { event: 'transition', from, to: 'planning' })
      writeCurrentFeedback(dir, card, 'Kicked back', note)
      const before = readFileSync(card.path, 'utf8')
      const starts = [], prompts = [], agents = []
      const io = {
        agentList: async () => agents, agentWorkspaceOr: async () => 'w', waitForPrompt: async () => {},
        tabCreate: async () => ({ root_pane: { pane_id: 'amend-1' } }),
        agentStart: async args => { starts.push(args); agents.push({ name: args.name, pane_id: args.paneId, agent_status: 'idle' }) },
        deliver: async (pane, text) => { prompts.push(text) }, paneClose: async () => {},
        recordUsageStart: () => {}, recordUsageFinish: async () => {},
      }
      await runCardPlanner({ project: 'Amend', projectPath: dir, tasksDir: dir, boardRoot: dir,
        assignmentForCard: () => ({ engine: 'codex', model: 'gpt-6-sol', reasoning: 'high' }), io })
      assert.equal(prompts.length, 1, note)
      assert.equal(prompts[0].includes('Amend mode:'), amend, note)
      assert.deepEqual(starts[0].engine.reasoningArgs, ['-c', `model_reasoning_effort="${amend ? 'low' : 'high'}"`], note)
      if (amend) {
        assert.ok(prompts[0].includes(note))
        assert.match(prompts[0], /Edit only ## Files and ## Prerequisites/)
        assert.doesNotMatch(prompts[0], /Read .*PLANNER-CODE/)
        const brief = readFileSync(join(dir, '.briefs', `${card.id}-planner.md`), 'utf8')
        assert.doesNotMatch(brief, /Keep this exact step/, 'the brief no longer repeats the plan; the card itself still carries it')
        assert.match(brief, /## Current feedback/)
        assert.match(before, /Keep this exact step/, 'the card the amend Planner reads directly still has it')
      } else assert.match(prompts[0], /Plan these approved cards/)
      assert.equal(readFileSync(card.path, 'utf8'), before)
      // F8 AC3: each decision writes a history event naming the mode chosen.
      if (category === 'planning' && from === 'working') {
        const history = readFileSync(historyPath(dir, card.id), 'utf8').trim().split('\n').map(l => JSON.parse(l))
        assert.ok(history.some(e => e.event === 'planner-amend-decision' && e.mode === (amend ? 'amend' : 'full')), note)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})
