// Turn an audit's card-ready findings into remediation cards (POST /api/audit-cards).
// Links go under the audit's ## Remediation links as `- F<n>: <card id>` or
// `- F<n>: declined — <reason>`, the lines auditArchiveError already checks.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
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

// One card for several findings on the same file(s): each finding's problem, change and
// evidence, then every AC renumbered so the IDs stay unique on the card.
export function groupBriefFor(auditId, group, area) {
  let ac = 0
  return [
    `This card fixes ${group.length} findings from ${auditId} that share ${area}. Fix them together in one change.`,
    ...group.map(f => [
      `### Finding ${f.n}: ${f.title}`,
      f.problem.trim(),
      `Recommended change: ${f.recommendation.trim()}`,
      `Severity: ${f.severity}`,
      `Files: ${f.files.join(', ')}`,
      `Evidence:\n${f.evidence.map(e => `- ${e}`).join('\n')}`,
    ].join('\n\n')),
    `Acceptance criteria:\n${group.flatMap(f => f.acceptance.map(a => `- AC${++ac}: ${a.replace(/^AC\d+:\s*/, '')} (finding ${f.n})`)).join('\n')}`,
    `Source: ${auditId} findings ${group.map(f => f.n).join(', ')}`,
  ].join('\n\n')
}

// Findings whose Files share a path go on one card, at most MAX_GROUP per card. One card per
// finding queued Injectbuddy behind its hot files one card at a time: one audit made 16
// LabDashboard.tsx cards (throughput audit 2026-09-26 F1).
const MAX_GROUP = 5
const realFiles = f => f.files.filter(p => !/^unknown\b/i.test(p))
const fileKeys = f => realFiles(f).map(p => `${f.workspace}\0${p.replaceAll('\\', '/').toLowerCase()}`)
const shares = (a, b) => fileKeys(a).some(k => fileKeys(b).includes(k))
const reaches = (deps, from, target, seen = new Set()) => [...deps[from]].some(j => j === target || (!seen.has(j) && seen.add(j) && reaches(deps, j, target, seen)))
export function groupFindings(list) {
  let groups = []
  for (const f of list) {
    const hits = groups.filter(g => g.some(h => shares(h, f)))
    groups = [...groups.filter(g => !hits.includes(g)), [...hits.flat(), f]]
  }
  let cards = groups.map(g => g.sort((a, b) => a.n - b.n)).sort((a, b) => a[0].n - b[0].n)
    .flatMap(g => Array.from({ length: Math.ceil(g.length / MAX_GROUP) }, (_, i) => g.slice(i * MAX_GROUP, (i + 1) * MAX_GROUP)))
  // Grouping must never make two cards block each other: a grouped card on a Blocked-by
  // cycle goes back to one card per finding (the findings' own graph has no cycle).
  for (;;) {
    const cardOf = new Map(cards.flatMap((c, i) => c.map(f => [f.n, i])))
    const deps = cards.map((c, i) => new Set(c.flatMap(f => f.dependsOn).map(d => cardOf.get(d)).filter(j => j !== undefined && j !== i)))
    const loop = cards.findIndex((c, i) => c.length > 1 && reaches(deps, i, i))
    if (loop < 0) return cards
    cards = [...cards.slice(0, loop), ...cards[loop].map(f => [f]), ...cards.slice(loop + 1)]
  }
}
// The path most of the card's findings list.
const sharedArea = group => {
  const count = new Map()
  for (const f of group) for (const p of new Set(realFiles(f))) count.set(p, (count.get(p) || 0) + 1)
  return [...count].sort((a, b) => b[1] - a[1])[0][0]
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
  // Reports written before the ## Audit conclusion section carry a `Status:` header line.
  const status = auditStatus(text) || (audit.column === 'report' ? text.match(/^Status:[^\S\r\n]*(INCOMPLETE|FINDINGS|CLEAR)\b/m)?.[1] : null)
  if (status !== 'FINDINGS') throw new Error(`${audit.id} has no FINDINGS conclusion`)
  const findings = cardReadyFindings(text)
  return { audit, text, findings, links: Object.fromEntries(findings.map(f => [f.n, linkLine(text, f.n) || null])) }
}

export function cardsFromAudit(tasksDir, { id, report, findings = [], decline = [], reason = '', prefix, mission = '' }) {
  const { audit, findings: all, links } = auditFindings(tasksDir, { id, report })
  if (audit.column === 'archive') return { audit: audit.id, created: [], links, archived: true, remaining: [] }
  if (!report && !['pou', 'owner', 'planning'].includes(audit.column)) throw new Error(`${audit.id} is in ${audit.column}; turn findings into cards once the report is in Pou, Owner or Planning`)
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
  // A report's evidence is copied into the project (TASKS/.evidence/<audit>/) so the
  // cards never cite _audits paths, which move on archive (Tradeflow TF49-TF61).
  const localEvidence = (file) => {
    if (!report) return file
    const source = resolve(dirname(report), file)
    if (!existsSync(source) || !statSync(source).isFile()) return file
    const inside = relative(dirname(report), source)
    const target = join(tasksDir, '.evidence', audit.id.replace(/[^\w.-]+/g, '-').replace(/^\.+/, ''), inside.startsWith('..') || isAbsolute(inside) ? basename(source) : inside)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    return target.replaceAll('\\', '/')
  }
  const created = []
  for (const group of groupFindings(all.filter(f => selected.includes(f.n) && !cardOf(f.n)))) {
    const local = group.map(f => ({ ...f, evidence: f.evidence.map(localEvidence) }))
    const lead = [...group].sort((a, b) => b.priority - a.priority)[0], area = group.length > 1 && sharedArea(group)
    const card = createCard(tasksDir, {
      title: area ? `Audit findings ${group.map(f => f.n).join(', ')} in ${area}`.slice(0, 200) : lead.title,
      brief: area ? groupBriefFor(audit.id, local, area) : briefFor(audit.id, local[0]),
      category: lead.category, workspace: lead.workspace, mission, prefix,
    })
    // Link before anything else can fail, so a retry never duplicates these findings.
    for (const f of group) { links[f.n] = card.id; setLink(audit.path, f.n, card.id) }
    created.push({ ns: group.map(f => f.n), id: card.id, path: card.path, dependsOn: group.flatMap(f => f.dependsOn), priority: lead.priority })
  }
  for (const card of created) {
    // ponytail: only dependencies already carded get Blocked by; a dependency carded later does not block retroactively.
    const blockers = [...new Set(card.dependsOn.map(cardOf).filter(id => id && id !== card.id))]
    const text = readFileSync(card.path, 'utf8')
    writeFileSync(card.path, text.replace(/^\*\*Priority\*\*[^\S\r\n]*\d+[^\S\r\n]*\/[^\S\r\n]*10/m, `**Priority** ${card.priority}/10${blockers.length ? `\n**Blocked by:** ${blockers.join(', ')}` : ''}`))
  }
  const remaining = all.map(f => f.n).filter(n => !cardOf(n) && !declined(n))
  const done = !remaining.length && !report
  if (done) moveCard(tasksDir, audit.id, 'archive')
  return { audit: audit.id, created: created.flatMap(({ ns, id }) => ns.map(n => ({ n, id }))).sort((a, b) => a.n - b.n), links, archived: done, archivedNow: done, remaining }
}
