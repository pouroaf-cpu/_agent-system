import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { renameSync } from './fs-retry.mjs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { withBoardLock } from './bindings.mjs'
import { appendHistory } from './card-history.mjs'
import { readDelivery, saveDelivery } from './delivery-state.mjs'

const file = dir => join(dir, '.card-planners.json')
const snapshots = new WeakMap()
const encode = x => JSON.stringify(x)
const conflict = () => Object.assign(new Error('Planner assignment changed; stale callback refused'), { paused: true, preservePane: true })
export function readCardPlanners(dir) {
  const data = existsSync(file(dir)) ? JSON.parse(readFileSync(file(dir), 'utf8')) : {}
  snapshots.set(data, structuredClone(data))
  return data
}
export function saveCardPlanners(dir, data) {
  const before = snapshots.get(data)
  if (!before) throw new Error('Planner update requires a read snapshot')
  return withBoardLock(dir, () => {
    const fresh = readCardPlanners(dir)
    for (const id of new Set([...Object.keys(before), ...Object.keys(data)])) {
      if (encode(before[id]) === encode(data[id])) continue
      if (encode(before[id]) !== encode(fresh[id])) throw conflict()
      if (!data[id]) throw new Error('Planner records are retired, never deleted')
      fresh[id] = data[id]
    }
    writeFileSync(file(dir) + '.tmp', JSON.stringify(fresh, null, 2))
    renameSync(file(dir) + '.tmp', file(dir))
    Object.assign(data, fresh)
    snapshots.set(data, structuredClone(fresh))
  })
}
export function assertPlannerAssignment(dir, id, owner) {
  const current = readCardPlanners(dir)[id]
  if (!current || current.lifecycle === 'retiring' || current.lifecycle === 'retired' || current.paneId !== owner.paneId || current.assignmentId !== owner.assignmentId) throw conflict()
}
export function assertPlannerHandoff(dir, id, token) {
  const owner = readCardPlanners(dir)[id]
  if (owner?.assignmentId && (owner.lifecycle !== 'active' || token !== owner.assignmentId)) throw conflict()
}
export function assertPlannerPaneAllowed(project, paneId) {
  const path = process.env.KANBAN_CONFIG || fileURLToPath(new URL('../board.config.json', import.meta.url))
  if (!existsSync(path)) return
  const config = JSON.parse(readFileSync(path, 'utf8'))
  const key = s => String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  const name = config.projects?.find(p => key(p) === key(project))
  if (!name) return
  const owners = readCardPlanners(join(config.projectsRoot, name, 'TASKS'))
  if (Object.values(owners).some(o => o.revokedPaneIds?.includes(paneId) || (o.paneId === paneId && ['retiring', 'retired'].includes(o.lifecycle)))) throw conflict()
}

// Maintenance only: never dispatches. Two-phase retirement fails closed if closing fails.
export async function reconcilePlannerAssignment({ project, tasksDir, cardId, recovery = false, reason, io }) {
  const configPath = process.env.KANBAN_CONFIG || fileURLToPath(new URL('../board.config.json', import.meta.url))
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  if (!config.projects.includes(project) || resolve(tasksDir) !== resolve(config.projectsRoot, project, 'TASKS')) throw new Error('Canonical registered project TASKS required')
  if (config.maxConcurrentAgents !== 0 || !config.projects.every(p => config.projectControls?.[p]?.paused)) throw new Error('All projects must remain paused with zero capacity')
  if (!reason?.trim()) throw new Error('Specific retirement/recovery reason required')
  const { activeCardRun } = await import('./card-run.mjs')
  if (activeCardRun()) throw new Error('Cancel explicit card run before reconciliation')
  const { findCard } = await import('./cards.mjs')
  const { readWorktrees } = await import('./worktrees.mjs')
  const herdr = io || await import('./herdr.mjs')
  const session = project.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  const owners = readCardPlanners(tasksDir), owner = owners[cardId]
  if (!owner) throw new Error('Planner assignment missing')
  if (owner.lifecycle === 'retired') return owner
  if (owner.lifecycle === 'retiring') throw new Error('Incomplete retirement requires inspection; no automatic replay')
  const card = findCard(tasksDir, cardId)
  if (recovery ? card.column !== 'planning' : ['planning', 'issues', 'working', 'review'].includes(card.column)) throw new Error('Unresolved assignment requires explicit Planning recovery, not obsolete retirement')
  const delivery = readDelivery(session, owner.paneId)
  if (delivery && !['confirmed', 'cancelled'].includes(delivery.status)) throw new Error('Pending or uncertain delivery must be reconciled before retirement')
  const agents = await herdr.agentList(session, { ensureSession: false })
  const agent = agents.find(a => a.pane_id === owner.paneId)
  if (!agent) throw new Error('Session unavailable: preserve output before reconciling manually')
  const output = String(await herdr.paneRead(owner.paneId, session))
  const updateMenu = agent.agent_status === 'blocked' && /Update available!/.test(output) && /Skip until next version/.test(output) && /Press enter to continue/.test(output)
  if (!['done', 'idle'].includes(agent.agent_status) && !updateMenu) throw new Error('Running, unknown or unresolved blocked session cannot be retired')
  const bytes = readFileSync(card.path), hash = createHash('sha256').update(bytes).digest('hex')
  const worktree = readWorktrees(tasksDir)[cardId]
  let gitEvidence = null
  if (worktree) {
    const cleaned = worktree.state === 'integrated' && worktree.cleaned && worktree.commit
    const cwd = cleaned ? worktree.integrationWorkspace : worktree.worktreePath
    const git = args => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
    let residual = null
    if (cleaned) {
      const samePath = p => resolve(p).toLowerCase() === resolve(worktree.worktreePath).toLowerCase()
      if (git(['worktree', 'list', '--porcelain']).split(/\r?\n/).some(line => line.startsWith('worktree ') && samePath(line.slice(9))) || existsSync(join(worktree.worktreePath, '.git'))) throw new Error('Cleaned worktree is still registered or contains Git state; inspect before retirement')
      try { git(['merge-base', '--is-ancestor', worktree.commit, 'HEAD']) } catch (err) {
        // Registry stores the source commit; normal integration cherry-picks -x.
        if (err.status !== 1 || !git(['log', '--format=%H', '--fixed-strings', `--grep=(cherry picked from commit ${worktree.commit})`, 'HEAD']).trim()) throw new Error('Saved source commit has no verified integration ancestry/trailer')
      }
      if (existsSync(worktree.worktreePath)) residual = { path: worktree.worktreePath, entries: readdirSync(worktree.worktreePath), disposition: 'Unregistered residual preserved unchanged; Git provenance read from verified integration' }
    }
    gitEvidence = { cwd, previouslyCleaned: !!cleaned, head: git(['rev-parse', 'HEAD']).trim(), status: git(['status', '--porcelain']), commits: git(['log', '--format=%H %s', `${worktree.baseCommit}..${cleaned ? worktree.commit : 'HEAD'}`]), refs: git(['show-ref', '--heads']), ...(cleaned ? { integratedCommit: git(['show', '--no-patch', '--format=%H %s', worktree.commit]) } : {}) }
    if (residual) gitEvidence.residual = residual
  }
  const currentAgent = (await herdr.agentList(session, { ensureSession: false })).find(a => a.pane_id === owner.paneId)
  if (encode(readDelivery(session, owner.paneId)) !== encode(delivery)) throw new Error('Delivery changed during inspection')
  if (!currentAgent || currentAgent.agent_status !== agent.agent_status || currentAgent.state_change_seq !== agent.state_change_seq || createHash('sha256').update(readFileSync(card.path)).digest('hex') !== hash) throw new Error('Session/card changed during inspection')
  const history = appendHistory(tasksDir, cardId, { event: 'planner-reconciliation-source', agent: 'board-maintenance', reason, recovery, assignment: owner, session: agent, output, sourcePath: card.path, sourceHash: hash, originalBase64: bytes.toString('base64'), worktree, gitEvidence, delivery })
  Object.assign(owner, { assignmentId: randomUUID(), lifecycle: 'retiring', reconciliationHistoryId: history.id, revokedPaneIds: [...new Set([...(owner.revokedPaneIds || []), owner.paneId])] })
  saveCardPlanners(tasksDir, owners)
  await herdr.paneClose(owner.paneId, session)
  if ((await herdr.agentList(session, { ensureSession: false })).some(a => a.pane_id === owner.paneId)) throw new Error('Pane closure unconfirmed; retirement stays blocked')
  if (delivery) saveDelivery(session, owner.paneId, { ...delivery, status: 'cancelled', reason: 'Planner assignment retired; never replay', reconciliationHistoryId: history.id })
  Object.assign(owner, { lifecycle: 'retired', closedAt: new Date().toISOString(), closureReason: reason, recoveryReady: recovery })
  saveCardPlanners(tasksDir, owners)
  appendHistory(tasksDir, cardId, { event: 'planner-reconciled', agent: 'board-maintenance', sourceHistoryId: history.id, recovery, reason, retiredPane: owner.paneId })
  return owner
}
