import { CARD_ID } from './ids.mjs'

// ponytail: any capitalised prefix counts, so prose like "AC1" on a link line reads
// as an (unknown) card and fails closed; pass the project prefix if that bites.
const CARD_REF = new RegExp(String.raw`\b${CARD_ID}\b`, 'g')
export const section = (text, name) => text.match(new RegExp(`^## ${name}[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'))?.[1]?.trim() || ''
const meaningful = text => text.replace(/<!--[\s\S]*?-->/g, '').trim()
export function auditStatus(text) {
  return meaningful(section(text, 'Audit conclusion')).match(/\b(INCOMPLETE|FINDINGS|CLEAR)\b/)?.[1] || null
}
export function auditDestination(text, status) {
  if (status === 'INCOMPLETE') return 'planning'
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
  const findings = [...meaningful(section(text, 'Findings')).matchAll(/^(\d+)\. /gm)].map(m => m[1])
  if (!findings.length) return 'Number current findings before linking remediation'
  const links = section(text, 'Remediation links')
  for (const id of findings) {
    const line = links.match(new RegExp(`^- F${id}: (.+)$`, 'm'))?.[1] || ''
    if (/^declined\b\W*\w/i.test(line)) continue // operator declined, with a reason
    const cards = line.match(CARD_REF) || []
    if (!cards.length || cards.some(card => !exists(card))) return `Finding F${id} needs an existing linked remediation card`
  }
  return null
}

// Card-ready findings: the ```json block under ## Card-ready findings. Required on
// general audits, validated on any audit that includes it. Throws the reason.
const FINDING_CATEGORIES = ['ui', 'code', 'data', 'auth-security']
export function cardReadyFindings(text) {
  const body = meaningful(section(text, 'Card-ready findings'))
  const json = body.match(/```json[^\S\r\n]*\r?\n([\s\S]*?)```/)?.[1]
  if (!json) throw new Error('## Card-ready findings needs a ```json block')
  let list
  try { list = JSON.parse(json) } catch (error) { throw new Error(`Card-ready findings JSON does not parse: ${error.message}`) }
  if (!Array.isArray(list) || !list.length) throw new Error('Card-ready findings must be a non-empty array')
  const strings = v => Array.isArray(v) && v.length && v.every(s => typeof s === 'string' && s.trim())
  const text1 = v => typeof v === 'string' && v.trim()
  const ns = list.map(f => f?.n)
  for (const f of list) {
    const at = `Finding ${f?.n}`
    if (!Number.isInteger(f?.n) || f.n < 1) throw new Error('Each finding needs a positive integer n')
    if (!text1(f.title) || f.title.length > 120 || /[\r\n]/.test(f.title)) throw new Error(`${at}: title must be one line of at most 120 characters`)
    if (!['high', 'medium', 'low'].includes(f.severity)) throw new Error(`${at}: severity must be high, medium or low`)
    if (!Number.isInteger(f.priority) || f.priority < 0 || f.priority > 10) throw new Error(`${at}: priority must be an integer 0-10`)
    if (!FINDING_CATEGORIES.includes(f.category)) throw new Error(`${at}: category must be one of ${FINDING_CATEGORIES.join(', ')}`)
    if (!text1(f.workspace) || /^[A-Za-z]:|^[\\/]|(^|[\\/])\.\.([\\/]|$)/.test(f.workspace)) throw new Error(`${at}: workspace must be project-relative ('.' by default)`)
    if (!strings(f.files)) throw new Error(`${at}: files must list paths, or ["unknown — planner to locate"]`)
    if (!strings(f.evidence)) throw new Error(`${at}: evidence must list screenshot/measurement paths`)
    if (!text1(f.problem) || !text1(f.recommendation)) throw new Error(`${at}: problem and recommendation are required`)
    if (!strings(f.acceptance)) throw new Error(`${at}: acceptance must list observable criteria`)
    const deps = f.dependsOn ?? []
    if (!Array.isArray(deps) || !deps.every(d => Number.isInteger(d) && d !== f.n && ns.includes(d))) throw new Error(`${at}: dependsOn must list other finding numbers`)
  }
  if (new Set(ns).size !== ns.length) throw new Error('Finding numbers must be unique')
  // A dependency cycle would block every card in it forever.
  const pending = new Map(list.map(f => [f.n, new Set(f.dependsOn || [])]))
  while (pending.size) {
    const free = [...pending].filter(([, deps]) => ![...deps].some(d => pending.has(d))).map(([n]) => n)
    if (!free.length) throw new Error(`dependsOn has a cycle among findings ${[...pending.keys()].join(', ')}`)
    free.forEach(n => pending.delete(n))
  }
  const numbered = [...meaningful(section(text, 'Findings')).matchAll(/^(\d+)\. /gm)].map(m => Number(m[1])).sort((a, b) => a - b)
  if (numbered.join() !== [...ns].sort((a, b) => a - b).join()) throw new Error(`## Findings numbers (${numbered.join(', ') || 'none'}) must match the JSON findings (${ns.join(', ')})`)
  return list.map(f => ({ ...f, dependsOn: f.dependsOn || [] }))
}

// FINDINGS without a valid card-ready block is INCOMPLETE: nothing could become a card.
export function auditOutcome(text, audit) {
  const status = auditStatus(text)
  if (status !== 'FINDINGS' || (audit !== 'general' && !/^## Card-ready findings/m.test(text))) return { status }
  try { cardReadyFindings(text); return { status } } catch (error) { return { status: 'INCOMPLETE', reason: error.message } }
}
