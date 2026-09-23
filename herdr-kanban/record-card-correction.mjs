import { appendFileSync } from 'node:fs'
import { findCard, appendBuildAttempt, moveCard } from './lib/cards.mjs'
const dir='C:/Users/PFrew/Projects/herdr-kanban/TASKS'
const card=findCard(dir,'T-1')
appendBuildAttempt(card)
appendFileSync(card.path, '\n\n## Correction evidence\n\nFixed the independent review finding: pollAgents now calls agentList with ensureSession gated by positive capacity and missionAllowsProject. This retains all-session usage reconciliation and prevents paused/out-of-mission startup. Updated only the obsolete agentsForProject source-shape assertion to the equivalent agentList call; the gating assertions remain. Full existing test.mjs: 119 passed, zero failed; card-planner.test.mjs and card-usage.test.mjs pass. Logs: C:/Users/PFrew/tmp/card-workflow-full-checks.txt. Also made unmeasured orchestrator intake explicit in the card drawer instead of silently implying the agent total includes intake. Review should focus on the previously failed startup gate and this disclosure; reuse the existing live screenshots and bounded checks, avoid repeated browser-selector experiments.\n')
moveCard(dir,'T-1','review')
