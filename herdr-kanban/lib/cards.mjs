// Card model. A card is a markdown file; its column is the folder it sits in.
// Nothing is duplicated into a database — the filesystem is the source of truth.

import { readdirSync, readFileSync, writeFileSync, appendFileSync, statSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, basename, resolve, dirname, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { recoveryTransition } from './recovery.mjs'
import { auditArchiveError } from './audit-routing.mjs'
import { appendHistory, writeCurrentFeedback } from './card-history.mjs'
import { CARD_ID, nextCardId } from './ids.mjs'

const TEMPLATE = new URL('../TASK-TEMPLATE.md', import.meta.url)
const AUDIT_TEMPLATES = {
  seo: new URL('../AUDIT-TEMPLATES/SEO.md', import.meta.url),
  contrast: new URL('../AUDIT-TEMPLATES/CONTRAST.md', import.meta.url),
  design: new URL('../AUDIT-TEMPLATES/DESIGN.md', import.meta.url),
}
export const AUDITS = Object.keys(AUDIT_TEMPLATES)

// `workspace` (absolute) is passed only at a Planner handoff, so cards already
// queued or working are never blocked retroactively by the plan check.
export function validatePlan(text, { requireReadiness = false, workspace: planRoot = null } = {}) {
  const section = (name) => (text.match(new RegExp(`^## ${name}\\s*\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'))?.[1] ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/^\*\*Callers checked:\*\*\s*$/gm, '').trim()
  const workspace = text.match(/^\*\*Workspace:\*\*\s*([^\n]+)$/im)?.[1]?.trim() || '.'
  const readinessLine = text.match(/^\*\*Plan readiness:\*\*[^\n]*$/im)?.[0]
  const readiness = text.match(/^\*\*Plan readiness:\*\*\s*(build-ready|investigation)\s*$/im)?.[1]?.toLowerCase()
  if (requireReadiness && !readinessLine) throw new Error('Plan incomplete: authenticated Planner handoff requires **Plan readiness:** build-ready or investigation')
  if (readinessLine && !readiness) throw new Error('Plan incomplete: Plan readiness must be build-ready or investigation')
  if (/^[A-Za-z]:|^\/|(^|\/)\.\.(\/|$)/.test(workspace.replace(/\\/g, '/'))) {
    throw new Error('Plan incomplete: Workspace must be a project-relative path')
  }
  for (const name of ['Approved brief', 'Files', 'Implementation plan', 'Acceptance criteria']) {
    if (!section(name)) throw new Error(`Plan incomplete: fill ## ${name} before handoff; keep the template headings`)
  }
  if (/^\*\*Workflow version:\*\* 2$/m.test(text)) {
    const criteria = [...section('Acceptance criteria').matchAll(/^-\s+(AC\d+):\s+\S.+$/gm)].map(m => m[1])
    const checks = section('Outcome checks')
    if (!criteria.length || new Set(criteria).size !== criteria.length || criteria.some(id => !new RegExp(`^\\s*\\|?\\s*${id}\\s*\\|\\s*[^|]+\\|\\s*[^|]+\\|\\s*[^|]+\\|?\\s*$`, 'm').test(checks))) throw new Error('Plan incomplete: map each AC ID to change, acceptance check and negative check under Outcome checks')
    if (!section('Prerequisites')) throw new Error('Plan incomplete: state workspace prerequisites (or explicitly none)')
  }
  const files = [...section('Files').matchAll(/^-\s+`([^`]+)`/gm)].map(m => m[1])
  if (!files.length || files.some(p => /[\\:*?<>]|(^|\/)\.\.(\/|$)|^\//.test(p) || !/\.(tsx?|jsx?|mjs|css|json|md|html?)$/.test(p) && !(readiness === 'investigation' && p.endsWith('/')))) {
    throw new Error('Plan incomplete: ## Files needs exact relative file paths as - `path/to/file.css` bullets (no placeholders or globs)')
  }
  if (/^\*\*Trivial:\*\*\s*yes\s*$/im.test(text) && files.length > 2) {
    throw new Error('Trivial cards may list no more than two files')
  }
  if (readiness === 'investigation') {
    const plan = section('Implementation plan').replaceAll('**', '')
    if (!/(?:check|measurement)\s*(?:commands?|method)?\s*:\s*\S|setup\/start\/check commands?[^\n]*\n[\s\S]*?```/i.test(plan) || !/(?:expected result|disposition)\s*:\s*\S/i.test(plan) || !/stop rules?\s*:\s*\S/i.test(plan)) {
      throw new Error('Plan incomplete: investigation needs a measurement/check, expected result or disposition, and stop rules')
    }
    // Checked last: only the operator can add this marker, so a plan failing on it
    // alone is waiting for the operator, not for more planning (T-148).
    if (!/^\*\*Investigation approved:\*\* yes\s*$/im.test(text.split(/^## Approved brief/m)[0])) throw Object.assign(new Error('Plan incomplete: investigation requires explicit approval on the card'), { operatorApproval: true })
  }
  if (readiness === 'build-ready') {
    const plan = section('Implementation plan')
    const required = [
      ['agreed outcome', /(?:^|\n)[ \t]*(?:[-*][ \t]*)?(?:outcome|agreed outcome)[ \t]*:[ \t]*[^\r\n]+/im],
      ['unchanged constraints', /(?:^|\n)[ \t]*(?:[-*][ \t]*)?unchanged constraints?[ \t]*:[ \t]*[^\r\n]+/im],
      ['observed cause and evidence', /(?:^|\n)[ \t]*(?:[-*][ \t]*)?(?:observed cause|cause)[ \t]*:[ \t]*[^\r\n]+[\s\S]*?(?:^|\n)[ \t]*evidence[ \t]*:[ \t]*[^\r\n]+/im],
      ['inspected current revision/state', /(?:^|\n)[ \t]*(?:[-*][ \t]*)?inspected current (?:revision\/state|revision|state)[ \t]*:[ \t]*[^\r\n]+/im],
      ['concrete changes', /(?:^|\n)[ \t]*(?:[-*][ \t]*)?(?:change|changes|concrete changes)[ \t]*:[ \t]*[^\r\n]+/im],
      ['runnable check and expected result', /(?:^|\n)[ \t]*(?:[-*][ \t]*)?(?:check|check command|setup)[ \t]*:[ \t]*[^\r\n]+[\s\S]*?(?:^|\n)[ \t]*(?:expected(?: result)?|result)[ \t]*:[ \t]*[^\r\n]+/im],
      ['scope/stop rules', /(?:^|\n)[ \t]*(?:[-*][ \t]*)?(?:scope|stop rules?)[ \t]*:[ \t]*[^\r\n]+/im],
    ]
    const missing = required.filter(([, pattern]) => !pattern.test(plan)).map(([name]) => name)
    if (missing.length) throw new Error(`Plan incomplete: build-ready plan needs ${missing.join(', ')}`)
    const cause = plan.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:observed cause|cause)\s*:\s*([^\n]+)/i)?.[1] || ''
    if (/\b(?:unknown|unclear|tbd|todo|investigate)\b/i.test(cause)) throw new Error('Plan incomplete: unknown cause is investigation, not build-ready')
    const fileSection = section('Files')
    if ([...fileSection.matchAll(/^[-*]\s+`[^`]+`\s*$/gm)].length) throw new Error('Plan incomplete: each build-ready file needs a concrete target/purpose')
    if (planRoot) {
      for (const [, path, rest] of fileSection.matchAll(/^[-*]\s+`([^`]+)`([^\n]*)/gm)) {
        if (!/\(new\b[^)]*\)/i.test(rest) && !existsSync(resolve(planRoot, path))) throw new Error(`Plan check failed: ## Files path ${path} does not exist in ${planRoot.replaceAll('\\', '/')}. Fix the path, or mark a file this card creates with (new).`)
      }
      if (!/^\*\*Callers checked:\*\*[ \t]*\S/m.test(plan)) throw new Error('Plan check failed: ## Implementation plan needs a **Callers checked:** line listing every file that references each changed function/export (or "none"). Grep for each changed symbol first.')
    }
  }
}

// A complete plan held only by an operator-only marker. The board asks the operator
// once (Owner) instead of re-prompting a Planner that cannot add the marker.
export function awaitsOperatorApproval(text) {
  try { validatePlan(text) } catch (error) { return !!error.operatorApproval }
  return false
}
export const approvalQuestion = (id) => `Approve the investigation for ${id}? The plan is ready, but only you can approve it: add the line \`**Investigation approved:** yes\` above ## Approved brief, then drag the card back to Planning. Or edit or cancel the card.`
export function askForApproval(tasksDir, card) {
  const moved = moveCard(tasksDir, card.id, 'owner')
  writeCurrentFeedback(tasksDir, moved, 'Needs you', approvalQuestion(card.id))
  return moved
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
  { key: 'review',    dir: 'review',    label: 'Review'    },
  { key: 'completed', dir: 'completed', label: 'Completed' },
]

// Not a column — a collapsed drawer at the end of the board.
export const ARCHIVE = { key: 'archive', dir: 'archive', label: 'Archive' }

const ALL = [...COLUMNS, ARCHIVE]

export const columnByKey = (key) => ALL.find((c) => c.key === key)

// Files that live in TASKS/ but are not cards.
const NOT_A_CARD = /^(README|TASK-TEMPLATE|PROJECT-CONSTRAINTS|PROJECT-WORKSPACES|TASKLOG|BRIEF)\.md$/i

const HEADING = new RegExp(String.raw`^#\s+(?:(${CARD_ID})\s*[—–-]\s*)?(.+)$`, 'm')
// Legacy T- ids were matched case-insensitively in file names; prefixed ids are
// capitals only, so an ordinary file such as v2-notes.md is never read as an id.
const ID_FROM_NAME = /^([Tt]-\d+|[A-Z]{1,3}\d+(?![A-Za-z0-9]))/
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
const AGENT_SETTING = /\*\*(Planner|Builder|Reviewer|Issues|Trivial)\s+(engine|model|reasoning):\*\*\s*([^\n]+)$/gim
const AGENT_STAGE = { Planner: 'planning', Builder: 'working', Reviewer: 'review', Issues: 'issues', Trivial: 'trivial' }
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
const FILES_SECTION = /##\s*Files\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i
const FILE_LINE = /^-\s*`([^`]+)`/gm
const DIRTY_SNAPSHOT = /^\*\*Dirty snapshot:\*\*[^\n]*\n+```json\n([\s\S]*?)\n```/gm

// Metadata may follow an assignment override longer than 2KB. Truncating here
// silently loses Workflow/Auto-review and sends corrections down the wrong lane.
function readHead(path) {
  return readFileSync(path, 'utf8')
}

// Agents append their reason to the bottom of the card, so the one line the
// operator actually needs lives in the tail, not the head.
const ASK = /\*\*(Needs you|Kicked back|Spawn failed|Review feedback)\*\*[^\n]*\n+([\s\S]+?)(?=\n+---|\n*$)/g

// How many times a reviewer has sent this card back. Counted from the card itself
// rather than kept in side state, so it survives restarts and is visible in the
// diff — and so the loop cannot be reset by deleting a state file.
const ROUND = /\*\*Review feedback\*\*/g

function readAsk(path, bytes = 8192) {
  const current = readFileSync(path, 'utf8').match(/^## Current feedback\r?\n([^\n]+): ([\s\S]*?)(?=^History entry:|^## |$(?![\s\S]))/m)
  if (current) return { kind: current[1], text: current[2].trim() }
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

// First backtick token on each `## Files` bullet line — the file path itself,
// not the descriptive prose (which often has its own backtick-quoted names).
export function cardFiles(path) {
  const section = readFileSync(path, 'utf8').match(FILES_SECTION)?.[1] ?? ''
  return [...section.matchAll(FILE_LINE)].map((m) => m[1].trim())
}

function cardWorkspace(projectPath, card) {
  return resolve(projectPath, card.workspace || '.')
}

function parseGitStatus(output) {
  const records = output.split('\0').filter(Boolean)
  const files = []
  for (let i = 0; i < records.length; i++) {
    const status = records[i].slice(0, 2)
    const path = records[i].slice(3).replace(/\\/g, '/')
    if (!path) continue
    if (status[0] === 'R' || status[0] === 'C') i++
    files.push({ path, status })
  }
  return files
}

function dirtyFiles(workspace, paths = []) {
  const args = ['-C', workspace, 'status', '--porcelain=v1', '-z']
  if (paths.length) args.push('--', ...paths)
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 30000, windowsHide: true })
  if (result.status !== 0) throw new Error(`git status failed in ${workspace}: ${(result.stderr || result.stdout).trim()}`)
  return parseGitStatus(result.stdout).map((file) => {
    const full = join(workspace, file.path)
    let sha256 = null
    try {
      if (statSync(full).isFile()) sha256 = createHash('sha256').update(readFileSync(full)).digest('hex')
    } catch { /* deleted, mid-write, or a directory: status is enough */ }
    return {
      ...file,
      sha256,
    }
  }).sort((a, b) => a.path.localeCompare(b.path))
}

export function dirtySnapshotForCard(card, projectPath, { listedOnly = false, ignoreTaskState = false } = {}) {
  const workspace = cardWorkspace(projectPath, card)
  const paths = listedOnly ? cardFiles(card.path) : []
  const files = (listedOnly && !paths.length ? [] : dirtyFiles(workspace, paths))
    .filter((f) => !ignoreTaskState || !f.path.startsWith('TASKS/'))
  return { card: card.id, workspace: card.workspace || '.', files }
}

export function appendDirtySnapshot(card, snapshot, now = new Date()) {
  if (!snapshot?.files?.length) return
  appendFileSync(card.path, `\n\n---\n\n**Dirty snapshot:** ${now.toISOString()}\n\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n`)
}

export function latestDirtySnapshot(path) {
  let latest = null
  for (const match of readFileSync(path, 'utf8').matchAll(DIRTY_SNAPSHOT)) {
    try { latest = JSON.parse(match[1]) } catch {}
  }
  return latest
}

export function currentDirtyMatchesSnapshot(card, projectPath) {
  const recorded = latestDirtySnapshot(card.path)
  if (!recorded || recorded.card !== card.id) return false
  const current = dirtySnapshotForCard(card, projectPath, { listedOnly: true, ignoreTaskState: true })
  return JSON.stringify(current) === JSON.stringify(recorded)
}

export function parseCard(path, columnKey) {
  const file = basename(path)
  const head = readHead(path)
  const text = readFileSync(path, 'utf8')
  const heading = head.match(HEADING)
  const idFromName = file.match(ID_FROM_NAME)

  const agentSettings = {}
  for (const match of text.matchAll(AGENT_SETTING)) {
    const stage = AGENT_STAGE[match[1]], field = match[2].toLowerCase()
    agentSettings[stage] ||= {}
    agentSettings[stage][field] = match[3].trim().toLowerCase()
  }
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
    agentSettings,
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
  // A pending correction invalidates any verdict retained in old evidence.
  if (/^## Current feedback\r?\nReview feedback:/m.test(text)) {
    const feedbackAt = text.indexOf('## Current feedback')
    const verdictAt = text.lastIndexOf('**Review verdict:**')
    if (verdictAt < feedbackAt) return null
  }
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

export function hasBuilderPass(card) {
  try {
    const text = readFileSync(card.path, 'utf8')
    const result = ['Implementation', 'Evidence']
      .map((name) => text.match(new RegExp(`^## ${name}\\s*\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'))?.[1]?.replace(/<!--[\\s\\S]*?-->/g, '') ?? '')
      .join('\n').replaceAll('**', '')
    return /^Stage:\s*builder\s*$/mi.test(result) && /^Outcome:\s*PASS\s*$/mi.test(result)
  } catch { return false }
}

export function canArchive(card) {
  return (!card.cardOwned && !card.mission) || card.reviewPassed || !!card.audit || hasOperatorCompletion(card) ||
    (card.cardOwned && !card.autoReview && hasBuilderPass(card) && hasIntegratedWorktree(card))
}

function hasIntegratedWorktree(card) {
  try {
    return JSON.parse(readFileSync(join(dirname(dirname(card.path)), '.board-worktrees.json'), 'utf8'))[card.id]?.state === 'integrated'
  } catch { return false }
}

// Explicit human waiver is separate from Review PASS and bound to exact evidence.
export function hasOperatorCompletion(card) {
  try {
    const tasksDir = dirname(dirname(card.path))
    const receipt = JSON.parse(readFileSync(join(tasksDir, '.operator-completions.json'), 'utf8'))[card.id]
    const work = JSON.parse(readFileSync(join(tasksDir, '.board-worktrees.json'), 'utf8'))[card.id]
    const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
    return receipt?.kind === 'explicit-user-review-waiver' && !!receipt.authorization && work?.state === 'integrated' && receipt.commit === work.commit && receipt.cardHash === hash(card.path) && receipt.evidenceHash === hash(receipt.evidencePath)
  } catch { return false }
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
export function moveCard(tasksDir, cardId, toKey, options = {}) {
  let col = columnByKey(toKey)
  if (!col) throw new Error(`unknown column: ${toKey}`)

  const card = options.sourcePath
    ? Object.values(readBoard(tasksDir)).flat().find(c => c.path === options.sourcePath)
    : findCard(tasksDir, cardId)
  if (!card) throw new Error(`unknown card source: ${options.sourcePath}`)
  if (card.column === toKey) return card
  // Completed means "built, ready to integrate". Review runs after integration,
  // so Auto-review cards need only the Builder PASS here.
  if (toKey === 'completed' && card.cardOwned && !card.trivial && !card.reviewPassed && !hasBuilderPass(card)) {
    throw new Error(`${card.id} requires Builder PASS before Completed`)
  }
  if (card.cardOwned && ['planned', 'queue'].includes(toKey)) validatePlan(readFileSync(card.path, 'utf8'), { requireReadiness: !!options.plannerAssignment, workspace: options.planWorkspace })
  if (card.column === 'archive' && toKey !== 'archive') {
    // Only reachable when every copy of the id is archived; moving one back out
    // silently is more surprising than refusing.
    throw new Error(`${card.id} only exists in archive (${card.file}) — move it by hand if you meant that`)
  }
  if (toKey === 'archive' && !options.operatorArchive && !canArchive(card)) {
    throw new Error(`${card.id} is a mission card and needs Reviewer evidence plus Review verdict: PASS before archive`)
  }

  const text = readFileSync(card.path, 'utf8')
  if (toKey === 'archive' && card.audit) {
    const error = auditArchiveError(text, id => id !== card.id && !!findCard(tasksDir, id))
    if (error) throw new Error(error)
  }
  const transition = recoveryTransition(text, card.column, toKey, options)
  toKey = transition.to
  col = columnByKey(toKey)
  const dest = join(tasksDir, col.dir)
  mkdirSync(dest, { recursive: true })
  let target = join(dest, card.file)
  if (options.sourcePath && existsSync(target)) {
    const ext = extname(card.file)
    const stem = card.file.slice(0, -ext.length)
    let copy = 2
    do { target = join(dest, `${stem}-duplicate-${copy++}${ext}`) } while (existsSync(target))
  }
  if (existsSync(target)) throw new Error(`already exists in ${toKey}: ${card.file}`)

  appendHistory(tasksDir, card.id, { event: 'transition', from: card.column, to: toKey, text, ...(options.operatorArchive && toKey === 'archive' ? { note: 'Archived by operator from board without independent review' } : {}) })
  if (transition.text !== text) writeFileSync(card.path, transition.text)
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

// `prefix` is the project's card prefix (board.config.json cardPrefixes); without
// one the project keeps issuing legacy T- ids.
export function createCard(tasksDir, { title, brief, category = 'code', workspace = '.', audit = '', tools = '', mission = '', prefix = 'T-', now = new Date() }) {
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
  const id = nextCardId(prefix, Object.values(readBoard(tasksDir)).flat().map(c => c.id))
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
