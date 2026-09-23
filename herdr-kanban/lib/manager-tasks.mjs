import { existsSync, readFileSync } from 'node:fs'

const REQ = /REQ-(\d{8})-(\d{3})/g
const HEADING = /^###\s+(.+)$/
const TIME = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)/

const clean = (s) => String(s ?? '')
  .replace(/\*\*|`/g, '')
  .replace(/\s+/g, ' ')
  .trim()

const cleanVisible = (s) => clean(s).replace(/\bREQ-\d{8}-\d{3}\b/g, '').replace(/\s+/g, ' ').trim()

function titleFrom(heading, id) {
  return cleanVisible(heading.replace(id, '').replace(/^[\s:;,.|/\\\-–—]+|[\s:;,.|/\\\-–—]+$/g, '')) || id
}

function descriptionFrom(title, lines, id) {
  if (title && title !== id) return title
  for (const line of lines) {
    const m = cleanVisible(line).match(/^-?\s*(?:User request|Approved goal|Goal|Scope):\s*(.+)$/i)
    if (m) return cleanVisible(m[1]).replace(/^[\s:;,.|/\\\-–—]+|[\s:;,.|/\\\-–—]+$/g, '').slice(0, 220)
  }
  return id
}

function dateFrom(id) {
  const m = /^REQ-(\d{4})(\d{2})(\d{2})-(\d{3})$/.exec(id)
  return m ? { date: `${m[1]}-${m[2]}-${m[3]}`, seq: Number(m[4]) } : { date: 'unknown', seq: 0 }
}

function inferProject(title, body) {
  const explicit = body.match(/^\s*-?\s*Project:\s*(.+)$/im)?.[1]?.replace(/[.;]\s*$/, '').trim()
  if (explicit) {
    if (/^kanban$/i.test(explicit)) return 'Kanban'
    if (/^injectbuddy$/i.test(explicit)) return 'InjectBuddy'
    if (/^tradeflow$/i.test(explicit)) return 'Tradeflow'
    return explicit
  }
  const text = `${title}\n${body}`
  if (/manager tasks|automatic board|board progression|kanban|herdr|model guard|startup manager/i.test(text)) return 'Kanban'
  const ib = /injectbuddy/i.test(text)
  const tf = /tradeflow/i.test(text)
  if (ib && tf) return 'Multiple'
  if (ib) return 'InjectBuddy'
  if (tf) return 'Tradeflow'
  return 'All projects'
}

function requestTime(lines) {
  for (const line of lines) {
    if (!/^\s*-?\s*(Requested at|User request recorded|Created at):/i.test(line)) continue
    const at = line.match(TIME)?.[1]
    if (at) return at
  }
  return null
}

function assignedTo(lines) {
  for (const line of lines) {
    const m = clean(line).match(/^-?\s*Assigned (?:to|Manager):\s*([^.;]+)/i)
    if (m) return clean(m[1]).replace(/\s+because\b.*$/i, '') || null
  }
  for (const line of lines) {
    const m = clean(line).match(/\bManager\s+([A-Za-z0-9_-]+)\s+owns\b/i)
    if (m) return m[1]
  }
  return null
}

function statusFrom(line) {
  const text = clean(line)
  if (!text) return null

  const explicit = text.match(/\bStatus:\s*([^.;]+)/i)?.[1]
  if (explicit) return normalizeStatus(explicit)
  if (/Verified outcome or decision needed:/i.test(text)) {
    if (/completed|complete|PASS/i.test(text)) return 'done'
    if (/blocked|blocker|stopped|failed|fail/i.test(text)) return 'blocked'
    return /\bdecision needed\b|awaiting|pending/i.test(text) ? 'needs decision' : null
  }
  if (/Result\b/i.test(text)) {
    if (/completed|complete|PASS/i.test(text)) return 'done'
    return /blocked|blocker|stopped|failed|fail/i.test(text) ? 'blocked' : 'done'
  }
  if (/\bBlocker checkpoint\b/i.test(text)) return 'blocked'
  if (/\bstatus working\b/i.test(text)) return 'working'
  if (/Manager pickup|acknowledges ownership|in progress|working/i.test(text)) return 'working'
  if (/Independent review.*PASS|Reviewer.*PASS/i.test(text)) return 'review pass'
  if (/handed off|handoff|delegated|assigned|queued/i.test(text)) return 'handed off'
  if (/decision needed|awaiting|pending/i.test(text)) return 'needs decision'
  if (/paused|pause|hold|deferred|tabled/i.test(text)) return 'paused'
  return null
}

function normalizeStatus(value) {
  const v = value.toLowerCase()
  if (/done|complete|pass/.test(v)) return 'done'
  if (/block|fail|stop/.test(v)) return 'blocked'
  if (/progress|working|pickup/.test(v)) return 'working'
  if (/handoff|handed|assign|queued/.test(v)) return 'handed off'
  if (/decision|await|pending/.test(v)) return 'needs decision'
  if (/pause|hold|defer|table/.test(v)) return 'paused'
  return clean(value).slice(0, 60) || 'unknown'
}

function sections(markdown) {
  const out = []
  let current = null

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(HEADING)?.[1]
    if (heading) {
      if (current) out.push(current)
      const ids = [...heading.matchAll(REQ)].map((m) => `REQ-${m[1]}-${m[2]}`)
      current = ids.length === 1 && !/^NOTIFY\b/i.test(heading)
        ? { id: ids[0], title: titleFrom(heading, ids[0]), primary: /^REQ-\d{8}-\d{3}\b/.test(heading), lines: [] }
        : null
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) out.push(current)
  return out
}

export function parseManagerTasks(markdown) {
  const tasks = new Map()

  sections(markdown).forEach((section, index) => {
    const { date, seq } = dateFrom(section.id)
    const prev = tasks.get(section.id) ?? {
      id: section.id,
      date,
      seq,
      time: null,
      timeKnown: false,
      project: 'All projects',
      description: descriptionFrom(section.title, section.lines, section.id),
      assignedTo: null,
      status: 'unknown',
      updatedAt: null,
      order: index,
    }

    if (!prev.seenPrimary && section.primary) {
      prev.description = descriptionFrom(section.title, section.lines, section.id)
      prev.seenPrimary = true
    }
    prev.project = canonicalProject(inferProject(prev.description, section.lines.join('\n')))
    prev.category = section.lines.join('\n').match(/^\s*-?\s*Category:\s*(.+)$/im)?.[1]?.trim() || prev.category || categoryFor(prev.description)
    prev.order = index
    prev.assignedTo = assignedTo(section.lines) || prev.assignedTo

    const at = requestTime(section.lines)
    if (at) {
      prev.time = at
      prev.timeKnown = true
    }

    for (const line of section.lines) {
      const status = statusFrom(line)
      if (!status) continue
      prev.status = status
      prev.updatedAt = line.match(TIME)?.[1] ?? prev.updatedAt
    }

    tasks.set(section.id, prev)
  })

  return [...tasks.values()]
    .map(({ seenPrimary, ...task }) => ({ ...task, assignedTo: task.assignedTo || 'Unknown' }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.seq - a.seq || b.order - a.order)
}

export function readManagerTasks(path) {
  if (!existsSync(path)) throw new Error(`request log not found: ${path}`)
  return parseManagerTasks(readFileSync(path, 'utf8'))
}

export function canonicalProject(name) {
  if (/^(kanban|herdr|orchestration( and tools)?)$/i.test(name)) return 'Orchestration and Tools'
  if (/^injectbuddy(?:[- ].*)?$/i.test(name)) return 'InjectBuddy'
  if (/kiwitown/i.test(name)) return 'Kiwitown'
  if (/last tahi|games hq/i.test(name)) return 'Games HQ'
  if (/healthypets/i.test(name)) return 'HealthyPets'
  return name
}
function categoryFor(title) {
  if (/usage|token|cost/i.test(title)) return 'Usage & Costs'
  if (/seo|search|citation/i.test(title)) return 'SEO'
  if (/security|permission|privilege/i.test(title)) return 'Security'
  if (/mobile|drawer|onboarding|layout|ui|ux|table|page/i.test(title)) return 'UI/UX'
  if (/data|schema|migration/i.test(title)) return 'Data'
  if (/hook|routing|board|planner|replan|agent|mission|model|dispatch|startup/i.test(title)) return 'Automation'
  return 'General'
}
