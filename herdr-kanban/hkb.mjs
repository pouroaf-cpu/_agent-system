#!/usr/bin/env node
// hkb — the one command a working agent runs to report back.
//
//   node hkb.mjs done  T-02
//   node hkb.mjs issue T-02 "acceptance criterion 3 fails at 390px"
//   node hkb.mjs owner T-02 "needs the Supabase service key, which I must not read"
//   node hkb.mjs park  T-02 "needs your bank details — no agent can supply them"
//   node hkb.mjs pass  T-02
//   node hkb.mjs move  T-02 review
//
// Run it from the project root. Moving the card IS the report; there is no
// separate status to update and nothing to keep in sync.
//
// issue vs owner: `issue` is a technical problem another agent could pick up.
// `owner` is a decision, credential, asset or judgement call only the human can
// supply — no amount of agent effort will resolve it.

import { existsSync, appendFileSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { moveCard, columnByKey, findCard, canArchive, dirtySnapshotForCard, appendDirtySnapshot, setAutoReview, awaitsOperatorApproval, approvalQuestion, readBoard, waitingOnPrerequisites } from './lib/cards.mjs'
import { unbind, readBindings } from './lib/bindings.mjs'
import { activityLog } from './lib/activity.mjs'
import { worktreeForCard, completeUnchangedWorktree, resolveGitSettings, readWorktrees, handoffCommitError } from './lib/worktrees.mjs'
import { explicitOwnerReason } from './lib/owner-reason.mjs'
import { auditDestination, auditStatus, auditOutcome } from './lib/audit-routing.mjs'
import { requestPlannerCorrection } from './lib/card-planner.mjs'
import { assertReviewHandoff, assertReviewInputs } from './lib/review-claims.mjs'
import { fileURLToPath } from 'node:url'
import { appendHistory, writeCurrentFeedback, droppedSections, historyPath } from './lib/card-history.mjs'
import { failureCategory, failureDestination, updateWorkflow, recordOperationalFailure, readWorkflow } from './lib/workflow-state.mjs'
import { stopCardRun } from './lib/card-run.mjs'
import { assertPlannerHandoff } from './lib/planner-state.mjs'

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

const VERBS = { audit: 'planning', done: null, unchanged: 'completed', issue: 'issues', owner: 'owner', park: 'owner', review: 'review', rework: 'issues', pass: null, move: null }

// What gets stamped above the note, and what the board reads back out.
const HEADING = { issue: 'Kicked back', owner: 'Needs you', park: 'Parked', rework: 'Review feedback' }

// Repeated failed reviews require deeper Planner diagnosis, never a human dump.
const MAX_REVIEW_ROUNDS = 3

// The card's workspace in the project's integration checkout: where a Planner's
// ## Files paths must already exist at handoff.
function integrationWorkspace(card) {
  const projectPath = dirname(tasksDir)
  let gitSettings
  try {
    const config = JSON.parse(readFileSync(process.env.KANBAN_CONFIG || fileURLToPath(new URL('./board.config.json', import.meta.url)), 'utf8'))
    const name = config.projects?.find(p => resolve(config.projectsRoot, p).toLowerCase() === resolve(projectPath).toLowerCase())
    gitSettings = config.projectSettings?.[name]
  } catch { /* No config: the project's own Git root is the integration checkout. */ }
  return resolve(resolveGitSettings({ projectPath, gitSettings })?.integrationPath || projectPath, card.workspace || '.')
}

function fail(msg) {
  console.error(`hkb: ${msg}`)
  process.exit(1)
}

if (!verb || !(verb in VERBS)) {
  fail(`usage: hkb [--tasks <absolute-tasks-dir>] <done|issue|owner|park|review|rework|pass|move> <card-id> [note|column]\n       got: ${verb ?? '(nothing)'}`)
}
if (!cardId) fail('missing card id, e.g. T-02')

if (!existsSync(tasksDir)) fail(`no TASKS folder at ${tasksDir}`)

let target = verb === 'move' ? note.toLowerCase() : VERBS[verb]
if (!target && !['done', 'pass'].includes(verb)) fail('move needs a target column, e.g. hkb move T-02 review')

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
if (verb === 'rework' && !note) fail('rework needs feedback the builder can act on: hkb rework T-02 "criterion 2 fails: ..."')
let card
let previousColumn
let approvalWait = false
let prerequisiteWait = false
let plannerIssues = 0
let auditNotReady = ''
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
    console.log(`${current.id}: ${verb} handoff already recorded (${current.column})`)
    process.exit(0)
  }
  const dropped = droppedSections(tasksDir, current.id, readFileSync(current.path, 'utf8'))
  if (dropped.length) fail(`${current.id}: handoff refused. ${dropped.map(s => `## ${s}`).join(', ')} had content in the last saved card but is now missing or empty. Put it back from the last "text" entry in ${historyPath(tasksDir, current.id).replaceAll('\\', '/')}, then hand off again. Edit only your own sections; never rewrite other sections.`)
  // A Planner cannot add an operator-only approval, so any Planner handoff on a plan
  // held only by one goes to Owner with the question, never back to planning (T-148).
  approvalWait = (plannerAssignment || ['planning', 'issues'].includes(current.column)) && ['move', 'issue', 'owner', 'park'].includes(verb) && awaitsOperatorApproval(readFileSync(current.path, 'utf8'))
  if (approvalWait) target = 'owner'
  if (reviewClaim || current.column === 'review') assertReviewHandoff(reviewRoot, tasksDir, current.id, reviewClaim)
  if (reviewClaim && !['pass', 'rework', 'owner', 'audit', 'issue'].includes(verb)) fail('Reviewer claim permits only scoped review handoffs')
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
  prerequisiteWait = verb === 'issue' && !approvalWait && current.column === 'planning' && waitingOnPrerequisites(current, readBoard(tasksDir), readWorktrees(tasksDir)).length > 0
  if (prerequisiteWait) {
    target = 'planning'
    appendHistory(tasksDir, current.id, { event: 'planner-prerequisite-wait', stage: current.column, note, waitingFor: waitingOnPrerequisites(current, readBoard(tasksDir), readWorktrees(tasksDir)) })
  } else if (['issue', 'rework'].includes(verb) && !approvalWait) {
    const category = failureCategory(note)
    if (category === 'incidental') fail('Incidental findings alone are not a failed handoff: record evidence/classification in the current result and use the normal done/pass handoff only when every agreed criterion is met. In-scope or change-caused defects still require issue/rework.')
    target = failureDestination(category, current.column)
    appendHistory(tasksDir, current.id, { event: 'failure', category, stage: current.column, note })
    if (['operational', 'evidence'].includes(category)) recordOperationalFailure(tasksDir, current, note, dirname(tasksDir))
    updateWorkflow(tasksDir, current.id, { correction: { category, note } })
    // Planners that keep reporting a blocker loop through fresh sessions: I152/I168/I184
    // each ran 25 overnight, worded differently every time. The third in a row is the
    // operator's question.
    if (current.column === 'planning' && target === 'planning') {
      plannerIssues = (readWorkflow(tasksDir)[current.id]?.plannerIssues || 0) + 1
      updateWorkflow(tasksDir, current.id, { plannerIssues })
      if (plannerIssues >= 3) target = 'owner'
    }
  }
  if (verb === 'move' && current.column === 'planning' && ['planned', 'queue'].includes(target)) updateWorkflow(tasksDir, current.id, { plannerIssues: null })
  if (verb === 'done' && current.cardOwned && ['working', 'issues'].includes(current.column)) {
    const commitError = handoffCommitError(tasksDir, current)
    if (commitError) fail(`done refused: ${commitError}. Fix it in your worktree (exactly one commit, card-listed files only; restore build-regenerated or out-of-scope files), then run hkb done again.`)
  }
  if (['done', 'unchanged'].includes(verb) && current.cardOwned) {
    const text = readFileSync(current.path, 'utf8')
    const sections = []
    for (const heading of ['Implementation', 'Evidence']) {
      const content = text.match(new RegExp(`^## ${heading}\\s*\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'))?.[1]?.replace(/<!--[\s\S]*?-->/g, '').trim()
      if (!content) fail(`${verb} requires a current ${heading} result; full logs belong in linked evidence files`)
      sections.push(content)
    }
    if (/^\*\*Workflow version:\*\* 2$/m.test(text)) {
      const result = sections.join('\n').replaceAll('**', '')
      for (const field of ['Stage', 'Outcome', 'Files', 'Check', 'Result', 'Evidence', 'Blocker']) {
        if (!new RegExp(`^${field}:\\s*\\S.+$`, 'mi').test(result)) fail(`version-2 ${verb} result requires ${field}: with a specific value (Blocker: none when clear)`)
      }
      if (!/^Stage:\s*builder\s*$/mi.test(result) || !/^Outcome:\s*PASS\s*$/mi.test(result)) fail(`${verb} requires Stage: builder and Outcome: PASS`)
    }
  }
  const planWorkspace = (plannerAssignment || ['planning', 'issues'].includes(current.column)) && ['planned', 'queue'].includes(target) ? integrationWorkspace(current) : undefined
  card = moveCard(tasksDir, cardId, target, { intake: auditIntake, plannerAssignment, planWorkspace, correction: !approvalWait && ['issue', 'rework'].includes(verb) && failureCategory(note) === 'implementation' })
  target = card.column
  if (previousColumn === 'review' && target === 'planning' && !auditIntake) requestPlannerCorrection(tasksDir, card.id)
  // A Planner's issue keeps the card in Planning; it is a handoff, so the next round gets
  // a fresh Planner. Left "submitted" it was counted as a no-handoff and sent to Owner
  // under a false reason (Injectbuddy I152, I178).
  if (previousColumn === 'planning' && target === 'planning' && verb === 'issue' && !prerequisiteWait && !approvalWait) requestPlannerCorrection(tasksDir, card.id)
  if (auditIntake && previousColumn !== 'planning') {
    requestPlannerCorrection(tasksDir, card.id)
    appendFileSync(card.path, '\n\n**Audit findings intake**\nValidate current findings, deduplicate against existing cards, and link each numbered finding to an approved remediation card. Create only missing in-scope fixes through Planner -> Builder -> scoped independent review. Archive this report only after all findings are linked; report closure does not mean fixes are complete. No deployment or unsafe business/data change is authorized.\n')
  }
  if (!card.audit && (verb === 'rework' || (previousColumn === 'review' && ['issues', 'planning'].includes(target)))) setAutoReview(tasksDir, card.id, true)
  appendDirtySnapshot(card, dirtySnapshot)
  if (previousColumn === 'review' || approvalWait || ['issue', 'rework', 'owner', 'park'].includes(verb)) stopCardRun(basename(dirname(tasksDir)), card.id, previousColumn === 'review' ? `Review handoff: ${verb}` : `Stopped at ${verb}`)
} catch (err) {
  fail(err.message)
}

if (approvalWait) writeCurrentFeedback(tasksDir, card, 'Needs you', approvalQuestion(card.id))
else if (plannerIssues >= 3 && target === 'owner') writeCurrentFeedback(tasksDir, card, 'Needs you', `Three Planners in a row could not make ${card.id} build-ready. The latest blocker:\n\n${note}\n\nWhat should change (scope, approach, or an approval)? Record it on the card, then drag it back to Planning.\n`)
else if (auditNotReady) writeCurrentFeedback(tasksDir, card, 'Kicked back', `${auditNotReady}\n`)
else if (HEADING[verb]) {
  const tail = capped
    ? `\n\nRepeated review failure: Planner must diagnose the root cause and record a changed approach before requeueing. Preserve all evidence and acceptance criteria.\n`
    : '\n'
  const heading = target === 'issues' && ['owner', 'park'].includes(verb) ? 'Kicked back' : HEADING[verb]
  writeCurrentFeedback(tasksDir, card, heading, note + tail)
}

const binding = readBindings(tasksDir)[card.id]
appendHistory(tasksDir, card.id, { event: 'handoff', stage: previousColumn, outcome: verb, note, run: binding?.agent_session, agent: binding?.name, text: readFileSync(card.path, 'utf8') })
if (binding) updateWorkflow(tasksDir, card.id, { builder: binding })
if (['done', 'unchanged', 'pass'].includes(verb)) updateWorkflow(tasksDir, card.id, {
  operational: null,
  // A Builder routed to Issues mid-work still completes the Builder stage (Tradeflow T-42).
  completedStage: previousColumn === 'issues' && ['done', 'unchanged'].includes(verb) && !plannerAssignment ? 'working' : previousColumn,
  ...(target === 'completed' ? { completedAt: new Date().toISOString() } : {}),
})
unbind(tasksDir, card.id)
activityLog({
  tasksDir,
  project: basename(dirname(tasksDir)),
  cardId: card.id,
  event: previousColumn === 'working' ? `builder-${['issue', 'rework', 'owner', 'park'].includes(verb) ? 'failure' : 'finish'}`
    : previousColumn === 'review' ? `reviewer-${['issue', 'rework', 'owner', 'park'].includes(verb) ? 'failure' : 'finish'}`
    : previousColumn === 'planning' ? `planner-${prerequisiteWait ? 'wait' : ['issue', 'rework', 'owner', 'park'].includes(verb) ? 'failure' : 'finish'}`
    : ['issue', 'rework', 'owner', 'park'].includes(verb) ? 'failure' : 'move',
  message: `${previousColumn} -> ${target} (${verb})`,
})

console.log(`${card.id} -> ${target}${capped ? ' (review cap reached)' : ''}` +
  `${binding?.pane_id ? ` (freed ${binding.pane_id})` : ''}`)
