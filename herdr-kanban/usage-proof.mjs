import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { reconcileUsage, usageSummary } from './lib/request-usage.mjs'
const output = process.argv.includes('--live') ? 'C:/Users/PFrew/Projects/Injectbuddy/TASKS' : 'C:/Users/PFrew/tmp/usage-proof'
mkdirSync(output, { recursive:true })
if (!process.argv.includes('--live')) copyFileSync('C:/Users/PFrew/Projects/Injectbuddy/TASKS/.request-usage.json', output+'/.request-usage.json')
const agents=JSON.parse(execFileSync('C:/Users/PFrew/AppData/Local/Programs/Herdr/bin/herdr.exe',['--session','injectbuddy','agent','list'],{encoding:'utf8'})).result.agents
const all=reconcileUsage(output,agents)
// Explicit original request ownership documented in the approved REQ-024 handoff report.
const scoped = new Set(['T-33','T-38','T-47','T-60','T-71','T-81','T-87','T-89'])
for (const run of Object.values(all.runs)) {
 if (run.cardIds?.length && run.cardIds.every(id => scoped.has(id)) && Date.parse(run.start.at) >= Date.parse('2026-09-10T09:15:54Z')) {
  run.requestId='REQ-20260910-024'; run.parentRequestIds=['REQ-20260910-024'];
  run.attributionEvidence='INJECTBUDDY-ISSUE-PLANNING-REQ-20260910-024.md';
 }
}
writeFileSync(output+'/.request-usage.json',JSON.stringify(all,null,2))
const runs=Object.values(all.runs)
if (!process.argv.includes('--live')) writeFileSync(output+'/result.json',JSON.stringify(runs,null,2))
console.log(JSON.stringify(runs.map(r=>({name:r.name,status:r.status,session:r.sessionId,total:r.delta?.total,duplicate:!!r.duplicateOf}))))
