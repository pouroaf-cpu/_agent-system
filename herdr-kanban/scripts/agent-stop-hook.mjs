// Stop hook for board-launched Claude agents (claude-agent-settings.json).
// Nobody reads a board agent's chat, so a question or blocker left there as plain text
// stalls the card; the operator found them only by opening the chats (2026-09-27).
// No handoff yet and the last message asks or reports a blocker: block once and tell the
// agent to route it with hkb. Still no handoff on the next stop: the excerpt goes to the
// manager inbox and the stop is allowed. Any error allows the stop.
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { findCard } from '../lib/cards.mjs'
import { askManager, historyPath } from '../lib/card-history.mjs'
import { agentCard, agentRole } from '../lib/ids.mjs'

const LANES = { p: ['planning'], b: ['working', 'issues'], r: ['review'], a: ['review'], i: ['issues'] }
// ponytail: keyword heuristic; widen it if questions still slip through.
const ASKS = /\?(\s|$)|\b(blocked|blocker|cannot|can't|unable to|unresolved|should I|do you want|let me know|waiting (for|on)|needs? (you|your|a decision|confirmation))\b/i
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
  if (id && tasksDir) {
    const card = findCard(tasksDir, id)
    const start = entries.find(e => e.timestamp)?.timestamp
    const history = existsSync(historyPath(tasksDir, id)) ? readFileSync(historyPath(tasksDir, id), 'utf8').split('\n') : []
    const handedOff = history.some(line => { try { const e = JSON.parse(line); return e.event === 'handoff' && e.at >= start } catch { return false } })
    const message = input.last_assistant_message ?? entries.findLast(e => e.type === 'assistant' && e.message?.content?.some?.(c => c.type === 'text'))
      ?.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? ''
    if (!handedOff && LANES[role]?.includes(card.column)) {
      if (input.stop_hook_active) askManager(tasksDir, card, `${name} stopped without a handoff. Its last message: ${message}`)
      else if (ASKS.test(message)) {
        const hkb = `node '${HKB}' --tasks '${tasksDir}'`
        process.stdout.write(JSON.stringify({ decision: 'block', reason: `Nobody reads this chat, so a question or blocker left here stalls ${id}. If you can answer it yourself, keep working. Otherwise route it before you stop: ${hkb} owner ${id} "<the question>" sends it to the project manager; ${hkb} issue ${id} "<what is wrong>" for a problem that blocks this card; ${hkb} found ${id} "<finding>" for one outside it.` }))
      }
    }
  }
} catch { /* fail open: the stop is allowed */ }
