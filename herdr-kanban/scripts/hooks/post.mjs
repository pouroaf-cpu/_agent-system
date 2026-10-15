// PostToolUse hook for board agents (claude-agent-settings.json and claude-planner-settings.json), matcher *.
// One process per tool call: runs the evidence, check-script, handoff and run-cap guards (lib/agent-hooks.mjs)
// and prints one JSON object with their decision/reason and continue/stopReason fields. Silent when none fire.
// Fails open: any error means exit 0 with no output.
import { runPost } from '../../lib/agent-hooks.mjs'

try {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const out = await runPost(JSON.parse(raw))
  if (Object.keys(out).length) process.stdout.write(JSON.stringify(out))
} catch { /* fail open */ }
