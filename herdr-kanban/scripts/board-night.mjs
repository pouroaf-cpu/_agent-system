// Night stop (operator 2026-10-05): `off` sets the board-wide agent cap to 0 (every project
// reads as paused, running agents finish, no stall alerts); `on` restores the saved cap.
// Run by the BoardNightOff / BoardMorningOn scheduled tasks.
// ponytail: a project Pause/Start overnight marks every project paused (project-control.mjs
// migration); `on` then only lifts the cap, so those projects need a Start by hand.
import { readFileSync } from 'node:fs'

const mode = process.argv[2]
if (!['on', 'off'].includes(mode)) { console.error('usage: board-night.mjs on|off'); process.exit(2) }
const config = JSON.parse(readFileSync(new URL('../board.config.json', import.meta.url), 'utf8'))
if (mode === 'on' && config.maxConcurrentAgents !== 0) { console.log(`already on (cap ${config.maxConcurrentAgents})`); process.exit(0) }
const cap = mode === 'off' ? 0 : config.resumeMaxConcurrentAgents || 5
const res = await fetch('http://127.0.0.1:7777/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxConcurrentAgents: cap }) })
console.log(`${new Date().toISOString()} board ${mode}: cap ${cap}, HTTP ${res.status}`)
if (!res.ok) process.exit(1)
