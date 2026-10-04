import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, appendFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCard } from './lib/cards.mjs'
import { appendHistory, writeCurrentFeedback } from './lib/card-history.mjs'
import { updateWorkflow } from './lib/workflow-state.mjs'
import { runCardPlanner } from './lib/card-planner.mjs'

test('Builder planning returns amend only Files/Check/Prerequisites; other returns fully re-plan', async () => {
  for (const [note, amend, from = 'working', category = 'planning'] of [
    ['[planning] Add generated output.json to ## Files', true],
    ['[planning] Correct the Check command to node test.mjs', true],
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
        assert.match(prompts[0], /Edit only ## Files, the Check lines and ## Prerequisites/)
        assert.doesNotMatch(prompts[0], /Read .*PLANNER-CODE/)
        assert.match(readFileSync(join(dir, '.briefs', `${card.id}-planner.md`), 'utf8'), /Keep this exact step/)
      } else assert.match(prompts[0], /Plan these approved cards/)
      assert.equal(readFileSync(card.path, 'utf8'), before)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})
