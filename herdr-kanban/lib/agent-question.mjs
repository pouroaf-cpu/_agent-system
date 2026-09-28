// Whether a board agent's last message reads as a question or a stated blocker
// left for a human, instead of routed through hkb. Shared by the Stop hooks
// (scripts/agent-stop-hook.mjs for Claude, scripts/codex-stop-hook.mjs for Codex)
// and the no-handoff recovery fallback (lib/autospawn.mjs), so "looks like a
// question" means the same thing everywhere nobody-reads-this-chat matters.
// ponytail: keyword heuristic; widen it if a real question still slips through.
const ASKS = /\?(\s|$)|\b(blocked|blocker|cannot|can't|unable to|unresolved|should I|do you want|let me know|waiting (for|on)|needs? (you|your|a decision|confirmation))\b/i
export const looksLikeAQuestion = (text) => ASKS.test(String(text ?? ''))

// The agent's own last message from a scraped Codex/Claude pane: the last "•"/"●"
// block that is not a tool call (those carry │ └ ⎿ output lines), minus the
// "Worked for" line and the input footer. Plain text without bullets is returned as is.
// ponytail: TUI-layout parse; update if Codex or Claude change their pane format.
export function lastAgentMessage(pane) {
  const text = String(pane ?? '').split(/\n\s*(?:─ )?Worked for |\n\s*[›>] /)[0]
  const blocks = text.split(/\n(?=[•●] )/)
  if (blocks.length < 2 && !/^[•●] /.test(text.trim())) return text.trim()
  const said = blocks.filter(b => /^[•●] /.test(b.trim()) && !/\n\s*[│└⎿]/.test(b) && !/^[•●] (Ran|Explored|Edited|Read|Search|Waited)\b/.test(b.trim()))
  return (said.at(-1) || '').trim().replace(/^[•●] /, '').replace(/\s*\n\s*/g, ' ')
}
