// Whether a board agent's last message reads as a question or a stated blocker
// left for a human, instead of routed through hkb. Shared by the Stop hooks
// (scripts/agent-stop-hook.mjs for Claude, scripts/codex-stop-hook.mjs for Codex)
// and the no-handoff recovery fallback (lib/autospawn.mjs), so "looks like a
// question" means the same thing everywhere nobody-reads-this-chat matters.
// ponytail: keyword heuristic; widen it if a real question still slips through.
const ASKS = /\?(\s|$)|\b(blocked|blocker|cannot|can't|unable to|unresolved|should I|do you want|let me know|waiting (for|on)|needs? (you|your|a decision|confirmation))\b/i
export const looksLikeAQuestion = (text) => ASKS.test(String(text ?? ''))
