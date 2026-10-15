// PostToolUse hook for board Planner and Builder agents (claude-*-settings.json).
// After hkb records a handoff nobody reads the agent's closing summary, yet that turn re-sends the
// whole conversation (Injectbuddy I1217, 174,869 tokens over Planner and Builder). Printing
// continue:false ends the Claude session right after the tool call, with no further model call.
// A refused hkb command writes no handoff event, so the agent keeps running and can retry.
// Fails open: any error means exit 0 with no output.
// The agent runs this through scripts/hooks/post.mjs, which calls handoffPost in-process.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { agentCard, agentRole } from '../lib/ids.mjs'
import { handoffRecorded } from '../lib/board-stop-hook.mjs'

// The output object to print ({ continue: false, stopReason }), or null. Throws on unreadable input.
export function handoffPost(input) {
  if (!/hkb\.mjs/.test(String(input.tool_input?.command ?? ''))) return null
  const text = readFileSync(input.transcript_path, 'utf8')
  const entries = text.split('\n').map(line => { try { return JSON.parse(line) } catch { return {} } })
  const name = entries.findLast(e => e.type === 'agent-name')?.agentName
  const id = agentCard(name), role = agentRole(name)
  const tasksDir = text.match(/--tasks '([^']+)'/)?.[1]?.replaceAll('\\\\', '\\')
  if (!['p', 'b'].includes(role) || !id || !tasksDir) return null
  // A resumed session can hold an earlier handoff of this card; only an event written during this call counts.
  const since = typeof input.duration_ms === 'number'
    ? new Date(Date.now() - input.duration_ms - 5000).toISOString()
    : entries.find(e => e.timestamp)?.timestamp
  return handoffRecorded({ tasksDir, id, since }) ? { continue: false, stopReason: `${id} handoff recorded; session ended without a summary turn` } : null
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    let raw = ''
    for await (const chunk of process.stdin) raw += chunk
    const out = handoffPost(JSON.parse(raw))
    if (out) process.stdout.write(JSON.stringify(out))
  } catch { /* fail open */ }
}
