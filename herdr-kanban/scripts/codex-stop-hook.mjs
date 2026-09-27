// Stop hook for board-launched Codex agents. Registered per card, not globally: each
// card runs in its own disposable git worktree (lib/worktrees.mjs), and
// writeCodexWorkspaceHooks (lib/herdr.mjs) drops this hook into that worktree's own
// .codex/hooks.json before the agent starts. The operator's own Codex chats never cd
// into a card worktree, so this never runs for them; ~/.codex/hooks.json and
// ~/.codex/config.toml are untouched (confirmed empirically: a board.config.toml
// profile's hooks.state can only enable/disable a hook already discovered elsewhere,
// not define a new one, 2026-09-27).
//
// Same policy as the Claude Stop hook (scripts/agent-stop-hook.mjs), shared via
// lib/board-stop-hook.mjs. Codex's Stop hook input already carries
// last_assistant_message directly, so only the card id, role and tasks dir still
// come from regexing the rollout transcript at transcript_path — the same way the
// Claude hook regexes --tasks out of its own transcript (prompt.mjs builds the same
// hkb command either way).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stopHookDecision } from '../lib/board-stop-hook.mjs'

const HKB = fileURLToPath(new URL('../hkb.mjs', import.meta.url))
const ROLE_FILES = { b: 'BUILDER.md', p: 'PLANNER.md', r: 'REVIEWER.md', a: 'AUDITOR-CARD-WORKFLOW.md' }
const VERB_ID = /\b(?:unchanged|done|issue|owner|move|pass|rework|wait|audit)\s+([A-Za-z]{1,3}-?\d+)\b/

try {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const input = JSON.parse(raw)
  const text = readFileSync(input.transcript_path, 'utf8')
  const tasksDir = text.match(/--tasks '([^']+)'/)?.[1]?.replaceAll('\\\\', '\\')
  const role = Object.entries(ROLE_FILES).find(([, file]) => text.includes(file))?.[0] ?? null
  const id = VERB_ID.exec(text)?.[1]?.toUpperCase() ?? null
  const start = text.match(/"timestamp":"([^"]+)"/)?.[1]
  const reason = stopHookDecision({
    tasksDir, id, role, name: id && role ? `${role}-${id.toLowerCase()}` : role, start,
    stopHookActive: input.stop_hook_active, message: input.last_assistant_message || '',
    hkbCommand: `node '${HKB}' --tasks '${tasksDir}'`,
  })
  if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }))
} catch { /* fail open: the stop is allowed */ }
