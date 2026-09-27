// Local kanban board over the filesystem. Phase 1+2: read, serve, move.

import { createServer } from 'node:http'
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, watch } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, extname, normalize, dirname, isAbsolute } from 'node:path'
import { renameSync } from './lib/fs-retry.mjs'
import { fileURLToPath } from 'node:url'
import { runCardPlanner, readCardPlanners, operatorRetry, operatorApprove, busyPlanners } from './lib/card-planner.mjs'
import { stopRunawayTsservers } from './lib/orphan-servers.mjs'
import { alertOwnerCards, pushover } from './lib/owner-alerts.mjs'
import { readManagerTasks } from './lib/manager-tasks.mjs'
import { isHardHold, notifyManagerException, resolveManagerException, ownerAgeing } from './lib/manager-alerts.mjs'
import { recoveryState } from './lib/recovery.mjs'
import { controlState, setProjectPaused } from './lib/project-control.mjs'
import { releaseWaiting, finishRelease } from './lib/release.mjs'
import { activeCardRun, readCardRuns, authorizeCardRun, stopCardRun } from './lib/card-run.mjs'
import { cardRunEligibility, tickCardRun } from './lib/card-runner.mjs'
import { reconcileCompletedHandoffs, operatorFinish } from './lib/completed-handoff.mjs'
import { readWorkflow, recordOperationalFailure, updateWorkflow } from './lib/workflow-state.mjs'
import { historyPath, appendHistory, laneEnteredAt } from './lib/card-history.mjs'
import { readAuditReports, resolveAuditReport, editorArguments } from './lib/audit-reports.mjs'
import { activeQuota, quotaHolds, quotaKey } from './lib/quota.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const AUDITS_ROOT = normalize(join(HERE, '..', '_audits') + '/')
const PUBLIC = join(HERE, 'public')
const CONFIG_PATH = process.env.KANBAN_CONFIG ?? join(HERE, 'board.config.json')
const REVIEW_ROOT = dirname(CONFIG_PATH)
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
const lanHost = process.env.KANBAN_LAN_HOST
const REQUESTS_PATH = process.env.KANBAN_REQUESTS ?? join(config.projectsRoot, 'ORCHESTRATOR-REQUESTS.md')

const { COLUMNS, ARCHIVE, createCard, readBoard, moveCard, setAutoReview, setPriority, findCard, updateCard } = await import('./lib/cards.mjs')
const { agentList, agentsForProject, isRunning, paneRead, paneClose, focusAgent, openProjectSession, openProjects, ensureAgentWorkspace, herdrLog, sessionOf } = await import('./lib/herdr.mjs')
const { readBindings, unbind } = await import('./lib/bindings.mjs')
const { stageIndicators } = await import('./lib/stage-indicators.mjs')
const { isCardId } = await import('./lib/ids.mjs')
const { auditFindings, cardsFromAudit } = await import('./lib/audit-cards.mjs')
const { readReviewClaims, MAX_REVIEWERS } = await import('./lib/review-claims.mjs')
const { cleanClosedReviewSnapshots } = await import('./lib/review-snapshots.mjs')
const { checkStalls, laneTimes, recordHealthyPoll } = await import('./lib/stall-watchdog.mjs')
const { stopCard, resumeDeliveries, confirmLateDeliveries } = await import('./lib/spawn.mjs')
const { autoSpawn, autoReview, promoteAutoReview, archiveNoReviewCards, promotePlanned, routeReviewVerdicts, spawnReviewer, spawnIssuesSweeper, routeBuilderNoHandoff, recoverBuilderNoHandoff, slotsFree, closeFinished, holdsFor, reviewerBusy, unmetBlockers, reconcileReviewers } = await import('./lib/autospawn.mjs')
const { computeReviewPlan, saveReviewGroups } = await import('./lib/review-plan.mjs')
const { busyReviewCards, reviewClaimFor } = await import('./lib/review-claims.mjs')
const { readRetries } = await import('./lib/retries.mjs')
const { recordSpawn, recordSpawnFailure, breakerState, resetBreaker } = await import('./lib/breaker.mjs')
const { cardUsageSummary, mergeUsageSummaries, reconcileUsage, recordUsageFinish, usageSummary, readUsage, recordUsageStart } = await import('./lib/request-usage.mjs')
const { activityLog } = await import('./lib/activity.mjs')
const { readWorktrees, reconcileCompletedWorktrees, resolveGitSettings, recordedOverlapBlockers, freeGb } = await import('./lib/worktrees.mjs')
const { STAGES, globalSettings, assignmentFor, engineForAssignment, validateSettingsPatch, catalog, setCardOverride } = await import('./lib/agent-settings.mjs')

const projectPathOf = (project) => join(config.projectsRoot, project)
const tasksDirOf = (project) => join(config.projectsRoot, project, 'TASKS')
const reviewInventory = () => Promise.all(config.projects.map(async project => {
  try { return { project, tasksDir: tasksDirOf(project), known: true, agents: await agentList(sessionOf(project), { ensureSession: false }) } }
  catch (err) { return { project, tasksDir: tasksDirOf(project), known: false, agents: [], error: err.message } }
}))
const resolvedProjectSettings = new Map()
const projectSettingsOf = (project) => {
  if (!resolvedProjectSettings.has(project)) resolvedProjectSettings.set(project, resolveGitSettings({ projectPath: projectPathOf(project), gitSettings: config.projectSettings?.[project] }))
  return resolvedProjectSettings.get(project)
}
const integrationPathOf = (project) => projectSettingsOf(project)?.integrationPath ?? projectPathOf(project)
const engineFor = (role) => engineForAssignment(globalSettings(config)[role])
const assignmentForCard = (project, card, stage) => assignmentFor(config, card, stage)
// Cards waiting for an engine that is out of usage: shown on the card, an allowed stall wait.
const quotaHoldsOf = (project, board = readBoard(tasksDirOf(project))) => quotaHolds(HERE, board, (card, stage) => { const a = assignmentForCard(project, card, stage); return quotaKey(a.engine, a.model) })
const missionAllowsProject = (project) => !config.mission?.project || config.mission.project.toLowerCase() === project.toLowerCase()

function ensureTasks(project) {
  const dir = tasksDirOf(project)
  for (const c of [...COLUMNS, ARCHIVE]) mkdirSync(join(dir, c.dir), { recursive: true })
  return dir
}

// Last known agent state per project, refreshed by each SSE client's poll.
const agentCache = new Map() // project -> { agents, herdrUp }
let herdrFailed = false
// Since when herdr has not answered; the board starting counts, so a reboot that leaves herdr down alerts too.
let herdrUnconfirmedSince = Date.now()
const HERDR_ALERT_AFTER_MS = 6 * 60 * 1000

const announcedBreakers = new Set()
const lastActivityHold = new Map()
const integrationHolds = new Map() // project -> { cardId: why integration is waiting }, for the stall watchdog
const finishedBindingSince = new Map()
const orphanWorkingSince = new Map()
const reconciliationPolls = new Set()
const projectPolls = new Set()
const actingPolls = new Set() // polls in progress that passed the stall watchdog's could-act gate
const pollErrors = new Map()
const FINISHED_BINDING_GRACE_MS = 2 * 60 * 1000

function activity(project, cardId, event, message, level = 'info') {
  return activityLog({ tasksDir: tasksDirOf(project), project, cardId, event, message, level })
}

// Two live copies of one card id hold only that card: log it once and never count it
// toward the project breaker (Tradeflow T-42 tripped auto-spawn for every card).
const ambiguousLogged = new Set()
function ambiguousHold(project, err) {
  if (!err?.ambiguous) return false
  const key = `${project}:${err.message}`
  if (!ambiguousLogged.has(key)) {
    ambiguousLogged.add(key)
    activity(project, err.ambiguous, 'hold', `${err.message}; card held, both copies kept — remove the stale copy by hand`, 'error')
  }
  return true
}

function schedulerActivity(project, message) {
  const prefixes = ['T-', config.cardPrefixes?.[project]].filter(Boolean).join('|')
  const cardId = String(message).match(new RegExp(String.raw`\b(?:${prefixes})\d+\b`, 'i'))?.[0]?.toUpperCase() ?? '-'
  const event = /retry|spawn failed/i.test(message) ? 'retry' : /held|busy|not ready/i.test(message) ? 'hold' : 'scheduler'
  console.log(message)
  activity(project, cardId, event, message, event === 'retry' ? 'error' : 'info')
}

// Low-disk pause, shared by every project: checked at most every 10 minutes.
// Under 3 GB free no new agents or worktrees start; above 4 GB they resume.
const disk = { at: 0, low: false }
function diskLow(now = Date.now()) {
  if (now - disk.at < 10 * 60 * 1000) return disk.low
  disk.at = now
  let gb
  try { gb = freeGb(config.projectsRoot) } catch { return disk.low }
  const drive = config.projectsRoot.slice(0, 2)
  if (!disk.low && gb < 3) {
    disk.low = true
    const message = `Kanban: drive ${drive} low on space (${gb.toFixed(1)} GB free); new agents paused`
    for (const project of config.projects) activity(project, '-', 'hold', `${message} until more than 4 GB is free`, 'error')
    pushover(`Kanban: drive ${drive} low on space`, message).catch(err => console.error(`low-disk Pushover failed: ${err.message}`))
  } else if (disk.low && gb > 4) {
    disk.low = false
    for (const project of config.projects) activity(project, '-', 'resume', `Drive ${drive} has ${gb.toFixed(1)} GB free; new agents resumed`)
  }
  return disk.low
}

function archiveNoReview(project, tasksDir) {
  const result = archiveNoReviewCards(tasksDir)
  for (const id of result.archived) {
    lastActivityHold.delete(`${project}:${id}:no-review-archive`)
    activity(project, id, 'move', 'archived after integration')
  }
  for (const { id, reason } of result.skipped) {
    const key = `${project}:${id}:no-review-archive`
    if (lastActivityHold.get(key) === reason) continue
    lastActivityHold.set(key, reason)
    schedulerActivity(project, `${id}: archive without independent review skipped — ${reason}`)
  }
  return result.archived.length > 0
}

// Logs and routes reconcileCompletedHandoffs results; true when the board changed.
function logIntegrationResults(project, results, waiting = {}) {
  const tasksDir = tasksDirOf(project)
  let dirty = false
  for (const result of results) {
    if (!['integrated', 'cleaned'].includes(result.status)) waiting[result.id] = result.reason
    if (result.status === 'integrated') {
      activity(project, result.id, 'integrated', `commit ${result.commit}${result.cleanupPending ? '; cleanup deferred until pane releases the directory' : '; card worktree cleaned'}`)
      dirty = true
    } else if (result.status === 'cleaned') {
      activity(project, result.id, 'cleanup', 'removed integrated card worktree and local branch')
    } else if (result.status === 'cleanup-held') {
      const key = `${project}:${result.id}:cleanup`
      if (lastActivityHold.get(key) !== result.reason) {
        lastActivityHold.set(key, result.reason)
        activity(project, result.id, 'cleanup-held', result.reason)
      }
    } else if (result.status === 'returned') {
      activity(project, result.id, 'integration-conflict', `${result.reason} — returned to ${result.to === 'owner' ? 'Owner' : 'a Builder'}`, 'error')
      dirty = true
    } else if (result.status === 'issue') {
      try {
        const card = findCard(tasksDir, result.id)
        if (card.column === 'completed') {
          recordOperationalFailure(tasksDir, card, result.reason, integrationPathOf(project), projectSettingsOf(project))
        }
      } catch {}
      activity(project, result.id, /conflict/i.test(result.reason) ? 'integration-conflict' : 'integration-block', result.reason, 'error')
      dirty = true
    } else {
      const key = `${project}:${result.id}:handoff`
      if (lastActivityHold.get(key) !== result.reason) activity(project, result.id, 'integration-held', result.reason, 'error')
      lastActivityHold.set(key, result.reason)
    }
  }
  return dirty
}

// The operator's archive: move with operatorArchive, then release its binding and card run.
// Planner assignments for archived cards are retired by the next planner pass.
function operatorArchiveRelease(project, id) {
  unbind(tasksDirOf(project), id)
  stopCardRun(project, id, 'Archived by operator from board')
}

function tripBreakerIfNeeded(project) {
  const state = breakerState(project)
  if (state.breakerTripped && !announcedBreakers.has(project)) {
    announcedBreakers.add(project)
    console.log(`circuit breaker tripped: ${state.reason} — auto-spawn halted, reset from Settings`)
    activity(project, '-', 'breaker-trip', state.reason, 'error')
    herdrLog(`${project}: circuit breaker tripped: ${state.reason}`, 'error')
  }
}

// Concurrent callers (the poll loop, every open board tab) share one herdr call per
// project: a slow herdr otherwise got one call per request and slowed further.
const agentPolls = new Map()
function pollAgents(project) {
  if (!agentPolls.has(project)) agentPolls.set(project, pollAgentsNow(project).finally(() => agentPolls.delete(project)))
  return agentPolls.get(project)
}

async function pollAgentsNow(project) {
  try {
    const allAgents = await agentList(sessionOf(project), { ensureSession: !controlState(project, CONFIG_PATH).paused && config.maxConcurrentAgents > 0 && missionAllowsProject(project) })
    reconcileUsage(tasksDirOf(project), allAgents)
    for (const [id, saved] of Object.entries(readWorkflow(tasksDirOf(project)))) {
      if (!saved.completedAt || saved.outputSavedAt === saved.completedAt || !saved.builder) continue
      const agent = allAgents.find(a => a.pane_id === saved.builder.pane_id && ['idle', 'done'].includes(a.agent_status))
      if (!agent) continue
      try {
        appendHistory(tasksDirOf(project), id, { event: 'finished-output', run: agent.agent_session, agent: agent.name, output: await paneRead(agent.pane_id, sessionOf(project)) })
        updateWorkflow(tasksDirOf(project), id, { outputSavedAt: saved.completedAt })
      } catch { /* Retain the session and retry output capture next poll. */ }
    }
    // The project's agents: its workspace in the shared HERDR session plus any still
    // running in its old per-project session. Builder cwd points at its isolated
    // worktree, so exact-cwd filtering would make live panes vanish.
    const agents = allAgents
    if (herdrFailed) { console.log('herdr: back up'); herdrFailed = false }
    if (herdrUnconfirmedSince) { herdrUnconfirmedSince = null; resolveManagerException(HERE, 'herdr') }
    const state = { agents, herdrUp: true }
    agentCache.set(project, state)
    return state
  } catch (err) {
    if (!herdrFailed) { console.log('herdr: unavailable —', err.message); herdrFailed = true }
    // herdr is shared, so one alert for all projects, and only after the scheduled
    // watchdog (every 5 minutes) has had a chance to start it.
    herdrUnconfirmedSince ??= Date.now()
    if (missionAllowsProject(project) && Date.now() - herdrUnconfirmedSince >= HERDR_ALERT_AFTER_MS) {
      await notifyManagerException({
        boardRoot: HERE,
        key: 'herdr',
        title: 'HERDR unavailable',
        detail: `${project}: ${err.message}`,
      })
    }
    const state = { agents: [], herdrUp: false }
    agentCache.set(project, state)
    return state
  }
}

function boardPayload(project) {
  const cached = agentCache.get(project) ?? { agents: [], herdrUp: false }
  const breaker = breakerState(project)
  const board = readBoard(tasksDirOf(project))
  const planners = readCardPlanners(tasksDirOf(project))
  const workflow = readWorkflow(tasksDirOf(project))
  let indicators = {}, times = {}
  try { indicators = stageIndicators({ tasksDir: tasksDirOf(project), reviewRoot: REVIEW_ROOT, board, planners, claims: readReviewClaims(REVIEW_ROOT), agents: cached.agents, workflow }) }
  catch (error) { console.error(`${project}: stage indicators unavailable — ${error.message}`) }
  try { times = laneTimes({ tasksDir: tasksDirOf(project), board, planners, workflow, claims: readReviewClaims(REVIEW_ROOT), agents: cached.agents }) }
  catch (error) { console.error(`${project}: lane times unavailable — ${error.message}`) }
  const blockerIds = {}
  try {
    const registry = readWorktrees(tasksDirOf(project))
    for (const card of Object.values(board).flat()) blockerIds[card.id] = [...new Set([
      ...unmetBlockers(card, board, registry),
      ...(card.column === 'queue' ? recordedOverlapBlockers(card, integrationPathOf(project), registry) : []),
    ])]
  } catch { /* Unknown lock state must not invent visual relationships. */ }
  return {
    project,
    control: controlState(project, CONFIG_PATH),
    release: controlState(project, CONFIG_PATH).release ?? null, // { startedAt }: why a project is paused for a release
    cardRuns: readCardRuns().filter(r => r.project === project),
    cardRunEligibility: Object.fromEntries(Object.values(board).flat().map(card => [card.id, cardRunEligibility({ project, tasksDir: tasksDirOf(project), projectPath: integrationPathOf(project), card, board, agents: cached.agents, known: cached.herdrUp })])),
    plannerRecoveryCards: Object.entries(readCardPlanners(tasksDirOf(project))).filter(([, o]) => o.lifecycle === 'retired' && o.recoveryReady && o.reconciliationHistoryId).map(([id]) => id),
    projectPath: projectPathOf(project),
    integrationPath: integrationPathOf(project),
    columns: COLUMNS,
    archive: ARCHIVE,
    board,
    blockerIds,
    cardUsage: cardUsageSummary(tasksDirOf(project)),
    planners,
    workflow,
    stageIndicators: indicators,
    // Per card in Planning/Queue/Working/Review/Completed: { since (ISO, lane entry), agentActive, agentRole, agentName }.
    laneTimes: times,
    bindings: readBindings(tasksDirOf(project)),
    retries: readRetries(tasksDirOf(project)),
    // Why a queued card did not start on the last tick — an unmet Blocked-by, or
    // files another card is still holding. Without it a held card is visually
    // identical to one simply waiting its turn.
    holds: { ...holdsFor(project), ...quotaHoldsOf(project, board) },
    // Engine usage blocks in force, keyed "claude" (every model) or "claude:<model>": { until, since }.
    quotaBlocks: activeQuota(HERE),
    agents: cached.agents,
    herdrUp: cached.herdrUp,
    breakerTripped: breaker.breakerTripped,
    breakerReason: breaker.reason ?? null,
    breakerAt: breaker.at ?? null,
    slotsFree: slotsFree({
      tasksDir: tasksDirOf(project),
      agents: cached.agents,
      max: config.maxConcurrentAgents,
    }),
    config: {
      mode: config.mode ?? 'auto',
      stallSeconds: config.stallSeconds,
      maxConcurrentAgents: config.maxConcurrentAgents,
      leadPlanner: config.leadPlanner ?? { autoIssues: false },
      model: config.models.working,
      trivialModel: config.models.trivial ?? config.models.working,
      reviewModel: config.models.review,
      sweepModel: config.models.issues,
      engine: engineFor('working').kind ?? engineFor('working'),
      agentSettings: globalSettings(config),
      supportedAgentSettings: catalog(),
      mission: config.mission ?? null,
    },
  }
}

// --- project chat reads: stuck cards and summary ---------------------------

// When the card's last Blocked-by card landed (integrated, else archived), or 0.
const lastBlockerLanded = (tasksDir, card, board, registry) => Math.max(0, ...(card.blockedBy || []).map(id => {
  const archived = board.archive.find(c => c.id === id)
  return Date.parse(registry[id]?.integratedAt ?? '') || (archived ? laneEnteredAt(tasksDir, id, 'archive') ?? archived.mtime : 0)
}))

// Every non-archived card with its minutes in lane, the live agent working on it and
// why it waits, from the same lane times, holds and stage indicators the board shows.
function cardWaits(project, now = Date.now()) {
  const tasksDir = tasksDirOf(project), board = readBoard(tasksDir), planners = readCardPlanners(tasksDir), workflow = readWorkflow(tasksDir)
  const agents = agentCache.get(project)?.agents ?? [], claims = readReviewClaims(REVIEW_ROOT)
  let indicators = {}, times = {}
  try { indicators = stageIndicators({ tasksDir, reviewRoot: REVIEW_ROOT, board, planners, claims, agents, workflow }) } catch { /* as on the board: no indicator */ }
  try { times = laneTimes({ tasksDir, board, planners, workflow, claims, agents }) } catch { /* fall back to lane entry below */ }
  const holds = { ...holdsFor(project), ...quotaHoldsOf(project, board) }
  let registry = {}
  try { registry = readWorktrees(tasksDir) } catch { /* no registry: blockers count as unmet by archive state alone */ }
  const cards = COLUMNS.flatMap(c => board[c.key] || []).map(card => {
    // The stuck clock starts when the last blocker landed if that is later: a card that waited
    // hours read as stuck the moment its blocker landed (Injectbuddy I341, I344, 2026-09-27).
    const since = Math.max(Date.parse(times[card.id]?.since ?? '') || (laneEnteredAt(tasksDir, card.id, card.column) ?? card.mtime), lastBlockerLanded(tasksDir, card, board, registry))
    // A Planner's `hkb wait`: the files or cards its plan needs that do not exist yet.
    const wait = card.column === 'planning' && workflow[card.id]?.waitFor, needs = wait ? [...wait.cards, ...wait.files] : []
    const waitingOn = [...new Set([...unmetBlockers(card, board, registry), ...needs])]
    return { project, id: card.id, title: card.title, lane: card.column, minutes: Math.floor((now - since) / 60000),
      agent: times[card.id]?.agentActive ? times[card.id].agentName : null, waitingOn,
      reason: holds[card.id] ?? (wait?.decision ? 'waiting for a decision' : needs.length ? `waiting for ${needs.join(', ')}` : waitingOn.length ? `waiting on ${waitingOn.join(', ')}` : null) ?? indicators[card.id]?.reason ?? null }
  })
  return { board, cards }
}

// Stuck = waiting past the threshold with nobody working on it and no unfinished blocker.
// A card an agent is on, or one queued behind another card, is moving (operator saw
// "stuck 3" for cards waiting on I307 that were planned the minute it merged, 2026-09-26).
const isStuck = (c, minutes) => c.minutes >= minutes && !c.agent && !c.waitingOn.length

// Commits on the integration checkout not yet in origin/master (no fetch); null without Git.
function integrationAheadOfMaster(project) {
  const path = projectSettingsOf(project)?.integrationPath
  if (!path) return null
  const r = spawnSync('git', ['-C', path, 'rev-list', '--count', 'origin/master..HEAD'], { encoding: 'utf8', timeout: 5000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } })
  return r.status === 0 ? Number(r.stdout.trim()) : null
}

function projectSummary(project) {
  const { board, cards } = cardWaits(project)
  const control = controlState(project, CONFIG_PATH)
  const oldest = cards.reduce((a, c) => (!a || c.minutes > a.minutes ? c : a), null)
  return {
    project,
    paused: control.paused,
    ...(control.release && { release: control.release }),
    lanes: Object.fromEntries(COLUMNS.map(c => [c.key, (board[c.key] || []).length])),
    oldestCard: oldest && { id: oldest.id, lane: oldest.lane, minutes: oldest.minutes },
    owner: board.owner.map(c => c.id),
    pou: board.pou.map(c => c.id),
    stuck: cards.filter(c => isStuck(c, 60)).length,
    quotaBlocks: activeQuota(HERE),
    integrationAheadOfMaster: integrationAheadOfMaster(project),
  }
}

// --- the spawner -----------------------------------------------------------

// Runs on every agent poll. Does nothing unless a card is sitting in Queue and a
// slot is free; autoSpawn holds its own lock so a slow spawn cannot re-enter.
async function tick(project, agents) {
  if (controlState(project, CONFIG_PATH).paused) return []
  // Auto-Manager mode: Planned is not a gate, it is a staging shelf — every card on
  // it belongs in the Queue (operator, 2026-08-17). No agent is needed to decide
  // that, so the move happens here rather than costing a sweep. Queue order still
  // holds the cards back: autoSpawn skips anything with an unmet "**Blocked by:**"
  // or a dirty preflight, and only one card runs at a time.
  const tasksDir = tasksDirOf(project)
  const max = config.maxConcurrentAgents
  if (max <= 0 || breakerState(project).breakerTripped) return []
  if (config.mode === 'manager' || config.autoQueuePlanned === true) {
    for (const id of promotePlanned(tasksDir, { mission: config.mission, project })) {
      console.log(`queued: ${id}`)
      activity(project, id, 'move', 'planned -> queue (auto)')
    }
  }
  // The cap is builders only. Slots are counted from card bindings, so the
  // operator's own panes — kanban manager, planner, reviewer, sweeper — are not
  // builders and never eat one (operator, 2026-08-18: keep 4 builders running).
  const started = await autoSpawn({
    project,
    projectPath: integrationPathOf(project),
    tasksDir,
    boardRoot: HERE,
      model: config.models.working,
      trivialModel: config.models.trivial ?? config.models.working,
      engine: engineFor('working'),
      trivialEngine: engineFor('trivial'),
    max,
    agents,
    onChange: () => broadcastBoard(project),
    log: (msg) => schedulerActivity(project, msg),
    mission: config.mission,
    stallSeconds: config.stallSeconds,
    gitSettings: projectSettingsOf(project),
    assignmentForCard: (card, stage) => assignmentForCard(project, card, stage),
  })
  if (started.length) {
    console.log(`spawned: ${started.join(', ')}`)
    for (const id of started) {
      recordSpawn({ project, cap: max })
      activity(project, id, 'builder-start', 'Builder started in isolated worktree')
    }
    tripBreakerIfNeeded(project)
  }

  return started
}

// Runs on a fixed interval per project, independent of whether any browser is
// connected — a card must still get spawned when the board is opened headless.
async function pollProject(project) {
  if (projectPolls.has(project)) {
    // A long poll (an integration check can run 10 minutes) is still the board acting.
    if (actingPolls.has(project)) recordHealthyPoll(tasksDirOf(project))
    return
  }
  projectPolls.add(project)
  try {
    const tasksDir = tasksDirOf(project)
    const gitSettings = projectSettingsOf(project)
    if (archiveNoReview(project, tasksDir)) broadcastBoard(project)
    const { agents, herdrUp } = await pollAgents(project)
    broadcast(project, 'agents', { project, agents, herdrUp })
    if (!herdrUp) { stopCardRun(project, null, 'Agent inventory unavailable; explicit run stopped'); return }
    const lowDisk = diskLow()
    if (activeCardRun(project)) {
      if (!lowDisk) await tickCardRun({ project, projectPath: integrationPathOf(project), tasksDir, boardRoot: HERE, reviewRoot: REVIEW_ROOT, agents, config: { ...config, assignmentForCard: (card, stage) => assignmentForCard(project, card, stage) }, gitSettings, inventory: reviewInventory, log: msg => schedulerActivity(project, msg) })
      broadcastBoard(project)
      return
    }
    // Observe usage/results during Pause, but leave assignments and recovery intact.
    // A release pause drains instead: running Builders finish and their cards integrate; nothing new starts.
    const control = controlState(project, CONFIG_PATH)
    if (control.paused && !control.release) { broadcastBoard(project); return }
    // Pushover alert for every card that newly lands in Owner (one attempt each).
    alertOwnerCards({ project, tasksDir }).then(ids => { if (ids.length) activity(project, ids.join(','), 'owner-alert', 'Pushover sent') })
      .catch(err => { if (lastActivityHold.get(`${project}:owner-alert`) !== err.message) { lastActivityHold.set(`${project}:owner-alert`, err.message); activity(project, '-', 'owner-alert', `Pushover failed: ${err.message}`, 'error') } })
    // Before the stall check, so a reviewer slot freed here counts.
    try {
      for (const claim of await reconcileReviewers({ reviewRoot: REVIEW_ROOT, boardRoot: HERE, project, tasksDir, agents })) activity(project, claim.cards.join(',') || '-', 'cleanup', `reviewer claim ${claim.paneId || claim.id} retired: ${claim.closeReason}`)
    } catch (err) { if (!err.busy) schedulerActivity(project, `review ownership unavailable: ${err.message}`) }
    // Safety net first, so a failure later in this poll cannot hide a stall.
    if (config.maxConcurrentAgents > 0 && missionAllowsProject(project) && !breakerState(project).breakerTripped) {
      actingPolls.add(project)
      try {
        const claims = readReviewClaims(REVIEW_ROOT)
        const stalls = checkStalls({ tasksDir, agents, claims, holds: { ...integrationHolds.get(project), ...holdsFor(project), ...quotaHoldsOf(project) }, minutes: config.stallMinutes ?? 20, paused: lowDisk, resumedAt: controlState(project, CONFIG_PATH).changedAt, gapEndedAt: recordHealthyPoll(tasksDir), holdsKnown: holdsReady.has(project),
          builderSlotsFree: slotsFree({ tasksDir, agents, max: config.maxConcurrentAgents }), plannerSlotsFree: (config.maxPlanners ?? 4) - busyPlanners(agents), reviewerSlotsFree: MAX_REVIEWERS - claims.filter(c => !c.closedAt).length })
        for (const s of stalls) activity(project, s.id, 'stall', `${s.column}: ${s.reason} — ${s.action}`, 'error')
        if (stalls.length) broadcastBoard(project)
      } catch (err) {
        if (lastActivityHold.get(`${project}:stall-watchdog`) !== err.message) activity(project, '-', 'stall-watchdog', `stall check failed: ${err.message}`, 'error')
        lastActivityHold.set(`${project}:stall-watchdog`, err.message)
      }
    }
    await resumeDeliveries(sessionOf(project))

    // Put the agents workspace back if it was closed, before anything spawns into it.
    await ensureAgentWorkspace(agents, (msg) => console.log(msg), sessionOf(project))

    let dirty = false
    if (!reconciliationPolls.has(project)) {
      reconciliationPolls.add(project)
      try {
    // Only herdr knows a pane died; drop bindings it no longer lists, then
    // deterministically recover its worktree instead of leaving Working stuck.
    const beforeReap = readBindings(tasksDir)
    const reaped = Object.entries(beforeReap).filter(([, binding]) => !agents.some(agent => agent.pane_id === binding.pane_id) && !(binding.spawning && Date.now() - Date.parse(binding.started) < 300000)).map(([id]) => id)
    const staleFinished = []
    const liveByPane = new Map(agents.map((agent) => [agent.pane_id, agent]))
    for (const [id, binding] of Object.entries(beforeReap)) {
      const agent = liveByPane.get(binding.pane_id)
      const key = `${project}:${id}`
      if (!agent || !['done', 'idle'].includes(agent.agent_status)) {
        finishedBindingSince.delete(key)
        continue
      }
      const since = finishedBindingSince.get(key) ?? Date.now()
      finishedBindingSince.set(key, since)
      if (Date.now() - since >= FINISHED_BINDING_GRACE_MS) {
        finishedBindingSince.delete(key)
        staleFinished.push(id)
      }
    }
    const orphaned = []
    for (const card of readBoard(tasksDir).working) {
      const key = `${project}:${card.id}`
      if (beforeReap[card.id]) {
        orphanWorkingSince.delete(key)
        continue
      }
      const since = orphanWorkingSince.get(key) ?? Date.now()
      orphanWorkingSince.set(key, since)
      if (Date.now() - since >= FINISHED_BINDING_GRACE_MS) {
        orphanWorkingSince.delete(key)
        orphaned.push(card.id)
      }
    }
    const recoverIds = [...new Set([...reaped, ...staleFinished, ...orphaned])]
    dirty = recoverIds.length > 0
    for (const id of recoverIds) {
      recordUsageFinish({ tasksDir, paneId: beforeReap[id]?.pane_id, binding: beforeReap[id], status: 'ambiguous' }).catch(() => {})
      try {
        if (await recoverBuilderNoHandoff({ tasksDir, cardId: id, agents, session: sessionOf(project), workspace: integrationPathOf(project), gitSettings, graceMs: FINISHED_BINDING_GRACE_MS })) {
          dirty = true
          continue
        }
        const pendingRecovery = readWorkflow(tasksDir)[id]?.builderRecovery
        if (['claimed', 'uncertain'].includes(pendingRecovery?.status)) continue
        // A nudged Builder still working must not be moved under it (Tradeflow T-42:
        // the card was routed to Issues mid-work and its handoff hit two copies).
        const nudgedAgent = pendingRecovery?.status === 'nudged' && liveByPane.get(pendingRecovery.paneId)
        if (nudgedAgent && !['idle', 'done'].includes(nudgedAgent.agent_status)) continue
        const card = findCard(tasksDir, id)
        const agent = liveByPane.get(beforeReap[id]?.pane_id)
        const evidence = agent ? await paneRead(agent.pane_id, sessionOf(project)).catch(() => '') : ''
        const assigned = assignmentForCard(project, card, card.trivial ? 'trivial' : 'working')
        const routed = routeBuilderNoHandoff({
          tasksDir,
          cardId: id,
          reason: `Session ${beforeReap[id]?.pane_id || 'unknown'} ${agent ? `finished with status=${agent.agent_status}` : 'is missing'} without a valid Builder handoff from Working`,
          evidence,
          workspace: integrationPathOf(project),
          gitSettings,
          boardRoot: HERE,
          engine: assigned.engine,
          model: assigned.model,
        })
        // Requeued to wait out an engine usage limit: its idle pane is of no further use.
        if (routed.column === 'queue' && agent) await paneClose(agent.pane_id, sessionOf(project)).catch(() => {})
      } catch (err) {
        if (!ambiguousHold(project, err)) activity(project, id, 'block', `recovery needs attention: ${err.message}`, 'error')
      }
    }

    if (config.maxConcurrentAgents > 0 && missionAllowsProject(project) && !breakerState(project).breakerTripped) {
      for (const card of readBoard(tasksDir).issues) {
        try {
          if (await recoverBuilderNoHandoff({ tasksDir, cardId: card.id, agents, session: sessionOf(project), workspace: integrationPathOf(project), gitSettings })) dirty = true
        } catch (err) {
          if (!ambiguousHold(project, err)) activity(project, card.id, 'recovery-held',`Builder recovery needs attention: ${err.message}`, 'error')
        }
      }
    }

    // A Builder hands off before integration. Validate and cherry-pick each
    // completed card serially, routing only the failing card back to its Planner.
    if (gitSettings) {
      const waiting = {} // why each card is not integrated yet, for the stall watchdog's Owner note
      integrationHolds.set(project, waiting)
      dirty = logIntegrationResults(project, await reconcileCompletedHandoffs({ tasksDir, project, integrationCheck: gitSettings.integrationCheck }), waiting) || dirty
    }
      } finally {
        reconciliationPolls.delete(project)
      }
    }
    dirty = archiveNoReview(project, tasksDir) || dirty

    const autoEnabled = !controlState(project, CONFIG_PATH).paused && config.maxConcurrentAgents > 0 && missionAllowsProject(project) && !breakerState(project).breakerTripped
    if (autoEnabled) {
      const promoted = promoteAutoReview(tasksDir, { all: config.mode === 'manager' })
      for (const id of promoted) activity(project, id, 'move', 'completed -> review (auto)')
      dirty = promoted.length > 0 || dirty
      let busyCards = null
      try { busyCards = busyReviewCards(REVIEW_ROOT, tasksDir, agents) } catch (err) { schedulerActivity(project, `review ownership unavailable: ${err.message}`) }
      const routed = routeReviewVerdicts(tasksDir, {
        reviewRoot: REVIEW_ROOT,
        log: (msg) => schedulerActivity(project, msg),
        reviewBusy: busyCards === null,
        busyCardIds: busyCards || [],
        includeCompleted: true,
      })
      for (const id of routed) activity(project, id, 'move', 'review verdict routed')
      dirty = routed.length > 0 || dirty
    }
    if (dirty) broadcastBoard(project)

    // Finished agents are observed every poll, but panes are only retired by the
    // hourly housekeeping gate so ordinary polling does not churn HERDR windows.
    const now = Date.now()
    const closed = await closeFinished({ tasksDir, agents, project, now, retire: cleanupDue(project, now) })
    for (const pane of closed) activity(project, '-', 'cleanup', `closed finished pane ${pane}`)

    // Builders are the main flow. Start them before slower planner/reviewer
    // housekeeping so a guarded poll never starves Queue capacity.
    for (const id of confirmLateDeliveries({ tasksDir, session: sessionOf(project), agents })) activity(project, id, 'delivery', 'agent started after a slow start; delivery confirmed, hold cleared')
    if (!lowDisk) { await tick(project, agents); holdsReady.add(project) }

    if (autoEnabled && !lowDisk) {
      if (config.leadPlanner?.autoIssues) {
      const planner = await runCardPlanner({
        project,
        projectPath: integrationPathOf(project),
        tasksDir,
        boardRoot: HERE,
        model: config.models.planning ?? config.models.issues,
        engine: engineFor('planning'),
        maxPlanners: config.maxPlanners ?? 4,
        assignmentForCard: (card, stage) => assignmentForCard(project, card, stage),
        mission: config.mission,
        onHold: (err) => ambiguousHold(project, err),
        onCardError: (card, err) => { if (!ambiguousHold(project, err)) activity(project, card.id, 'failure', `planner: ${err.message}`, 'error') },
      }).catch((err) => {
        if (err.paused || ambiguousHold(project, err)) return null
        recordSpawnFailure({ project, cap: config.maxConcurrentAgents, reason: err.message })
        if (!err.busy && !/nothing in Issues/.test(err.message)) {
          console.log(`lead planner skipped — ${err.message}`)
          activity(project, '-', 'failure', err.message, 'error')
        }
        return null
      })
      if (!planner && readBoard(tasksDirOf(project)).issues.some(c => !c.cardOwned)) {
        const sweeper = await spawnIssuesSweeper({ project, projectPath: integrationPathOf(project), tasksDir, boardRoot: HERE, model: config.models.issues ?? config.models.planning, engine: engineFor('issues'), assignmentForCard: (card, stage) => assignmentForCard(project, card, stage), mission: config.mission }).catch(err => {
          if (!err.busy && !/nothing in Issues/.test(err.message)) console.log(`legacy planner skipped — ${err.message}`)
          if (!err.busy && !/nothing in Issues/.test(err.message)) activity(project, '-', 'failure', err.message, 'error')
          return null
        })
        if (sweeper) for (const id of sweeper.cards) activity(project, id, 'planner-start', 'Issues sweeper started')
      }
      if (planner) {
        if (planner.spawnedNewAgent) recordSpawn({ project, cap: config.maxConcurrentAgents })
        tripBreakerIfNeeded(project)
        for (const id of planner.cards) activity(project, id, 'planner-start', 'Lead Planner started')
        herdrLog(`Lead Planner started for ${planner.cards.length} card(s): ${planner.cards.join(', ')}`)
        broadcastBoard(project)
      }
      }

      const reviewer = await autoReview({
      reviewRoot: REVIEW_ROOT,
      inventory: reviewInventory,
      project,
      projectPath: integrationPathOf(project),
      tasksDir,
      boardRoot: HERE,
      model: config.models.review,
      engine: engineFor('review'),
      assignmentForCard: (card, stage) => assignmentForCard(project, card, stage),
      agents,
      log: (msg) => schedulerActivity(project, msg),
    })
      if (reviewer) {
        recordSpawn({ project, cap: config.maxConcurrentAgents })
        tripBreakerIfNeeded(project)
        for (const id of reviewer.cards) activity(project, id, 'reviewer-start', 'Reviewer started')
        herdrLog(`review started for ${reviewer.cards.length} card(s): ${reviewer.cards.join(', ')}`)
        broadcastBoard(project)
      }
    }

    for (const card of readBoard(tasksDir).owner) {
      const recovery = recoveryState(readFileSync(card.path, 'utf8'))
      if (!recovery.escalatedAt) continue
      await notifyManagerException({ boardRoot: HERE, key: `recovery:${project}:${card.id}:${recovery.escalatedAt}`,
        title: `${project} ${card.id}: automatic recovery stopped after ${recovery.returns} failed returns`,
        detail: `Five distinct failed returns; attempts and failure evidence preserved in ${card.path}. Choose a changed recovery approach, narrower scope, or cancellation. No unchanged retry is authorized.` })
    }
    const ageing = ownerAgeing(tasksDir)
    if (ageing) await notifyManagerException({ boardRoot: HERE, key: `owner:${project}`, title: `${project}: ${ageing.title}`, detail: ageing.detail })
    // One alert per engine block (its reset time is in the key), shared by every project's poll.
    for (const [kind, block] of Object.entries(activeQuota(HERE))) {
      await notifyManagerException({ boardRoot: HERE, key: `quota:${kind}:${block.until}`, cooldownMs: Infinity, title: `${kind} usage limit`,
        detail: `No ${kind} agent starts on any project until ${new Date(block.until).toLocaleString()}. Waiting cards keep their lanes and resume by themselves.` })
    }
    const breaker = breakerState(project)
    if (breaker.breakerTripped) {
    await notifyManagerException({
      boardRoot: HERE,
      key: 'circuit-breaker',
      title: 'Kanban circuit breaker tripped',
      detail: breaker.reason || 'auto-spawn halted',
    })
    }
    for (const [id, reason] of Object.entries(holdsFor(project))) {
      const key = `${project}:${id}`
      if (lastActivityHold.get(key) !== reason) {
        lastActivityHold.set(key, reason)
        activity(project, id, 'hold', reason)
      }
      if (!isHardHold(reason)) continue
      await notifyManagerException({
      boardRoot: HERE,
      key: `hold:${project}:${id}`,
      title: `${project} ${id} held`,
      detail: reason,
      })
    }
  } catch (error) {
    const message = error?.message || String(error)
    if (pollErrors.get(project) !== message) {
      pollErrors.set(project, message)
      console.error(`${project}: poll failed — ${message}`)
      try { activity(project, '-', 'poll-error', message, 'error') } catch {}
    }
  } finally {
    projectPolls.delete(project)
    actingPolls.delete(project)
  }
}

// --- SSE -------------------------------------------------------------------

const clients = new Set() // { res, project }

const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

function broadcast(project, event, data) {
  for (const c of clients) if (c.project === project) send(c.res, event, data)
}

const broadcastBoard = (project) => broadcast(project, 'board', boardPayload(project))

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const lastCleanup = new Map()

function cleanupDue(project, now = Date.now()) {
  const last = lastCleanup.get(project) ?? 0
  if (now - last < CLEANUP_INTERVAL_MS) return false
  lastCleanup.set(project, now)
  return true
}

// One watcher and one agent poller per project, shared by every connected tab.
// Per-client pollers would spawn a herdr process per tab every 2s.
const feeds = new Map() // project -> { watcher, debounce, retry, poll, clients }

function openFeed(project) {
  const existing = feeds.get(project)
  if (existing) return ++existing.clients

  const feed = { watcher: null, debounce: null, retry: null, clients: 1 }
  feeds.set(project, feed)

  const onChange = () => {
    clearTimeout(feed.debounce)
    feed.debounce = setTimeout(() => broadcastBoard(project), 150)
  }

  const startWatch = () => {
    try {
      feed.watcher = watch(tasksDirOf(project), { recursive: true }, onChange)
      // A watch that dies (folder renamed, drive hiccup) must come back on its own.
      feed.watcher.on('error', () => {
        feed.watcher?.close()
        feed.watcher = null
        feed.retry = setTimeout(startWatch, 2000)
      })
    } catch {
      ensureTasks(project)
      feed.retry = setTimeout(startWatch, 2000)
    }
  }
  startWatch()

  return feed.clients
}

function closeFeed(project) {
  const feed = feeds.get(project)
  if (!feed || --feed.clients > 0) return
  clearTimeout(feed.debounce)
  clearTimeout(feed.retry)
  feed.watcher?.close()
  feeds.delete(project)
}

function sse(req, res, project) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const client = { res, project }
  clients.add(client)
  send(res, 'board', boardPayload(project))
  openFeed(project)

  const beat = setInterval(() => res.write(': ping\n\n'), 30000)

  req.on('close', () => {
    clients.delete(client)
    clearInterval(beat)
    closeFeed(project)
  })
}

// --- static ----------------------------------------------------------------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

function serveStatic(urlPath, res) {
  const rel = normalize(urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).slice(1))
  const file = join(PUBLIC, rel)
  if (!file.startsWith(PUBLIC) || !existsSync(file)) return notFound(res)
  res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
const notFound = (res) => { res.writeHead(404); res.end('not found') }

function badMutationOrigin(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false
  const origin = req.headers.origin
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  if (lanHost) allowed.add(`http://${lanHost}:${port}`)
  if (origin && !allowed.has(origin)) return true
  return req.headers['sec-fetch-site'] === 'cross-site'
}

// --- routes ----------------------------------------------------------------

const handleRequest = async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const project = url.searchParams.get('project') ?? config.projects[0]

  if (badMutationOrigin(req)) return json(res, 403, { ok: false, error: 'invalid origin' })

  if (req.method === 'GET' && url.pathname === '/api/audits') {
    try { return json(res, 200, { ok: true, project, audits: readAuditReports(config, project) }) }
    catch (err) { return json(res, 400, { ok: false, error: err.message }) }
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-open') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const { project: selected, paneId } = JSON.parse(body)
      if (!config.projects.includes(selected)) throw new Error('Unknown project')
      await focusAgent(paneId, sessionOf(selected))
      return json(res, 200, { ok: true })
    } catch (err) { return json(res, 400, { ok: false, error: err.message }) }
  }
  if (req.method === 'POST' && url.pathname === '/api/herdr-open') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const { project: selected } = JSON.parse(body)
      if (!config.projects.includes(selected)) throw new Error('Unknown project')
      await openProjectSession(sessionOf(selected))
      return json(res, 200, { ok: true })
    } catch (err) { return json(res, 400, { ok: false, error: err.message }) }
  }
  if (req.method === 'GET' && url.pathname === '/api/card-history') {
    try {
      if (!config.projects.includes(project)) throw new Error('Unknown project')
      const path = historyPath(tasksDirOf(project), url.searchParams.get('id'))
      return json(res, 200, { entries: existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] })
    } catch (err) { return json(res, 400, { ok: false, error: err.message }) }
  }

  if (req.method === 'POST' && url.pathname === '/api/card-run') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const { project: selected, id, requestId, cancel } = JSON.parse(body)
      if (!config.projects.includes(selected)) throw new Error('Unknown project')
      if (cancel === true) {
        stopCardRun(selected, id, 'Cancelled by operator; current turn may finish')
      } else {
        const duplicate = readCardRuns().find(r => r.requestId === requestId)
        if (duplicate) {
          if (duplicate.project !== selected || duplicate.cardId !== id) throw new Error('Request identity already used')
          return json(res, 200, { ok: true, run: duplicate })
        }
        const agents = await agentList(sessionOf(selected), { ensureSession: false })
        const card = findCard(tasksDirOf(selected), id)
        const reason = cardRunEligibility({ project: selected, tasksDir: tasksDirOf(selected), projectPath: integrationPathOf(selected), card, agents, known: true })
        if (reason) throw new Error(reason)
        authorizeCardRun({ project: selected, cardId: card.id, autoReview: !!card.autoReview, requestId })
      }
      broadcastBoard(selected)
      return json(res, 200, { ok: true })
    } catch (err) { return json(res, 400, { ok: false, error: err.message }) }
  }
  if (req.method === 'POST' && url.pathname === '/api/project-control') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const { project: selected, paused } = JSON.parse(body)
      Object.assign(config, setProjectPaused(selected, paused, CONFIG_PATH))
      broadcastBoard(selected)
      return json(res, 200, { ok: true, control: controlState(selected, CONFIG_PATH) })
    } catch (err) { return json(res, 400, { ok: false, error: err.message }) }
  }

  // A project chat's release: start pauses and reports readiness, finish fast-forwards the
  // integration checkout to the released commit and unpauses, abort just unpauses.
  if (req.method === 'POST' && url.pathname.startsWith('/api/release/')) {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const { project: p, commit } = JSON.parse(body)
      if (!config.projects.includes(p)) throw new Error('Unknown project')
      const action = url.pathname.slice('/api/release/'.length)
      const active = controlState(p, CONFIG_PATH).release
      if (action === 'start') {
        if (!active) Object.assign(config, setProjectPaused(p, true, CONFIG_PATH, { release: { startedAt: new Date().toISOString() } }))
        broadcastBoard(p)
        const { agents, herdrUp } = await pollAgents(p)
        const waiting = releaseWaiting({ tasksDir: tasksDirOf(p), agents, herdrUp, integrating: reconciliationPolls.has(p) })
        return json(res, 200, { ok: true, ready: !waiting.length, waiting })
      }
      if (action !== 'finish' && action !== 'abort') return json(res, 404, { ok: false, error: 'Unknown release action' })
      if (!active) throw new Error(`No release in progress for ${p}; call /api/release/start first`)
      let integration
      if (action === 'finish') {
        if (reconciliationPolls.has(p)) throw new Error('The board is integrating right now; try again in a few seconds')
        const settings = projectSettingsOf(p)
        integration = finishRelease({ integrationPath: settings?.integrationPath, commit, branch: settings?.releaseBranch })
      }
      Object.assign(config, setProjectPaused(p, false, CONFIG_PATH))
      broadcastBoard(p)
      return json(res, 200, { ok: true, ...(integration && { integration }), control: controlState(p, CONFIG_PATH) })
    } catch (err) { return json(res, 400, { ok: false, error: err.message }) }
  }

  // Config projects first (they are the ones you named), then anything else herdr
  // has open under projectsRoot, so a project you opened after startup still shows.
  if (req.method === 'GET' && url.pathname === '/api/projects') {
    let open = []
    try {
      open = await openProjects(config.projectsRoot)
    } catch { /* herdr down: fall back to config alone */ }
    const known = config.projects.filter((p) => existsSync(tasksDirOf(p)))
    const extra = open.filter((p) => !known.includes(p) && existsSync(tasksDirOf(p)))
    return json(res, 200, { ok: true, projects: [...known, ...extra], open })
  }

  if (req.method === 'GET' && url.pathname === '/api/board') {
    // The poll loop keeps the agent cache fresh; a page load waits only for the first
    // fill, never for herdr (Kiwitown's empty board took 17s behind a slow herdr).
    const polled = pollAgents(project)
    if (!agentCache.has(project)) await polled
    else polled.catch(() => {})
    return json(res, 200, boardPayload(project))
  }

  if (req.method === 'GET' && url.pathname === '/api/manager-tasks') {
    try {
      const usage = mergeUsageSummaries(config.projects.flatMap(p => usageSummary(tasksDirOf(p))))
      return json(res, 200, {
        ok: true,
        source: REQUESTS_PATH,
        generatedAt: new Date().toISOString(),
        usage,
        tasks: readManagerTasks(REQUESTS_PATH),
      })
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message })
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/request-usage') {
    try {
      const p = url.searchParams.get('project') || config.projects[0]
      return json(res, 200, {
        ok: true,
        project: p,
        source: join(tasksDirOf(p), '.request-usage.json'),
        generatedAt: new Date().toISOString(),
        summary: usageSummary(tasksDirOf(p)),
        runs: Object.values(readUsage(tasksDirOf(p)).runs),
      })
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message })
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/request-usage/start') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const { project: p = config.projects[0], requestId, cardIds, role = 'manual', paneId, tabId, model, name, agentSession } = JSON.parse(body || '{}')
      if (!requestId) throw new Error('requestId is required')
      const identity = name ? (await agentList(sessionOf(p), { ensureSession: false })).find(a => a.name === name) : null
      const run = recordUsageStart({ tasksDir: tasksDirOf(p), project: p, requestId, cardIds, role, paneId: identity?.pane_id || paneId, tabId: identity?.tab_id || tabId, model, name, agentSession: identity?.agent_session || agentSession })
      return json(res, 200, { ok: true, run })
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message })
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/request-usage/finish') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const { project: p = config.projects[0], runId, paneId, status = 'complete', agentSession } = JSON.parse(body || '{}')
      const run = await recordUsageFinish({ tasksDir: tasksDirOf(p), runId, paneId, agent: { agent_session: agentSession }, status })
      return json(res, 200, { ok: true, run })
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message })
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/events') return sse(req, res, project)


  if (req.method === 'POST' && url.pathname === '/api/cards') {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 60000) return json(res, 413, { error: 'Brief too large' })
    }
    try {
      const { project: p, title, brief, category = 'code', workspace = '.', audit = '', tools = '', priority, blockedBy } = JSON.parse(body)
      if (!config.projects.includes(p)) throw new Error('Unknown project')
      // Audits run off the board (Tradeflow TF49 was created here by mistake).
      if (audit) throw new Error('Audits do not go on the board: follow C:/Users/PFrew/Projects/_roles/AUDIT-REQUESTS.md (auditor agent, report in Projects/_audits)')
      // Only API cards need ACs: internal creators (audit findings, fixtures) write their own briefs.
      if (typeof brief === 'string' && brief.trim() && !/AC\d+:/.test(brief)) throw new Error('The brief needs at least one acceptance criterion line, e.g. "AC1: <observable outcome>"')
      const mission = missionAllowsProject(p) ? config.mission?.id || '' : ''
      const card = createCard(tasksDirOf(p), { title, brief, category, workspace, audit, tools, mission, priority, blockedBy, prefix: config.cardPrefixes?.[p] })
      broadcastBoard(p)
      return json(res, 201, { ok: true, card })
    } catch (err) { return json(res, 400, { ok: false, error: err.message }) }
  }

  // Card-ready audit findings: GET to read them, POST to turn them into cards.
  if (url.pathname === '/api/audit-cards' && ['GET', 'POST'].includes(req.method)) {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const input = req.method === 'GET' ? { project: url.searchParams.get('project'), id: url.searchParams.get('id'), report: url.searchParams.get('report') || undefined } : JSON.parse(body || '{}')
      const p = input.project
      if (!config.projects.includes(p)) throw new Error('Unknown project')
      // Off-board Auditor reports live only under Projects/_audits (_roles/AUDITOR.md).
      if (input.report) {
        input.report = normalize(input.report)
        if (!input.report.toLowerCase().startsWith(AUDITS_ROOT.toLowerCase()) || extname(input.report) !== '.md') throw new Error(`report must be a .md file under ${AUDITS_ROOT}`)
      }
      if (req.method === 'GET') {
        const { audit, findings, links } = auditFindings(tasksDirOf(p), input)
        return json(res, 200, { ok: true, audit: { id: audit.id, title: audit.title, column: audit.column }, findings, links })
      }
      const mission = missionAllowsProject(p) ? config.mission?.id || '' : ''
      const result = cardsFromAudit(tasksDirOf(p), { ...input, mission, prefix: config.cardPrefixes?.[p] })
      for (const { n, id } of result.created) activity(p, id, 'create', `from ${result.audit} finding ${n}`)
      if (result.archivedNow) {
        operatorArchiveRelease(p, result.audit)
        activity(p, result.audit, 'move', '-> archive (every finding carded or declined)')
      }
      broadcastBoard(p)
      return json(res, 200, { ok: true, ...result })
    } catch (err) { return json(res, 400, { ok: false, error: err.message }) }
  }

  // Orchestrators maintain their own cards here: priority, blockers and dated notes.
  if (req.method === 'POST' && url.pathname === '/api/card-update') {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 60000) return json(res, 413, { error: 'Update too large' })
    }
    try {
      const { project: p, id, priority, addBlockedBy, removeBlockedBy, note } = JSON.parse(body)
      if (!config.projects.includes(p)) throw new Error('Unknown project')
      const tasksDir = tasksDirOf(p), current = findCard(tasksDir, id)
      const lockBlockers = ['working', 'review', 'completed'].includes(current.column) && !!(readBindings(tasksDir)[current.id] || reviewClaimFor(REVIEW_ROOT, tasksDir, current.id))
      const { card, changes } = updateCard(tasksDir, id, { priority, addBlockedBy, removeBlockedBy, note }, { lockBlockers })
      activity(p, card.id, 'update', `${changes.join('; ')} (API)`)
      json(res, 200, { ok: true, card, changes })
      broadcastBoard(p)
    } catch (err) {
      json(res, 400, { ok: false, error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/move') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const { project: p = config.projects[0], id, to } = JSON.parse(body)
      const before = findCard(tasksDirOf(p), id)
      const card = moveCard(tasksDirOf(p), id, to, { operatorArchive: to === 'archive' })
      // Moving a card held on a Planner's [decision] question is the answer: lift the hold.
      const decision = before.column === 'planning' && readWorkflow(tasksDirOf(p))[card.id]?.waitFor?.decision
      if ((['pou', 'owner'].includes(before.column) || decision) && to !== 'archive') operatorRetry(tasksDirOf(p), card.id, to)
      if (to === 'archive') operatorArchiveRelease(p, id)
      activity(p, card.id, 'move', `${before.column} -> ${to} (board)`)
      herdrLog(`${card.id} → ${to} (board)`)
      json(res, 200, { ok: true, card })
      broadcastBoard(p)
    } catch (err) {
      json(res, 400, { ok: false, error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/approve') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const { project: p = config.projects[0], id } = JSON.parse(body)
      if (!config.projects.includes(p)) throw new Error('Unknown project')
      const { card, investigation } = operatorApprove(tasksDirOf(p), id)
      activity(p, card.id, 'move', `owner -> ${card.column} (approved by operator${investigation ? '; investigation approved' : ''})`)
      herdrLog(`${card.id} approved → ${card.column} (board)`)
      json(res, 200, { ok: true, card, investigation })
      broadcastBoard(p)
    } catch (err) {
      json(res, 400, { ok: false, error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/finish') {
    let body = ''
    for await (const chunk of req) body += chunk
    let p
    try {
      const parsed = JSON.parse(body)
      p = parsed.project ?? config.projects[0]
      if (!config.projects.includes(p)) throw new Error('Unknown project')
      // Same guard as the poll: one integration pass per project at a time.
      if (reconciliationPolls.has(p)) return json(res, 409, { ok: false, error: 'The board is integrating right now; try Finish again in a few seconds' })
      reconciliationPolls.add(p)
      const before = findCard(tasksDirOf(p), parsed.id).column
      let result
      try {
        const settings = projectSettingsOf(p)
        result = await operatorFinish({ tasksDir: tasksDirOf(p), project: p, cardId: parsed.id, integrationCheck: settings?.integrationCheck, git: !!settings })
      } finally { reconciliationPolls.delete(p) }
      logIntegrationResults(p, result.results)
      const { card, held } = result
      broadcastBoard(p)
      if (held) {
        activity(p, card.id, 'integration-held', `Finish from board: ${held}`, 'error')
        // A Review card has already moved to Completed with the operator PASS; it archives after integration.
        if (before === 'review') return json(res, 200, { ok: true, card, held })
        return json(res, 409, { ok: false, card, error: `${card.id} not finished: integration held — ${held}` })
      }
      operatorArchiveRelease(p, card.id)
      activity(p, card.id, 'move', `${before} -> archive (finished by operator)`)
      herdrLog(`${card.id} finished → archive (board)`)
      json(res, 200, { ok: true, card })
    } catch (err) {
      json(res, 400, { ok: false, error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/spawn') {
    let body = ''
    for await (const chunk of req) body += chunk
    const { project: p = config.projects[0], id } = JSON.parse(body || '{}')
    const tasksDir = tasksDirOf(p)
    try {
      if (breakerState(p).breakerTripped) throw new Error('circuit breaker tripped — auto-spawn halted, reset from Settings')
      const card = findCard(tasksDir, id)
      if (!card) throw new Error(`unknown card: ${id}`)
      if (card.column !== 'queue') throw new Error(`${card.id} is in ${card.column}; only Queue cards can start`)

      // A second spawn would orphan the first pane and overwrite its binding, so
      // refuse while one is genuinely still alive. herdr decides what "alive" means.
      const existing = readBindings(tasksDir)[card.id]
      if (existing) {
        const { agents, herdrUp } = await pollAgents(p)
        if (!herdrUp) throw new Error('herdr agent state unknown; refusing explicit spawn')
        if (agents.some((a) => a.pane_id === existing.pane_id)) {
          throw new Error(`${card.id} is already running in ${existing.pane_id}`)
        }
        throw new Error(`${card.id}: assigned session is missing; recover its saved work/assignment before redispatch`)
      }

      const polled = await pollAgents(p)
      if (!polled.herdrUp) throw new Error('herdr agent state unknown; refusing explicit spawn')
      const [startedId] = await autoSpawn({
        project: p,
        projectPath: integrationPathOf(p),
        tasksDir,
        boardRoot: HERE,
        model: config.models.working,
        trivialModel: config.models.trivial ?? config.models.working,
        engine: engineFor('working'),
        trivialEngine: engineFor('trivial'),
        max: config.maxConcurrentAgents,
        agents: polled.agents,
        onChange: () => broadcastBoard(p),
        log: (msg) => schedulerActivity(p, msg),
        mission: config.mission,
        onlyIds: [card.id],
        gitSettings: projectSettingsOf(p),
      })
      if (!startedId) throw new Error(holdsFor(p)[card.id] || `${card.id} did not start`)
      activity(p, startedId, 'builder-start', 'Builder started by hand')
      herdrLog(`${startedId} spawned by hand`)
      json(res, 200, { ok: true, started: startedId })
    } catch (err) {
      activity(p, id || '-', 'failure', err.message, 'error')
      json(res, 400, { ok: false, error: err.message })
    }
    broadcastBoard(p)
    return
  }

  // A project chat registers as its project's manager: hkb found then goes to its inbox
  // instead of the Kanban Manager's. { project, chat: null } unregisters.
  if (url.pathname === '/api/project-manager' && ['GET', 'POST'].includes(req.method)) {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const input = req.method === 'GET' ? { project: url.searchParams.get('project') } : JSON.parse(body || '{}')
      const p = input.project
      if (!config.projects.includes(p)) throw new Error('Unknown project')
      if (req.method === 'POST') {
        const { chat } = input
        const inbox = (input.inbox ?? join(HERE, '..', '_roles', 'inbox', `${p}-INBOX.md`)).replaceAll('\\', '/')
        if (chat !== null) {
          if (typeof chat !== 'string' || !chat.trim() || chat.length > 60 || /[\r\n]/.test(chat)) throw new Error('chat must be the chat display name, 1-60 characters on one line')
          if (typeof inbox !== 'string' || !isAbsolute(inbox)) throw new Error('inbox must be an absolute path')
          try { mkdirSync(dirname(inbox), { recursive: true }) } catch (err) { throw new Error(`inbox folder cannot be created: ${err.message}`) }
        }
        // Patch the current file, as /api/config does; hkb reads it, so replace it atomically.
        Object.assign(config, JSON.parse(readFileSync(CONFIG_PATH, 'utf8')))
        config.projectSettings ||= {}
        const settings = config.projectSettings[p] ||= {}
        if (chat === null) delete settings.manager
        else settings.manager = { chat: chat.trim(), inbox }
        if (!Object.keys(settings).length) delete config.projectSettings[p]
        writeFileSync(CONFIG_PATH + '.tmp', JSON.stringify(config, null, 2) + '\n')
        renameSync(CONFIG_PATH + '.tmp', CONFIG_PATH)
        activity(p, '-', 'manager', chat === null ? 'project manager unregistered' : `project manager: ${chat.trim()} (${inbox})`)
      }
      return json(res, 200, { ok: true, project: p, manager: config.projectSettings?.[p]?.manager ?? null })
    } catch (err) { return json(res, 400, { ok: false, error: err.message }) }
  }

  // Cards at least `minutes` (default 60) in their lane, for one project or all of them.
  if (req.method === 'GET' && (url.pathname === '/api/stuck' || url.pathname === '/api/summary')) {
    try {
      const only = url.searchParams.get('project')
      if (only && !config.projects.includes(only)) throw new Error('Unknown project')
      const projects = (only ? [only] : config.projects).filter(p => existsSync(tasksDirOf(p)))
      if (url.pathname === '/api/summary') return json(res, 200, { ok: true, projects: projects.map(projectSummary) })
      const minutes = Number(url.searchParams.get('minutes') ?? 60)
      if (!Number.isFinite(minutes) || minutes < 0) throw new Error('minutes must be a number of minutes, 0 or more')
      return json(res, 200, { ok: true, minutes, cards: projects.flatMap(p => cardWaits(p).cards).filter(c => isStuck(c, minutes)).sort((a, b) => b.minutes - a.minutes) })
    } catch (err) { return json(res, 400, { ok: false, error: err.message }) }
  }

  // Settings are applied to the running server and written back to disk, so a
  // change takes effect on the next poll rather than at the next restart.
  if (req.method === 'POST' && url.pathname === '/api/config') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const patch = JSON.parse(body || '{}')
      // Other writers (project pause, hand edits like workflowLimits) change the
      // file after startup; patch the current file, not the startup copy.
      Object.assign(config, JSON.parse(readFileSync(CONFIG_PATH, 'utf8')))
      if ('maxConcurrentAgents' in patch) {
        const n = Number(patch.maxConcurrentAgents)
        if (!Number.isInteger(n) || n < 0 || n > 10) {
          throw new Error('maxConcurrentAgents must be a whole number from 0 to 10')
        }
        config.maxConcurrentAgents = n
      }
      if ('mode' in patch) {
        if (!['auto', 'manager'].includes(patch.mode)) throw new Error("mode must be 'auto' or 'manager'")
        config.mode = patch.mode
      }
      if ('stallSeconds' in patch) {
        const n = Number(patch.stallSeconds)
        if (!Number.isFinite(n) || n < 10 || n > 3600) throw new Error('stallSeconds must be 10-3600')
        config.stallSeconds = n
      }
      if ('agentSettings' in patch) {
        config.agentSettings ||= {}
        config.agentSettings.global = validateSettingsPatch(config, patch.agentSettings)
      }
      writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
      json(res, 200, { ok: true, config })
    } catch (err) {
      json(res, 400, { ok: false, error: err.message })
    }
    for (const p of new Set([...clients].map((c) => c.project))) broadcastBoard(p)
    return
  }

  // Manual only — no auto-recovery timer trips this back on.
  if (req.method === 'POST' && url.pathname === '/api/breaker-reset') {
    resetBreaker()
    announcedBreakers.clear()
    json(res, 200, { ok: true, config: { maxConcurrentAgents: config.maxConcurrentAgents } })
    for (const p of config.projects) activity(p, '-', 'breaker-reset', 'circuit breaker reset')
    for (const p of new Set([...clients].map((c) => c.project))) broadcastBoard(p)
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/priority') {
    let body = ''
    for await (const chunk of req) body += chunk
    const { project: p = config.projects[0], id, priority } = JSON.parse(body || '{}')
    try {
      json(res, 200, { ok: true, card: setPriority(tasksDirOf(p), id, priority) })
    } catch (err) {
      json(res, 400, { ok: false, error: err.message })
    }
    broadcastBoard(p)
    return
  }

  // Open the card in the editor. `code` is a .cmd shim on Windows, so it needs a
  // shell; detached so closing the board never takes the editor with it.
  if (req.method === 'POST' && url.pathname === '/api/open') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const { project: p = config.projects[0], id, reportId } = JSON.parse(body || '{}')
      if (!config.projects.includes(p)) throw new Error('Unknown project')
      if (!reportId && !isCardId(id)) throw new Error('Invalid card identity')
      const path = reportId ? resolveAuditReport(config, p, reportId) : findCard(tasksDirOf(p), id).path
      // The configured editor is trusted; the browser supplies only an identity.
      // Validate shell characters before quoting the resolved server-owned path.
      const child = spawn(config.editor ?? 'code', editorArguments(path), {
        shell: true, detached: true, stdio: 'ignore', windowsHide: true,
      })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      child.unref()
      return json(res, 200, { ok: true, path })
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message })
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auto-review') {
    let body = ''
    for await (const chunk of req) body += chunk
    const { project: p = config.projects[0], id, on } = JSON.parse(body || '{}')
    try {
      const card = setAutoReview(tasksDirOf(p), id, !!on)
      json(res, 200, { ok: true, card })
    } catch (err) {
      json(res, 400, { ok: false, error: err.message })
    }
    broadcastBoard(p)
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/review-plan') {
    const p = url.searchParams.get('project') || config.projects[0]
    try {
      const plan = computeReviewPlan({ tasksDir: tasksDirOf(p) })
      json(res, 200, { ok: true, ...plan })
    } catch (err) {
      json(res, 400, { ok: false, error: err.message })
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/review-groups') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const { project: p, groups } = JSON.parse(body)
      if (!config.projects.includes(p)) throw new Error('Unknown project')
      json(res, 200, { ok: true, groups: saveReviewGroups(tasksDirOf(p), groups) })
    } catch (err) { json(res, 400, { ok: false, error: err.message }) }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/card-settings') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const { project: p = config.projects[0], id, stage, settings } = JSON.parse(body || '{}')
      if (!config.projects.includes(p) || !STAGES.includes(stage) || !settings || typeof settings !== 'object') throw new Error('Known project, card stage and settings object required')
      const card = findCard(tasksDirOf(p), id)
      const next = setCardOverride(tasksDirOf(p), card.id, stage, settings, config)
      json(res, 200, { ok: true, card: next })
      broadcastBoard(p)
    } catch (err) { json(res, 400, { ok: false, error: err.message }) }
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/review') {
    let body = ''
    for await (const chunk of req) body += chunk
    const { project: p = config.projects[0], cardIds } = JSON.parse(body || '{}')
    try {
      if (breakerState(p).breakerTripped) throw new Error('circuit breaker tripped — auto-spawn halted, reset from Settings')
      const result = await spawnReviewer({
        inventory: reviewInventory, reviewRoot: REVIEW_ROOT,
        project: p,
        projectPath: integrationPathOf(p),
        tasksDir: tasksDirOf(p),
        boardRoot: HERE,
        model: config.models.review,
        engine: engineFor('review'),
        assignmentForCard: (card, stage) => assignmentForCard(p, card, stage),
        cardIds,
      })
      recordSpawn({ project: p, cap: config.maxConcurrentAgents })
      tripBreakerIfNeeded(p)
      herdrLog(`review started for ${result.cards.length} card(s): ${result.cards.join(', ')}`)
      for (const id of result.cards) activity(p, id, 'reviewer-start', 'Reviewer started')
      json(res, 200, { ok: true, reviewer: result })
    } catch (err) {
      // 409: the tick or another click is already spawning one; not a failure. An empty
      // Issues lane is not one either: the 15-minute sweep task logged it on every project.
      if (!err.busy && !/nothing in Issues/.test(err.message)) activity(p, '-', 'failure', err.message, 'error')
      json(res, err.busy ? 409 : 400, { ok: false, error: err.message })
    }
    broadcastBoard(p)
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/sweep-issues') {
    let body = ''
    for await (const chunk of req) body += chunk
    const { project: p = config.projects[0] } = JSON.parse(body || '{}')
    try {
      if (breakerState(p).breakerTripped) throw new Error('circuit breaker tripped — auto-spawn halted, reset from Settings')
      const result = await spawnIssuesSweeper({
        project: p,
        projectPath: integrationPathOf(p),
        tasksDir: tasksDirOf(p),
        boardRoot: HERE,
        model: config.models.planning ?? config.models.issues,
        engine: engineFor('planning'),
        assignmentForCard: (card, stage) => assignmentForCard(p, card, stage),
        mission: p === config.mission?.project ? config.mission : null,
      })
      recordSpawn({ project: p, cap: config.maxConcurrentAgents })
      tripBreakerIfNeeded(p)
      herdrLog(`Lead Planner started for ${result.cards.length} card(s)`)
      for (const id of result.cards) activity(p, id, 'planner-start', 'Lead Planner started')
      json(res, 200, { ok: true, planner: result })
    } catch (err) {
      // 409: the tick or another click is already spawning one; not a failure.
      if (!err.busy) activity(p, '-', 'failure', err.message, 'error')
      json(res, err.busy ? 409 : 400, { ok: false, error: err.message })
    }
    broadcastBoard(p)
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/pane') {
    const binding = readBindings(tasksDirOf(project))[String(url.searchParams.get('id')).toUpperCase()]
    if (!binding) return json(res, 404, { ok: false, error: 'not bound' })
    try {
      return json(res, 200, { ok: true, output: await paneRead(binding.pane_id, sessionOf(project)) })
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message })
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    let body = ''
    for await (const chunk of req) body += chunk
    const { project: p = config.projects[0], id } = JSON.parse(body || '{}')
    const tasksDir = tasksDirOf(p)
    try {
      const binding = readBindings(tasksDir)[String(id).toUpperCase()]
      await stopCard({ tasksDir, paneId: binding?.pane_id, cardId: id, project: p })
      json(res, 200, { ok: true })
    } catch (err) {
      json(res, 400, { ok: false, error: err.message })
    }
    broadcastBoard(p)
    return
  }

  if (req.method === 'GET') return serveStatic(url.pathname, res)
  notFound(res)
}

// --- start -----------------------------------------------------------------

let port = config.port
let pollersStarted = false
const holdsReady = new Set() // projects whose file-lock holds this process has computed
// One bad request must never take the board down: an async handler that throws is an
// unhandled rejection, which kills node (a project folder that no longer exists did this).
const serve = (req, res) => handleRequest(req, res).catch((err) => {
  console.error(`${req.method} ${req.url}: ${err.stack || err.message}`)
  if (res.headersSent) res.end()
  else json(res, 500, { ok: false, error: err.message })
})
const server = createServer(serve)

async function startPollers() {
  if (pollersStarted) return
  pollersStarted = true
  console.log(`kanban: http://127.0.0.1:${port}`)
  console.log(`herdr: ${(await isRunning()) ? 'up' : 'down'}`)
  cleanClosedReviewSnapshots(REVIEW_ROOT) // background; failures go to the activity log

  // Spawner must run whether or not a browser tab is open — a headless restart
  // still has to pick up queued cards.
  for (const project of config.projects) {
    setInterval(() => pollProject(project), config.agentPollMs)
  }
  setInterval(() => {
    const pids = stopRunawayTsservers(config.projectsRoot)
    if (pids.length) herdrLog(`stopped runaway tsserver(s) ${pids.join(', ')} under ${config.projectsRoot}`, 'warn')
  }, 10 * 60000)
}

function startLan() {
  if (!lanHost) return
  const lanServer = createServer(serve)
  lanServer.on('error', (err) => console.error(`kanban lan ${lanHost}:${port}: ${err.message}`))
  lanServer.listen(port, lanHost, () => console.log(`kanban lan: http://${lanHost}:${port}`))
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port < config.port + 5) server.listen(++port, '127.0.0.1')
  else { console.error(err.message); process.exit(1) }
})
server.listen(port, '127.0.0.1', () => {
  startLan()
  startPollers()
})
