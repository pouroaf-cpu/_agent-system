import { existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, mkdirSync, statSync, appendFileSync } from 'node:fs'
import { renameSync } from './fs-retry.mjs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { prepareWorktreeEnvironment } from './worktrees.mjs'
import { readBoard, moveCard, currentReviewDecision, setAutoReview, findCard } from './cards.mjs'
import { requestPlannerCorrection } from './card-planner.mjs'
import { recordOperationalFailure, evidenceFingerprint } from './workflow-state.mjs'
import { projectEnvironment } from './project-control.mjs'
import { isCardId, isReviewerAgent } from './ids.mjs'
import { cleanClosedReviewSnapshots } from './review-snapshots.mjs'

export const MAX_REVIEWERS = 4
const file = root => join(root, '.review-claims.json')
export function readReviewClaims(root) {
  if (!existsSync(file(root))) return []
  const data = JSON.parse(readFileSync(file(root), 'utf8'))
  if (data.version !== 1 || !Array.isArray(data.claims)) throw new Error('Invalid reviewer claims; refusing dispatch')
  for (const c of data.claims) if (typeof c.id !== 'string' || !c.id || typeof c.project !== 'string' || typeof c.tasksDir !== 'string' || !c.tasksDir || !Array.isArray(c.cards) || c.cards.some(id => !isCardId(id)) || new Set(c.cards).size !== c.cards.length || !Number.isFinite(c.createdAt) || (c.paneId != null && typeof c.paneId !== 'string') || (c.phase && !['starting', 'running', 'uncertain'].includes(c.phase)) || ['closedAt', 'doneSince', 'lastSeen'].some(k => c[k] != null && !Number.isFinite(c[k]))) throw new Error('Invalid reviewer claim shape; refusing dispatch')
  if (new Set(data.claims.map(c => c.id)).size !== data.claims.length) throw new Error('Duplicate reviewer claim ids')
  return data.claims
}
const active = claim => !claim.closedAt
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' } }
// Claims only close inside a transaction; closed snapshots are then cleaned in the background.
function transaction(root, update) {
  try { return ledger(root, update) } finally { cleanClosedReviewSnapshots(root) }
}
function ledger(root, update) {
  const lock = `${file(root)}.lock`
  let fd
  if (existsSync(lock)) {
    const bytes = readFileSync(lock, 'utf8')
    let owner; try { owner = JSON.parse(bytes) } catch {}
    if (Date.now() - statSync(lock).mtimeMs > 60000 && (!owner?.pid || !alive(owner.pid)) && readFileSync(lock, 'utf8') === bytes) unlinkSync(lock)
  }
  try { fd = openSync(lock, 'wx') } catch { throw Object.assign(new Error('reviewer ledger locked; retry after current transaction'), { busy: true }) }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
  try {
    const claims = readReviewClaims(root)
    const result = update(claims)
    const temp = `${file(root)}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, claims }, null, 2))
    renameSync(temp, file(root))
    return result
  } finally { closeSync(fd); unlinkSync(lock) }
}
function retire(claim, now, reason) {
  for (const card of readBoard(claim.tasksDir).review.filter(c => claim.cards.includes(c.id))) {
    if (currentReviewDecision(readFileSync(card.path, 'utf8'))) continue
    recordOperationalFailure(claim.tasksDir, card, `Reviewer ${claim.paneId || claim.id} ended without a per-card verdict: ${reason}`, claim.integrationPath || resolve(claim.tasksDir, '..'))
  }
  claim.closedAt = now
  claim.closeReason = reason
}
function reconcile(claims, inventory, now) {
  if (!inventory?.length || inventory.some(p => !p.known)) throw new Error('Global reviewer inventory unavailable; refusing dispatch')
  for (const project of inventory) {
    for (const agent of project.agents.filter(isReviewerAgent)) {
      let claim = claims.find(c => active(c) && c.project === project.project && c.paneId === agent.pane_id)
      if (!claim) {
        // Usage supplies legacy ownership, never liveness. Only actual HERDR agents count.
        const runs = existsSync(join(project.tasksDir, '.request-usage.json')) ? JSON.parse(readFileSync(join(project.tasksDir, '.request-usage.json'), 'utf8')).runs : {}
        const run = Object.values(runs || {}).filter(r => r.role === 'reviewer' && r.paneId === agent.pane_id).at(-1)
        claim = { id: randomUUID(), project: project.project, tasksDir: project.tasksDir, cards: run?.cardIds || [], paneId: agent.pane_id, legacy: true, createdAt: now }
        // A pane whose claim was closed is never re-adopted: done, or idle with no prompt
        // after a retired launch (it would become a card-less legacy claim blocking all review).
        if (claims.some(c => c.project === project.project && c.paneId === agent.pane_id && c.closedAt)) continue
        claims.push(claim)
      }
      if (agent.agent_status === 'done') {
        claim.doneSince ??= now
        if (now - claim.doneSince >= 120000) retire(claim, now, 'HERDR reported done without a complete handoff')
      } else delete claim.doneSince
      claim.lastSeen = now
    }
    for (const claim of claims.filter(c => active(c) && c.project === project.project)) {
      if (claim.paneId && !project.agents.some(a => a.pane_id === claim.paneId) && now - (claim.lastSeen || claim.createdAt) >= 120000) retire(claim, now, 'reviewer disappeared from confirmed HERDR inventory')
      // A board restart mid-launch leaves the pane idle with no prompt and the claim in
      // 'starting' forever, which also hides the card from the stall watchdog (Tradeflow T-38).
      if ((!claim.paneId || claim.phase === 'starting') && claim.ownerPid && !alive(claim.ownerPid) && now - claim.createdAt >= 120000) {
        retire(claim, now, claim.paneId ? 'the board restarted before the reviewer prompt was submitted' : 'launch process exited before recording a reviewer pane')
      }
    }
  }
}
export function syncReviewClaims(root, inventory, now = Date.now()) {
  return transaction(root, claims => { reconcile(claims, inventory, now); return claims.filter(active) })
}
export function reserveReview(root, { project, tasksDir, cards, inventory, now = Date.now() }) {
  return transaction(root, claims => {
    reconcile(claims, inventory, now)
    if (!inventory.some(p => p.project === project && resolve(p.tasksDir) === resolve(tasksDir)) || !Array.isArray(cards) || !cards.length || cards.some(id => !isCardId(id)) || new Set(cards).size !== cards.length) throw new Error('Invalid reviewer reservation')
    const live = claims.filter(active)
    if (live.length >= MAX_REVIEWERS) throw Object.assign(new Error('board-wide reviewer limit is four'), { busy: true })
    if (live.some(c => c.project === project && (!c.cards.length || c.cards.some(id => cards.includes(id))))) throw Object.assign(new Error('review cards already claimed or legacy ownership unknown'), { busy: true })
    const claim = { id: randomUUID(), project, tasksDir, cards, phase: 'starting', createdAt: now, ownerPid: process.pid }
    claims.push(claim)
    return claim
  })
}
export function updateReviewClaim(root, id, patch) {
  return transaction(root, claims => {
    const claim = claims.find(c => c.id === id && active(c))
    if (!claim) throw new Error('Reviewer claim missing or closed')
    Object.assign(claim, patch)
    return claim
  })
}
export function failReviewClaim(root, id, reason) {
  return transaction(root, claims => {
    const claim = claims.find(c => c.id === id && active(c))
    if (claim) retire(claim, Date.now(), reason)
  })
}
export function reviewClaimFor(root, tasksDir, cardId) {
  return readReviewClaims(root).find(c => active(c) && resolve(c.tasksDir) === resolve(tasksDir) && c.cards.includes(cardId))
}
export function assertReviewHandoff(root, tasksDir, cardId, claimId) {
  const claim = reviewClaimFor(root, tasksDir, cardId)
  if (claimId && (!claim || claim.id !== claimId)) throw new Error('Card is not owned by this reviewer claim')
  if (claim && !claim.legacy && claim.id !== claimId) throw new Error('Active reviewer claim required for this card handoff')
}
export function assertReviewInputs(root, tasksDir, cardId) {
  const claim = reviewClaimFor(root, tasksDir, cardId)
  if (!claim?.inputFingerprints?.[cardId]) return // Legacy reviews cannot claim cached evidence.
  const card = findCard(tasksDir, cardId)
  const expected = claim.inputFingerprints[cardId]
  if (JSON.stringify(projectEnvironment(claim.project)) !== JSON.stringify(claim.environment ?? null)) throw new Error('Approved environment changed; affected review checks must run again')
  // The snapshot is the reviewed code. Integration may move on after review
  // (later cards); that is their review's concern, not a reason to refuse this PASS.
  if (evidenceFingerprint(card, claim.snapshot.path) !== expected) throw new Error('Relevant code, environment manifest or acceptance criteria changed; affected review checks must run again')
}

// Integration cherry-picks with -x, so the card's own commit is either an
// ancestor or named in a cherry-pick trailer.
export function snapshotContains(path, commit) {
  const git = args => spawnSync('git', ['-C', path, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  if (git(['merge-base', '--is-ancestor', commit, 'HEAD']).status === 0) return true
  return !!git(['log', '--format=%H', '--fixed-strings', `--grep=(cherry picked from commit ${commit})`, 'HEAD']).stdout?.trim()
}

export function busyReviewCards(root, tasksDir, agents) {
  const claims = readReviewClaims(root).filter(c => active(c) && resolve(c.tasksDir) === resolve(tasksDir))
  const live = agents.filter(a => isReviewerAgent(a) && a.agent_status !== 'done')
  if (live.some(a => !claims.some(c => c.paneId === a.pane_id && c.cards.length))) return null
  return claims.filter(c => c.phase === 'starting' || !agents.some(a => a.pane_id === c.paneId && a.agent_status === 'done')).flatMap(c => c.cards)
}

export function prepareReviewSnapshot(root, projectPath, claimId) {
  const probe = spawnSync('git', ['-C', projectPath, 'rev-parse', '--git-dir'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  if (probe.status !== 0 && /not a git repository/i.test(probe.stderr || '')) return { path: projectPath, head: null, reportOnly: true }
  if (probe.error || probe.status !== 0) throw new Error(`Review workspace unavailable: ${probe.error?.message || probe.stderr}`)
  const run = args => {
    const r = spawnSync('git', ['-C', projectPath, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    if (r.error || r.status !== 0) throw new Error(`Review snapshot Git check failed: ${r.error?.message || r.stderr}`)
    return r.stdout.trim()
  }
  const head = run(['rev-parse', 'HEAD'])
  const path = join(root, 'review-workspaces', claimId)
  mkdirSync(join(root, 'review-workspaces'), { recursive: true })
  run(['worktree', 'add', '--detach', path, head])
  prepareWorktreeEnvironment({ workspacePath: path, integrationWorkspace: projectPath })
  return { path, head }
}
