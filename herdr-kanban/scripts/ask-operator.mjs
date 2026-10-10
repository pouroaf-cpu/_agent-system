// A manager's question for the operator, as a Pushover critical alert (operator, 2026-10-09).
// node herdr-kanban/scripts/ask-operator.mjs --again "<chat name>" "<the question, plain and short>"
// Only for a question asked in chat that the operator has not answered: ask in chat first, and
// page with --again when asking it the second time. Without --again nothing is sent (operator,
// 2026-10-10: "alerts for every question ... only when I haven't answered, eg asked twice").
import { critical } from '../lib/owner-alerts.mjs'
const args = process.argv.slice(2), again = args[0] === '--again'
const [chat, ...question] = again ? args.slice(1) : args
if (!chat || !question.length) { console.error('usage: ask-operator.mjs --again "<chat name>" "<question>"'); process.exit(2) }
if (!again) { console.log('not sent: ask in chat first; page only when asking an unanswered question again (--again)'); process.exit(0) }
await critical(`${chat} asks`, question.join(' '))
console.log('sent')
