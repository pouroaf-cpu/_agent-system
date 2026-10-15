// Pre/Post tool hook for board agents (claude-agent-settings.json and claude-planner-settings.json).
// Keeps TASKS/.evidence/<card> to logs and summaries (lib/evidence-guard.mjs, 2026-10-16: 12.4 GB, C: full twice).
// --pre refuses a Write or Edit into a cache folder or a Write over the file cap, and a shell command that copies
// node_modules or .next into evidence. It also records when the command started.
// --post cuts an over-cap file, and deletes a cache folder, that the command wrote into the card's evidence.
// Files that were already there are never touched. Fails open: any error means exit 0 with no output.
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cardContext, commandRefusal, overCapFiles, settleCommandOutput, writeRefusal } from '../lib/evidence-guard.mjs'

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

try {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const input = JSON.parse(raw)
  const key = [input.session_id, input.tool_use_id ?? ''].map(s => String(s).replace(/[^\w-]/g, '_')).join('-')
  const snap = join(tmpdir(), `evidence-guard-${createHash('sha1').update(key).digest('hex')}.json`)
  const tool = input.tool_name, toolInput = input.tool_input || {}
  if (process.argv.includes('--pre')) {
    const refusal = WRITE_TOOLS.has(tool) ? writeRefusal({ path: toolInput.file_path, content: toolInput.content })
      : SHELL_TOOLS.has(tool) ? commandRefusal(toolInput.command) : null
    if (refusal) { console.error(refusal); process.exit(2) }
    const ctx = cardContext(input.transcript_path)
    if (ctx) { const folder = join(ctx.tasksDir, '.evidence', ctx.id); writeFileSync(snap, JSON.stringify({ folder, startedAt: Date.now(), existing: overCapFiles(folder) })) }
  } else if (process.argv.includes('--post')) {
    let before
    try { before = JSON.parse(readFileSync(snap, 'utf8')) } catch { process.exit(0) }
    rmSync(snap, { force: true })
    const notes = settleCommandOutput(before)
    if (notes.length) process.stdout.write(JSON.stringify({ decision: 'block', reason: `Evidence limit: ${notes.join(' ')}` }))
  }
} catch { /* fail open */ }
