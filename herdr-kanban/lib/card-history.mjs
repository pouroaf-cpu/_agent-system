import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export function historyPath(tasksDir, id) {
  if (!/^T-\d+$/i.test(id)) throw new Error('Invalid history card ID')
  return join(tasksDir, '.history', `${id.toUpperCase()}.jsonl`)
}
export function appendHistory(tasksDir, id, event) {
  const path = historyPath(tasksDir, id)
  mkdirSync(join(tasksDir, '.history'), { recursive: true })
  const entry = { ...event, id: randomUUID(), at: new Date().toISOString(), run: event.run || process.env.HERDR_AGENT_SESSION || null, agent: event.agent || process.env.HERDR_AGENT_NAME || 'board' }
  appendFileSync(path, JSON.stringify(entry) + '\n')
  return entry
}
const historyMarker = /^\*\*(?:Build attempt|Kicked back|Spawn failed|Review feedback|Failed return \d+|Technical recovery|Diagnostic recovery|Dirty snapshot)\*\*/m
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
export function writeBrief(tasksDir, card, role, { maxChars = null } = {}) {
  const source = readFileSync(card.path, 'utf8')
  const text = focusedText(source, role)
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
