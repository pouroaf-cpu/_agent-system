// PostToolUse hook for board Planner and Builder agents (claude-*-settings.json): the per-step
// check of lib/run-cap.mjs. It runs after every tool call, once per model turn that used a
// tool, and stops the run in the step that crossed workflowLimits.maxTokensPerRun or
// maxStepsPerRun with continue:false (worktree untouched). Audit 2026-10-15 F4: it also ends
// the run in the step whose tool call handed the card off (the card left the run's lane):
// Planners kept working after the plan was written, 241 steps on one night's sweep. The
// board's poll is the backstop; this fails open: any error means exit 0 with no output.
// The agent runs this through scripts/hooks/post.mjs, which calls runCapPost in-process.
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { agentCard, agentRole } from '../lib/ids.mjs'
import { readUsage } from '../lib/request-usage.mjs'
import { maxTokensPerRun, maxStepsPerRun } from '../lib/workflow-limits.mjs'

const LANES = { planner: ['planning'], builder: ['working', 'issues'] }

// The output object to print ({ continue: false, stopReason }), or null. Throws on unreadable input.
export async function runCapPost(input) {
  const text = readFileSync(input.transcript_path, 'utf8')
  const name = text.split('\n').map(line => { try { return JSON.parse(line) } catch { return {} } }).findLast(e => e.type === 'agent-name')?.agentName
  const id = agentCard(name), role = { p: 'planner', b: 'builder' }[agentRole(name)]
  const tasksDir = text.match(/--tasks '([^']+)'/)?.[1]?.replaceAll('\\\\', '\\')
  if (!role || !id || !tasksDir) return null
  const { findCard } = await import('../lib/cards.mjs')
  let column = null
  try { column = findCard(tasksDir, id).column } catch { /* no live card: nothing to end */ }
  if (column && !LANES[role].includes(column)) {
    return { continue: false, stopReason: `${id} is in ${column}: the handoff is recorded, this run ends here` }
  }
  const tokenLimit = maxTokensPerRun(), stepLimit = maxStepsPerRun()
  if (tokenLimit == null && stepLimit == null) return null
  const run = Object.values(readUsage(tasksDir).runs)
    .filter(r => !r.finish && !r.duplicateOf && r.role === role && r.cardIds?.length === 1 && r.cardIds[0] === id)
    .sort((a, b) => Date.parse(a.start?.at) - Date.parse(b.start?.at)).at(-1)
  if (!run) return null
  const { capStopRun, runOverCap } = await import('../lib/run-cap.mjs')
  const over = runOverCap(run, { sessionId: input.session_id, tokenLimit, stepLimit })
  if (!over) return null
  const result = await capStopRun({ tasksDir, project: basename(dirname(tasksDir)), run, ...over })
  return result.stopped ? { continue: false, stopReason: `${id} stopped: run passed ${over.unit === 'steps' ? 'maxStepsPerRun' : 'maxTokensPerRun'}` } : null
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    let raw = ''
    for await (const chunk of process.stdin) raw += chunk
    const out = await runCapPost(JSON.parse(raw))
    if (out) process.stdout.write(JSON.stringify(out))
  } catch { /* fail open */ }
}
