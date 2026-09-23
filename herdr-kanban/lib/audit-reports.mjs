import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, basename, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { readBoard } from './cards.mjs'
import { auditStatus } from './audit-routing.mjs'

const key = value => createHash('sha256').update(value).digest('hex')
const entries = path => { try { return readdirSync(path, { withFileTypes: true }) } catch { return [] } }
const within = (root, path) => { const rel = relative(root, path); return rel && !rel.startsWith('..') && !isAbsolute(rel) }

function reportFile(root, path) {
  try {
    const realRoot = realpathSync(root), real = realpathSync(path)
    const realProject = realpathSync(join(root, '..', '..'))
    if (!within(realProject, realRoot) || !within(realRoot, real) || !/\.md$/i.test(real) || !statSync(real).isFile()) return null
    return real
  } catch { return null }
}

export function readAuditReports(config, project) {
  if (!config.projects.includes(project)) throw new Error('Unknown project')
  const tasks = join(config.projectsRoot, project, 'TASKS'), root = join(tasks, 'reports')
  const cards = Object.values(readBoard(tasks)).flat().filter(card => card.audit)
  const candidates = new Set()
  // ponytail: only the known reports directory and one directory level; deeper
  // historical reports are included only when explicitly referenced by an audit card.
  for (const entry of entries(root)) {
    if (entry.isFile() && /\.md$/i.test(entry.name)) candidates.add(join(root, entry.name))
    if (entry.isDirectory()) for (const file of entries(join(root, entry.name))) {
      if (file.isFile() && /^(report|summary|findings)(?:[-.].*)?\.md$/i.test(file.name)) candidates.add(join(root, entry.name, file.name))
    }
  }
  const sources = cards.map(card => ({ card, text: readFileSync(card.path, 'utf8') }))
  for (const { text } of sources) {
    for (const match of text.matchAll(/TASKS[\\/]reports[\\/]([^`\n\r"<>]*?\.md)\b/g)) {
      const path = resolve(root, match[1].replaceAll('\\', '/'))
      if (within(root, path)) candidates.add(path)
    }
  }
  const groups = new Map(), matched = new Set()
  for (const candidate of candidates) {
    const path = reportFile(root, candidate)
    if (!path) continue
    const rel = relative(root, path).replaceAll('\\', '/')
    const group = dirname(rel) === '.' ? rel : dirname(rel)
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push({ id: key(`${project}/${rel}`), file: `TASKS/reports/${rel}`, path, name: basename(path) })
  }
  const audits = []
  for (const [group, files] of groups) {
    files.sort((a, b) => (a.name === 'report.md' ? 0 : a.name === 'summary.md' ? 1 : 2) - (b.name === 'report.md' ? 0 : b.name === 'summary.md' ? 1 : 2) || a.name.localeCompare(b.name))
    // References to another audit's evidence do not transfer its title/verdict.
    const source = sources.find(({ card }) => new RegExp(`^${card.id}(?:\\b|-)`, 'i').test(group))
      || sources.find(({ text }) => files.some(file => text.replaceAll('\\', '/').split(/\r?\n/).some(line => /^\*\*(?:Audit report|Report):\*\*/i.test(line) && line.includes(file.file))))
    if (source) matched.add(source.card.path)
    const text = readFileSync(files[0].path, 'utf8'), meaningful = text.replace(/<!--[\s\S]*?-->/g, '').trim()
    const reported = text.match(/^(?:\*\*)?(?:Audit status|Status)(?::\*\*|:)?\s*(INCOMPLETE|PARTIAL|BLOCKED|FINDINGS|CLEAR|PASS)\b/im)?.[1]?.toUpperCase() || auditStatus(text) || (source ? auditStatus(source.text) : null)
    const status = !meaningful || meaningful.split(/\r?\n/).filter(Boolean).length < 2 ? 'Empty report'
      : /INCOMPLETE|PARTIAL|BLOCKED/.test(reported || '') ? 'Incomplete'
      : reported === 'FINDINGS' ? 'Findings reported'
      : reported === 'CLEAR' || reported === 'PASS' ? `${reported === 'CLEAR' ? 'Clear' : 'Pass'} reported — unverified`
      : 'Report available — completion unverified'
    const recordedDate = text.match(/^(?:\*\*)?(?:Date|Generated|Audited)(?::\*\*|:)\s*(\d{4}-\d{2}-\d{2}(?:T[^\s`]+)?)/im)?.[1]
    const validDate = recordedDate && Number.isFinite(Date.parse(recordedDate))
    audits.push({ id: key(group), title: source?.card.title || text.match(/^#\s+(.+)$/m)?.[1] || group,
      date: validDate ? recordedDate : statSync(files[0].path).mtime.toISOString(), dateLabel: validDate ? 'Report date' : 'Updated', status,
      reports: files.map(({ path, ...file }) => file) })
  }
  for (const { card } of sources) if (!matched.has(card.path)) audits.push({ id: `card-${card.id}`, title: card.title, date: new Date(card.mtime).toISOString(), dateLabel: 'Card updated', status: 'Report missing', reports: [] })
  return audits.sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || a.title.localeCompare(b.title))
}

export function resolveAuditReport(config, project, reportId) {
  if (typeof reportId !== 'string' || !/^[a-f0-9]{64}$/.test(reportId)) throw new Error('Invalid report identity')
  const report = readAuditReports(config, project).flatMap(a => a.reports).find(file => file.id === reportId)
  if (!report) throw new Error('Report missing or no longer registered')
  const root = join(config.projectsRoot, project, 'TASKS', 'reports')
  const path = reportFile(root, join(config.projectsRoot, project, report.file))
  if (!path) throw new Error('Report missing or outside project report directory')
  return path
}

export function editorArguments(path) {
  // Existing Windows editor uses a shell shim. Reject shell expansion/control
  // characters even in server-discovered filenames; browser paths are never used.
  if (/["%!^&|<>\r\n`$]/.test(path)) throw new Error('Unsupported editor path characters')
  return [`"${path}"`]
}
