// Shared Stop-hook policy for board agents, whichever engine ran them (Claude via
// scripts/agent-stop-hook.mjs, Codex via scripts/codex-stop-hook.mjs). Board agents
// run unattended, so a question or blocker left in the chat as plain text — instead
// of routed with hkb — stalls the card until someone happens to open that pane.
// No handoff yet and the agent's last message asks or reports a blocker: block once
// and tell it to route the question with hkb. Still no handoff on the next stop: the
// excerpt goes to the manager inbox and the stop is allowed either way.
import { existsSync, readFileSync } from 'node:fs'
import { findCard } from './cards.mjs'
import { askManager, historyPath } from './card-history.mjs'
import { looksLikeAQuestion } from './agent-question.mjs'

const LANES = { p: ['planning'], b: ['working', 'issues'], r: ['review'], a: ['review'], i: ['issues'] }

// Returns a block reason string, or null to let the stop through.
export function stopHookDecision({ tasksDir, id, role, name, start, stopHookActive, message, hkbCommand }) {
  if (!id || !tasksDir || !LANES[role]?.length) return null
  let card
  try { card = findCard(tasksDir, id) } catch { return null }
  if (!LANES[role].includes(card.column)) return null
  const history = existsSync(historyPath(tasksDir, id)) ? readFileSync(historyPath(tasksDir, id), 'utf8').split('\n') : []
  const handedOff = history.some((line) => { try { const e = JSON.parse(line); return e.event === 'handoff' && (!start || e.at >= start) } catch { return false } })
  if (handedOff) return null
  if (stopHookActive) { askManager(tasksDir, card, `${name} stopped without a handoff. Its last message: ${message}`); return null }
  if (!looksLikeAQuestion(message)) return null
  return `Nobody reads this chat, so a question or blocker left here stalls ${id}. If you can answer it yourself, keep working. Otherwise route it before you stop: ${hkbCommand} owner ${id} "<the question>" sends it to the project manager; ${hkbCommand} issue ${id} "<what is wrong>" for a problem that blocks this card; ${hkbCommand} found ${id} "<finding>" for one outside it.`
}
