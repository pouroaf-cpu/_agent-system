// Stop hook for board-launched Claude agents (claude-agent-settings.json).
// Nobody reads a board agent's chat, so a question or blocker left there as plain text
// stalls the card; the operator found them only by opening the chats (2026-09-27).
// Policy lives in lib/board-stop-hook.mjs, shared with the Codex Stop hook
// (scripts/codex-stop-hook.mjs); this script only gathers the Claude-specific inputs.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { agentCard, agentRole } from '../lib/ids.mjs'
import { stopHookDecision } from '../lib/board-stop-hook.mjs'

const HKB = fileURLToPath(new URL('../hkb.mjs', import.meta.url))

try {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const input = JSON.parse(raw)
  const text = readFileSync(input.transcript_path, 'utf8')
  const entries = text.split('\n').map(line => { try { return JSON.parse(line) } catch { return {} } })
  // herdr sets no agent-name env var; Claude Code records --name in the transcript. The
  // tasks dir is the --tasks of the hkb command in the agent's delivered prompt.
  const name = entries.findLast(e => e.type === 'agent-name')?.agentName
  const id = agentCard(name), role = agentRole(name)
  const tasksDir = text.match(/--tasks '([^']+)'/)?.[1]?.replaceAll('\\\\', '\\')
  const start = entries.find(e => e.timestamp)?.timestamp
  const message = input.last_assistant_message ?? entries.findLast(e => e.type === 'assistant' && e.message?.content?.some?.(c => c.type === 'text'))
    ?.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? ''
  const reason = stopHookDecision({ tasksDir, id, role, name, start, stopHookActive: input.stop_hook_active, message, hkbCommand: `node '${HKB}' --tasks '${tasksDir}'` })
  if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }))
} catch { /* fail open: the stop is allowed */ }
