#!/usr/bin/env node
import { recordBuilderReturn } from './lib/workflow-state.mjs'
import { formatNZTime, formatNZText } from './lib/nz-time.mjs'
// hkb — the one command a working agent runs to report back.
//
//   node hkb.mjs done  T-02
//   node hkb.mjs issue T-02 "acceptance criterion 3 fails at 390px"
//   node hkb.mjs owner T-02 "needs the Supabase service key, which I must not read"
//   node hkb.mjs park  T-02 "needs your bank details — no agent can supply them"
//   node hkb.mjs pass  T-02
//   node hkb.mjs move  T-02 review
//   node hkb.mjs found T-02 "e2e/x.spec.ts fails on base too: ..."
//   node hkb.mjs found --board T-02 "hkb refused a valid handoff: ..."
//   node hkb.mjs wait  T-02 "public/x/y.html, T-03" "the page this plan edits is created by T-03"
//   node hkb.mjs covered T-02 T-03 "node check.mjs -> PASS"
//   node hkb.mjs result T-02 --file result.md   (Builder: write ## Implementation and ## Evidence, or pipe the text)
//   node hkb.mjs files T-02 path [path ...]     (Builder, before the first edit: exit 1 names the needed files ## Files misses)
//   node hkb.mjs tests T-02 <name> "<command>" [--timeout <seconds>]   (Builder: hand a long test run to the board and stop)
//
// Run it from the project root. Moving the card IS the report; there is no
// separate status to update and nothing to keep in sync.
//
// issue vs owner: `issue` is a technical problem another agent could pick up.
// `owner` is a decision, credential, asset or judgement call only the human can
// supply — no amount of agent effort will resolve it.

import { existsSync, appendFileSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { moveCard, validatePlan, columnByKey, findCard, updateCard, canArchive, cardFiles, dirtySnapshotForCard, appendDirtySnapshot, setAutoReview, awaitsOperatorApproval, approvalQuestion, readBoard, waitingOnPrerequisites, builderResultError, replaceResultSections, parseResultText, unglueHeadings, createCard, planEditedFiles, missingFromFiles } from './lib/cards.mjs'
import { difficultyFromText } from './lib/difficulty.mjs'
import { unbind, readBindings } from './lib/bindings.mjs'
import { activityLog } from './lib/activity.mjs'
import { worktreeForCard, completeUnchangedWorktree, resolveGitSettings, readWorktrees, handoffCommitError, integrationStartHoldReason } from './lib/worktrees.mjs'
import { explicitOwnerReason } from './lib/owner-reason.mjs'
import { auditDestination, auditStatus, auditOutcome } from './lib/audit-routing.mjs'
import { requestPlannerCorrection, readCardPlanners, ESCALATION_MODEL } from './lib/card-planner.mjs'
import { approvedManagedModel } from './lib/herdr.mjs'
import { assertReviewHandoff, assertReviewInputs, reviewClaimFor } from './lib/review-claims.mjs'
import { fileURLToPath } from 'node:url'
import { postInbox } from './lib/inbox.mjs'
import { appendHistory, writeCurrentFeedback, repairHandoffSections, repeatedFinding } from './lib/card-history.mjs'
import { failureCategory, failureDestination, updateWorkflow, recordOperationalFailure, readWorkflow } from './lib/workflow-state.mjs'
import { stopCardRun } from './lib/card-run.mjs'
import { recoveryState } from './lib/recovery.mjs'
import { assertPlannerHandoff } from './lib/planner-state.mjs'
import { CARD_ID } from './lib/ids.mjs'

const args = process.argv.slice(2)
let tasksDir = join(process.cwd(), 'TASKS')
if (args[0] === '--tasks') {
  if (!args[1] || !isAbsolute(args[1])) fail('--tasks needs an absolute TASKS directory')
  tasksDir = args[1]
  args.splice(0, 2)
}
let reviewClaim
let reviewRoot = dirname(fileURLToPath(import.meta.url))
if (args[0] === '--review-root') { reviewRoot = args[1]; args.splice(0, 2) }
if (args[0] === '--review-claim') { reviewClaim = args[1]; args.splice(0, 2) }
let plannerAssignment
if (args[0] === '--planner-assignment') { plannerAssignment = args[1]; args.splice(0, 2) }
const [verb, cardId, ...rest] = args
const note = rest.join(' ').trim()

if (verb === 'show') {
  if (!cardId) fail('missing card id, e.g. hkb show T-02')
  if (!existsSync(tasksDir)) fail(`no TASKS folder at ${tasksDir}`)
  try {
    const card = findCard(tasksDir, cardId)
    process.stdout.write(`${resolve(card.path)}\n${readFileSync(card.path, 'utf8')}`)
    process.exit(0)
  } catch (err) { fail(err.message) }
}

// result: write the Builder's ## Implementation and ## Evidence bodies from text (--file, else stdin),
// refusing exactly what done would, so no helper script is needed (HK25).
if (verb === 'result') {
  if (!cardId) fail('missing card id, e.g. hkb result T-02 --file result.md')
  if (!existsSync(tasksDir)) fail(`no TASKS folder at ${tasksDir}`)
  try {
    const card = findCard(tasksDir, cardId)
    if (card.column !== 'working') fail(`result writes the Builder's sections; ${cardId} is in ${card.column}`)
    const file = rest[rest.indexOf('--file') + 1]
    let input = ''
    try { input = readFileSync(rest.includes('--file') && file ? file : 0, 'utf8') } catch {}
    if (!input.trim()) fail('result needs the text: hkb result T-02 --file <path>, or pipe it on stdin')
    const bodies = parseResultText(input), next = replaceResultSections(readFileSync(card.path, 'utf8'), bodies)
    // done splits the card at "## Implementation|Evidence|Reviewer evidence" in mid-line, so refuse text that would be cut.
    const midLine = Object.values(bodies).some(body => unglueHeadings(body) !== body)
    const error = midLine ? 'result text has "## Implementation", "## Evidence" or "## Reviewer evidence" in the middle of a line, where hkb done would split the card; reword it without the leading ##' : builderResultError('done', unglueHeadings(next))
    if (error) fail(error)
    writeFileSync(card.path, next)
    console.log(`${cardId}: Implementation and Evidence written; run hkb done ${cardId} when the commit is ready`)
    process.exit(0)
  } catch (err) { fail(err.message) }
}

// files: read-only Files check a Builder runs before its first edit (HK41); writes nothing, so the issue path and return count are untouched.
if (verb === 'files') {
  if (!cardId || !rest.length) fail('usage: hkb files T-02 <path> [<path> ...] (workspace-relative, written as ## Files writes them)')
  if (!existsSync(tasksDir)) fail(`no TASKS folder at ${tasksDir}`)
  const bad = rest.find(p => isAbsolute(p) || /^[a-z]:/i.test(p) || p.split(/[\\/]/).includes('..'))
  if (bad) fail(`files paths are workspace-relative, as ## Files writes them; "${bad}" is not`)
  try {
    const card = findCard(tasksDir, cardId)
    if (card.column !== 'working') fail(`files checks a Builder's scope; ${cardId} is in ${card.column}`)
    const missing = missingFromFiles(readFileSync(card.path, 'utf8'), rest)
    if (!missing.length) { console.log(`FILES OK ${cardId}: all ${rest.length} paths are in ## Files; edit now`); process.exit(0) }
    const list = missing.join(', ')
    console.log(`FILES MISSING ${cardId}: ${list}\nHand back now, before any edit: issue ${cardId} "[planning] ## Files misses: ${list}; needed because <why>"`)
    process.exit(1)
  } catch (err) { fail(err.message) }
}

// tests: hand a long test command to the board and stop; the board runs it, saves the result in
// the card's evidence folder and starts a fresh short agent on it (HK64).
if (verb === 'tests') {
  const name = rest[0], timeoutAt = rest.indexOf('--timeout')
  const command = (timeoutAt > 0 ? rest.slice(1, timeoutAt) : rest.slice(1)).join(' ').trim()
  const timeoutSeconds = timeoutAt > 0 ? Number(rest[timeoutAt + 1]) : undefined
  if (!cardId || !name || !command) fail('usage: hkb tests T-02 <name> "<command>" [--timeout <seconds>]')
  if (!existsSync(tasksDir)) fail(`no TASKS folder at ${tasksDir}`)
  try {
    const { submitTestRun } = await import('./lib/test-handoff.mjs')
    const run = submitTestRun({ tasksDir, cardId, name, command, cwd: process.cwd(), timeoutSeconds })
    console.log(`TEST RUN HANDED OFF ${cardId} ${name}: result will be at ${run.record}; a fresh agent starts on it. Stop now.`)
    process.exit(0)
  } catch (err) { fail(err.message) }
}

if (reviewClaim && verb !== 'plancheck' && reviewClaimFor(reviewRoot, tasksDir, cardId)?.role === 'plancheck') fail('Plan checker permits only plancheck handoffs')

if (verb === 'plancheck') {
  try {
    const { finishPlanCheck } = await import('./lib/autospawn.mjs')
    console.log(JSON.stringify(finishPlanCheck({ tasksDir, cardId, reviewRoot, claimId: reviewClaim, verdict: rest[0], evidence: rest.slice(1).join(' ') })))
    process.exit(0)
  } catch (err) { fail(err.message) }
}

const VERBS = { audit: 'planning', covered: 'archive', done: null, unchanged: 'completed', issue: 'planning', owner: 'owner', park: 'owner', split: 'owner', review: 'review', rework: 'planning', pass: null, move: null }

// What gets stamped above the note, and what the board reads back out.
// split: an investigation found several separate issues. The card stops, and the project's
// orchestrator turns each finding into its own card (operator, 2026-09-25).
const HEADING = { issue: 'Kicked back', owner: 'Needs you', park: 'Parked', split: 'Split needed', rework: 'Review feedback' }

// Repeated failed reviews require deeper Planner diagnosis, never a human dump.
const MAX_REVIEW_ROUNDS = 3

// The plan check at a Planner handoff: the card's workspace in the project's integration
// checkout (where ## Files paths must already exist) and the project's sharedFiles.
function planCheck(card) {
  // I863: an already-covered card must close before the unchanged-base gate.
  if (!cardFiles(card.path).length) fail(`no exact files listed: list the files to change, or if another card already fixed this use hkb covered ${card.id} <card> "<check> -> <result>"`)
  const projectPath = dirname(tasksDir)
  const gitSettings = projectSettings()
  const integration = resolveGitSettings({ projectPath, gitSettings })?.integrationPath
  const repoRoot = integration || projectPath
  const planWorkspace = resolve(repoRoot, card.workspace || '.')
  // IA98 (2026-10-09): the Planner drafted its check in the integration checkout; the board then held the card there for hours.
  const dirty = integration && integrationStartHoldReason({ repoRoot, workspace: planWorkspace, card })?.match(/substantive changes: (.+); preserved/)?.[1]
  if (dirty) fail(`${dirty} is changed or untracked in the integration checkout ${repoRoot}, so the board will not start ${card.id}. If you drafted it, move it to TASKS/.evidence/${card.id}/ and point the card there; otherwise hkb found --board ${card.id} "${dirty} dirty in integration".`)
  return { planWorkspace, sharedFiles: gitSettings?.sharedFiles }
}

// This project's projectSettings entry in the board config (read-only). No config: none, so the
// project's own Git root is the integration checkout and findings go to the Kanban Manager.
function projectSettings() {
  try {
    const config = JSON.parse(readFileSync(process.env.KANBAN_CONFIG || fileURLToPath(new URL('./board.config.json', import.meta.url)), 'utf8'))
    const name = config.projects?.find(p => resolve(config.projectsRoot, p).toLowerCase() === resolve(dirname(tasksDir)).toLowerCase())
    return config.projectSettings?.[name]
  } catch { return undefined }
}

// Same id prefix POST /api/cards gives a new card for this project, for split --parts' children.
function projectCardPrefix(project) {
  try {
    const config = JSON.parse(readFileSync(process.env.KANBAN_CONFIG || fileURLToPath(new URL('./board.config.json', import.meta.url)), 'utf8'))
    return config.cardPrefixes?.[project]
  } catch { return undefined }
}

function fail(msg) {
  console.error(`hkb: ${msg}`)
  process.exit(1)
}

// One line in the project's registered manager inbox, else the Kanban Manager's. Returns who got it.
function tellManager(line, toBoard = false, code) {
  const manager = !toBoard && projectSettings()?.manager
  const inbox = manager?.inbox || process.env.KANBAN_MANAGER_INBOX || join(dirname(fileURLToPath(import.meta.url)), '..', '_roles', 'KANBAN_MANAGER-INBOX.md')
  postInbox(inbox, `- ${formatNZTime()} ${formatNZText(line)}\n`, undefined, code)
  return manager ? `${manager.chat} (project manager)` : 'the Kanban Manager'
}

// found: something outside this card's scope. The card doesn't move. The finding goes to the
// project's registered manager chat (POST /api/project-manager), else to the Kanban Manager,
// who forwards product ones. --board sends a board/process problem to the Kanban Manager
// always. I213's Builder noted two failing specs only in its card, and nobody saw them
// until the operator did (2026-09-26).
if (verb === 'found') {
  const toBoard = cardId === '--board'
  const [id, ...words] = toBoard ? rest : [cardId, ...rest]
  const finding = words.join(' ').trim()
  if (!id || !finding) fail('found needs the card and the finding with its evidence: hkb found [--board] T-02 "e2e/x.spec.ts fails on base too: ..."')
  const card = findCard(tasksDir, id)
  const project = basename(dirname(tasksDir))
  const earlier = repeatedFinding(tasksDir, finding)
  if (earlier) {
    appendHistory(tasksDir, card.id, { event: 'found', note: finding, to: 'duplicate', of: earlier })
    console.log(`hkb: ${earlier} already reported this finding; not sent again. Carry on with your card`)
    process.exit(0)
  }
  const to = tellManager(`FOUND ${project} ${card.id} (${card.column}): ${finding.replace(/\s+/g, ' ')}`, toBoard, 'FD')
  appendHistory(tasksDir, card.id, { event: 'found', note: finding, to })
  activityLog({ tasksDir, project, cardId: card.id, event: 'found', message: `${finding} (to ${to})` })
  console.log(`hkb: ${card.id} finding sent to ${to}; carry on with your card`)
  process.exit(0)
}

// wait: the plan needs a file or card that does not exist yet and is not in Blocked by.
// The card waits in Planning without counting as a failed plan; the board starts a fresh
// Planner once every file exists and every card has landed, and the manager can card the
// missing piece. 11 of 19 Planner hand-backs since 26 Sep were this, each sent as `issue`.
if (verb === 'wait') {
  const items = String(rest[0] || '').split(',').map(s => s.trim()).filter(Boolean)
  const why = rest.slice(1).join(' ').replace(/\s+/g, ' ').trim()
  if (!cardId || !items.length || !why) fail('wait needs the missing files or cards and why: hkb wait I343 "public/x/y.html, I344" "the page this plan edits is created by I344"')
  const isCard = s => new RegExp(`^${CARD_ID}$`, 'i').test(s)
  const cards = items.filter(isCard).map(s => s.toUpperCase()), files = items.filter(s => !isCard(s)).map(s => s.replaceAll('\\', '/'))
  if (files.some(f => isAbsolute(f) || f.split('/').includes('..'))) fail('wait files must be repo-relative paths, e.g. public/x/y.html')
  try {
    const current = findCard(tasksDir, cardId)
    if (current.column !== 'planning') fail(`wait is a Planner handoff; ${current.id} is in ${current.column}`)
    assertPlannerHandoff(tasksDir, current.id, plannerAssignment)
    repairHandoffSections(tasksDir, current)
    // Cards join Blocked by, so the existing prerequisite wait covers them too.
    if (cards.length) updateCard(tasksDir, current.id, { addBlockedBy: cards })
    const project = basename(dirname(tasksDir)), waitFor = { cards, files, why, since: new Date().toISOString() }
    updateWorkflow(tasksDir, current.id, { waitFor })
    // A handoff, not a failed plan: plannerIssues, the Codex failure log and escalation stay untouched.
    requestPlannerCorrection(tasksDir, current.id, { correction: false })
    appendHistory(tasksDir, current.id, { event: 'planner-wait', stage: 'planning', waitFor })
    appendHistory(tasksDir, current.id, { event: 'handoff', stage: 'planning', outcome: 'wait', note: `${items.join(', ')}: ${why}`, text: readFileSync(current.path, 'utf8') })
    const to = tellManager(`WAIT ${project} ${current.id} (planning): needs ${items.join(', ')} — ${why}`, false, 'WT')
    activityLog({ tasksDir, project, cardId: current.id, event: 'planner-wait', message: `needs ${items.join(', ')}: ${why} (to ${to})` })
    stopCardRun(project, current.id, 'Stopped at wait')
    console.log(`${current.id} waits in Planning for ${items.join(', ')}; ${to} was told. Stop now.`)
  } catch (err) { fail(err.message) }
  process.exit(0)
}

// split --parts: a Planner splits a card into several ready-to-build children in one
// step, no manager chat, no second Planner (operator, 2026-10-11). Each part is a full
// plan; every part must pass the normal Planned hand-in checks and nothing is written
// until every part has. The old numbered-findings split (below) is untouched.
if (verb === 'split' && rest[0] === '--parts') {
  const partPaths = rest.slice(1)
  if (!cardId || partPaths.length < 2) fail('split --parts needs the card id and at least two part files: hkb split I12 --parts part1.md part2.md')
  try {
    const current = findCard(tasksDir, cardId)
    if (current.column !== 'planning') fail(`split --parts is a Planner handoff; ${current.id} is in ${current.column}`)
    if (!readCardPlanners(tasksDir)[current.id]?.assignmentId) fail('split --parts requires the assigned Planner and --planner-assignment')
    assertPlannerHandoff(tasksDir, current.id, plannerAssignment)

    const parts = partPaths.map((p, i) => {
      let raw
      try { raw = readFileSync(p, 'utf8') } catch { fail(`can't read part ${i + 1}: ${p}`) }
      const title = raw.match(/^#\s+(.+?)\s*\r?$/m)?.[1]?.trim()
      if (!title) fail(`part ${i + 1} (${p}) needs a title line: # Title`)
      const bodyStart = raw.search(/^## /m)
      if (bodyStart < 0) fail(`part ${i + 1} (${p}) has no ## sections`)
      const head = raw.slice(0, bodyStart)
      const body = raw.slice(bodyStart)
      const blockedLine = head.match(/^\*\*Blocked by:\*\*\s*([^\r\n]+)/im)?.[1]
      const blockedTokens = blockedLine ? blockedLine.split(',').map(s => s.trim()).filter(Boolean) : []
      const partRefs = []
      for (const t of blockedTokens) {
        const m = t.match(/^part\s+(\d+)$/i)
        if (m) {
          const n = Number(m[1])
          if (n < 1 || n > partPaths.length || n - 1 === i) fail(`part ${i + 1} (${p}): "${t}" does not refer to one of the other ${partPaths.length - 1} parts`)
          partRefs.push(n - 1)
        } else {
          try { findCard(tasksDir, t) } catch { fail(`part ${i + 1} (${p}): Blocked by "${t}" does not match an existing card`) }
        }
      }
      return { path: p, title, head, body, blockedTokens, partRefs, difficulty: difficultyFromText(head) }
    })

    // Blocked-by cycle check over the part-index graph.
    const visiting = new Set(), finished = new Set()
    const detectCycle = (i, chain) => {
      if (finished.has(i)) return
      if (visiting.has(i)) fail(`split --parts: Blocked-by cycle: ${chain.concat(i).map(n => `part ${n + 1}`).join(' -> ')}`)
      visiting.add(i)
      for (const j of parts[i].partRefs) detectCycle(j, chain.concat(i))
      visiting.delete(i); finished.add(i)
    }
    parts.forEach((_, i) => detectCycle(i, []))
    // Transitive reachability over "blocked by" either direction counts as chained.
    const reachable = (from) => {
      const seen = new Set(), stack = [from]
      while (stack.length) { const n = stack.pop(); for (const j of parts[n].partRefs) if (!seen.has(j)) { seen.add(j); stack.push(j) } }
      return seen
    }
    const reach = parts.map((_, i) => reachable(i))
    const chained = (i, j) => reach[i].has(j) || reach[j].has(i)

    // Every part is a complete plan in the same shape as a normal planned card.
    const check = planCheck(current)
    const workflowVersionLine = readFileSync(current.path, 'utf8').match(/^\*\*Workflow version:\*\*[^\r\n]*/m)?.[0] || '**Workflow version:** 2'
    for (const part of parts) {
      const diffLine = part.difficulty ? `**Difficulty:** ${part.difficulty}` : current.difficulty ? `**Difficulty:** ${current.difficulty}` : ''
      const readinessLine = part.head.match(/^\*\*Plan readiness:\*\*[^\r\n]*/im)?.[0] || ''
      const investigationLine = part.head.match(/^\*\*Investigation approved:\*\*[^\r\n]*/im)?.[0] || ''
      const newHead = `# ${part.title}\n\n**Workflow:** card-owned\n${workflowVersionLine}\n**Category:** ${current.category}\n` +
        `**Workspace:** ${current.workspace}\n**Auto-review:** ${current.autoReview ? 'yes' : 'no'}\n${diffLine}\n**Priority** ${current.priority || 5}/10\n` +
        `${current.mission ? `**Mission:** ${current.mission}\n` : ''}${readinessLine}\n${investigationLine}\n**Split from:** ${current.id}\n`
      part.merged = `${newHead}\n${part.body}`
      try { validatePlan(part.merged, { requireReadiness: true, workspace: check.planWorkspace, sharedFiles: check.sharedFiles }) }
      catch (err) { fail(`part "${part.title}" (${part.path}): ${err.message}`) }
      part.files = planEditedFiles(part.merged)
    }
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        if (chained(i, j)) continue
        const shared = parts[i].files.find(f => parts[j].files.includes(f))
        if (shared) fail(`split --parts: part ${i + 1} ("${parts[i].title}") and part ${j + 1} ("${parts[j].title}") both edit ${shared}. Merge them into one part, or add **Blocked by:** part ${i + 1} (or part ${j + 1}) to the other.`)
      }
    }

    // Nothing above wrote anything. From here on, create the children.
    const project = basename(dirname(tasksDir))
    const prefix = projectCardPrefix(project)
    const made = []
    try {
      for (const part of parts) {
        const brief = (part.body.match(/^## Approved brief\s*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] ?? '').trim() || part.title
        const card = createCard(tasksDir, { title: part.title, brief, category: current.category, workspace: current.workspace, mission: current.mission, priority: current.priority, prefix })
        writeFileSync(card.path, part.merged)
        part.id = card.id
        made.push(card.id)
      }
    } catch (err) {
      fail(`split --parts failed partway: made ${made.join(', ') || 'none'} so far (${err.message})`)
    }
    for (const part of parts) {
      if (!part.blockedTokens.length) continue
      const ids = part.blockedTokens.map(t => { const m = t.match(/^part\s+(\d+)$/i); return m ? parts[Number(m[1]) - 1].id : t })
      updateCard(tasksDir, part.id, { addBlockedBy: ids })
    }
    for (const part of parts) moveCard(tasksDir, part.id, 'planned', { plannerAssignment, planWorkspace: check.planWorkspace, sharedFiles: check.sharedFiles })

    const parentText = readFileSync(current.path, 'utf8')
    moveCard(tasksDir, current.id, 'archive', { covered: true })
    appendHistory(tasksDir, current.id, { event: 'handoff', stage: 'planning', outcome: 'split', note: `split into ${made.join(', ')}`, text: parentText })
    unbind(tasksDir, current.id)
    activityLog({ tasksDir, project, cardId: current.id, event: 'planner-finish', message: `planning -> archive (split into ${made.join(', ')})` })
    stopCardRun(project, current.id, 'Stopped at split')
    console.log(`${current.id} split into ${made.join(', ')}; all in Planned. Stop now.`)
  } catch (err) { fail(err.message) }
  process.exit(0)
}

if (!verb || !(verb in VERBS)) {
  fail(`usage: hkb [--tasks <absolute-tasks-dir>] <done|issue|owner|park|split|found|wait|covered|review|rework|pass|move|show|result|tests> <card-id> [note|column]\n       hkb show <card-id>   (read the card from any lane)\n       hkb tests <card-id> <name> "<command>" [--timeout <seconds>]   (Builder: hand a long test run to the board and stop; a fresh agent reads the saved result)\n       hkb result <card-id> --file <path>   (Builder: write the ## Implementation and ## Evidence bodies from text, or pipe it on stdin; refuses what done would)\n       hkb found [--board] <card-id> "<finding>"   (--board: a board/process problem, always to the Kanban Manager)\n       hkb wait <card-id> "<files or cards>" "<why>"   (Planner: the plan needs something that does not exist yet)\n       hkb covered <card-id> <covering-card> "<check> -> <result>"   (Planner: another card already fixed this)\n       got: ${verb ?? '(nothing)'}`)
}
if (!cardId) fail('missing card id, e.g. T-02')

if (!existsSync(tasksDir)) fail(`no TASKS folder at ${tasksDir}`)

let target = verb === 'move' ? note.toLowerCase() : VERBS[verb]
if (!target && !['done', 'pass'].includes(verb)) fail('move needs a target column, e.g. hkb move T-02 review')
// Pou is the operator's lane: only a deliberate board move reaches it (2026-09-25).
if (target === 'pou') fail('agents cannot move cards to Pou; hand off with hkb owner and the Kanban Manager decides')

// The cap is enforced here rather than in the reviewer's prompt, because a
// prompt is advice and this has to hold even when the reviewer ignores it.
let capped = false
if (verb === 'rework') {
  const rounds = findCard(tasksDir, cardId).reviewRounds
  if (rounds + 1 >= MAX_REVIEW_ROUNDS) {
    capped = true
  }
}

// A handover with no explanation is not a report. Whoever picks the card up next
// — another agent, or the operator staring at it cold — needs to know why.
if (verb === 'issue' && !note) fail('issue needs a reason: hkb issue T-02 "what went wrong"')
if (verb === 'owner' && !note) fail('owner needs to say what you need: hkb owner T-02 "what only the operator can supply"')
// park = owner, but the auto-manager sweep skips it from now on. For cards no
// amount of agent effort can resolve, so re-reading them every 15 minutes is waste.
if (verb === 'park' && !note) fail('park needs to say why no agent can resolve it: hkb park T-02 "needs your bank details"')
if (verb === 'split' && !/^\s*1[.)]/m.test(note)) fail('split needs the separate findings as a numbered list, each with its evidence: hkb split T-02 "1. ... 2. ..."')
if (verb === 'rework' && !note) fail('rework needs feedback the builder can act on: hkb rework T-02 "criterion 2 fails: ..."')
let card
let previousColumn
let approvalWait = false
let prerequisiteWait = false
let decisionWait = false
let plannerIssues = 0
let escalated = false
let auditNotReady = ''
let coveringCard
try {
  const current = findCard(tasksDir, cardId)
  // Review runs on integrated code, so every Builder handoff goes to Completed first.
  if (verb === 'done') target = 'completed'
  if (verb === 'unchanged') target = current.trivial ? 'completed' : !current.autoReview ? 'archive' : 'review'
  if (verb === 'pass') target = 'completed'
  if (!columnByKey(target)) fail(`unknown column: ${target}`)
  if (plannerAssignment || current.column === 'planning') assertPlannerHandoff(tasksDir, current.id, plannerAssignment)
  if ((verb === 'done' && ['completed', 'review', 'archive'].includes(current.column)) ||
      (verb === 'unchanged' && (['review', 'archive'].includes(current.column) || (current.column === 'completed' && (current.trivial || current.reviewPassed)))) ||
      (verb === 'pass' && ['completed', 'archive'].includes(current.column) && current.reviewPassed)) {
    // A handoff stopped after the card move (EPERM, busy lock, killed process) left the
    // Builder bound or its stage unrecorded; finish those steps so it can integrate (Tradeflow T-43).
    const bound = readBindings(tasksDir)[current.id], saved = readWorkflow(tasksDir)[current.id]
    if (bound || !saved?.completedStage) {
      updateWorkflow(tasksDir, current.id, { ...(bound && { builder: bound }), operational: null, completedStage: saved?.completedStage || (verb === 'pass' ? 'review' : 'working'),
        ...(current.column === 'completed' ? { completedAt: new Date().toISOString() } : {}) })
      unbind(tasksDir, current.id)
    }
    console.log(`${current.id}: ${verb} handoff already recorded (${current.column})${bound || !saved?.completedStage ? '; finished its interrupted steps' : ''}`)
    process.exit(0)
  }
  repairHandoffSections(tasksDir, current)
  if (verb === 'covered') {
    if (current.column !== 'planning') fail(`covered is a Planner handoff; ${current.id} is in ${current.column}`)
    if (!readCardPlanners(tasksDir)[current.id]?.assignmentId) fail('covered requires the assigned Planner and --planner-assignment')
    const evidence = rest.slice(1).join(' ').trim()
    if (!rest[0] || !/^\S[\s\S]*?\s+->\s+\S/.test(evidence)) fail('covered needs the covering card and passing evidence: hkb covered <ID> <card> "<check> -> <result>"')
    try { coveringCard = findCard(tasksDir, rest[0]) } catch (err) { fail(`${err.message}; use hkb wait ${current.id} ${rest[0]} "waiting for the covering fix" instead`) }
    if (!coveringCard || !['archive', 'completed', 'review'].includes(coveringCard.column)) fail(`${rest[0]} must exist in archive, completed or review; use hkb wait ${current.id} ${rest[0]} "waiting for the covering fix" instead`)
    appendFileSync(current.path, `\n\n**Covered by ${coveringCard.id}**\n\n${evidence}\n`)
  }
  // A Planner cannot add an operator-only approval, so any Planner handoff on a plan
  // held only by one goes to Owner with the question, never back to planning (T-148).
  approvalWait = (plannerAssignment || current.column === 'planning') && ['move', 'issue', 'owner', 'park', 'split'].includes(verb) && awaitsOperatorApproval(readFileSync(current.path, 'utf8'))
  if (approvalWait) target = 'owner'
  if (reviewClaim || current.column === 'review') assertReviewHandoff(reviewRoot, tasksDir, current.id, reviewClaim)
  if (reviewClaim && !['pass', 'rework', 'owner', 'audit', 'issue'].includes(verb)) fail('Reviewer claim permits only scoped review handoffs')
  // Review runs on integrated code: an agent's `hkb review` sent build-ready I960 from Planned
  // straight to Review (2026-10-09), where it sat 3 h with no build ('integration receipt required').
  if (['review', 'move'].includes(verb) && target === 'review' && ['planning', 'planned', 'queue'].includes(current.column)) fail(`${current.id} is in ${current.column} and has not been built; Review needs integrated code. Plan checker: hkb plancheck. Planner: hkb move ${current.id} planned.`)
  previousColumn = current.column
  let auditIntake = false
  if (verb === 'audit' || (current.audit && verb === 'owner' && /audit report ready/i.test(note))) {
    if (!current.audit) fail('audit handoff requires an audit card')
    const text = readFileSync(current.path, 'utf8')
    if (note.match(/\b(CLEAR|FINDINGS|INCOMPLETE)\b/)?.[1] !== auditStatus(text)) fail('handoff must match current Audit conclusion')
    const { status, reason } = auditOutcome(text, current.audit)
    target = auditDestination(text, status)
    if (status === 'INCOMPLETE') {
      target = current.column
      if (reason) auditNotReady = `INCOMPLETE: FINDINGS not card-ready: ${reason}. Fix ## Findings and the ## Card-ready findings JSON block, then hand off again.`
      recordOperationalFailure(tasksDir, current, auditNotReady || note, dirname(tasksDir))
    }
    auditIntake = target === 'planning'
  }
  if (['owner', 'park'].includes(verb) && !approvalWait && !explicitOwnerReason(note)) {
    const auditReport = current.audit && /audit report ready/i.test(note)
    if (!auditReport) {
      target = current.column
      recordOperationalFailure(tasksDir, current, note, dirname(tasksDir))
    }
  }
  if (verb === 'unchanged') {
    if (!note) fail('unchanged requires the passing check and observed result')
    completeUnchangedWorktree({ tasksDir, cardId: current.id, evidence: note })
    appendFileSync(current.path, `\n\n**Verified unchanged** ${new Date().toISOString()}\n\n${note}\n`)
  }
  let dirtySnapshot = null
  if (verb === 'issue') {
    if (current.cardOwned && !worktreeForCard(tasksDir, current.id)) {
      dirtySnapshot = dirtySnapshotForCard(current, process.cwd(), { listedOnly: true })
    }
  }
  if (verb === 'pass') {
    if (current.column !== 'review') fail('pass only closes a card from Review')
    if (!canArchive(current)) fail('pass needs current nonempty Reviewer evidence and latest Review verdict: PASS already recorded')
    assertReviewInputs(reviewRoot, tasksDir, current.id)
  }
  // A Planner reporting that Blocked-by prerequisites have not landed is a valid
  // wait, not a failed plan (TF44): the card stays in Planning until they land.
  // A product/operator decision no Planner can make: the card waits in Planning for the
  // manager's answer, uncounted and unescalated; moving the card (/api/move) clears it.
  // [board] is the same wait for a conflict with the board's own tooling (plan check, gate,
  // hkb refusal): it still parks the card, but it is the Kanban Manager's problem,
  // not the operator's, so it is flagged there instead of paging the operator (2026-10-10).
  const decisionCategory = verb === 'issue' && !approvalWait && current.column === 'planning' ? failureCategory(note) : null
  decisionWait = decisionCategory === 'decision' || decisionCategory === 'board'
  if (decisionWait) {
    target = 'planning'
    updateWorkflow(tasksDir, current.id, { waitFor: { cards: [], files: [], decision: true, ...(decisionCategory === 'board' ? { board: true } : {}), why: note, since: new Date().toISOString() } })
    appendHistory(tasksDir, current.id, { event: 'planner-decision-wait', stage: 'planning', note })
    if (decisionCategory === 'board') tellManager(`BOARD ${basename(dirname(tasksDir))} ${current.id} (planning): ${note.replace(/\s+/g, ' ')}`, true, 'BQ')
  }
  prerequisiteWait = verb === 'issue' && !approvalWait && !decisionWait && current.column === 'planning' && waitingOnPrerequisites(current, readBoard(tasksDir), readWorktrees(tasksDir)).length > 0
  if (prerequisiteWait) {
    target = 'planning'
    const waitingFor = waitingOnPrerequisites(current, readBoard(tasksDir), readWorktrees(tasksDir))
    // Planned ahead but declined: wait for the blockers, then a fresh Planner (card-planner waitFor).
    updateWorkflow(tasksDir, current.id, { waitFor: { cards: waitingFor, files: [], why: note, since: new Date().toISOString() } })
    appendHistory(tasksDir, current.id, { event: 'planner-prerequisite-wait', stage: current.column, note, waitingFor })
  } else if (['issue', 'rework'].includes(verb) && !approvalWait && !decisionWait) {
    const category = failureCategory(note)
    if (category === 'incidental') fail('Incidental findings alone are not a failed handoff: record evidence/classification in the current result and use the normal done/pass handoff only when every agreed criterion is met. In-scope or change-caused defects still require issue/rework.')
    target = failureDestination(category, current.column)
    // A second Builder on the same plan that also cannot implement it is a plan gap:
    // Injectbuddy I340 hit the plan's own stop rule five times in six minutes, each
    // tagged [implementation], and each re-queued to a fresh Builder (2026-09-27).
    const plan = recoveryState(readFileSync(current.path, 'utf8')).plan
    const prior = readWorkflow(tasksDir)[current.id]?.correction
    const repeat = current.column === 'working' && category === 'implementation' && prior?.category === 'implementation' && prior.plan === plan
    if (repeat) target = 'planning'
    if (current.column === 'working') recordBuilderReturn(tasksDir, current, note)
    appendHistory(tasksDir, current.id, { event: 'failure', category, stage: current.column, note, ...(repeat ? { routed: 'planning: second Builder implementation failure on the same plan' } : {}) })
    if (['operational', 'evidence'].includes(category)) recordOperationalFailure(tasksDir, current, note, dirname(tasksDir))
    updateWorkflow(tasksDir, current.id, { correction: { category, note, plan } })
    // Planners that keep reporting a blocker loop through fresh sessions: I152/I168/I184
    // each ran 25 overnight, worded differently every time. The third in a row is the
    // operator's question.
    if (current.column === 'planning' && target === 'planning') {
      const saved = readWorkflow(tasksDir)[current.id]
      plannerIssues = (saved?.plannerIssues || 0) + 1
      // Operator 2026-09-27: a Codex Planner gets one try; its first blocker hands the card to
      // Claude Opus planners for the rest of the three. Every Codex failure is logged for review.
      const codex = readCardPlanners(tasksDir)[current.id]?.engine === 'codex'
      if (codex) {
        appendFileSync(join(tasksDir, 'codex-planner-failures.log'), `${new Date().toISOString()}	${current.id}	${note.replace(/\s+/g, ' ').slice(0, 300)}
`)
        activityLog({ tasksDir, project: basename(dirname(tasksDir)), cardId: current.id, event: 'codex-planner-failure', message: note })
      }
      escalated = !!saved?.plannerEscalation
      const escalate = codex && !escalated && plannerIssues < 3 && approvedManagedModel('p-t-1')?.includes(ESCALATION_MODEL)
      updateWorkflow(tasksDir, current.id, { plannerIssues, ...(escalate ? { plannerEscalation: { model: ESCALATION_MODEL, at: new Date().toISOString() } } : {}) })
      if (plannerIssues >= 3) target = 'owner'
    }
  }
  if (verb === 'done' && current.cardOwned && current.column === 'working') {
    const commitError = handoffCommitError(tasksDir, current)
    if (commitError) fail(`done refused: ${commitError}. Fix it in your worktree (exactly one commit, card-listed files only; restore build-regenerated or out-of-scope files), then run hkb done again.`)
  }
  if (['done', 'unchanged'].includes(verb) && current.cardOwned) {
    const raw = readFileSync(current.path, 'utf8'), text = unglueHeadings(raw)
    if (text !== raw) writeFileSync(current.path, text)
    const error = builderResultError(verb, text)
    if (error) fail(error)
  }
  const check = (plannerAssignment || current.column === 'planning') && ['planned', 'queue'].includes(target) ? planCheck(current) : {}
  if (check.planWorkspace && current.cardOwned) validatePlan(readFileSync(current.path, 'utf8'), { requireReadiness: !!plannerAssignment, workspace: check.planWorkspace, sharedFiles: check.sharedFiles })
  card = moveCard(tasksDir, cardId, target, { intake: auditIntake, plannerAssignment, covered: !!coveringCard, ...check, correction: !approvalWait && ['issue', 'rework'].includes(verb) && failureCategory(note) === 'implementation' })
  target = card.column
  if (verb === 'covered') {
    updateWorkflow(tasksDir, card.id, { plannerIssues: null, plannerEscalation: null, waitFor: null, planCheck: null, operational: null, startFailure: null })
    appendHistory(tasksDir, card.id, { event: 'covered', coveringCard: coveringCard.id, note: rest.slice(1).join(' ').trim(), text: readFileSync(card.path, 'utf8') })
    stopCardRun(basename(dirname(tasksDir)), card.id, 'Archived as covered')
  }
  // Only a plan the check accepted clears the blocker count: resetting it before a refused
  // move let Injectbuddy I267 loop six Planners past the three-in-a-row cap (2026-09-26).
  if (verb === 'move' && previousColumn === 'planning' && ['planned', 'queue'].includes(target)) updateWorkflow(tasksDir, current.id, { plannerIssues: null, plannerEscalation: null, waitFor: null })
  if (previousColumn === 'review' && target === 'planning' && !auditIntake) requestPlannerCorrection(tasksDir, card.id)
  // A Planner's issue keeps the card in Planning; it is a handoff, so the next round gets
  // a fresh Planner. Left "submitted" it was counted as a no-handoff and sent to Owner
  // under a false reason (Injectbuddy I152, I178).
  if (previousColumn === 'planning' && target === 'planning' && verb === 'issue' && !prerequisiteWait && !approvalWait) requestPlannerCorrection(tasksDir, card.id, { correction: !decisionWait })
  if (auditIntake && previousColumn !== 'planning') {
    requestPlannerCorrection(tasksDir, card.id)
    appendFileSync(card.path, '\n\n**Audit findings intake**\nValidate current findings, deduplicate against existing cards, and link each numbered finding to an approved remediation card. Create only missing in-scope fixes through Planner -> Builder -> scoped independent review. Archive this report only after all findings are linked; report closure does not mean fixes are complete. No deployment or unsafe business/data change is authorized.\n')
  }
  if (!card.audit && (verb === 'rework' || (previousColumn === 'review' && target === 'planning'))) setAutoReview(tasksDir, card.id, true)
  appendDirtySnapshot(card, dirtySnapshot)
  if (previousColumn === 'review' || approvalWait || ['issue', 'rework', 'owner', 'park', 'split'].includes(verb)) stopCardRun(basename(dirname(tasksDir)), card.id, previousColumn === 'review' ? `Review handoff: ${verb}` : `Stopped at ${verb}`)
} catch (err) {
  fail(err.message)
}
// The board may already have moved the card on (planned -> queue) since moveCard returned:
// I539 exited ENOENT reading the stale backlog path.
card = findCard(tasksDir, card.id)

if (approvalWait) writeCurrentFeedback(tasksDir, card, 'Needs you', approvalQuestion(card.id))
else if (decisionWait) writeCurrentFeedback(tasksDir, card, 'Needs you', `${note}

Record the answer on the card, then move it to Planning (or Planned).
`)
else if (plannerIssues >= 3 && target === 'owner') writeCurrentFeedback(tasksDir, card, 'Needs you', `Three Planners in a row could not make ${card.id} build-ready${escalated ? ` (after one Codex Planner, the ${ESCALATION_MODEL} escalation Planners also failed)` : ''}. The latest blocker:\n\n${note}\n\nWhat should change (scope, approach, or an approval)? Record it on the card, then drag it back to Planning.\n`)
else if (auditNotReady) writeCurrentFeedback(tasksDir, card, 'Kicked back', `${auditNotReady}\n`)
else if (HEADING[verb]) {
  const tail = capped
    ? `\n\nRepeated review failure: Planner must diagnose the root cause and record a changed approach before requeueing. Preserve all evidence and acceptance criteria.\n`
    : '\n'
  writeCurrentFeedback(tasksDir, card, HEADING[verb], note + tail)
}
// A plan that is now build-ready answers any earlier Owner question; a stale "Needs you"
// left on a queued card reads as waiting on the operator (Injectbuddy I165, I178).
else if (previousColumn === 'planning' && ['planned', 'queue'].includes(target) && /^## Current feedback\r?\nNeeds you:/m.test(readFileSync(card.path, 'utf8'))) {
  writeCurrentFeedback(tasksDir, card, 'Resolved', 'a Planner made this card build-ready, so the earlier question no longer applies.\n')
}
// The same for a Builder's [planning] kick-back the Planner has now answered: left as the
// current feedback, I994's next Builder re-raised the already-fixed blocker from the old
// builder-run.log in 43 seconds without running the corrected Check (2026-10-10).
else if (previousColumn === 'planning' && ['planned', 'queue'].includes(target) && /^## Current feedback\r?\nKicked back: \[planning\]/m.test(readFileSync(card.path, 'utf8'))) {
  writeCurrentFeedback(tasksDir, card, 'Resolved', 'a Planner re-planned this card after the last [planning] kick-back. That blocker, any earlier Builder result under ## Evidence and any builder-run.log in the evidence folder are history. The plan above is current: build and test it yourself before reporting a blocker.\n')
}

const binding = readBindings(tasksDir)[card.id]
appendHistory(tasksDir, card.id, { event: 'handoff', stage: previousColumn, outcome: verb, note, run: binding?.agent_session, agent: binding?.name, text: readFileSync(card.path, 'utf8') })
if (binding) updateWorkflow(tasksDir, card.id, { builder: binding })
if (['done', 'unchanged', 'pass'].includes(verb)) updateWorkflow(tasksDir, card.id, {
  operational: null,
  completedStage: previousColumn,
  // A genuine Builder handoff resets the no-handoff streak (audit #7): only consecutive
  // crashes in a row escalate to Planning; a successful hand-in starts the count over.
  ...(previousColumn === 'working' ? { noHandoffStreak: null } : {}),
  ...(target === 'completed' ? { completedAt: new Date().toISOString() } : {}),
})
unbind(tasksDir, card.id)
activityLog({
  tasksDir,
  project: basename(dirname(tasksDir)),
  cardId: card.id,
  event: previousColumn === 'working' ? `builder-${['issue', 'rework', 'owner', 'park', 'split'].includes(verb) ? 'failure' : 'finish'}`
    : previousColumn === 'review' ? `reviewer-${['issue', 'rework', 'owner', 'park', 'split'].includes(verb) ? 'failure' : 'finish'}`
    : previousColumn === 'planning' ? `planner-${prerequisiteWait ? 'wait' : ['issue', 'rework', 'owner', 'park', 'split'].includes(verb) ? 'failure' : 'finish'}`
    : ['issue', 'rework', 'owner', 'park', 'split'].includes(verb) ? 'failure' : 'move',
  message: `${previousColumn} -> ${target} (${verb})`,
})

console.log(`${card.id} -> ${target}${capped ? ' (review cap reached)' : ''}` +
  `${binding?.pane_id ? ` (freed ${binding.pane_id})` : ''}`)
