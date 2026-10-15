// Prints what the archived-evidence sweep (lib/evidence-sweep.mjs) would change, card by card, with sizes.
// Dry run unless --apply is given. Live cards, audit cards and folders naming no archived card are never planned.
// Usage: node scripts/evidence-sweep.mjs <TASKS dir> [--keep-days N] [--apply]
import { resolve } from 'node:path'
import { planArchivedEvidence, applyEvidencePlan } from '../lib/evidence-sweep.mjs'

const argv = process.argv.slice(2)
const k = argv.indexOf('--keep-days')
const keepDays = k >= 0 ? Number(argv[k + 1]) : 0
const tasksDir = argv.find((a, i) => !a.startsWith('--') && (k < 0 || i !== k + 1))
if (!tasksDir || !(keepDays >= 0)) {
  console.error('usage: node scripts/evidence-sweep.mjs <TASKS dir> [--keep-days N] [--apply]')
  process.exit(2)
}
const mb = bytes => (bytes / (1024 * 1024)).toFixed(1)
const plan = planArchivedEvidence(resolve(tasksDir), { keepDays })
let total = 0
for (const card of plan.cards) {
  total += card.bytes
  console.log(`${card.id}  ${mb(card.bytes)} MB  ${card.reasons.join('; ')}`)
  for (const item of card.items) console.log(`    ${item.kind}  ${mb(item.bytes)} MB  ${item.path}`)
}
console.log(`${plan.cards.length} archived card(s), ${mb(total)} MB would be freed. Skipped: live ${plan.skipped.live}, audit ${plan.skipped.audit}, unknown ${plan.skipped.unknown}.`)
if (argv.includes('--apply')) {
  const done = applyEvidencePlan(plan)
  console.log(`changed ${done.items} item(s), ${mb(done.bytes)} MB; failed ${done.failed.length}`)
  for (const line of done.failed) console.log(`    ${line}`)
} else {
  console.log('Dry run: nothing deleted. Add --apply to change it.')
}
