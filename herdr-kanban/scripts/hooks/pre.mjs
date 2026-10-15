// PreToolUse hook for board agents (claude-agent-settings.json and claude-planner-settings.json), matcher
// Write|Edit|MultiEdit|Bash|PowerShell. One process per tool call: runs the evidence, npm and check-script
// guards (lib/agent-hooks.mjs). A refusal from any guard prints every reason to stderr and exits 2.
// Fails open: any error means exit 0 with no output.
import { runPre } from '../../lib/agent-hooks.mjs'

try {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const refusals = runPre(JSON.parse(raw))
  if (refusals.length) { console.error(refusals.join('\n')); process.exit(2) }
} catch { /* fail open */ }
