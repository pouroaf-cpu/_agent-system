// Pre/Post tool guard for board agents (claude-agent-settings.json and claude-planner-settings.json).
// Keeps TASKS/.evidence/<card> to logs and summaries (lib/evidence-guard.mjs, 2026-10-16: 12.4 GB, C: full twice).
// --pre refuses a Write or Edit into a cache folder or a Write over the file cap, and a shell command that copies
// node_modules or .next into evidence. It also records when the command started.
// --post cuts an over-cap file, and deletes a cache folder, that the command wrote into the card's evidence.
// Files that were already there are never touched. Fails open: any error means exit 0 with no output.
// The agent runs this through scripts/hooks/pre.mjs and post.mjs, which call evidencePre and evidencePost
// in-process (one hook process per tool call). Run directly with --pre or --post it behaves as before.
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cardContext, commandRefusal, overCapFiles, settleCommandOutput, writeRefusal } from '../lib/evidence-guard.mjs'

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

const snapshotPath = input => {
  const key = [input.session_id, input.tool_use_id ?? ''].map(s => String(s).replace(/[^\w-]/g, '_')).join('-')
  return join(tmpdir(), `evidence-guard-${createHash('sha1').update(key).digest('hex')}.json`)
}

// The refusal text for a pre-tool call, or null. Records the card's evidence state for the post call.
export function evidencePre(input) {
  const tool = input.tool_name, toolInput = input.tool_input || {}
  const refusal = WRITE_TOOLS.has(tool) ? writeRefusal({ path: toolInput.file_path, content: toolInput.content })
    : SHELL_TOOLS.has(tool) ? commandRefusal(toolInput.command) : null
  if (refusal) return refusal
  const ctx = cardContext(input.transcript_path)
  if (ctx) {
    const folder = join(ctx.tasksDir, '.evidence', ctx.id)
    writeFileSync(snapshotPath(input), JSON.stringify({ folder, startedAt: Date.now(), existing: overCapFiles(folder) }))
  }
  return null
}

// The block reason for a post-tool call, or null. Throws when no pre snapshot exists (the caller fails open).
export function evidencePost(input) {
  const snap = snapshotPath(input)
  const before = JSON.parse(readFileSync(snap, 'utf8'))
  rmSync(snap, { force: true })
  const notes = settleCommandOutput(before)
  return notes.length ? `Evidence limit: ${notes.join(' ')}` : null
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    let raw = ''
    for await (const chunk of process.stdin) raw += chunk
    const input = JSON.parse(raw)
    if (process.argv.includes('--pre')) {
      const refusal = evidencePre(input)
      if (refusal) { console.error(refusal); process.exit(2) }
    } else if (process.argv.includes('--post')) {
      let reason = null
      try { reason = evidencePost(input) } catch { process.exit(0) }
      if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }))
    }
  } catch { /* fail open */ }
}
