#!/usr/bin/env node
// Maintenance CLI only, never called by scheduler/agents or exposed as a web API.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { findCard, moveCard } from './lib/cards.mjs'
import { readWorktrees } from './lib/worktrees.mjs'
import { withBoardLock } from './lib/bindings.mjs'
import { appendHistory } from './lib/card-history.mjs'
import { activeCardRun, pausedRunEnvironment } from './lib/card-run.mjs'
import { isCardId } from './lib/ids.mjs'
const [project, cardId, report, ...words] = process.argv.slice(2)
const config = JSON.parse(readFileSync(process.env.KANBAN_CONFIG || fileURLToPath(new URL('./board.config.json', import.meta.url)), 'utf8'))
if (!config.projects.includes(project) || !isCardId(cardId || '') || !report || !words.length) throw new Error('Usage: node operator-complete.mjs PROJECT T-ID absolute-report.json "explicit user authorization"')
if (!pausedRunEnvironment() || activeCardRun()) throw new Error('Paused zero-capacity maintenance with no active run required')
const tasksDir = join(config.projectsRoot, project, 'TASKS'), evidencePath = resolve(report)
if (!evidencePath.startsWith(resolve(tasksDir, 'reports') + sep)) throw new Error('Evidence must be in this project TASKS/reports')
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex')
withBoardLock(tasksDir, () => {
  const card = findCard(tasksDir, cardId), work = readWorktrees(tasksDir)[cardId]
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  if (card.column !== 'completed' || !card.cardOwned || work?.state !== 'integrated' || !work.commit) throw new Error('Requires completed implementation and successful integration receipt')
  if (evidence.cardId !== card.id || evidence.status !== 'SELF-VERIFIED' || evidence.independentReview !== 'WAIVED BY USER' || !evidence.checks?.length || evidence.checks.some(c => c.status !== 'PASS')) throw new Error('Complete self-verification and explicit independent-review waiver required')
  const receipt = { kind: 'explicit-user-review-waiver', at: new Date().toISOString(), authorization: words.join(' '), commit: work.commit, cardHash: hash(card.path), evidencePath, evidenceHash: hash(evidencePath) }
  appendHistory(tasksDir, cardId, { event: 'operator-completion', ...receipt, text: readFileSync(card.path, 'utf8'), independentReview: 'not performed; explicitly waived by user' })
  const path = join(tasksDir, '.operator-completions.json'), all = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  all[cardId] = receipt; writeFileSync(path + '.tmp', JSON.stringify(all, null, 2)); renameSync(path + '.tmp', path)
  console.log(JSON.stringify({ cardId, column: moveCard(tasksDir, cardId, 'archive').column, independentReview: 'WAIVED BY USER', commit: work.commit }))
})
