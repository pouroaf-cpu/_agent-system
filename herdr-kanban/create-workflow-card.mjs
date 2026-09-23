import { createCard, moveCard } from './lib/cards.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
const dir = 'C:/Users/PFrew/Projects/herdr-kanban/TASKS'
mkdirSync(dir, { recursive: true })
const card = createCard(dir, { title: 'Card-owned planning, lifecycle and token accountability', brief: 'Approved by the user on 11 September 2026. The orchestrator creates a card after agreed intake; the board assigns a dedicated Planner automatically. Planned proceeds to Queue, fresh Builder, Completed, independent Review and Archive; Issues return to the original Planner. Keep the Planner idle until archive, then close its pane while preserving history and evidence. Capture actual per-run usage once, show per-card totals and expandable agent/model/start/finish/uncached/cached/output details. Exclude unverified attribution. Include orchestrator intake only when measurable; never invent historical counters. Use the card instead of a separate Tasks request. User explicitly assigned implementation to the orchestrator directly. Validate normal and correction paths and live activation before marking complete.' })
moveCard(dir, card.id, 'working')
writeFileSync('C:/Users/PFrew/tmp/card-workflow-current.json', JSON.stringify({ id: card.id, project: 'herdr-kanban' }))
console.log(card.id)
