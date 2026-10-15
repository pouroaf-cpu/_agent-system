// One PreToolUse and one PostToolUse hook process for each board agent tool call (audit 2026-10-16, F8:
// a Bash call started six hook processes). scripts/hooks/pre.mjs and post.mjs read the hook input once and
// call these functions, which run every guard that used to be its own process, with the same rules and
// the same blocks. Each guard fails open on its own: a guard that throws is skipped, the others still run.
import { evidencePre, evidencePost } from '../scripts/evidence-guard.mjs'
import { checkPre, checkPost } from '../scripts/check-script-guard.mjs'
import { handoffPost } from '../scripts/agent-handoff-hook.mjs'
import { runCapPost } from '../scripts/run-cap-hook.mjs'
import { hookRefusal } from '../bin/npm-guard.mjs'

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

const guard = fn => { try { return fn() } catch { return null } }
const guardAsync = async fn => { try { return await fn() } catch { return null } }

// Refusal lines for a PreToolUse input, in the order the separate hooks ran. Empty means allow.
// Every guard runs even after one refuses, as the separate hooks did in parallel.
// Matcher: Write|Edit|MultiEdit|Bash|PowerShell.
export function runPre(input) {
  const tool = input.tool_name
  const refusals = []
  if (WRITE_TOOLS.has(tool) || SHELL_TOOLS.has(tool)) refusals.push(guard(() => evidencePre(input)))
  if (tool === 'PowerShell') refusals.push(guard(() => hookRefusal(input)))
  if (SHELL_TOOLS.has(tool)) refusals.push(guard(() => checkPre(input)))
  return refusals.filter(Boolean)
}

// The hook output for a PostToolUse input: {} (silent), or the block and continue:false fields the
// separate hooks printed, merged into one object. Matcher: *.
export async function runPost(input) {
  const tool = input.tool_name
  const blocks = [], stops = []
  if (WRITE_TOOLS.has(tool) || SHELL_TOOLS.has(tool)) blocks.push(guard(() => evidencePost(input)))
  if (SHELL_TOOLS.has(tool)) {
    blocks.push(guard(() => checkPost(input)))
    stops.push(guard(() => handoffPost(input)))
  }
  stops.push(await guardAsync(() => runCapPost(input)))
  const out = {}
  const reasons = blocks.filter(Boolean)
  if (reasons.length) { out.decision = 'block'; out.reason = reasons.join(' ') }
  const stopReasons = stops.filter(Boolean).map(s => s.stopReason)
  if (stopReasons.length) { out.continue = false; out.stopReason = stopReasons.join(' ') }
  return out
}
