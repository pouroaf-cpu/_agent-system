// Turn an audit's card-ready findings into remediation cards (POST /api/audit-cards).
// Links go under the audit's ## Remediation links as `- F<n>: <card id>` or
// `- F<n>: declined — <reason>`, the lines auditArchiveError already checks.
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { createCard, findCard, moveCard } from './cards.mjs'
import { auditStatus, cardReadyFindings, section } from './audit-routing.mjs'
import { CARD_ID } from './ids.mjs'

const linkLine = (text, n) => section(text, 'Remediation links').match(new RegExp(`^- F${n}: (.+?)\\s*$`, 'm'))?.[1] || ''

function setLink(path, n, value) {
  const text = readFileSync(path, 'utf8'), line = `- F${n}: ${value}`
  const head = /^## Remediation links[^\S\r\n]*\r?\n/m.exec(text)
  if (!head) return writeFileSync(path, `${text.trimEnd()}\n\n## Remediation links\n${line}\n`)
  const start = head.index + head[0].length, rest = text.slice(start), end = rest.search(/^## /m)
  const body = end < 0 ? rest : rest.slice(0, end), own = new RegExp(`^- F${n}:.*$`, 'm')
  const next = own.test(body) ? body.replace(own, line) : `${body.trimEnd()}${body.trim() ? '\n' : ''}${line}\n\n`
  writeFileSync(path, text.slice(0, start) + next + (end < 0 ? '' : rest.slice(end)))
}

export function briefFor(auditId, f) {
  return [
    f.problem.trim(),
    `Recommended change: ${f.recommendation.trim()}`,
    `Severity: ${f.severity}`,
    `Files: ${f.files.join(', ')}`,
    `Evidence:\n${f.evidence.map(e => `- ${e}`).join('\n')}`,
    `Acceptance criteria:\n${f.acceptance.map((a, i) => `- ${/^AC\d+:/.test(a) ? a : `AC${i + 1}: ${a}`}`).join('\n')}`,
    `Source: ${auditId} finding ${f.n}`,
  ].join('\n\n')
}

// An audit is either a board audit card (id) or an off-board report.md (report),
// the Auditor agent's output in Projects/_audits. A report's links are written into
// the report itself; the orchestrator archives its folder, not the board.
function auditSource(tasksDir, { id, report }) {
  if (report) {
    const text = readFileSync(report, 'utf8')
    const auditId = text.match(/^Audit ID:[^\S\r\n]*(\S.*?)\s*$/m)?.[1] || basename(dirname(report))
    return { audit: { id: auditId, title: text.match(/^# (.+)$/m)?.[1]?.trim() || auditId, path: report, column: 'report' }, text }
  }
  const audit = findCard(tasksDir, id)
  if (!audit.audit) throw new Error(`${audit.id} is not an audit card`)
  return { audit, text: readFileSync(audit.path, 'utf8') }
}

// Read-only view for the orchestrator's summary.
export function auditFindings(tasksDir, source) {
  const { audit, text } = auditSource(tasksDir, typeof source === 'string' ? { id: source } : source)
  if (auditStatus(text) !== 'FINDINGS') throw new Error(`${audit.id} has no FINDINGS conclusion`)
  const findings = cardReadyFindings(text)
  return { audit, text, findings, links: Object.fromEntries(findings.map(f => [f.n, linkLine(text, f.n) || null])) }
}

export function cardsFromAudit(tasksDir, { id, report, findings = [], decline = [], reason = '', prefix, mission = '' }) {
  const { audit, findings: all, links } = auditFindings(tasksDir, { id, report })
  if (audit.column === 'archive') return { audit: audit.id, created: [], links, archived: true, remaining: [] }
  if (!report && !['owner', 'planning'].includes(audit.column)) throw new Error(`${audit.id} is in ${audit.column}; turn findings into cards once the report is in Owner or Planning`)
  const known = new Set(all.map(f => f.n))
  const numbers = (list, name) => {
    if (!Array.isArray(list) || list.some(n => !known.has(n))) throw new Error(`${name} must list finding numbers from: ${[...known].join(', ')}`)
    return list
  }
  decline = numbers(decline, 'decline')
  if (decline.length && (typeof reason !== 'string' || !reason.trim() || /[\r\n]/.test(reason))) throw new Error('decline needs a one-line reason')
  const declined = n => /^declined\b/i.test(links[n] || '')
  const selected = findings === 'all' ? all.map(f => f.n).filter(n => !decline.includes(n) && !declined(n)) : numbers(findings, 'findings')
  if (selected.some(n => decline.includes(n))) throw new Error('A finding cannot be both selected and declined')
  const cardOf = n => {
    if (!links[n] || declined(n)) return null
    return (links[n].match(new RegExp(String.raw`\b${CARD_ID}\b`, 'g')) || []).find(card => { try { return findCard(tasksDir, card) } catch { return false } }) || null
  }
  for (const n of decline) {
    if (cardOf(n)) throw new Error(`F${n} is already linked to ${cardOf(n)}; it cannot be declined`)
    links[n] = `declined — ${reason.trim()}`
    setLink(audit.path, n, links[n])
  }
  const created = []
  for (const f of all.filter(f => selected.includes(f.n) && !cardOf(f.n))) {
    const card = createCard(tasksDir, { title: f.title, brief: briefFor(audit.id, f), category: f.category, workspace: f.workspace, mission, prefix })
    // Link before anything else can fail, so a retry never duplicates this finding.
    links[f.n] = card.id
    setLink(audit.path, f.n, card.id)
    created.push({ n: f.n, id: card.id, path: card.path, dependsOn: f.dependsOn, priority: f.priority })
  }
  for (const card of created) {
    // ponytail: only dependencies already carded get Blocked by; a dependency carded later does not block retroactively.
    const blockers = card.dependsOn.map(cardOf).filter(Boolean)
    const text = readFileSync(card.path, 'utf8')
    writeFileSync(card.path, text.replace(/^\*\*Priority\*\*[^\S\r\n]*\d+[^\S\r\n]*\/[^\S\r\n]*10/m, `**Priority** ${card.priority}/10${blockers.length ? `\n**Blocked by:** ${blockers.join(', ')}` : ''}`))
  }
  const remaining = all.map(f => f.n).filter(n => !cardOf(n) && !declined(n))
  const done = !remaining.length && !report
  if (done) moveCard(tasksDir, audit.id, 'archive')
  return { audit: audit.id, created: created.map(({ n, id }) => ({ n, id })), links, archived: done, archivedNow: done, remaining }
}
