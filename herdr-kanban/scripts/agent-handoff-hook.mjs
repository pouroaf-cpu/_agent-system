// PostToolUse hook for board Planner and Builder agents (claude-*-settings.json).
// After hkb records a handoff nobody reads the agent's closing summary, yet that turn re-sends the
// whole conversation (Injectbuddy I1217, 174,869 tokens over Planner and Builder). Printing
// continue:false ends the Claude session right after the tool call, with no further model call.
// A refused hkb command writes no handoff event, so the agent keeps running and can retry.
// Fails open: any error means exit 0 with no output.
import { readFileSync } from 'node:fs'
import { agentCard, agentRole } from '../lib/ids.mjs'
import { handoffRecorded } from '../lib/board-stop-hook.mjs'

try {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const input = JSON.parse(raw)
  if (!/hkb\.mjs/.test(String(input.tool_input?.command ?? ''))) process.exit(0)
  const text = readFileSync(input.transcript_path, 'utf8')
  const entries = text.split('\n').map(line => { try { return JSON.parse(line) } catch { return {} } })
  const name = entries.findLast(e => e.type === 'agent-name')?.agentName
  const id = agentCard(name), role = agentRole(name)
  const tasksDir = text.match(/--tasks '([^']+)'/)?.[1]?.replaceAll('\\\\', '\\')
  if (!['p', 'b'].includes(role) || !id || !tasksDir) process.exit(0)
  // A resumed session can hold an earlier handoff of this card; only an event written during this call counts.
  const since = typeof input.duration_ms === 'number'
    ? new Date(Date.now() - input.duration_ms - 5000).toISOString()
    : entries.find(e => e.timestamp)?.timestamp
  if (handoffRecorded({ tasksDir, id, since })) process.stdout.write(JSON.stringify({ continue: false, stopReason: `${id} handoff recorded; session ended without a summary turn` }))
} catch { /* fail open */ }
