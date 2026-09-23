export const section = (text, name) => text.match(new RegExp(`^## ${name}[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'))?.[1]?.trim() || ''
const meaningful = text => text.replace(/<!--[\s\S]*?-->/g, '').trim()
export function auditStatus(text) {
  return meaningful(section(text, 'Audit conclusion')).match(/\b(INCOMPLETE|FINDINGS|CLEAR)\b/)?.[1] || null
}
export function auditDestination(text, status) {
  if (status === 'INCOMPLETE') return 'issues'
  if (!meaningful(section(text, 'Evidence'))) throw new Error('Audit needs current Evidence before completed-report handoff')
  if (status === 'CLEAR') return 'archive'
  if (status === 'FINDINGS') return /^\*\*Audit disposition:\*\*\s*report-only-await-owner\s*$/im.test(text) ? 'owner' : 'planning'
  throw new Error('Audit status must be CLEAR, FINDINGS or INCOMPLETE')
}
export function auditArchiveError(text, exists) {
  const status = auditStatus(text)
  if (!meaningful(section(text, 'Evidence'))) return 'Audit closure requires current evidence'
  if (status === 'CLEAR') return null
  if (status !== 'FINDINGS') return 'Incomplete audit cannot be archived'
  const findings = [...section(text, 'Findings').matchAll(/^\s*(\d+)\./gm)].map(m => m[1])
  if (!findings.length) return 'Number current findings before linking remediation'
  const links = section(text, 'Remediation links')
  for (const id of findings) {
    const line = links.match(new RegExp(`^- F${id}: (.+)$`, 'm'))?.[1] || ''
    const cards = line.match(/\bT-\d+\b/g) || []
    if (!cards.length || cards.some(card => !exists(card))) return `Finding F${id} needs an existing linked remediation card`
  }
  return null
}
