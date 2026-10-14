// Pre/Post tool hook for board Planner agents (claude-agent-settings.json).
// Planners write <tasks>/.evidence/<card>/check-*.mjs; a shell rewrite (node -e, here-strings)
// silently strips regex backslashes, and one broken script reached the plan checker (2026-10-11).
// --pre snapshots the check scripts' hashes, --post blocks if a shell command changed them.
// --pre also refuses a shell command that writes the card's plan file (HK70-HK72: shell edits damaged it);
// --post backstops a script that writes it without naming it. Reads (cat, sed -n, hkb show) are fine.
// Fails open: any error means exit 0 with no output.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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
    const plan = planFile(tasksDir, id)
    if (plan && writesPlan(input.tool_input?.command, basename(plan))) {
      console.error(`Refused: shell commands must not write the card file ${plan}. Make plan changes with the Edit or Write tool; reading it from the shell is fine.`)
      process.exit(2)
    }
    writeFileSync(snap, JSON.stringify({ dir, hashes: hashes(dir), plan, planHash: plan && sha(plan) }))
  } else if (process.argv.includes('--post')) {
    const before = JSON.parse(readFileSync(snap, 'utf8'))
    rmSync(snap, { force: true })
    const after = hashes(before.dir)
    const changed = [...new Set([...Object.keys(before.hashes), ...Object.keys(after)])].filter(f => before.hashes[f] !== after[f])
    const reasons = []
    if (changed.length) reasons.push(`A shell command changed this check script: ${changed.map(f => join(before.dir, f)).join(', ')}. Shell quoting can strip regex backslashes. Read the file now, confirm every regex line and backslash is as intended, run \`node --check <file>\`, and make any further change with the Edit or Write tool, never through a shell command.`)
    // hkb commands (move, result) legitimately rewrite the card; a missing file was moved.
    const planNow = before.plan && sha(before.plan)
    if (planNow && planNow !== before.planHash && !/hkb/.test(input.tool_input?.command ?? '')) reasons.push(`A shell command changed the card file ${before.plan}. Read it now and check the damage; make plan changes with the Edit or Write tool, never through a shell command.`)
    if (reasons.length) process.stdout.write(JSON.stringify({ decision: 'block', reason: reasons.join(' ') }))
  }
} catch { /* fail open */ }
