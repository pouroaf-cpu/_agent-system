import { readCardPlanners } from './card-planner.mjs'
// The spawner. Watches one column — Queue — and nothing else.
//
// You put a card in Queue; that is the consent. Everything here is about not
// doing anything you did not ask for: it never pulls from another column, never
// exceeds the concurrency cap, and never retries a card that failed to start.

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readBoard, moveCard, isParked, appendBuildAttempt, currentReviewDecision, currentDirtyMatchesSnapshot } from './cards.mjs'
import { bind, unbind, liveBindings, readBindings } from './bindings.mjs'
import { spawnForCard, deliver, START_TIMEOUT_MS } from './spawn.mjs'
import { reviewerPrompt, issuesSweeperPrompt, agentName, isBoardAgent, reviewLabel, sweepLabel } from './prompt.mjs'
import { tabCreate, agentStart, agentList, agentsForProject, paneClose, agentWorkspaceOr, waitForPrompt, isSpawning, beginSpawn, endSpawn, herdrLog, sessionOf } from './herdr.mjs'
import { coolingDown, recordFailure, clearRetries } from './retries.mjs'
import { computeReviewPlan } from './review-plan.mjs'
import { readUsage, recordUsageFinish, recordUsageStart } from './request-usage.mjs'

// A spawn blocks for ~55s. Without this, every 2s agent poll would start another.
const busy = new Set()

// Three goes at starting, then it is a real problem and belongs on the board.
const MAX_ATTEMPTS = 3

export function slotsFree({ tasksDir, agents, max, now = Date.now() }) {
  return max - Object.keys(liveBindings(tasksDir, agents, now)).length
}

// Hard gate: a card naming prerequisites (**Blocked by:** T-08, T-09) is not
// spawned until every one of them has landed — reached Completed (a builder
// finished it) or Archive (a superset: everything archived passed through
// Completed first). Exported standalone so it can be tested without going
// anywhere near a real spawn. Replaces the old behaviour of spawning the card
// anyway and paying for a builder to boot, read the card, and immediately
// kick itself back — cards stalled on the same unmet dependency, repeatedly,
// before this gate existed.
export function unmetBlockers(card, board) {
  return (card.blockedBy || []).filter((id) => {
    const live = liveCards(board).filter((c) => c.id === id)
    const archived = board.archive.filter((c) => c.id === id)
    return live.length || archived.length !== 1
  })
}

const liveCards = (board) => Object.entries(board).filter(([key]) => key !== 'archive').flatMap(([, cards]) => cards)

function duplicateLiveId(card, board) {
  const hits = liveCards(board).filter((c) => c.id === card.id)
  return hits.length > 1 ? hits.map((c) => `${c.column}/${c.file}`).join(', ') : null
}

function duplicateIssueKey(card, board) {
  if (!card.issueKey) return null
  const hits = liveCards(board).filter((c) => c.issueKey && c.issueKey === card.issueKey)
  return hits.length > 1 ? hits.map((c) => `${c.id} in ${c.column}`).join(', ') : null
}

function cycleFor(card, board) {
  const byId = new Map()
  for (const c of liveCards(board)) {
    if (!byId.has(c.id)) byId.set(c.id, c)
    else byId.set(c.id, null)
  }
  const seen = new Set()
  const visit = (id) => {
    if (id === card.id) return true
    if (seen.has(id)) return false
    seen.add(id)
    const next = byId.get(id)
    return !!next && (next.blockedBy || []).some(visit)
  }
  return (card.blockedBy || []).some(visit)
}

function missionBuilds(board, mission) {
  if (!mission?.id) return 0
  return Object.values(board).flat()
    .filter((c) => c.mission === mission.id)
    .reduce((n, c) => n + (c.buildAttempts || 0), 0)
}

export function startHoldReason({ card, board, projectPath, tasksDir, mission, log, now = Date.now() }) {
  if (card.column !== 'queue') return 'only Queue cards can start'
  const dupId = duplicateLiveId(card, board)
  if (dupId) return `duplicate live card id ${card.id}: ${dupId}`
  const dupKey = duplicateIssueKey(card, board)
  if (dupKey) return `duplicate issue key ${card.issueKey}: ${dupKey}`
  if (mission?.id) {
    const project = projectPath.split(/[\\/]/).pop()
    if (mission.project && project !== mission.project) return `mission ${mission.id} is active for ${mission.project}`
    if (card.mission !== mission.id) return `mission ${mission.id} only starts cards marked **Mission:** ${mission.id}`
    if ((card.buildAttempts || 0) >= (mission.maxBuildsPerCard ?? 3)) return `mission build budget exhausted for ${card.id}`
    if (missionBuilds(board, mission) >= (mission.maxBuilds ?? 9)) return `mission build budget exhausted (${mission.maxBuilds ?? 9} total)`
  }
  if (cycleFor(card, board)) return 'dependency cycle detected'
  if (coolingDown(tasksDir, card.id, now)) return 'cooling down after failed spawn'
  const unmet = unmetBlockers(card, board)
  if (unmet.length) return `waiting for unique archived prerequisite ${unmet.join(', ')}`
  const dirty = preflightBlocks({ projectPath, card, log })
  if (dirty) {
    const running = holderOf(board)
    const who = dirty.kind === 'files busy' && running.length ? `, likely held by ${running.join(', ')}` : ''
    return `${dirty.kind}${who} — ${dirty.detail}`
  }
  return null
}

// Optional per-repo check: <project>/scripts/preflight.mjs <path-to-card.md>,
// run from the project root before a card leaves Queue — the contract (path,
// not id) is preflight.mjs's own, documented at its top; do not change it here
// without changing it there too. Most repos will not have this script — no
// script means no check, not a block.
//
// exit 0  clean, spawn it. exit 1  the card's own ## Files are dirty right
// now (another agent mid-edit); hold it in Queue, same as an unmet
// Blocked-by — costs nothing, versus a builder discovering the same thing
// itself ~30 minutes in. exit 2  the card itself could not be read or is
// malformed — preflight.mjs's own contract warns that conflating this with
// "dirty" silently skips a broken card forever, so this also holds the card
// but logs distinctly, so a human notices instead of it just never spawning.
export function preflightBlocks({ projectPath, card, log }) {
  const script = join(projectPath, 'scripts', 'preflight.mjs')
  if (!existsSync(script)) return false
  const result = spawnSync('node', [script, card.path], { cwd: projectPath, timeout: 10000, encoding: 'utf8' })
  if (result.status === 2) log?.(`${card.id}: preflight could not read the card — ${(result.stderr || '').trim()}`)
  if (result.status === 0) return false
  if (result.status === 1 && card.cardOwned && currentDirtyMatchesSnapshot(card, projectPath)) return false
  // exit 2 is the card's own fault, not a busy tree — saying "files busy" about a
  // card with no ## Files section sends whoever reads it hunting for an agent
  // that does not exist.
  const kind = result.status === 2 ? 'card not ready' : 'files busy'
  return { kind, detail: `${(result.stdout || result.stderr || 'preflight failed').trim()}` }
}

// Why each queued card did not start this tick, so a card sitting still says so
// on the board instead of looking identical to one nobody has got to yet. Kept in
// memory rather than on disk: it is recomputed every tick and is worthless stale.
const holds = new Map() // project -> { cardId: reason }

export const holdsFor = (project) => holds.get(project) ?? {}

// Which running card most likely owns the dirty files — with one card at a time
// there is usually exactly one, and naming it is the difference between "held"
// and "held by T-29".
const holderOf = (board) => [...board.working, ...board.review].map((c) => c.id)

// Returns the ids it started. Safe to call on every board change and agent poll.
export async function autoSpawn({ project, projectPath, tasksDir, boardRoot, model, engine, trivialModel = model, trivialEngine = engine, max, agents, onChange, log, mission, onlyIds, spawn = spawnForCard }) {
  if (max <= 0 || busy.has(project)) return []

  let slots = slotsFree({ tasksDir, agents, max })
  if (slots <= 0) return []

  const board = readBoard(tasksDir)
  const only = onlyIds?.length ? new Set(onlyIds.map((id) => id.toUpperCase())) : null
  const queued = only ? board.queue.filter((c) => only.has(c.id)) : board.queue
  if (!queued.length) return []

  busy.add(project)
  const started = []
  const held = {}
  try {
    for (const card of queued) {
      if (slots <= 0) break
      const fresh = mission?.id ? readBoard(tasksDir) : board
      const freshCard = mission?.id
        ? fresh.queue.find((c) => c.id === card.id && c.file === card.file) || card
        : card
      const selectedModel = freshCard.trivial ? trivialModel : model
      const selectedEngine = freshCard.trivial ? trivialEngine : engine
      const hold = startHoldReason({ card: freshCard, board: fresh, projectPath, tasksDir, mission, log })
      if (hold) {
        held[freshCard.id] = hold
        if (/mission build budget exhausted/.test(hold)) {
          const parked = moveCard(tasksDir, freshCard.id, 'owner')
          appendFileSync(parked.path, `\n\n---\n\n**Needs you** ${new Date().toISOString()}\n\n${hold}. Mission budget does not auto-reset.\n`)
          onChange?.()
        }
        continue
      }

      // Move first so the card is visibly in Working for the ~55s the spawn takes.
      appendBuildAttempt(freshCard)
      const moved = moveCard(tasksDir, freshCard.id, 'working')
      try {
        const result = await spawn({
          project, projectPath, tasksDir, boardRoot, card: moved, model: selectedModel, engine: selectedEngine,
          onPane: (provisional) => {
            bind(tasksDir, moved.id, provisional)
            try {
              recordUsageStart({
                tasksDir, project, requestId: moved.id, cardIds: [moved.id], role: 'builder',
                paneId: provisional.pane_id, tabId: provisional.tab_id, model: selectedModel, name: provisional.name,
                agentSession: provisional.agent_session,
              })
            } catch {}
            onChange?.()
          },
        })
        bind(tasksDir, moved.id, result)
        clearRetries(tasksDir, moved.id)
        herdrLog(`${moved.id} → working (auto-spawn)`)
        started.push(moved.id)
        slots--
      } catch (err) {
        if (err.preservePane) {
          log?.(`${moved.id}: ${err.message}`)
          held[moved.id] = err.message
          slots--
          continue
        }
        unbind(tasksDir, moved.id)   // the provisional claim dies with the pane
        const { attempts } = recordFailure(tasksDir, moved.id)
        if (attempts < MAX_ATTEMPTS) {
          // Starting is flaky in a way the work itself is not — a slow shell, a
          // busy machine. Put it back and try again, but bounded.
          moveCard(tasksDir, moved.id, 'queue')
          log?.(`${moved.id}: spawn failed (attempt ${attempts}/${MAX_ATTEMPTS}), retrying — ${err.message}`)
        } else {
          const parked = moveCard(tasksDir, moved.id, 'issues')
          herdrLog(`${parked.id} → issues after ${attempts} failed spawns`, 'error')
          appendFileSync(parked.path,
            `\n\n---\n\n**Spawn failed** ${new Date().toISOString()}\n\n` +
            `Failed to start ${attempts} times, last error: ${err.message}\n`)
          clearRetries(tasksDir, moved.id)
        }
      }
      onChange?.()
    }
  } finally {
    busy.delete(project)
    holds.set(project, held)
  }
  return started
}

// Close panes the board spawned that have finished and reported back.
//
// Two conditions, both required. `kb-` means we spawned it, so a window you
// opened by hand is never touched. Unbound means hkb already ran — an agent that
// exited WITHOUT reporting keeps its pane open, because that is exactly the case
// you need to look at.
//
// idle-counts-as-finished is right for a BUILDER: unbound only ever happens after
// hkb ran, so idle really does mean done. It is WRONG for the reviewer/sweeper —
// they are unbound for their entire multi-card run by design (owning the whole
// column, not one card's slot), so an ordinary idle blip between tool calls reads
// identically to "finished" and got reaped mid-review — a real incident, not a
// hypothetical: a reviewer vanished twice, review count unchanged, before this
// fix. For kb-review-*/kb-sweep-* specifically, only a genuine `done` status
// counts as finished; idle does not.
// ...and `done` alone is still not enough for them either. `done` is what herdr
// reports for ANY pause: before the agent's first thought, and again every time it
// finishes a turn and waits. A multi-card reviewer pauses between cards by nature,
// so an instant reap on `done` kills it at the first gap — which is exactly what
// happened twice on 2026-08-17: a 7-card reviewer died having archived nothing,
// silently, because the pane it would have explained itself in was closed.
//
// So `done` has to be SUSTAINED to count. A pause between cards lasts seconds; a
// genuinely finished agent stays done forever. Two minutes tells them apart, and
// costs only a slightly later pane close in the ordinary case.
const REVIEW_OR_SWEEP = /^kb-(review|plan)-/
const DONE_GRACE_MS = 2 * 60 * 1000
const doneSince = new Map() // pane_id -> timestamp it most recently went done
const inactiveSince = new Map() // pane_id -> timestamp a builder first looked finished

function doneLongEnough(agent, now) {
  if (agent.agent_status !== 'done') {
    doneSince.delete(agent.pane_id)
    return false
  }
  const since = doneSince.get(agent.pane_id) ?? now
  doneSince.set(agent.pane_id, since)
  return now - since >= DONE_GRACE_MS
}

function inactiveLongEnough(agent, now) {
  if (agent.agent_status !== 'done' && agent.agent_status !== 'idle') {
    inactiveSince.delete(agent.pane_id)
    return false
  }
  const since = inactiveSince.get(agent.pane_id) ?? now
  inactiveSince.set(agent.pane_id, since)
  return now - since >= DONE_GRACE_MS
}

export async function closeFinished({ tasksDir, agents, project, now = Date.now(), retire = true }) {
  const bound = new Set([...Object.values(readBindings(tasksDir)).map((b) => b.pane_id), ...Object.values(readCardPlanners(tasksDir)).filter(p => !p.closedAt).map(p => p.paneId)])
  for (const a of agents) {
    if (isBoardAgent(a) && !bound.has(a.pane_id) && !isSpawning(a.pane_id)) continue
    doneSince.delete(a.pane_id)
    inactiveSince.delete(a.pane_id)
  }
  let spent = agents.filter((a) => {
    if (!isBoardAgent(a) || bound.has(a.pane_id) || isSpawning(a.pane_id)) return false
    // Must run on EVERY poll, not only the done ones — a non-done poll is what
    // clears the timer, and && would short-circuit past it.
    if (REVIEW_OR_SWEEP.test(a.name || '')) return doneLongEnough(a, now)
    return inactiveLongEnough(a, now)
  })
  if (!retire) {
    const owned = new Set(Object.values(readBoard(tasksDir)).flat().filter(c => c.cardOwned).map(c => c.id))
    const panes = new Set(Object.values(readUsage(tasksDir).runs).filter(r => r.cardIds?.length && r.cardIds.every(id => owned.has(id))).map(r => r.paneId))
    spent = spent.filter(a => panes.has(a.pane_id))
  }
  for (const a of spent) doneSince.delete(a.pane_id)
  for (const a of spent) inactiveSince.delete(a.pane_id)
  for (const a of spent) {
    try { await recordUsageFinish({ tasksDir, paneId: a.pane_id, agent: a, status: 'complete', now: new Date(now) }) } catch {}
    await paneClose(a.pane_id, sessionOf(project)).catch(() => {})
    herdrLog(`${a.name || a.pane_id} finished, pane closed`)
  }
  return spent.map((a) => a.pane_id)
}

// A completed card marked auto-review skips the manual gate. Everything else
// waits for you.
export function promoteAutoReview(tasksDir, { all = false } = {}) {
  const promoted = []
  for (const card of readBoard(tasksDir).completed) {
    if (!all && !card.autoReview) continue
    const target = card.trivial ? 'archive' : 'review'
    moveCard(tasksDir, card.id, target)
    herdrLog(`${card.id} → ${target} (${card.trivial ? 'trivial deterministic check' : 'auto-review'})`)
    promoted.push(card.id)
  }
  return promoted
}

const explicitOwnerReason = (text) => {
  const hasOnlyUser = /\b(?:only (?:the )?(?:operator|owner|user|human))\b/i.test(text)
  const hasDecisionNeed = /\b(?:decision|approval|credential|secret|key|token|account|login|access|permission|2fa|mfa|purchase|judg(?:e)?ment|taste|confirm|choose|grant)\b/i.test(text)
  const hasNegatedOwnerOnly = /\bnot true that[^.\n]{0,80}\s+only (?:the )?(?:operator|owner|user|human)|not only (?:the )?(?:operator|owner|user|human)/i.test(text)
  return hasOnlyUser && hasDecisionNeed && !hasNegatedOwnerOnly
}

export function routeReviewVerdicts(tasksDir, { log, reviewBusy = false, includeCompleted = false } = {}) {
  if (reviewBusy) return []
  const routed = []
  const board = readBoard(tasksDir)
  const columns = includeCompleted ? ['review', 'completed'] : ['review']
  for (const card of columns.flatMap((column) => board[column])) {
    const decision = currentReviewDecision(readFileSync(card.path, 'utf8'))
    if (!decision) continue
    if (card.column === 'completed' && decision.verdict !== 'UNKNOWN') continue
    try {
      if (decision.verdict === 'PASS') {
        moveCard(tasksDir, card.id, 'archive')
        herdrLog(`${card.id} → archive (review verdict PASS)`)
        routed.push({ id: card.id, to: 'archive', verdict: 'PASS' })
      } else if (decision.verdict === 'FAIL') {
        const moved = moveCard(tasksDir, card.id, 'issues')
        appendFileSync(moved.path,
          `\n\n---\n\n**Review feedback** ${new Date().toISOString()}\n\n` +
          `Automatic review routing saw **Review verdict:** FAIL. Use the Reviewer evidence above as the correction brief.\n`)
        herdrLog(`${card.id} → issues (review verdict FAIL)`)
        routed.push({ id: card.id, to: 'issues', verdict: 'FAIL' })
      } else if (decision.verdict === 'UNKNOWN') {
        const to = explicitOwnerReason(decision.evidence) ? 'owner' : 'issues'
        const moved = moveCard(tasksDir, card.id, to)
        const heading = to === 'owner' ? 'Needs you' : 'Review feedback'
        const brief = to === 'owner'
          ? `Automatic review routing saw **Review verdict:** UNKNOWN. ${decision.evidence}\n`
          : `Automatic review routing saw **Review verdict:** UNKNOWN. Use the Reviewer evidence above as the technical triage brief; retain UNKNOWN until a reviewer records PASS or FAIL.\n`
        appendFileSync(moved.path, `\n\n---\n\n**${heading}** ${new Date().toISOString()}\n\n${brief}`)
        herdrLog(`${card.id} → ${to} (review verdict UNKNOWN)`)
        routed.push({ id: card.id, to, verdict: 'UNKNOWN' })
      }
    } catch (err) {
      log?.(`${card.id}: review verdict routing skipped — ${err.message}`)
    }
  }
  return routed
}

export function promotePlanned(tasksDir, { mission, project } = {}) {
  const promoted = []
  for (const card of readBoard(tasksDir).planned) {
    if (mission?.id && (mission.project && project !== mission.project || card.mission !== mission.id)) continue
    moveCard(tasksDir, card.id, 'queue')
    promoted.push(card.id)
  }
  return promoted
}

const REVIEWER_PREFIX = 'kb-review-'
export const reviewerRunning = (agents, now = Date.now()) =>
  agents.some((a) => (a.name || '').startsWith(REVIEWER_PREFIX) && !doneLongEnough(a, now))

// herdr does not register an agent until it has booted, so reviewerRunning() is
// false for the whole ~55s spawn. Held here so two explicit Review requests
// cannot start concurrently and archive or rework the same card.
const reviewing = new Set()
export const reviewerBusy = (project, agents) =>
  reviewing.has(project) || agents.some((a) => (a.name || '').startsWith(REVIEWER_PREFIX) && a.agent_status !== 'done')
const busyError = () => Object.assign(new Error('a reviewer is already running'), { busy: true })

export async function autoReview({ project, projectPath, tasksDir, boardRoot, model, engine, agents, log, plan = computeReviewPlan, spawn = spawnReviewer }) {
  if (reviewerBusy(project, agents)) return null
  const batch = plan({ tasksDir }).batches[0]
  if (!batch) return null
  try {
    const owned = readBoard(tasksDir).review.filter(c => c.cardOwned).map(c => c.id)
    const cardIds = batch.cards.some(id => owned.includes(id)) ? [batch.cards[0]] : batch.cards
    return await spawn({ project, projectPath, tasksDir, boardRoot, model, engine, cardIds })
  } catch (err) {
    if (!err.busy) log?.(`auto-review skipped — ${err.message}`)
    return null
  }
}

// One reviewer for every card sitting in Review, or — when `cardIds` is given —
// just that subset (the review-plan batching). Batching is the point: a single
// context reading several related cards costs far less than several contexts.
export async function spawnReviewer({ project, projectPath, tasksDir, boardRoot, model, engine, cardIds }) {
  // Claimed before the first await, so two callers in the same tick cannot both
  // pass the check.
  if (reviewing.has(project)) throw busyError()
  reviewing.add(project)
  try {
    const session = sessionOf(project)
    if (reviewerRunning(await agentsForProject(projectPath, session))) throw busyError()

    let cards = readBoard(tasksDir).review
    if (cardIds?.length) {
      const wanted = new Set(cardIds.map((id) => id.toUpperCase()))
      cards = cards.filter((c) => wanted.has(c.id))
    }
    if (cards.some((c) => c.audit)) cards = [cards.find((c) => c.audit)]
    if (!cards.length) throw new Error('nothing in Review')

    const workspace = await agentWorkspaceOr(projectPath, session)
    const created = await tabCreate({
      cwd: projectPath, label: reviewLabel(cards.length), focus: false, workspace, session,
    })
    const paneId = created?.root_pane?.pane_id
    if (!paneId) throw new Error(`tab create returned no pane id: ${JSON.stringify(created)}`)

    // Named so closeFinished and reviewerRunning can both recognise it, and so it
    // is never mistaken for a card's builder. Pane id included so a retry after a
    // failed start does not collide with the previous attempt's registration.
    await waitForPrompt(paneId, { session })
    const name = agentName({ id: 'review' }, project, paneId)
    // Held across agentStart AND deliver: the reviewer is never bound to a card
    // (see below), so isSpawning() is its ONLY protection from the board's
    // reaper closing an idle-but-not-yet-prompted pane. agentStart alone isn't
    // enough — see the comment on beginSpawn/endSpawn in herdr.mjs.
    beginSpawn(paneId)
    try {
      // Same generous startup budget as a builder — Opus is no faster to boot.
      await agentStart({ name, paneId, model, engine, timeoutMs: START_TIMEOUT_MS, session })
      const agent = (await agentList(session).catch(() => [])).find((a) => a.pane_id === paneId)
      try {
        recordUsageStart({
          tasksDir, project, requestId: `review:${cards.map((c) => c.id).join(',')}`, cardIds: cards.map((c) => c.id),
          role: 'reviewer', paneId, tabId: created?.tab?.tab_id, model, name, agentSession: agent?.agent_session,
        })
      } catch {}
      await deliver(paneId, reviewerPrompt({ cards, projectPath, boardRoot }), session)
    } catch (err) {
      if (!err.preservePane) await paneClose(paneId, session).catch(() => {})
      throw new Error(`reviewer spawn failed: ${err.message}`)
    } finally {
      endSpawn(paneId)
    }

    // Deliberately not bound to a card: the reviewer owns the whole Review column,
    // and binding it to one card would let it hold that card's slot forever.
    return { pane_id: paneId, tab_id: created?.tab?.tab_id, model, name, cards: cards.map((c) => c.id) }
  } finally {
    reviewing.delete(project)
  }
}

const SWEEPER_PREFIX = 'kb-plan-'
export const sweeperRunning = (agents) => agents.some((a) => (a.name || '').startsWith(SWEEPER_PREFIX))

// Same one-in-flight guard as spawnReviewer, held here for the same reason:
// herdr does not register an agent until it has booted.
const sweeping = new Set()

// Move mission-matching Issues into Planning before a Lead Planner starts, so
// ownership is explicit and a restart cannot spawn a duplicate planner for the
// same cards.
export function missionIssueHandoff(tasksDir, mission, { all = false } = {}) {
  const moved = []
  if (!all && !mission?.id) return moved
  const issues = readBoard(tasksDir).issues.filter((c) => !c.cardOwned && (all || c.mission === mission.id))
  for (const card of issues) {
    const next = moveCard(tasksDir, card.id, 'planning')
    appendFileSync(next.path,
      `\n\n---\n\n**Planner handoff** ${new Date().toISOString()}\n\n` +
      `Lead Planner accepted ownership of this Issue. Await a builder-ready plan in Planned; do not rewrite or requeue directly.\n`)
    moved.push(next.id)
  }
  return moved
}

export async function spawnIssuesSweeper({ project, projectPath, tasksDir, boardRoot, model, engine, manager = false, mission }) {
  if (sweeping.has(project)) throw busyError()
  sweeping.add(project)
  try {
    const session = sessionOf(project)
    if (sweeperRunning(await agentsForProject(projectPath, session))) throw busyError()

    const accepted = missionIssueHandoff(tasksDir, mission, { all: !mission?.id })
    const wanted = new Set(accepted)
    const cards = readBoard(tasksDir).planning.filter((c) => wanted.has(c.id))

    if (!cards.length) throw new Error('nothing in Issues')

    const workspace = await agentWorkspaceOr(projectPath, session)
    const created = await tabCreate({
      cwd: projectPath, label: sweepLabel(cards.length), focus: false, workspace, session,
    })
    const paneId = created?.root_pane?.pane_id
    if (!paneId) throw new Error(`tab create returned no pane id: ${JSON.stringify(created)}`)

    await waitForPrompt(paneId, { session })
    const name = agentName({ id: 'plan' }, project, paneId)
    // Same reasoning as spawnReviewer: unbound, so isSpawning() must stay true
    // through deliver(), not just agentStart().
    beginSpawn(paneId)
    try {
      await agentStart({ name, paneId, model, engine, timeoutMs: START_TIMEOUT_MS, session })
      const agent = (await agentList(session).catch(() => [])).find((a) => a.pane_id === paneId)
      try {
        recordUsageStart({
          tasksDir, project, requestId: `plan:${cards.map((c) => c.id).join(',')}`, cardIds: cards.map((c) => c.id),
          role: 'planner', paneId, tabId: created?.tab?.tab_id, model, name, agentSession: agent?.agent_session,
        })
      } catch {}
      await deliver(paneId, issuesSweeperPrompt({ cards, projectPath, boardRoot, manager }), session)
    } catch (err) {
      if (!err.preservePane) await paneClose(paneId, session).catch(() => {})
      throw new Error(`issues sweeper spawn failed: ${err.message}`)
    } finally {
      endSpawn(paneId)
    }

    // Deliberately not bound to a card, same reasoning as the reviewer.
    return { pane_id: paneId, tab_id: created?.tab?.tab_id, model, name, cards: cards.map((c) => c.id) }
  } finally {
    sweeping.delete(project)
  }
}
