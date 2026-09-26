// A project chat's release, through the board: start pauses the project and reports
// what is still in flight; finish fast-forwards the integration checkout to the
// released master commit. The board never pushes or deploys.
import { spawnSync } from 'node:child_process'
import { readBoard } from './cards.mjs'
import { liveBindings } from './bindings.mjs'
import { readWorktrees, clean } from './worktrees.mjs'

// Why the project is not ready to release yet; empty means ready.
export function releaseWaiting({ tasksDir, agents, herdrUp, integrating = false }) {
  if (!herdrUp) return ['Agent list unavailable (herdr down): cannot confirm no Builder is working']
  const waiting = integrating ? ['The board is integrating completed cards right now'] : []
  const byPane = new Map(agents.map(a => [a.pane_id, a]))
  for (const [id, b] of Object.entries(liveBindings(tasksDir, agents))) {
    const agent = byPane.get(b.pane_id)
    if (!agent || agent.agent_status === 'working') waiting.push(`${id}: Builder is still working`)
  }
  const board = readBoard(tasksDir), registry = readWorktrees(tasksDir)
  for (const card of [...board.completed, ...board.review]) {
    const entry = registry[card.id]
    if (entry && entry.state !== 'integrated') waiting.push(`${card.id}: in ${card.column}, not integrated yet (${entry.state})`)
  }
  return waiting
}

// Throws the exact reason on any failed check; nothing moves unless every check passes.
export function finishRelease({ integrationPath, commit, branch = 'master' }) {
  const git = (...args) => spawnSync('git', ['-C', integrationPath, ...args], { encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  const fail = (what, r) => { throw new Error(`${what}: ${(r.stderr || r.stdout || r.error?.message || '').trim()}`) }
  if (!/^[0-9a-f]{4,64}$/i.test(String(commit))) throw new Error('commit must be a commit hash')
  if (!integrationPath || git('rev-parse', '--git-dir').status !== 0) throw new Error('No git integration checkout for this project')
  const fetched = git('fetch', 'origin')
  if (fetched.status !== 0) fail('git fetch origin failed', fetched)
  const sha = git('rev-parse', '--verify', '--quiet', `${commit}^{commit}`).stdout.trim()
  if (!sha) throw new Error(`Commit ${commit} not found in ${integrationPath} after git fetch origin`)
  if (git('merge-base', '--is-ancestor', sha, `origin/${branch}`).status !== 0) throw new Error(`Commit ${commit} is not on origin/${branch}`)
  if (!clean(integrationPath)) throw new Error(`Integration checkout ${integrationPath} has uncommitted changes or an unfinished git operation`)
  if (git('merge-base', '--is-ancestor', 'HEAD', sha).status !== 0) {
    throw new Error(`Integration checkout HEAD ${git('rev-parse', '--short', 'HEAD').stdout.trim()} is not an ancestor of ${commit}: it has commits the release does not include`)
  }
  const merged = git('merge', '--ff-only', sha)
  if (merged.status !== 0) fail('git merge --ff-only failed', merged)
  return git('rev-parse', '--short', 'HEAD').stdout.trim()
}
