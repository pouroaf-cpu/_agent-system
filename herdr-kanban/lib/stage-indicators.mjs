import { existsSync, readFileSync } from 'node:fs'
import { validatePlan, currentReviewDecision } from './cards.mjs'
import { historyPath } from './card-history.mjs'
import { assertReviewInputs } from './review-claims.mjs'

function priorIssueStage(tasksDir, card) {
  const path = historyPath(tasksDir, card.id)
  if (!existsSync(path)) return null
  const moves = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { const e = JSON.parse(line); return e.event === 'transition' ? [e] : [] } catch { return [] }
  })
  for (const move of moves.reverse()) {
    if (['planning', 'review'].includes(move.from) && ['issues', 'pou', 'owner'].includes(move.to)) return move.from
    if (!['issues', 'pou', 'owner'].includes(move.from) || !['issues', 'pou', 'owner'].includes(move.to)) break
  }
  return null
}

export function stageIndicators({ tasksDir, reviewRoot, board, planners, claims, agents, workflow }) {
  const result = {}
  const byPane = new Map(agents.map(agent => [agent.pane_id, agent]))
  for (const card of Object.values(board).flat()) {
    if (card.column === 'planning') {
      const owner = planners[card.id]
      if (!owner || owner.lifecycle !== 'active') continue
      const agent = byPane.get(owner.paneId)
      if (owner.error || workflow[card.id]?.operational?.stage === 'planning' || !agent || ['blocked', 'unknown'].includes(agent.agent_status)) {
        result[card.id] = { status: 'issue', stage: 'Planner', reason: owner.error || workflow[card.id]?.operational?.reason || 'Planner session unavailable or blocked' }
      } else if (['done', 'idle'].includes(agent.agent_status) && !owner.submitted) {
        result[card.id] = { status: 'issue', stage: 'Planner', reason: 'Planner ended before receiving its plan assignment' }
      } else if (['done', 'idle'].includes(agent.agent_status)) {
        try {
          validatePlan(readFileSync(card.path, 'utf8'), { requireReadiness: true })
          result[card.id] = { status: 'passed', stage: 'Planner', reason: 'Planner finished; plan passed board checks, awaiting handoff' }
        } catch (error) {
          result[card.id] = { status: 'issue', stage: 'Planner', reason: error.message }
        }
      } else {
        result[card.id] = { status: 'working', stage: 'Planner', reason: 'Planner assigned and working' }
      }
    } else if (card.column === 'review') {
      const claim = claims.find(c => !c.closedAt && c.tasksDir === tasksDir && c.cards.includes(card.id))
      const agent = claim?.paneId && byPane.get(claim.paneId)
      const decision = currentReviewDecision(readFileSync(card.path, 'utf8'))
      if (decision?.verdict === 'PASS') {
        try {
          if (reviewRoot) assertReviewInputs(reviewRoot, tasksDir, card.id)
          result[card.id] = { status: 'passed', stage: 'Reviewer', reason: 'Review passed board checks; awaiting handoff' }
        } catch (error) {
          result[card.id] = { status: 'issue', stage: 'Reviewer', reason: error.message }
        }
      }
      else if (decision || workflow[card.id]?.operational?.stage === 'review' || claim && (claim.phase !== 'starting' && !agent || agent && ['done', 'idle', 'blocked', 'unknown'].includes(agent.agent_status))) {
        result[card.id] = { status: 'issue', stage: 'Reviewer', reason: workflow[card.id]?.operational?.reason || (decision ? `Review verdict: ${decision.verdict}` : 'Reviewer ended without a passing verdict') }
      } else if (claim) result[card.id] = { status: 'working', stage: 'Reviewer', reason: 'Reviewer assigned and working' }
    } else if (['issues', 'pou', 'owner'].includes(card.column)) {
      const stage = priorIssueStage(tasksDir, card)
      if (stage) result[card.id] = { status: 'issue', stage: stage === 'planning' ? 'Planner' : 'Reviewer', reason: `${stage === 'planning' ? 'Planning' : 'Review'} issue; see card feedback` }
    }
  }
  return result
}
