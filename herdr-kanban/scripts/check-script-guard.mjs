// Pre/Post tool guard for board Planner agents (claude-agent-settings.json and claude-planner-settings.json).
// Planners write <tasks>/.evidence/<card>/check-*.mjs; a shell rewrite (node -e, here-strings)
// silently strips regex backslashes, and one broken script reached the plan checker (2026-10-11).
// --pre snapshots the check scripts' hashes, --post blocks if a shell command changed them.
// --pre also refuses a shell command that writes the card's plan file (HK70-HK72: shell edits damaged it);
// --post backstops a script that writes it without naming it. Reads (cat, sed -n, hkb show) are fine.
// Fails open: any error means exit 0 with no output.
// The agent runs this through scripts/hooks/pre.mjs and post.mjs, which call checkPre and checkPost
// in-process. Run directly with --pre or --post it behaves as before.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { agentCard, agentRole } from '../lib/ids.mjs'

// Scripts only: a Check's own output (check-*.log, .txt, .json) changes on every run.
const hashes = dir => { try { return Object.fromEntries(readdirSync(dir).filter(f => /^check-.*\.(mjs|cjs|js|ts|ps1|sh)$/.test(f)).map(f => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')])) } catch { return {} } }
const sha = file => { try { return createHash('sha256').update(readFileSync(file)).digest('hex') } catch { return null } }
const planFile = (tasksDir, id) => {
  for (const lane of readdirSync(tasksDir).filter(l => !l.startsWith('.')))
    try { const f = readdirSync(join(tasksDir, lane)).find(f => f.startsWith(`${id}-`) && f.endsWith('.md')); if (f) return join(tasksDir, lane, f) } catch { /* not a lane */ }
  return null
}
// ponytail: text match on the command; a write verb anywhere next to the file name counts, even in a pipeline.
const writeVerb = /\b(Set-Content|Add-Content|Out-File|Clear-Content|Tee-Object|tee|Move-Item|Rename-Item|Remove-Item|mv|rm|del)\b|\bsed\b.*\s(-[a-z]*i|--in-place)\b|writeFileSync|writeFile|appendFile|createWriteStream|WriteAllText|WriteAllLines|AppendAllText|open\([^)]*['"][wa]/i
const writesPlan = (command, name) => {
  if (typeof command !== 'string' || !command.includes(name)) return false
  const redirect = new RegExp(`>>?\\s*["']?[^\\s"'|;&<>]*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  return redirect.test(command) || writeVerb.test(command.replaceAll(name, ''))  // a slug word like "del" must not read as a verb
}
const snapshotPath = input => join(tmpdir(), `check-guard-${[input.session_id, input.tool_use_id ?? ''].map(s => String(s).replace(/[^\w-]/g, '_')).join('-')}.json`)

// The refusal text for a pre-tool call, or null. Snapshots the card's check scripts and plan file.
export function checkPre(input) {
  const text = readFileSync(input.transcript_path, 'utf8')
  const name = text.split('\n').map(line => { try { return JSON.parse(line) } catch { return {} } }).findLast(e => e.type === 'agent-name')?.agentName
  const id = agentCard(name), tasksDir = text.match(/--tasks '([^']+)'/)?.[1]?.replaceAll('\\\\', '\\')
  if (agentRole(name) !== 'p' || !id || !tasksDir) return null
  const dir = join(tasksDir, '.evidence', id)
  const plan = planFile(tasksDir, id)
  if (plan && writesPlan(input.tool_input?.command, basename(plan))) {
    return `Refused: shell commands must not write the card file ${plan}. Make plan changes with the Edit or Write tool; reading it from the shell is fine.`
  }
  writeFileSync(snapshotPath(input), JSON.stringify({ dir, hashes: hashes(dir), plan, planHash: plan && sha(plan) }))
  return null
}

// The block reason for a post-tool call, or null. Throws when no pre snapshot exists (the caller fails open).
export function checkPost(input) {
  const snap = snapshotPath(input)
  const before = JSON.parse(readFileSync(snap, 'utf8'))
  rmSync(snap, { force: true })
  const after = hashes(before.dir)
  const changed = [...new Set([...Object.keys(before.hashes), ...Object.keys(after)])].filter(f => before.hashes[f] !== after[f])
  const reasons = []
  if (changed.length) reasons.push(`A shell command changed this check script: ${changed.map(f => join(before.dir, f)).join(', ')}. Shell quoting can strip regex backslashes. Read the file now, confirm every regex line and backslash is as intended, run \`node --check <file>\`, and make any further change with the Edit or Write tool, never through a shell command.`)
  // hkb commands (move, result) legitimately rewrite the card; a missing file was moved.
  const planNow = before.plan && sha(before.plan)
  if (planNow && planNow !== before.planHash && !/hkb/.test(input.tool_input?.command ?? '')) reasons.push(`A shell command changed the card file ${before.plan}. Read it now and check the damage; make plan changes with the Edit or Write tool, never through a shell command.`)
  return reasons.length ? reasons.join(' ') : null
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    let raw = ''
    for await (const chunk of process.stdin) raw += chunk
    const input = JSON.parse(raw)
    if (process.argv.includes('--pre')) {
      const refusal = checkPre(input)
      if (refusal) { console.error(refusal); process.exit(2) }
    } else if (process.argv.includes('--post')) {
      let reason = null
      try { reason = checkPost(input) } catch { process.exit(0) }
      if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }))
    }
  } catch { /* fail open */ }
}
