#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reconcilePlannerAssignment } from './lib/planner-state.mjs'
const [project, cardId, mode, ...words] = process.argv.slice(2)
if (!project || !/^T-\d+$/.test(cardId || '') || !['retire', 'recover'].includes(mode) || !words.length) throw new Error('Usage: node planner-reconcile.mjs PROJECT T-ID retire|recover "specific reason"')
const config = JSON.parse(readFileSync(process.env.KANBAN_CONFIG || fileURLToPath(new URL('./board.config.json', import.meta.url)), 'utf8'))
const result = await reconcilePlannerAssignment({ project, cardId, tasksDir: join(config.projectsRoot, project, 'TASKS'), recovery: mode === 'recover', reason: words.join(' ') })
console.log(JSON.stringify({ project, cardId, lifecycle: result.lifecycle, recoveryReady: result.recoveryReady, history: result.reconciliationHistoryId, paneId: result.paneId }))
