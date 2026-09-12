// Card model. A card is a markdown file; its column is the folder it sits in.
// Nothing is duplicated into a database — the filesystem is the source of truth.

import { readdirSync, readFileSync, writeFileSync, appendFileSync, statSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, basename } from 'node:path'

const TEMPLATE = new URL('../TASK-TEMPLATE.md', import.meta.url)
const AUDIT_TEMPLATES = {
  seo: new URL('../AUDIT-TEMPLATES/SEO.md', import.meta.url),
  contrast: new URL('../AUDIT-TEMPLATES/CONTRAST.md', import.meta.url),
  design: new URL('../AUDIT-TEMPLATES/DESIGN.md', import.meta.url),
}
export const AUDITS = Object.keys(AUDIT_TEMPLATES)

export function validatePlan(text) {
  const section = (name) => (text.match(new RegExp(`^## ${name}\\s*\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'))?.[1] ?? '').replace(/<!--[\s\S]*?-->/g, '').trim()
  const workspace = text.match(/^\*\*Workspace:\*\*\s*([^\n]+)$/im)?.[1]?.trim() || '.'
  if (/^[A-Za-z]:|^\/|(^|\/)\.\.(\/|$)/.test(workspace.replace(/\\/g, '/'))) {
    throw new Error('Plan incomplete: Workspace must be a project-relative path')
  }
  for (const name of ['Approved brief', 'Files', 'Implementation plan', 'Acceptance criteria']) {
    if (!section(name)) throw new Error(`Plan incomplete: fill ## ${name} before handoff; keep the template headings`)
  }
  const files = [...section('Files').matchAll(/^-\s+`([^`]+)`/gm)].map(m => m[1])
  if (!files.length || files.some(p => /[\\:*?<>]|(^|\/)\.\.(\/|$)|^\//.test(p) || !/\.(tsx?|jsx?|mjs|css|json|md|html?)$/.test(p))) {
    throw new Error('Plan incomplete: ## Files needs exact relative file paths as - `path/to/file.css` bullets (no placeholders or globs)')
  }
  if (/^\*\*Trivial:\*\*\s*yes\s*$/im.test(text) && files.length > 2) {
    throw new Error('Trivial cards may list no more than two files')
  }
}

// Column order is board order. `dir` is the folder under <project>/TASKS/.
// `backlog` and `queue` keep their historical names so existing repos need no migration.
export const COLUMNS = [
  // First, because it is the only column the board cannot act on by itself.
  { key: 'owner',     dir: 'owner',     label: 'Owner'     },
  { key: 'planning',  dir: 'planning',  label: 'Planning'  },
  { key: 'planned',   dir: 'backlog',   label: 'Planned'   },
  { key: 'queue',     dir: 'queue',     label: 'Queue'     },
  { key: 'working',   dir: 'working',   label: 'Working'   },
  { key: 'issues',    dir: 'issues',    label: 'Issues'    },
  { key: 'completed', dir: 'completed', label: 'Completed' },
  { key: 'review',    dir: 'review',    label: 'Review'    },
]

// Not a column — a collapsed drawer at the end of the board.
export const ARCHIVE = { key: 'archive', dir: 'archive', label: 'Archive' }

const ALL = [...COLUMNS, ARCHIVE]

export const columnByKey = (key) => ALL.find((c) => c.key === key)

// Files that live in TASKS/ but are not cards.
const NOT_A_CARD = /^(README|TASK-TEMPLATE|PROJECT-CONSTRAINTS|PROJECT-WORKSPACES|TASKLOG|BRIEF)\.md$/i

const HEADING = /^#\s+(?:(T-\d+)\s*[—–-]\s*)?(.+)$/m
const PRIORITY = /\*\*Priority\*\*\s*(\d+)\s*\/\s*10/i
const STATUS = /\*\*Status:\*\*\s*([^·\n]+)/i
const SURFACE = /\*\*Surface:\*\*\s*([^·\n]+)/i
const CATEGORY = /^\*\*Category:\*\*\s*([^\n]+)$/im
const WORKSPACE = /^\*\*Workspace:\*\*\s*([^\n]+)$/im
const AUDIT = /^\*\*Audit:\*\*\s*([^\n]+)$/im
export const CATEGORIES = ['ui', 'code', 'auth-security', 'data']
// Auto-review lives in the card, not in board state, so the planner can set it
// when it writes the card and a human can see it in the diff.
const AUTOREVIEW = /^\*\*Auto-review:\*\*\s*(yes|no)\s*$/im
const TRIVIAL = /^\*\*Trivial:\*\*\s*(yes|no)\s*$/im
// Planner-authored time estimates, same metadata line as Priority/Status/Surface.
const EST_BUILD = /\*\*Est build:\*\*\s*(\d+)\s*m/i
const EST_REVIEW = /\*\*Est review:\*\*\s*(\d+)\s*m/i
// Hard gate: a queued card naming a prerequisite is not spawned until that
// prerequisite has landed. See unmetBlockers in autospawn.mjs.
// The (?<!`) excludes a backtick-wrapped mention — a code-style literal used
// to talk ABOUT the field, not set it. Real incident (T-59, 2026-08-11): a
// note explaining "a line like `**Blocked by:** nothing` would be read as an
// unresolvable ID" was itself read as exactly that, self-blocking the card
// with no real field anywhere on it.
const BLOCKED_BY = /(?<!`)\*\*Blocked by:\*\*\s*([^\n]+)/i
const ISSUE_KEY = /(?<!`)\*\*Issue key:\*\*\s*([^\n]+)/i
const MISSION = /(?<!`)\*\*Mission:\*\*\s*([^\n]+)/i
const BUILD_ATTEMPT = /^\*\*Build attempt\*\*/gm
const REVIEW_FEEDBACK = /^\*\*Review feedback\*\*/gm
const RESET_MARKER_LINE = /^\*\*(Build attempt|Review feedback)\*\*/i
const REVIEWER_EVIDENCE_LINE = /^##\s+Reviewer evidence\s*$/i
const ANY_HEADING_LINE = /^#{1,6}\s+/
const REVIEW_VERDICT_LINE = /^\*\*Review verdict:\*\*\s*(PASS|FAIL|UNKNOWN)\b/i

// Read only the head of the file. Card bodies run to hundreds of lines and the
// board never shows more than the title strip.
function readHead(path, bytes = 2048) {
  const buf = readFileSync(path)
  return buf.subarray(0, bytes).toString('utf8')
}

// Agents append their reason to the bottom of the card, so the one line the
// operator actually needs lives in the tail, not the head.
const ASK = /\*\*(Needs you|Kicked back|Spawn failed|Review feedback)\*\*[^\n]*\n+([\s\S]+?)(?=\n+---|\n*$)/g

// How many times a reviewer has sent this card back. Counted from the card itself
// rather than kept in side state, so it survives restarts and is visible in the
// diff — and so the loop cannot be reset by deleting a state file.
const ROUND = /\*\*Review feedback\*\*/g

function readAsk(path, bytes = 8192) {
  const buf = readFileSync(path)
  const tail = buf.subarray(Math.max(0, buf.length - bytes)).toString('utf8')
  let last = null
  for (const m of tail.matchAll(ASK)) last = { kind: m[1], text: m[2].trim() }
  return last
}

// Counted over the whole file: rounds accumulate over a card's life, and the
// earliest ones scroll out of any tail window.
function reviewRounds(path) {
  return (readFileSync(path, 'utf8').match(ROUND) || []).length
}

const plain = (s) => (s ?? '').replace(/\*\*|`/g, '').trim()

export function parseCard(path, columnKey) {
  const file = basename(path)
  const head = readHead(path)
  const text = readFileSync(path, 'utf8')
  const heading = head.match(HEADING)
  const idFromName = file.match(/^(T-\d+)/i)

  return {
    id: (heading?.[1] || idFromName?.[1] || file.replace(/\.md$/i, '')).toUpperCase(),
    title: (heading?.[2] || file.replace(/\.md$/i, '')).trim(),
    file,
    path,
    column: columnKey,
    cardOwned: /^\*\*Workflow:\*\* card-owned$/m.test(head),
    createdAt: head.match(/^\*\*Created:\*\* (.+)$/m)?.[1] || null,
    priority: Number(head.match(PRIORITY)?.[1] ?? 0),
    // The board renders text, not markdown, so bold markers would show as asterisks.
    status: plain(head.match(STATUS)?.[1]),
    surface: plain(head.match(SURFACE)?.[1]),
    category: CATEGORIES.includes(plain(head.match(CATEGORY)?.[1]).toLowerCase())
      ? plain(head.match(CATEGORY)?.[1]).toLowerCase()
      : 'code',
    workspace: plain(head.match(WORKSPACE)?.[1]) || '.',
    audit: AUDITS.includes(plain(head.match(AUDIT)?.[1]).toLowerCase())
      ? plain(head.match(AUDIT)?.[1]).toLowerCase()
      : '',
    autoReview: head.match(AUTOREVIEW)?.[1]?.toLowerCase() === 'yes',
    trivial: head.match(TRIVIAL)?.[1]?.toLowerCase() === 'yes',
    estBuild: head.match(EST_BUILD)?.[1] ? Number(head.match(EST_BUILD)[1]) : null,
    estReview: head.match(EST_REVIEW)?.[1] ? Number(head.match(EST_REVIEW)[1]) : null,
    blockedBy: (head.match(BLOCKED_BY)?.[1] || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    issueKey: plain(head.match(ISSUE_KEY)?.[1]),
    mission: plain(head.match(MISSION)?.[1]),
    buildAttempts: (text.match(BUILD_ATTEMPT) || []).length,
    reviewPassed: hasCurrentReviewPass(text),
    ask: readAsk(path),
    reviewRounds: reviewRounds(path),
    mtime: statSync(path).mtimeMs,
    // When the card first existed. A column move is a rename, which keeps birthtime
    // on Windows and ext4, so this survives the card's trip across the board — mtime
    // does not, it resets every time an agent appends a note.
    added: statSync(path).birthtimeMs || statSync(path).ctimeMs,
  }
}

export function appendBuildAttempt(card, now = new Date()) {
  appendFileSync(card.path, `\n\n---\n\n**Build attempt** ${now.toISOString()}\n`)
}

export function appendReviewPass(card, note, now = new Date()) {
  appendFileSync(card.path,
    `\n\n---\n\n## Reviewer evidence\n\n${note}\n\n**Review verdict:** PASS ${now.toISOString()}\n`)
}

const realReviewerEvidence = (evidence) =>
  evidence.length > 0 && !/^(todo|tbd|n\/a|template|placeholder|\[.*\])$/i.test(evidence)

export function currentReviewDecision(text) {
  let inFence = false
  let afterReset = true
  let inReviewerEvidence = false
  let evidence = ''
  let latest = null

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (/^```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || line.startsWith('>')) continue
    if (RESET_MARKER_LINE.test(line)) {
      afterReset = true
      inReviewerEvidence = false
      evidence = ''
      latest = null
      continue
    }
    if (REVIEWER_EVIDENCE_LINE.test(line)) {
      inReviewerEvidence = afterReset
      evidence = ''
      continue
    }
    const verdict = line.match(REVIEW_VERDICT_LINE)
    if (verdict && afterReset) {
      latest = { verdict: verdict[1], evidence: evidence.trim() }
      inReviewerEvidence = false
      continue
    }
    if (inReviewerEvidence && ANY_HEADING_LINE.test(line)) {
      inReviewerEvidence = false
      continue
    }
    if (inReviewerEvidence) evidence += `${raw}\n`
  }
  if (!latest || !realReviewerEvidence(latest.evidence)) return null
  return latest
}

export function hasCurrentReviewPass(text) {
  return currentReviewDecision(text)?.verdict === 'PASS'
}

export function canArchive(card) {
  return card.trivial || !card.mission || card.reviewPassed
}

// Priority lives in the card's metadata line, same as everything else the board
// reads. Editing it here keeps the file the single source of truth.
export function setPriority(tasksDir, cardId, priority) {
  const n = Math.max(0, Math.min(10, Math.round(Number(priority))))
  if (!Number.isFinite(n)) throw new Error(`priority must be 0-10, got: ${priority}`)

  const card = findCard(tasksDir, cardId)
  const text = readFileSync(card.path, 'utf8')

  let next
  if (PRIORITY.test(text)) {
    next = text.replace(PRIORITY, `**Priority** ${n}/10`)
  } else {
    const heading = text.match(HEADING)
    const line = `**Priority** ${n}/10`
    next = heading ? text.replace(heading[0], `${heading[0]}\n\n${line}`) : `${line}\n\n${text}`
  }
  if (next !== text) writeFileSync(card.path, next)
  return { ...card, priority: n }
}

// Toggle the auto-review marker by rewriting the one line in the card. The card
// stays the source of truth, so the flag survives outside the board entirely.
export function setAutoReview(tasksDir, cardId, on) {
  const card = findCard(tasksDir, cardId)
  const text = readFileSync(card.path, 'utf8')
  const has = AUTOREVIEW.test(text)

  let next
  if (!on) {
    // Off means no marker, not a marker saying no. Toggling on and back off has
    // to leave the card byte-identical, or every toggle dirties someone's diff.
    next = has ? text.replace(/\n*^\*\*Auto-review:\*\*[^\n]*\n/im, '\n') : text
  } else if (has) {
    next = text.replace(AUTOREVIEW, '**Auto-review:** yes')
  } else {
    // Put it directly under the heading, where the other metadata already lives.
    const heading = text.match(HEADING)
    next = heading
      ? text.replace(heading[0], `${heading[0]}\n\n**Auto-review:** yes`)
      : `**Auto-review:** yes\n\n${text}`
  }
  if (next !== text) writeFileSync(card.path, next)
  return { ...card, autoReview: on }
}

function readColumn(tasksDir, col) {
  const dir = join(tasksDir, col.dir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.md') && !NOT_A_CARD.test(f))
    .map((f) => {
      try {
        return parseCard(join(dir, f), col.key)
      } catch {
        return null // a file mid-write; the next watch event will pick it up
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
}

// A parked card is one an agent has already declared unresolvable without the
// operator (`hkb park`). The auto-manager sweep skips it, so a card that needs a
// credential or a taste call is not re-read every 15 minutes forever. Clearing the
// marker is the operator's act — edit or move the card and the sweep sees it again.
export const isParked = (card) => /\*\*Parked\*\*/.test(readFileSync(card.path, 'utf8'))

// Full board snapshot: { planning: [...], planned: [...], ..., archive: [...] }
export function readBoard(tasksDir) {
  const board = {}
  for (const col of ALL) board[col.key] = readColumn(tasksDir, col)
  return board
}

// Ids come from filenames, and real repos reuse numbers over time — an archived
// T-06 and a live T-06 can genuinely coexist. Archive never wins, and a tie
// between two live cards is an error rather than a coin flip, because the caller
// is usually about to move one of them.
export function findCard(tasksDir, cardId) {
  const id = String(cardId).toUpperCase()
  const all = Object.values(readBoard(tasksDir)).flat().filter((c) => c.id === id)
  if (!all.length) throw new Error(`unknown card: ${cardId}`)

  const live = all.filter((c) => c.column !== 'archive')
  if (live.length > 1) {
    throw new Error(`${id} is ambiguous — ${live.map((c) => `${c.column}/${c.file}`).join(' and ')}`)
  }
  return live[0] ?? all[0]
}

// Move a card between columns. This IS the state change — there is nothing else to update.
export function moveCard(tasksDir, cardId, toKey) {
  const col = columnByKey(toKey)
  if (!col) throw new Error(`unknown column: ${toKey}`)

  const card = findCard(tasksDir, cardId)
  if (card.column === toKey) return card
  if (card.cardOwned && ['planned', 'queue'].includes(toKey)) validatePlan(readFileSync(card.path, 'utf8'))
  if (card.column === 'archive' && toKey !== 'archive') {
    // Only reachable when every copy of the id is archived; moving one back out
    // silently is more surprising than refusing.
    throw new Error(`${card.id} only exists in archive (${card.file}) — move it by hand if you meant that`)
  }
  if (toKey === 'archive' && !canArchive(card)) {
    throw new Error(`${card.id} is a mission card and needs Reviewer evidence plus Review verdict: PASS before archive`)
  }

  const dest = join(tasksDir, col.dir)
  mkdirSync(dest, { recursive: true })
  const target = join(dest, card.file)
  if (existsSync(target)) throw new Error(`already exists in ${toKey}: ${card.file}`)

  renameSync(card.path, target)
  return { ...card, column: toKey, path: target }
}

function constraintsFor(tasksDir, category) {
  const path = join(tasksDir, 'PROJECT-CONSTRAINTS.md')
  if (!existsSync(path)) return '<!-- Optional; populated only when this project has relevant constraints. -->'
  const text = readFileSync(path, 'utf8')
  const section = (name) => text.match(new RegExp(`^## ${name}\\s*\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'))?.[1]?.trim()
  return [section('all'), section(category)].filter(Boolean).join('\n\n')
    || '<!-- No project-specific constraints for this category. -->'
}

export function createCard(tasksDir, { title, brief, category = 'code', workspace = '.', audit = '', tools = '', mission = '', now = new Date() }) {
  if (typeof title !== 'string' || !title.trim() || title.length > 200 || /[\r\n]/.test(title)) throw new Error('A single-line title of at most 200 characters is required')
  if (typeof brief !== 'string' || !brief.trim() || brief.length > 50000) throw new Error('An approved brief of at most 50000 characters is required')
  if (typeof mission !== 'string' || /[\r\n]/.test(mission)) throw new Error('Invalid mission')
  category = String(category).toLowerCase()
  if (!CATEGORIES.includes(category)) throw new Error(`Category must be one of: ${CATEGORIES.join(', ')}`)
  workspace = String(workspace).replace(/\\/g, '/').trim() || '.'
  if (/^[A-Za-z]:|^\/|(^|\/)\.\.(\/|$)/.test(workspace)) throw new Error('Workspace must be a project-relative path')
  audit = String(audit).toLowerCase()
  if (audit && !AUDITS.includes(audit)) throw new Error(`Audit must be one of: ${AUDITS.join(', ')}`)
  if (audit && (typeof tools !== 'string' || !tools.trim())) throw new Error('Audit cards require exact tools/MCPs')
  const highest = Math.max(0, ...Object.values(readBoard(tasksDir)).flat().map(c => Number(c.id.match(/^T-(\d+)$/)?.[1]) || 0))
  const id = `T-${highest + 1}`
  const dir = join(tasksDir, audit ? 'review' : 'planning')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, audit ? `${id}-audit-${audit}.md` : `${id}-approved-job.md`)
  const template = readFileSync(audit ? AUDIT_TEMPLATES[audit] : TEMPLATE, 'utf8')
  // The project copy is a reference; creation always uses the board's canonical template.
  if (!audit) writeFileSync(join(tasksDir, 'TASK-TEMPLATE.md'), template)
  const values = { ID: id, TITLE: title.trim(), CREATED: now.toISOString(), CATEGORY: category, WORKSPACE: workspace, AUDIT: audit, TOOLS: tools.trim(), MISSION: mission ? `**Mission:** ${mission}` : '', BRIEF: brief.trim(), PROJECT_CONSTRAINTS: constraintsFor(tasksDir, category) }
  writeFileSync(path, template.replace(/\{\{(ID|TITLE|CREATED|CATEGORY|WORKSPACE|AUDIT|TOOLS|MISSION|BRIEF|PROJECT_CONSTRAINTS)\}\}/g, (_, key) => values[key]), { flag: 'wx' })
  return parseCard(path, audit ? 'review' : 'planning')
}
