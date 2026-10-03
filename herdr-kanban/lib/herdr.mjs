// Thin wrappers over the herdr CLI. Every call shells out to herdr.exe and parses
// its JSON envelope: {"id":"cli:agent:list","result":{...}}.

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPromptAllowed } from './project-control.mjs'
import { assertPlannerPaneAllowed } from './planner-state.mjs'
import { agentRole, isBoardAgent } from './ids.mjs'
import { PaneProcessTrees } from './process-tree.mjs'
import { headless, isHeadless } from './headless.mjs'
import { backendFor } from './agent-backend.mjs'

const run = promisify(execFile)
const inventoryCycle = new AsyncLocalStorage()
let inventoryGeneration = 0
export async function withAgentListCycle(action) {
  const cycle = { lists: new Map(), active: true }
  try { return await inventoryCycle.run(cycle, action) }
  finally { cycle.active = false; cycle.lists.clear() }
}
const paneTrees = new PaneProcessTrees()
const treePolls = new Map()
const treeKey = (paneId, session) => {
  const ref = splitRef(paneId, session)
  return `${ref.session || SHARED_SESSION}/${ref.id}`
}

async function rememberPane(paneId, session, cli = herdr, trees = paneTrees) {
  const ref = splitRef(paneId, session)
  const result = await cli(['pane', 'process-info', '--pane', ref.id], { session: ref.session, ensureSession: false })
  const shellPid = (result?.process_info ?? result)?.shell_pid
  if (!Number.isInteger(shellPid) || shellPid <= 0) throw new Error(`pane process-info: missing shell PID for ${paneId}`)
  await trees.observe([{ key: treeKey(paneId, session), shellPid }])
}

async function pollPaneTrees(session, agents) {
  session ||= SHARED_SESSION
  const previous = treePolls.get(session)
  // Listing every process costs ~2.5 s of PowerShell: once a minute is enough for leftovers.
  if (previous && (previous.pending || Date.now() - previous.at < 60000)) return previous.poll
  const poll = (async () => {
    const result = await herdr(['pane', 'list'], { session, ensureSession: false })
    if (!Array.isArray(result?.panes) || result.panes.some(p => !p || typeof p.pane_id !== 'string')) throw new Error('pane list: malformed response')
    const live = new Set(result.panes.map(p => treeKey(p.pane_id, session)))
    for (const agent of agents.filter(isBoardAgent)) {
      if (live.has(treeKey(agent.pane_id, session)) && !paneTrees.panes.has(treeKey(agent.pane_id, session))) await rememberPane(agent.pane_id, session)
    }
    await paneTrees.observe([...live].filter(key => paneTrees.panes.has(key)).map(key => ({ key })))
    await paneTrees.sweep(session, live)
  })()
  const entry = { poll, pending: true, at: Date.now() }
  treePolls.set(session, entry)
  try { await poll; entry.pending = false } catch (err) { treePolls.delete(session); throw err }
}

const HERDR = process.env.HERDR_BIN_PATH || 'herdr'
const CLAUDE_AGENT_SETTINGS = fileURLToPath(new URL('../claude-agent-settings.json', import.meta.url))
const CLAUDE_BROWSER_MCP = fileURLToPath(new URL('../claude-browser-mcp.json', import.meta.url))
// The built-ins board agents called in 135 audited runs; the rest (Artifact alone ~12.9k
// tokens) rode along on every call. MCP tools are not affected by --tools.
const CLAUDE_BOARD_TOOLS = 'Bash,PowerShell,Read,Edit,Write,Grep,Glob,ToolSearch,TaskStop'

// Codex board profile: `codex -p board` layers ~/.codex/board.config.toml on the user config.
// It turns off the curated Vercel and Google Drive skills (~3.3k tokens a call, never used by
// board agents). Those plugins are enabled account-side, so only per-SKILL.md entries work, and
// passing them with -c made a 7.8 KB start command. Rewritten at each Codex start so a plugin
// update's new version folder is covered; its entries add to the user's own skills.config list.
// bin/ first on board agents' PATH: its npm refuses installs through a card checkout's shared
// node_modules link (Tradeflow TF103/TF105, 2026-09-27). Codex takes PATH literally (no
// expansion), so it is the board's own PATH with bin/ in front. Claude's shells ignore a
// settings PATH: claude-agent-settings.json prepends bin/ for Bash (CLAUDE_ENV_FILE) and a
// PreToolUse hook runs the same check on PowerShell commands.
export const NPM_SHIM_DIR = fileURLToPath(new URL('../bin', import.meta.url))
export const boardAgentPath = (path = process.env.PATH || '') => [NPM_SHIM_DIR, ...path.split(';').filter(p => p && p !== NPM_SHIM_DIR)].join(';')
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex')
export const CODEX_BOARD_PROFILE = join(CODEX_HOME, 'board.config.toml')
export function writeCodexBoardProfile() {
  const cache = join(CODEX_HOME, 'plugins', 'cache', 'openai-curated-remote')
  const list = dir => { try { return readdirSync(dir) } catch { return [] } }
  const skills = ['vercel', 'google-drive'].flatMap(plugin => list(join(cache, plugin)).flatMap(version =>
    list(join(cache, plugin, version, 'skills')).map(skill => join(cache, plugin, version, 'skills', skill, 'SKILL.md'))))
    .filter(path => existsSync(path))
  const toml = '# Written by herdr-kanban for board agents (codex -p board). Do not edit.\n' +
    skills.map(path => `\n[[skills.config]]\npath = '${path}'\nenabled = false\n`).join('') +
    // JSON string escapes are valid TOML basic-string escapes.
    `\n[shell_environment_policy.set]\nPATH = ${JSON.stringify(boardAgentPath())}\n`
  try { if (readFileSync(CODEX_BOARD_PROFILE, 'utf8') === toml) return } catch {}
  writeFileSync(CODEX_BOARD_PROFILE, toml)
}

// Board-only Codex Stop hook: nobody reads a board agent's chat, so a question or
// blocker left there as plain text stalls the card (scripts/codex-stop-hook.mjs has
// the policy). ~/.codex/hooks.json is off limits, and a board.config.toml profile's
// hooks.state can only toggle a hook already discovered elsewhere, not define a new
// one (confirmed empirically, 2026-09-27) — so this is registered the one place Codex
// discovers a hook scoped to a single directory: <workspacePath>/.codex/hooks.json.
// Every card's workspace is its own disposable git worktree (lib/worktrees.mjs), so
// this never reaches the operator's own Codex chats, which never cd into one.
// Idempotent merge: a project's own committed .codex/hooks.json, if any, keeps its
// other hooks; only our Stop entry is added or replaced.
const CODEX_STOP_HOOK = fileURLToPath(new URL('../scripts/codex-stop-hook.mjs', import.meta.url))
export function writeCodexWorkspaceHooks(workspacePath) {
  if (!workspacePath) return
  const file = join(workspacePath, '.codex', 'hooks.json')
  const command = `node ${JSON.stringify(CODEX_STOP_HOOK)}`
  let doc
  try { doc = JSON.parse(readFileSync(file, 'utf8')) } catch { doc = {} }
  const kept = (doc.hooks?.Stop || []).filter(entry => !(entry.hooks?.length === 1 && entry.hooks[0].command === command))
  const next = { ...doc, hooks: { ...doc.hooks, Stop: [...kept, { hooks: [{ type: 'command', command, timeout: 30 }] }] } }
  const text = JSON.stringify(next, null, 2)
  try { if (readFileSync(file, 'utf8') === text) return } catch {}
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

const CONFIG = (() => {
  try { return JSON.parse(readFileSync(process.env.KANBAN_CONFIG || new URL('../board.config.json', import.meta.url), 'utf8')) } catch { return {} }
})()
// Fallback label when a caller has no project.
const AGENT_WORKSPACE = CONFIG.agentWorkspace || 'agents'

// Every new board agent lives in ONE herdr session — the default one, so plain
// `herdr` shows them all — with one workspace per project, labelled with the
// project name. Callers still pass sessionOf(project): that key names the project,
// and it is also the project's old per-project session, where agents started before
// the switch keep running. herdr ids are only unique within a session, so an id
// from the shared session travels as `w1:p5@default`; a bare id is a legacy agent
// in sessionOf(project) and keeps resolving there until it finishes.
export const SHARED_SESSION = 'default'
export const sessionOf = (project) => (project || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || null
const projectLabel = (session) => CONFIG.projects?.find((p) => sessionOf(p) === session) ?? session
const shared = (id) => (id ? `${id}@${SHARED_SESSION}` : id)
export function splitRef(ref, session) {
  const at = String(ref ?? '').lastIndexOf('@')
  return at > 0 ? { id: ref.slice(0, at), session: ref.slice(at + 1) } : { id: ref, session }
}
// Which argument names a pane/agent/tab, per command; -1 when none does.
function refIndex([group, verb, ...rest]) {
  if (group === 'agent' && verb === 'start') return rest.includes('--pane') ? rest.indexOf('--pane') + 3 : -1
  const targeted = (group === 'agent' && verb === 'prompt') || (group === 'pane' && ['read', 'close', 'send-keys'].includes(verb)) || (group === 'tab' && verb === 'focus')
  return targeted ? 2 : -1
}
// The argv for one call: a pane-targeted call goes to the session that owns the
// pane (qualified id) or else to the caller's project session; the shared default
// session takes no --session flag.
export function herdrArgv(args, session) {
  const at = refIndex(args)
  const target = at < 0 ? { session } : splitRef(args[at], session)
  const argv = at < 0 ? args : args.with(at, target.id)
  return target.session && target.session !== SHARED_SESSION ? ['--session', target.session, ...argv] : argv
}
// One project's view: legacy-session agents as they are, plus the shared-session
// agents in the workspace labelled with the project, with their ids qualified.
export function projectAgents(session, legacy, all, labels) {
  return [
    ...legacy.map((a) => ({ ...a, session })),
    ...all.filter((a) => sessionOf(labels.get(a.workspace_id)) === session)
      .map((a) => ({ ...a, session: SHARED_SESSION, pane_id: shared(a.pane_id), tab_id: shared(a.tab_id) })),
  ]
}

export const sessionServerArgs = (session) => ['--session', session, 'server']
// herdr's panes inherit its env: a server started from a Claude chat gave every agent pane
// that chat's CLAUDE_CODE_HOST_SESSION_ID, so its state hooks treated agents as that chat (2026-10-02).
export const cleanEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^CLAUDE/i.test(k)))

const sessionStarts = new Map()
const sessionBlocked = new Map()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function ensureSessionReady(session) {
  if (!session) return
  if (sessionBlocked.has(session)) throw sessionBlocked.get(session)
  if (sessionStarts.has(session)) return sessionStarts.get(session)

  const start = (async () => {
    let first
    try {
      await herdr(['agent', 'list'], { timeout: 5000, session, ensureSession: false })
      return
    } catch (err) {
      first = err
    }

    let child
    try {
      child = spawn(HERDR, sessionServerArgs(session), { detached: true, stdio: 'ignore', windowsHide: true, env: cleanEnv() })
      const launchErr = await new Promise((resolve) => {
        child.once('error', resolve)
        child.once('spawn', () => resolve(null))
      })
      if (launchErr) throw launchErr
      child.unref()
    } catch (err) {
      throw new Error(`herdr --session ${session} server failed to launch after readiness check failed: ${first.message}; launch: ${err.message}`)
    }

    let last = first
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      await sleep(250)
      try {
        await herdr(['agent', 'list'], { timeout: 5000, session, ensureSession: false })
        return
      } catch (err) {
        last = err
      }
    }
    throw new Error(`herdr --session ${session} server did not become ready after one startup attempt: ${first.message}; last: ${last.message}`)
  })()

  sessionStarts.set(session, start)
  try {
    await start
  } catch (err) {
    sessionBlocked.set(session, err)
    throw err
  } finally {
    sessionStarts.delete(session)
  }
}

async function herdr(args, { timeout = 15000, session, ensureSession = true } = {}) {
  // A launch, prompt or closure makes earlier inventories unsafe for dispatch.
  if (!['list', 'read', 'process-info'].includes(args[1])) inventoryGeneration++
  // A pane never survives its server, so a stopped session is not restarted for a
  // pane-targeted call.
  if (ensureSession && refIndex(args) < 0) await ensureSessionReady(session === SHARED_SESSION ? null : session)
  if (args[0] === 'agent' && ['start', 'prompt'].includes(args[1])) assertPlannerPaneAllowed(session, args[1] === 'start' ? args[args.indexOf('--pane') + 1] : args[2])
  if (args[0] === 'pane' && args[1] === 'send-keys') assertPlannerPaneAllowed(session, args[2])
  // Last boundary, after asynchronous readiness: Pause/cancel cannot leave a queued launch authorized.
  if (args[0] === 'agent' && ['start', 'prompt'].includes(args[1])) assertPromptAllowed(session, { paneId: args[1] === 'start' ? args[args.indexOf('--pane') + 1] : args[2], action: args[1] })
  if (args[0] === 'pane' && args[1] === 'send-keys') assertPromptAllowed(session, { paneId: args[2], action: 'enter' })
  const argv = herdrArgv(args, session)
  const { stdout } = await run(HERDR, argv, { timeout, windowsHide: true })
  if (!['list', 'read', 'process-info'].includes(args[1])) inventoryGeneration++
  const text = stdout.trim()
  if (!text) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { raw: text }
  }
  if (parsed.error) throw new Error(`herdr ${args[0]} ${args[1]}: ${JSON.stringify(parsed.error)}`)
  return parsed.result ?? parsed
}

// Config uses forward slashes, herdr reports backslashes — compare normalised or
// nothing ever matches.
const norm = (p) => (p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
const sameDir = (a, b) => !!a && !!b && norm(a) === norm(b)

// A missing/non-array `agents` field, or an entry with no pane_id, used to be
// swallowed into [] or a "no match" — which reads as "nothing is running" to
// every caller that decides whether it is safe to spawn (reviewerRunning off
// the name field, liveBindings off pane_id — the builder's concurrency count).
// That is the exact shape of the bug this guards against: fail closed instead
// — throw, so both the builder path (via pollAgents -> herdrUp) and the
// reviewer path (spawnReviewer calls agentsForProject directly) treat it as
// unknown and skip the spawn, not as a clear go-ahead.
export function parseAgentList(result) {
  const agents = result?.agents
  if (!Array.isArray(agents) || agents.some((a) => !a || typeof a.pane_id !== 'string')) {
    throw new Error(`agent list: malformed response (${JSON.stringify(result)})`)
  }
  return agents
}

// Live agents. agent_status is one of idle | working | blocked | done | unknown.
// For a project: its legacy session's agents (bare ids) plus the agents in its
// workspace of the shared session (qualified ids), each tagged with `session`.
// A legacy session that is no longer running simply has no agents; the shared
// session failing is still a failure, so callers keep failing closed.
export async function agentList(session, options = {}) {
  const local = await headless.agentList(session)
  const listNow = async (session, options) => {
    let result
    try { result = await herdr(['agent', 'list'], { ...options, session }) } catch (err) {
      if (/server_not_running/.test(err.message)) await paneTrees.sweep(session || SHARED_SESSION, new Set())
      throw err
    }
    const agents = parseAgentList(result)
    // Cleanup is best-effort and runs in the background: it must never fail or slow the agent list.
    void pollPaneTrees(session, agents).catch(err => herdrLog(`process cleanup: ${err.message}`))
    return agents
  }
  const list = (session, options) => {
    const cycle = inventoryCycle.getStore(), key = session || SHARED_SESSION
    if (!cycle?.active) return listNow(session, options)
    const hit = cycle.lists.get(key)
    // Long integration checks can outlive a poll interval; never retain their
    // starting inventory indefinitely.
    if (!hit || hit.generation !== inventoryGeneration || Date.now() - hit.at >= (CONFIG.agentPollMs || 5000)) cycle.lists.set(key, { at: Date.now(), generation: inventoryGeneration, promise: listNow(session, options) })
    return cycle.lists.get(key).promise
  }
  const interactive = async () => {
    if (!session || session === SHARED_SESSION) return list(session, options)
    const [legacy, all] = await Promise.all([
      list(session, { ...options, ensureSession: false }).catch((err) => { if (/server_not_running/.test(err.message)) return []; throw err }),
      list(SHARED_SESSION, options),
    ])
    return projectAgents(session, legacy, all, await sharedLabels(all))
  }
  try { return [...await interactive(), ...local] } catch (err) {
    // Only an absent server is safe to treat as empty; malformed inventory fails closed.
    if ((local.length || ['planner', 'builder', 'reviewer', 'plancheck'].some(role => backendFor(role) === 'headless')) && /server_not_running|ENOENT|ECONNREFUSED/.test(err.message)) return local
    throw err
  }
}

// workspace_id -> label in the shared session, refreshed when an unknown id shows up.
const labelCache = { at: 0, labels: new Map() }
async function sharedLabels(agents) {
  if (Date.now() - labelCache.at > 30000 || agents.some((a) => !labelCache.labels.has(a.workspace_id))) {
    labelCache.labels = new Map((await workspaceList(SHARED_SESSION)).map((w) => [w.workspace_id, w.label]))
    labelCache.at = Date.now()
  }
  return labelCache.labels
}

// Agents whose cwd is this project.
export async function agentsForProject(projectPath, session, options = {}) {
  return (await agentList(session, options)).filter((a) => sameDir(a.cwd, projectPath))
}

// Projects herdr currently has open, by pane cwd. This is what makes the board
// follow your session instead of a hardcoded list.
export async function openProjects(projectsRoot, session) {
  const result = await herdr(['pane', 'list'], { session })
  const root = projectsRoot.replace(/[\\/]+$/, '').toLowerCase()
  const names = new Set()
  for (const pane of result?.panes ?? []) {
    const cwd = (pane.cwd || '').replace(/\//g, '\\')
    const parts = cwd.toLowerCase().startsWith(root.replace(/\//g, '\\'))
      ? cwd.slice(root.length).split('\\').filter(Boolean)
      : []
    if (parts.length) names.add(parts[0])
  }
  return [...names]
}

// Labels are what the operator sees and types, so match them the way they read.
const sameLabel = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase()
export const findWorkspace = (workspaces, label) =>
  (workspaces ?? []).find((w) => sameLabel(w.label, label))?.workspace_id ?? null

export async function workspaceList(session) {
  const workspaces = (await herdr(['workspace', 'list'], { session }))?.workspaces
  // herdr sometimes answers with nothing under load. That is not "no workspaces":
  // reading it as one made the board create a duplicate project workspace.
  if (!Array.isArray(workspaces)) throw new Error('workspace list: malformed response')
  return workspaces
}

// Deliberately re-listed on every call rather than cached: the operator can close
// the agents workspace mid-session, and a remembered id would then send `tab
// create` to a window that no longer exists. One extra CLI call against a spawn
// that takes ~55s is not worth the invalidation logic.
// Reports whether it had to create one, so callers can log a recreation without
// logging the ordinary case.
export async function agentWorkspace(label = AGENT_WORKSPACE, { list = workspaceList, create, session } = {}) {
  const existing = findWorkspace(await list(session), label)
  if (existing) return { id: existing, created: false }
  // --no-focus: creating the workspace must never pull the operator out of theirs.
  const made = create
    ? await create(label)
    : await herdr(['workspace', 'create', '--label', label, '--no-focus'], { timeout: 30000, session })
  const id = made?.workspace?.workspace_id ?? made?.workspace_id ?? null
  if (id && !session) labelCache.labels.set(id, label)
  return { id, created: true }
}

// Where board-spawned tabs go: the project's workspace in the shared session. No
// fallback — a tab in some other workspace would be invisible to this project's
// agent list, so failing the spawn is the safe outcome.
export async function agentWorkspaceOr(projectPath, session) {
  const { id } = await agentWorkspace(projectLabel(session) || AGENT_WORKSPACE)
  if (!id) throw new Error('workspace create returned no id')
  return id
}

// herdr has no unclosable workspace, so the board keeps its own alive instead:
// called from the poll, it puts the workspace back if the operator closed it.
// The `workspace list` call is skipped whenever a live agent is already sitting
// in the one we last resolved — that is the common case, and the agent poll has
// already paid for the information.
// Keyed by project: each project has its own workspace in the shared session, and
// one id remembered globally would send another project's tabs to a stranger's window.
const knownWorkspace = new Map() // project session key -> workspace_id
const workspaceBackoffUntil = new Map() // project session key -> epoch ms

export async function ensureAgentWorkspace(agents = [], log, session) {
  if (['planner', 'builder', 'reviewer', 'plancheck'].every(role => backendFor(role) === 'headless') && agents.every(a => isHeadless(a.pane_id))) return null
  const label = projectLabel(session) || AGENT_WORKSPACE
  const known = knownWorkspace.get(session ?? '')
  // The label cache (refreshed at least every 30s by agentList) also proves it is
  // still there, so idle projects do not each re-list workspaces every poll.
  if (known && (labelCache.labels.get(known) === label || agents.some((a) => a.workspace_id === known && (a.session ?? SHARED_SESSION) === SHARED_SESSION))) return known
  // An older herdr with no `workspace create` would otherwise fail every 2s forever.
  if (Date.now() < (workspaceBackoffUntil.get(session ?? '') ?? 0)) return null
  try {
    const { id, created } = await agentWorkspace(label)
    if (created) log?.(`agent workspace recreated: ${id}`)
    knownWorkspace.set(session ?? '', id)
    return id
  } catch (err) {
    workspaceBackoffUntil.set(session ?? '', Date.now() + 60000)
    log?.(`agent workspace unavailable, retrying in 60s — ${err.message}`)
    return null
  }
}

// New tabs always open in the shared session. Their ids come back qualified unless
// the caller has no project session of its own (then the shared one is its session).
export async function tabCreate({ cwd, label, focus = false, workspace, session, backend }) {
  if (backend === 'headless') return headless.tabCreate({ cwd, label, session })
  const args = ['tab', 'create', '--cwd', cwd]
  if (workspace) args.push('--workspace', workspace)
  if (label) args.push('--label', label)
  args.push(focus ? '--focus' : '--no-focus')
  const created = await herdr(args, { timeout: 30000, session: SHARED_SESSION })
  if (created?.root_pane?.pane_id) await rememberPane(created.root_pane.pane_id, SHARED_SESSION).catch(err => herdrLog(`process cleanup: ${err.message}`))
  if (!session || session === SHARED_SESSION || !created?.root_pane) return created
  const tab = created.tab && { ...created.tab, tab_id: shared(created.tab.tab_id) }
  return { ...created, root_pane: { ...created.root_pane, pane_id: shared(created.root_pane.pane_id), tab_id: shared(created.root_pane.tab_id) }, ...(tab ? { tab } : {}) }
}

// Panes whose agent is mid-spawn. herdr registers a newly started agent as
// `idle`, which is indistinguishable from one that has finished and reported
// back — so the board's own pane reaper would close a pane it is still booting
// into, leaving `agent start` to wait out its full timeout on a pane that no
// longer exists. Held here rather than at the call sites so every caller of
// agentStart/agentPrompt is covered, bound to a card or not.
//
// Refcounted, not a flag: a bound builder is protected the moment it's bound
// (before agentStart even runs), so agentStart's own internal hold is enough
// for it. An UNBOUND agent (the reviewer — deliberately
// never bound to one card) has no such backstop; it's only protected by this
// flag, and agentStart's hold used to release it the instant `agent start`
// returned — before deliver() ever sent the actual prompt. In that gap the
// pane reads idle+unbound+not-spawning, and the reaper closed it before it
// did a single card: opened, then vanished. beginSpawn/endSpawn let a caller
// hold the pane across BOTH agentStart and deliver; a plain count (not a Set)
// so agentStart's own inner hold releasing first doesn't drop an outer one.
const spawning = new Map() // paneId -> refcount
export const isSpawning = (paneId) => (spawning.get(paneId) || 0) > 0
export function beginSpawn(paneId) { spawning.set(paneId, (spawning.get(paneId) || 0) + 1) }
export function endSpawn(paneId) {
  const n = (spawning.get(paneId) || 0) - 1
  if (n <= 0) spawning.delete(paneId)
  else spawning.set(paneId, n)
}

async function hold(paneId, fn) {
  beginSpawn(paneId)
  try {
    return await fn()
  } finally {
    endSpawn(paneId)
  }
}

// By role letter (see ids.mjs), so old kb-* and new b-/p-/r-/i-/a- names match alike.
// Operator's Claude fallback while Codex is out of usage (2026-09-26): Opus 5.5 plans, Sonnet 5 builds, Haiku 4.5 anywhere.
// Operator 2026-09-28: Builders on Codex gpt-6-sol for speed; 2026-09-30: gpt-6.1-sol (Codex 0.159.2+).
// Operator 2026-09-27: Planners on Codex gpt-6-luna to balance usage; claude-opus-5-5 (was 4-6: its cache reads cost ~2.5x) plans cards a Codex Planner could not.
const BOARD_MODELS = {
  r: ['gpt-5.6-luna', 'gpt-6-luna', 'claude-haiku-4-5', 'claude-sonnet-5'],
  a: ['gpt-5.6-luna', 'gpt-6-luna', 'claude-haiku-4-5'],
  i: ['gpt-5.6-luna', 'gpt-6-luna', 'claude-opus-5-5', 'claude-opus-4-6', 'claude-haiku-4-5'],
  p: ['gpt-5.6-luna', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-4-6', 'claude-haiku-4-5'],
  b: ['gpt-5.6-luna', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'qwen3-coder', 'claude-opus-5-5'],
}

export function approvedManagedModel(name) {
  return BOARD_MODELS[agentRole(name)] ?? null
}

export function assertManagedModel({ name, model }) {
  const expected = approvedManagedModel(name)
  if (!expected) {
    if (/astra/i.test(model || '')) throw new Error(`model ${model} is not allowed for managed HERDR launches`)
    return
  }
  const allowed = Array.isArray(expected) ? expected : [expected]
  if (!allowed.includes(model)) throw new Error(`${name} must use model ${allowed.join(' or ')}, got ${model || '(default)'}`)
}

export function agentStartArgs({ name, paneId, model, engine, kind, workspacePath, guardArgs = [], timeoutMs = 90000, browser = true }) {
  const cfg = typeof engine === 'string' ? { kind: engine } : (engine || {})
  const agentKind = kind || cfg.kind || 'claude'
  const args = ['agent', 'start', name, '--kind', agentKind, '--pane', paneId, '--timeout', String(timeoutMs)]
  // Board agents run unattended, so a permission prompt is a pane that hangs
  // until its timeout with nobody there to answer it. Every spawn path (builder,
  // planner, reviewer) calls agentStart, so the flag belongs here rather
  // than at three call sites.
  assertManagedModel({ name, model })
  args.push('--')
  if (agentKind === 'codex') {
    if (workspacePath) args.push('--cd', workspacePath)
    if (cfg.sandbox) {
      if (!['read-only', 'workspace-write'].includes(cfg.sandbox)) throw new Error('unsupported managed sandbox')
      if (!['on-request', 'never'].includes(cfg.approvalPolicy || 'on-request')) throw new Error('unsupported managed approval policy')
      args.push('--sandbox', cfg.sandbox, '--ask-for-approval', cfg.approvalPolicy || 'on-request')
    } else args.push('--dangerously-bypass-approvals-and-sandbox')
    args.push('-c', 'check_for_update_on_startup=false')
    // Workers skip the orchestrator's Grill Me intake hook and the impeccable design lint
    // (PostToolUse and the Stop "Design deep pass"). -c splits a dotted path on every '.',
    // so hook ids (which contain '.codex\hooks.json') only work inside an inline table,
    // which Codex merges into the user's hooks.state rather than replacing it.
    if (!/orchestrator/i.test(name || '')) {
      const hooks = ['user_prompt_submit:0:0', 'post_tool_use:0:0', 'stop:1:0'].map(id => String.raw`'C:\Users\PFrew\.codex\hooks.json:` + id + `'={enabled=false}`)
      args.push('-c', `hooks.state={${hooks.join(',')}}`)
      if (existsSync(CODEX_BOARD_PROFILE)) args.push('-p', 'board')
      // The workspace's own .codex/hooks.json (writeCodexWorkspaceHooks) carries the board
      // Stop hook; unattended board agents can't answer its one-time hook-trust prompt.
      args.push('--dangerously-bypass-hook-trust')
    }
    // Browser MCPs start ~4 node processes per Codex agent; 27 idle agents' worth
    // overloaded herdr (2026-09-24). Agents whose cards don't browse start without them.
    if (!browser) for (const server of ['chrome-devtools', 'playwright', 'node_repl']) args.push('-c', `mcp_servers.${server}.enabled=false`)
    if (model === 'qwen3-coder') {
      if (cfg.localProvider !== 'ollama') throw new Error('qwen3-coder requires the enabled local Ollama assignment')
      args.push('--oss', '--local-provider', 'ollama')
    }
    if (model) args.push('--model', model)
    if (Array.isArray(cfg.reasoningArgs)) args.push(...cfg.reasoningArgs.map(String))
    args.push(...guardArgs)
  } else {
    args.push('--dangerously-skip-permissions')
    // --disable-slash-commands drops the skill listing; cards name skills by SKILL.md path.
    args.push('--tools', CLAUDE_BOARD_TOOLS, '--disable-slash-commands')
    // Same rule as the Codex branch: no user MCPs or claude.ai connectors, and the browser MCP
    // only when the card browses.
    args.push('--strict-mcp-config')
    if (browser) args.push('--mcp-config', CLAUDE_BROWSER_MCP)
    // HERDR started from a Claude session passes on its CLAUDE_CODE_CHILD_SESSION
    // marker, which turns off transcript saving, and the transcript is where the
    // board reads a Claude agent's token usage.
    args.push('--settings', CLAUDE_AGENT_SETTINGS)
    // Session title in the Claude app matches the herdr agent name.
    if (name) args.push('--name', name)
    if (model) args.push('--model', model)
  }
  return args
}

// herdr names must be unique among a session's live agents, and the shared session
// holds every project (each has a T-11). A taken name gets -2, -3 appended; names
// mid-start are held here so two concurrent spawns cannot pick the same one.
const startingNames = new Set()
async function freeName(base, paneId, session) {
  const live = await herdr(['agent', 'list'], { session: splitRef(paneId, session).session, ensureSession: false }).then(parseAgentList).catch(() => [])
  const taken = new Set([...startingNames, ...live.map((a) => a.name)])
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
  startingNames.add(name)
  return name
}

// Resolves to { name } — the name herdr actually registered.
export async function agentStart({ name, paneId, model, engine, kind, workspacePath, guardArgs, timeoutMs = 90000, session, browser = true }) {
  if (isHeadless(paneId)) return headless.agentStart({ name, paneId, model, engine, kind, workspacePath, guardArgs, timeoutMs, session, browser })
  assertPromptAllowed(session)
  name = await freeName(name, paneId, session)
  try {
    if ((kind || (typeof engine === 'string' ? engine : engine?.kind)) === 'codex') {
      try { writeCodexBoardProfile() } catch { /* no profile: the agent starts without it */ }
      if (!/orchestrator/i.test(name || '')) { try { writeCodexWorkspaceHooks(workspacePath) } catch { /* no Stop hook: the agent starts without it */ } }
    }
    const args = agentStartArgs({ name, paneId, model, engine, kind, workspacePath, guardArgs, timeoutMs, browser })
    return { ...(await hold(paneId, () => herdr(args, { timeout: timeoutMs + 15000, session }))), name }
  } catch (err) {
    if (!/agent_not_ready/.test(err.message)) throw err
    const screen = String(await paneRead(paneId, session).catch(() => '')).slice(-4000)
    throw Object.assign(new Error(`${err.message}; startup pane retained (${session}/${paneId}). Resolve the displayed startup prompt before continuing.\n${screen}`), { preservePane: true })
  } finally {
    startingNames.delete(name)
  }
}

// Codex's title is idle before its composer/MCP startup is ready; agent start
// returning (and agent_status=idle) is not permission to type into that screen.
// ponytail: UI text is the readiness signal; use a HERDR readiness API when exposed.
export async function waitForAgentPrompt(paneId, { timeoutMs = 240000, everyMs = 400, session, read = paneRead } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    assertPromptAllowed(session)
    const screen = String(await read(paneId, session).catch(() => ''))
    if (/^\s*›/m.test(screen) && !/Starting MCP (?:servers|tools)/i.test(screen)) return
    await sleep(everyMs)
  }
  throw Object.assign(new Error(`Codex input not ready in ${paneId}; startup pane retained`), { preservePane: true, notReady: true })
}

export async function agentPrompt(target, text, { wait = false, timeoutMs = 20000, session, engine } = {}) {
  if (isHeadless(target)) return headless.agentPrompt(target, text, { session })
  assertPromptAllowed(session)
  const args = ['agent', 'prompt', target, text]
  // --wait makes herdr confirm the agent actually changed state after submission.
  // Without it a prompt that lands in the input box but never submits looks
  // identical to success.
  if (wait) args.push('--wait', '--until', 'working', '--timeout', String(timeoutMs))
  // Still idle until the prompt is submitted, so the pane needs the same cover.
  return hold(target, async () => {
    if ((typeof engine === 'string' ? engine : engine?.kind) === 'codex') await waitForAgentPrompt(target, { session })
    return herdr(args, { timeout: timeoutMs + 10000, session })
  })
}

// `agent start` requires the pane to already be at an interactive shell prompt.
// A fresh tab is not: PowerShell has a profile to load first, and starting the
// agent into a shell that is not ready hangs until the timeout expires.
export async function waitForPrompt(paneId, { timeoutMs = 20000, everyMs = 400, session } = {}) {
  if (isHeadless(paneId)) return true
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = String(await paneRead(paneId, session).catch(() => ''))
    if (/(?:PS [^\n]*>|\$|#|❯)\s*$/m.test(text.trimEnd())) return true
    await new Promise((r) => setTimeout(r, everyMs))
  }
  return false
}

// Tail a pane's terminal output for the card detail view.
export async function paneRead(paneId, session) {
  if (isHeadless(paneId)) return headless.paneRead(paneId)
  const result = await herdr(['pane', 'read', paneId], { session })
  return result?.raw ?? result?.output ?? result ?? ''
}

export async function focusAgent(paneId, session) {
  if (isHeadless(paneId)) return headless.focusAgent(paneId)
  const agent = (await agentList(session, { ensureSession: false })).find(a => a.pane_id === paneId)
  if (!agent?.tab_id) throw new Error('Existing agent session/tab is unavailable')
  await herdr(['tab', 'focus', agent.tab_id], { session, ensureSession: false })
  const child = spawn(HERDR, ['session', 'attach', splitRef(paneId, session).session || SHARED_SESSION], { detached: true, stdio: 'ignore', windowsHide: false })
  child.on('error', () => {})
  child.unref()
  return agent
}

// Projects are workspaces in the shared session (one per project label), not sessions of their own.
export async function openProjectSession(project, spawnClient = spawn, cli = herdr) {
  const session = SHARED_SESSION
  try {
    parseAgentList(await cli(['agent', 'list'], { session, ensureSession: false }))
  } catch (err) {
    throw new Error(`herdr is unavailable: ${err.message}`)
  }
  const workspaces = (await cli(['workspace', 'list'], { session, ensureSession: false }))?.workspaces
  if (!Array.isArray(workspaces)) throw new Error('workspace list: malformed response')
  const workspace = findWorkspace(workspaces, project) || findWorkspace(workspaces, AGENT_WORKSPACE)
  if (workspace) await cli(['workspace', 'focus', workspace], { session, ensureSession: false })
  const child = spawnClient(HERDR, ['session', 'attach', session], { detached: true, stdio: 'ignore', windowsHide: false })
  child.on('error', () => {})
  child.unref()
}

export async function paneSendKeys(paneId, keys, session) {
  if (isHeadless(paneId)) throw new Error('Headless agents do not accept typed keys')
  assertPromptAllowed(session)
  return herdr(['pane', 'send-keys', paneId, ...keys], { session })
}

export async function paneClose(paneId, session, { cli = herdr, trees = paneTrees } = {}) {
  if (isHeadless(paneId)) return headless.paneClose(paneId)
  const key = treeKey(paneId, session)
  // Best-effort: a cleanup failure must never keep a pane open.
  try {
    if (!trees.panes.has(key)) await rememberPane(paneId, session, cli, trees)
    await trees.close(key)
  } catch (err) { herdrLog(`process cleanup ${paneId}: ${err.message}`) }
  return cli(['pane', 'close', paneId], { session })
}

export async function isRunning(session) {
  try {
    await agentList(session)
    return true
  } catch {
    return false
  }
}

// Push one line into herdr's sidebar activity log. Fire-and-forget on purpose:
// the board must never block on, or die because of, a herdr that is down, slow,
// or too old to know the log.append method. Every failure path is swallowed.
export function herdrLog(text, level = 'info') {
  try {
    const child = execFile(
      HERDR,
      ['log', 'append', String(text), '--source', 'kanban', '--level', level],
      { timeout: 5000, windowsHide: true },
      () => {},
    )
    child.on('error', () => {})
    child.unref()
  } catch { /* herdr missing from PATH; the board carries on regardless */ }
}
