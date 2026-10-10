// Pre/Post tool hook for board Planner agents (claude-agent-settings.json).
// Planners write <tasks>/.evidence/<card>/check-*.mjs; a shell rewrite (node -e, here-strings)
// silently strips regex backslashes, and one broken script reached the plan checker (2026-10-11).
// --pre snapshots the check scripts' hashes, --post blocks if a shell command changed them.
// Fails open: any error means exit 0 with no output.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentCard, agentRole } from '../lib/ids.mjs'

// Scripts only: a Check's own output (check-*.log, .txt, .json) changes on every run.
const hashes = dir => { try { return Object.fromEntries(readdirSync(dir).filter(f => /^check-.*\.(mjs|cjs|js|ts|ps1|sh)$/.test(f)).map(f => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')])) } catch { return {} } }

try {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const input = JSON.parse(raw)
  const snap = join(tmpdir(), `check-guard-${[input.session_id, input.tool_use_id ?? ''].map(s => String(s).replace(/[^\w-]/g, '_')).join('-')}.json`)
  if (process.argv.includes('--pre')) {
    const text = readFileSync(input.transcript_path, 'utf8')
    const name = text.split('\n').map(line => { try { return JSON.parse(line) } catch { return {} } }).findLast(e => e.type === 'agent-name')?.agentName
    const id = agentCard(name), tasksDir = text.match(/--tasks '([^']+)'/)?.[1]?.replaceAll('\\\\', '\\')
    if (agentRole(name) !== 'p' || !id || !tasksDir) process.exit(0)
    const dir = join(tasksDir, '.evidence', id)
    writeFileSync(snap, JSON.stringify({ dir, hashes: hashes(dir) }))
  } else if (process.argv.includes('--post')) {
    const before = JSON.parse(readFileSync(snap, 'utf8'))
    rmSync(snap, { force: true })
    const after = hashes(before.dir)
    const changed = [...new Set([...Object.keys(before.hashes), ...Object.keys(after)])].filter(f => before.hashes[f] !== after[f])
    if (changed.length) process.stdout.write(JSON.stringify({ decision: 'block', reason: `A shell command changed this check script: ${changed.map(f => join(before.dir, f)).join(', ')}. Shell quoting can strip regex backslashes. Read the file now, confirm every regex line and backslash is as intended, run \`node --check <file>\`, and make any further change with the Edit or Write tool, never through a shell command.` }))
  }
} catch { /* fail open */ }
