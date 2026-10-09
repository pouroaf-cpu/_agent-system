import test from 'node:test'
import assert from 'node:assert/strict'
import { cardsInUse } from './lib/autospawn.mjs'

test('a live plan checker keeps its card checkout safe from the closing Planner cleanup (IA93)', () => {
  const agents = [
    { pane_id: 'p-ia93', agent_status: 'done' },
    { pane_id: 'r-ia93-2', agent_status: 'working' },
    { pane_id: 'r-ia50', agent_status: 'done' },
  ]
  const runs = {
    a: { paneId: 'p-ia93', cardIds: ['IA93'] },
    b: { paneId: 'r-ia93-2', cardIds: ['IA93'] },
    c: { paneId: 'r-ia50', cardIds: ['IA50'] },
  }
  assert.deepEqual([...cardsInUse(agents, runs, new Set(['p-ia93', 'r-ia50']))], ['IA93'])
  assert.deepEqual([...cardsInUse(agents, runs, new Set(['p-ia93', 'r-ia93-2', 'r-ia50']))], [])
})
