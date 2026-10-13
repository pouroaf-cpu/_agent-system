// PostToolUse hook for board Planner and Builder agents (claude-*-settings.json): the per-step
// token check of lib/run-cap.mjs. It runs after every tool call, once per model turn that used a
// tool, and stops the run in the step that crossed workflowLimits.maxTokensPerRun with
// continue:false (worktree untouched). The board's poll is the backstop; this fails open: any
// error means exit 0 with no output.
import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { agentCard, agentRole } from '../lib/ids.mjs'
import { readUsage, liveRunTokens } from '../lib/request-usage.mjs'
import { maxTokensPerRun } from '../lib/workflow-limits.mjs'

try {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const input = JSON.parse(raw)
  const limit = maxTokensPerRun()
  if (limit == null) process.exit(0)
  const text = readFileSync(input.transcript_path, 'utf8')
  const name = text.split('\n').map(line => { try { return JSON.parse(line) } catch { return {} } }).findLast(e => e.type === 'agent-name')?.agentName
  const id = agentCard(name), role = { p: 'planner', b: 'builder' }[agentRole(name)]
  const tasksDir = text.match(/--tasks '([^']+)'/)?.[1]?.replaceAll('\\\\', '\\')
  if (!role || !id || !tasksDir) process.exit(0)
  const run = Object.values(readUsage(tasksDir).runs)
    .filter(r => !r.finish && !r.duplicateOf && r.role === role && r.cardIds?.length === 1 && r.cardIds[0] === id)
    .sort((a, b) => Date.parse(a.start?.at) - Date.parse(b.start?.at)).at(-1)
  const tokens = run && liveRunTokens(run, { sessionId: input.session_id })
  if (tokens == null || tokens < limit) process.exit(0)
  const { capStopRun } = await import('../lib/run-cap.mjs')
  const result = await capStopRun({ tasksDir, project: basename(dirname(tasksDir)), run, tokens, limit })
  if (result.stopped) process.stdout.write(JSON.stringify({ continue: false, stopReason: `${id} stopped: run passed maxTokensPerRun` }))
} catch { /* fail open */ }
