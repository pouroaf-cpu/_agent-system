// A manager's question for the operator, as a Pushover critical alert (operator, 2026-10-09).
// node herdr-kanban/scripts/ask-operator.mjs "<chat name>" "<the question, plain and short>"
import { critical } from '../lib/owner-alerts.mjs'
const [chat, ...question] = process.argv.slice(2)
if (!chat || !question.length) { console.error('usage: ask-operator.mjs "<chat name>" "<question>"'); process.exit(2) }
await critical(`${chat} asks`, question.join(' '))
console.log('sent')
