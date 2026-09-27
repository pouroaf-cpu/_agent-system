// Explicit, same-session environment recovery; no Builder/Planner or new Reviewer.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findCard } from './lib/cards.mjs'
import { readWorkflow, updateWorkflow } from './lib/workflow-state.mjs'
import { appendHistory } from './lib/card-history.mjs'
import { reviewClaimFor, assertReviewInputs, updateReviewClaim } from './lib/review-claims.mjs'
import { authorizeCardRun, activeCardRun, withCardRunAssignment, bindCardRunAssignment, pausedRunEnvironment } from './lib/card-run.mjs'
import { projectEnvironment } from './lib/project-control.mjs'
import { agentList, paneRead, sessionOf } from './lib/herdr.mjs'
import { deliver } from './lib/spawn.mjs'
import { reviewerPrompt } from './lib/prompt.mjs'

export async function recoverReviewEnvironment({ project, cardId, historyId, requestId, io = { agentList, paneRead, deliver } }) {
  const configPath = process.env.KANBAN_CONFIG || fileURLToPath(new URL('./board.config.json', import.meta.url))
  const root = dirname(configPath), config = JSON.parse(readFileSync(configPath))
  if (!config.projects.includes(project) || !pausedRunEnvironment() || activeCardRun()) throw new Error('Registered paused project and no active run required')
  const tasksDir = join(config.projectsRoot, project, 'TASKS'), card = findCard(tasksDir, cardId)
  const pending = readWorkflow(tasksDir)[card.id]?.operational, claim = reviewClaimFor(root, tasksDir, card.id), environment = projectEnvironment(project)
  if (card.column !== 'review' || !card.autoReview || !pending || pending.historyId !== historyId || !/env|environment/i.test(pending.reason) || !environment || !claim?.snapshot?.path || claim.cards.length !== 1 || !claim.paneId) throw new Error('Exact operational environment hold and existing single-card review required')
  assertReviewInputs(root, tasksDir, card.id)
  const session = sessionOf(project), agents = await io.agentList(session, { ensureSession: false }), agent = agents.find(a => a.pane_id === claim.paneId)
  if (!agent || !['done', 'idle'].includes(agent.agent_status) || agents.some(a => a.agent_status === 'working') || /Pasted Content/.test(String(await io.paneRead(claim.paneId, session)).slice(-1000))) throw new Error('Reviewer must be idle with no staged prompt')
  const event = appendHistory(tasksDir, card.id, { event: 'explicit-review-environment-recovery', previous: pending, claimId: claim.id, environment, authorization: 'Operator authorized same-stage prerequisite recovery; no source changes or verdict waiver' })
  const run = authorizeCardRun({ project, cardId: card.id, autoReview: true, requestId })
  updateWorkflow(tasksDir, card.id, { operational: null, operationalResolution: { historyId: event.id, at: event.at } })
  updateReviewClaim(root, claim.id, { doneSince: null, lastSeen: Date.now() })
  await withCardRunAssignment(run, 'reviewer', async () => {
    bindCardRunAssignment(project, [card.id], 'reviewer', claim.paneId)
    const text = reviewerPrompt({ cards: [card], projectPath: claim.snapshot.path, boardRoot: fileURLToPath(new URL('.', import.meta.url)), tasksDir, reviewRoot: root, reviewClaim: claim.id, envFile: environment.path, engine: claim.engine })
    await io.deliver(claim.paneId, text + ' Same-session operational recovery only: reuse your prior rewrite and baseline findings; rerun only environment-dependent checks and resolve the evidence dispositions. Third-party requests are not themselves cookie findings: distinguish no cookies observed from approval claims, and cite configured script owners for any intentional sources. Preserve your generated report outside tracked snapshot inputs, then restore only that generated report to its pinned snapshot version before final input validation. No product source edits. Record a fresh per-criterion Reviewer evidence section and explicit verdict before the single handoff.', session, null, { engine: claim.engine })
  })
  return { runId: run.runId, paneId: claim.paneId }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [project, cardId, historyId, requestId] = process.argv.slice(2)
  console.log(await recoverReviewEnvironment({ project, cardId, historyId, requestId }))
}
