import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isCardId } from './ids.mjs'

export function historyPath(tasksDir, id) {
  if (!isCardId(id)) throw new Error('Invalid history card ID')
  return join(tasksDir, '.history', `${id.toUpperCase()}.jsonl`)
}
export function appendHistory(tasksDir, id, event) {
  const path = historyPath(tasksDir, id)
  mkdirSync(join(tasksDir, '.history'), { recursive: true })
  const entry = { ...event, id: randomUUID(), at: new Date().toISOString(), run: event.run || process.env.HERDR_AGENT_SESSION || null, agent: event.agent || process.env.HERDR_AGENT_NAME || 'board' }
  appendFileSync(path, JSON.stringify(entry) + '\n')
  return entry
}
// T-147: a Builder rewrote its whole card and dropped Files, plan and criteria.
// A handoff must keep every required section that had content in the board's last
// saved copy of the card. Nothing is restored automatically.
const REQUIRED_SECTIONS = ['Approved brief', 'Files', 'Implementation plan', 'Acceptance criteria']
const sectionBody = (text, name) => (text.match(new RegExp(`^## ${name}\\s*\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'))?.[1] ?? '').replace(/<!--[\s\S]*?-->/g, '').trim()
export function droppedSections(tasksDir, id, text) {
  const path = historyPath(tasksDir, id)
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  let saved
  for (let i = lines.length - 1; i >= 0 && saved == null; i--) {
    try { const entry = JSON.parse(lines[i]); if (typeof entry.text === 'string') saved = entry.text } catch { /* torn line */ }
  }
  return saved ? REQUIRED_SECTIONS.filter(name => sectionBody(saved, name) && !sectionBody(text, name)) : []
}
// The lane a card left when it last went to Pou or Owner, or null when history does not say.
// An Owner -> Pou promotion is not a lane the card left.
export function laneBeforeOwner(tasksDir, id) {
  const path = historyPath(tasksDir, id)
  if (!existsSync(path)) return null
  let from = null
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try { const entry = JSON.parse(line); if (entry.event === 'transition' && ['pou', 'owner'].includes(entry.to) && !['pou', 'owner'].includes(entry.from)) from = entry.from } catch { /* torn line */ }
  }
  return from
}
// The card's last lane transition from history, or null.
export function lastTransition(tasksDir, id) {
  const path = historyPath(tasksDir, id)
  if (!existsSync(path)) return null
  let last = null
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.includes('"transition"')) continue
    try { const e = JSON.parse(line); if (e.event === 'transition') last = e } catch { /* torn line */ }
  }
  return last
}
// True when the Builder's hkb done/unchanged is recorded since the card last entered Working.
export function builderHandedOff(tasksDir, id) {
  const path = historyPath(tasksDir, id)
  if (!existsSync(path)) return false
  let handedOff = false
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try {
      const e = JSON.parse(line)
      if (e.event === 'transition' && e.to === 'working') handedOff = false
      if (e.event === 'handoff' && ['done', 'unchanged'].includes(e.outcome)) handedOff = true
    } catch { /* torn line */ }
  }
  return handedOff
}
// When the card last moved into `column` (ms), from its history transitions; null when
// history does not say. Histories reach ~0.5MB and every poll asks, so the answer is
// cached per file size+mtime.
const entered = new Map() // path -> { key, at }
export function laneEnteredAt(tasksDir, id, column) {
  const path = historyPath(tasksDir, id)
  let stat
  try { stat = statSync(path) } catch { return null }
  const key = `${stat.size}:${stat.mtimeMs}:${column}`
  if (entered.get(path)?.key !== key) {
    let at = null
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.includes('"transition"')) continue
      try { const e = JSON.parse(line); if (e.event === 'transition') at = e.to === column ? Date.parse(e.at) : null } catch { /* torn line */ }
    }
    entered.set(path, { key, at })
  }
  return entered.get(path).at
}
const historyMarker =/^\*\*(?:Build attempt|Kicked back|Spawn failed|Review feedback|Failed return \d+|Technical recovery|Diagnostic recovery|Dirty snapshot)\*\*/m
export function focusedText(text, role) {
  // Project the whole card, not just the prefix before the first attempt. Legacy
  // approved Return N corrections can appear AFTER history markers.
  const historical = new Set(['History', 'Transcript', 'Previous attempts', 'Launch prompt'])
  const chunks = text.split(/(?=^## )/m)
  const latestReturn = Math.max(0, ...[...text.matchAll(/^## Return (\d+) /gm)].map(m => Number(m[1])))
  const latestBySection = new Map()
  for (const match of text.matchAll(/^## Return (\d+) ([^\r\n]+)/gm)) {
    const section = match[2].toLowerCase()
    latestBySection.set(section, Math.max(Number(match[1]), latestBySection.get(section) || 0))
  }
  const sections = new Map()
  for (const chunk of chunks) {
    const heading = chunk.match(/^## ([^\r\n]+)/)?.[1]
    if (heading && historical.has(heading)) continue
    const returned = heading?.match(/^Return (\d+) (.+)/)
    if (returned && Number(returned[1]) !== latestBySection.get(returned[2].toLowerCase())) continue
    // Reviewer sees current Builder result/evidence, never a previous verdict.
    // Builder/Planner see requirements and evidence, not old implementation prose.
    if (heading === 'Reviewer evidence' || (heading === 'Implementation' && role !== 'reviewer')) continue
    const body = chunk.split(historyMarker)[0].replace(/\n---\s*$/, '').trim()
    if (body) sections.set(heading || 'header', body)
  }
  const feedback = sections.has('Current feedback') ? null : [...text.matchAll(/^\*\*(?:Kicked back|Spawn failed|Review feedback)\*\*[^\n]*\n+([\s\S]*?)(?=^## |^\*\*|^---|$(?![\s\S]))/gm)].at(-1)?.[1]?.trim()
  return [...sections.values(), ...(feedback ? [`## Current feedback\n${feedback}`] : []),
    ...(latestReturn ? [`Latest correction: Return ${latestReturn}; still-current sections from earlier returns remain above until explicitly replaced. Preserve approved constraints and acceptance criteria; do not replay finished implementation. Superseded sections and verdicts are history, not a fresh pass.`] : [])].join('\n\n')
}
// `## all` plus the card's category section of TASKS/PROJECT-CONSTRAINTS.md, or null.
export function projectConstraints(tasksDir, category) {
  const path = join(tasksDir, 'PROJECT-CONSTRAINTS.md')
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  return [sectionBody(text, 'all'), category && sectionBody(text, category)].filter(Boolean).join('\n\n') || null
}
export function writeBrief(tasksDir, card, role, { maxChars = null } = {}) {
  const source = readFileSync(card.path, 'utf8')
  // The card's own copy is taken at creation; rules added later reach live cards
  // only through here (Injectbuddy I265). The brief revision hash carries the change.
  const constraints = projectConstraints(tasksDir, card.category)
  const text = focusedText(source, role) + (constraints ? `\n\n## Current project constraints\n${constraints}` : '')
  if (maxChars && text.length > maxChars) throw new Error(`Brief exceeds configured ${maxChars} characters; compact it without removing requirements`)
  const dir = join(tasksDir, '.briefs')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${card.id}-${role}.md`)
  appendHistory(tasksDir, card.id, { event: 'brief-source', stage: role, text: source })
  writeFileSync(path, `${text}\n\nAuthoritative card: ${card.path}\nHistory (read only relevant entries on demand): ${historyPath(tasksDir, card.id)}\n`)
  return path.replaceAll('\\', '/')
}

export function writeCurrentFeedback(tasksDir, card, heading, note) {
  const text = readFileSync(card.path, 'utf8')
  const event = appendHistory(tasksDir, card.id, { event: 'feedback', heading, note, text })
  const section = `## Current feedback\n${heading}: ${note}\nHistory entry: ${event.id}\n`
  // Recovery counters and legacy attempt records can be appended after feedback.
  // They remain authoritative card state, not part of the replaceable note.
  const pattern = /^## Current feedback\r?\n[\s\S]*?(?=^## |^\*\*Recovery:\*\*|^---\s*$|^\*\*(?:Build attempt|Failed return \d+)\*\*|$(?![\s\S]))/m
  const next = pattern.test(text) ? text.replace(pattern, section + '\n') : text + '\n\n' + section
  writeFileSync(card.path, next)
}
