// Tally of plan-check FAILs by issue tag, so the commonest plan mistakes get fixed at the
// Planner (operator, 2026-10-09). node scripts/plan-check-issues.mjs [days=7]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = 'C:/Users/PFrew/KanbanProjects', since = Date.now() - (Number(process.argv[2]) || 7) * 864e5
const fails = []
for (const project of readdirSync(root)) {
  const dir = join(root, project, 'TASKS', '.history')
  if (!existsSync(dir)) continue
  for (const file of readdirSync(dir)) for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
    if (!line.includes('"plan-check"') || !line.includes('"FAIL"')) continue
    const e = JSON.parse(line)
    if (Date.parse(e.at) >= since) fails.push({ project, card: file.replace(/\.jsonl$/, ''), issue: e.issue || 'untagged', reason: e.reason })
  }
}
const counts = Object.entries(Object.groupBy(fails, (f) => f.issue)).sort((a, b) => b[1].length - a[1].length)
console.log(`${fails.length} plan-check FAILs`)
for (const [issue, list] of counts) {
  console.log(`\n${issue}: ${list.length}`)
  for (const f of list.slice(-3)) console.log(`  ${f.project} ${f.card}: ${f.reason.replace(/^Plan check: /, '').replace(/\s+/g, ' ').slice(0, 160)}`)
}
