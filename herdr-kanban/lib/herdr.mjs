// Thin wrappers over the herdr CLI. Every call shells out to herdr.exe and parses
// its JSON envelope: {"id":"cli:agent:list","result":{...}}.

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { assertPromptAllowed } from './project-control.mjs'
import { assertPlannerPaneAllowed } from './planner-state.mjs'
import { isBoardAgent } from './ids.mjs'
import { PaneProcessTrees } from './process-tree.mjs'
import { headless, isHeadless } from './headless.mjs'
import { backendFor } from './agent-backend.mjs'
import { agentStartArgs, cleanEnv, writeCodexBoardProfile, writeCodexWorkspaceHooks } from './agent-launch.mjs'
import { sessionOf } from './project-key.mjs'
import { boardLog } from './board-log.mjs'

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
    void pollPaneTrees(session, agents).catch(err => boardLog(`process cleanup: ${err.message}`))
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
  try { const agents = [...await interactive(), ...local]; herdrInventoryDegraded = false; return agents } catch (err) {
    // With every card role headless, no card's agent lives in herdr, so an unreadable herdr
    // (down, hung, malformed) must not stop dispatch, planning, review, integration or release.
    if (cardRolesHeadless()) {
      if (!herdrInventoryDegraded) boardLog(`herdr agent inventory unavailable; card flow is headless, continuing without it: ${err.message}`)
      herdrInventoryDegraded = true
      return local
    }
    // Only an absent server is safe to treat as empty; malformed inventory fails closed.
    if ((local.length || ['planner', 'builder', 'reviewer', 'plancheck'].some(role => backendFor(role) === 'headless')) && /server_not_running|ENOENT|ECONNREFUSED/.test(err.message)) return local
    throw err
  }
}
let herdrInventoryDegraded = false
const cardRolesHeadless = () => ['planner', 'builder', 'reviewer', 'plancheck'].every(role => backendFor(role) === 'headless')

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
  if (created?.root_pane?.pane_id) await rememberPane(created.root_pane.pane_id, SHARED_SESSION).catch(err => boardLog(`process cleanup: ${err.message}`))
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
export async function agentStart({ name, paneId, model, engine, kind, workspacePath, worktreePath, guardArgs, timeoutMs = 90000, session, browser = true }) {
  if (isHeadless(paneId)) return headless.agentStart({ name, paneId, model, engine, kind, workspacePath, worktreePath, guardArgs, timeoutMs, session, browser })
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
  } catch (err) { boardLog(`process cleanup ${paneId}: ${err.message}`) }
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

