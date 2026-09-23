// Thin wrappers over the herdr CLI. Every call shells out to herdr.exe and parses
// its JSON envelope: {"id":"cli:agent:list","result":{...}}.

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { assertPromptAllowed } from './project-control.mjs'
import { assertPlannerPaneAllowed } from './planner-state.mjs'

const run = promisify(execFile)

const HERDR = process.env.HERDR_BIN_PATH || 'herdr'

// Board agents get their own workspace, so the operator's window is not buried
// under kb-* tabs. herdr prefixes every agent in its sidebar with the workspace
// label, which makes that label the only way to tell board work from yours.
const AGENT_WORKSPACE = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../board.config.json', import.meta.url), 'utf8')).agentWorkspace
  } catch { return null }
})() || 'agents'

// Each project runs in its own named herdr session (`herdr --session tradeflow`),
// with its own socket under AppData/Roaming/herdr/sessions/<name>. A CLI call with
// no --session hits the default session, which is how board agents for one project
// ended up spawning inside another project's window. Every call is session-scoped;
// omitting it stays the old default-session behaviour for callers that are global.
export const sessionOf = (project) => (project || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || null

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
      child = spawn(HERDR, sessionServerArgs(session), { detached: true, stdio: 'ignore', windowsHide: true })
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
  if (ensureSession) await ensureSessionReady(session)
  if (args[0] === 'agent' && ['start', 'prompt'].includes(args[1])) assertPlannerPaneAllowed(session, args[1] === 'start' ? args[args.indexOf('--pane') + 1] : args[2])
  if (args[0] === 'pane' && args[1] === 'send-keys') assertPlannerPaneAllowed(session, args[2])
  // Last boundary, after asynchronous readiness: Pause/cancel cannot leave a queued launch authorized.
  if (args[0] === 'agent' && ['start', 'prompt'].includes(args[1])) assertPromptAllowed(session, { paneId: args[1] === 'start' ? args[args.indexOf('--pane') + 1] : args[2], action: args[1] })
  if (args[0] === 'pane' && args[1] === 'send-keys') assertPromptAllowed(session, { paneId: args[2], action: 'enter' })
  const argv = session ? ['--session', session, ...args] : args
  const { stdout } = await run(HERDR, argv, { timeout, windowsHide: true })
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
export async function agentList(session, options = {}) {
  return parseAgentList(await herdr(['agent', 'list'], { ...options, session }))
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

// Which workspace this project's panes already live in. Now only the fallback for
// agentWorkspaceOr: `tab create` otherwise follows whatever is focused, so a board
// tab could land in an unrelated window.
export async function projectWorkspace(projectPath, session) {
  const result = await herdr(['pane', 'list'], { session })
  const panes = (result?.panes ?? []).filter((p) => sameDir(p.cwd, projectPath))
  if (!panes.length) return null

  // Most-populated workspace wins, so one stray pane elsewhere cannot drag new
  // agents away from where the rest of the work is.
  const counts = new Map()
  for (const p of panes) counts.set(p.workspace_id, (counts.get(p.workspace_id) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

// Labels are what the operator sees and types, so match them the way they read.
const sameLabel = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase()
export const findWorkspace = (workspaces, label) =>
  (workspaces ?? []).find((w) => sameLabel(w.label, label))?.workspace_id ?? null

export async function workspaceList(session) {
  return (await herdr(['workspace', 'list'], { session }))?.workspaces ?? []
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
  return { id: made?.workspace?.workspace_id ?? made?.workspace_id ?? null, created: true }
}

// Where board-spawned tabs go. Falls back to the project's own workspace so a
// herdr without `workspace create` degrades instead of failing the spawn.
export async function agentWorkspaceOr(projectPath, session) {
  try {
    const { id } = await agentWorkspace(AGENT_WORKSPACE, { session })
    if (id) return id
    throw new Error('workspace create returned no id')
  } catch (err) {
    console.warn(`agent workspace unavailable (${err.message}); falling back to the project's workspace`)
    return projectWorkspace(projectPath, session).catch(() => null)
  }
}

// herdr has no unclosable workspace, so the board keeps its own alive instead:
// called from the poll, it puts the workspace back if the operator closed it.
// The `workspace list` call is skipped whenever a live agent is already sitting
// in the one we last resolved — that is the common case, and the agent poll has
// already paid for the information.
// Keyed by session: every project's herdr session has its own agents workspace, and
// one id remembered globally would send another project's tabs to a stranger's window.
const knownWorkspace = new Map() // session -> workspace_id
const workspaceBackoffUntil = new Map() // session -> epoch ms

export async function ensureAgentWorkspace(agents = [], log, session) {
  const known = knownWorkspace.get(session ?? '')
  if (known && agents.some((a) => a.workspace_id === known)) return known
  // An older herdr with no `workspace create` would otherwise fail every 2s forever.
  if (Date.now() < (workspaceBackoffUntil.get(session ?? '') ?? 0)) return null
  try {
    const { id, created } = await agentWorkspace(AGENT_WORKSPACE, { session })
    if (created) log?.(`agent workspace recreated: ${id}`)
    knownWorkspace.set(session ?? '', id)
    return id
  } catch (err) {
    workspaceBackoffUntil.set(session ?? '', Date.now() + 60000)
    log?.(`agent workspace unavailable, retrying in 60s — ${err.message}`)
    return null
  }
}

export async function tabCreate({ cwd, label, focus = false, workspace, session }) {
  const args = ['tab', 'create', '--cwd', cwd]
  if (workspace) args.push('--workspace', workspace)
  if (label) args.push('--label', label)
  args.push(focus ? '--focus' : '--no-focus')
  return herdr(args, { timeout: 30000, session })
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
// for it. An UNBOUND agent (the reviewer, the issues sweeper — deliberately
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

const BOARD_MODELS = [
  [/^kb-review-/, ['gpt-5.6-luna', 'gpt-6-luna']],
  [/^kb-plan-/, 'gpt-5.6-luna'],
  [/^kb-planner-/, ['gpt-5.6-luna', 'gpt-6-sol', 'claude-opus-5-5']],
  [/^kb-t-/, ['gpt-5.6-luna', 'gpt-6-luna']],
]

export function approvedManagedModel(name) {
  return BOARD_MODELS.find(([rx]) => rx.test(name || ''))?.[1] ?? null
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

export function agentStartArgs({ name, paneId, model, engine, kind, workspacePath, guardArgs = [], timeoutMs = 90000 }) {
  const cfg = typeof engine === 'string' ? { kind: engine } : (engine || {})
  const agentKind = kind || cfg.kind || 'claude'
  const args = ['agent', 'start', name, '--kind', agentKind, '--pane', paneId, '--timeout', String(timeoutMs)]
  // Board agents run unattended, so a permission prompt is a pane that hangs
  // until its timeout with nobody there to answer it. Every spawn path (builder,
  // reviewer, issues sweeper) calls agentStart, so the flag belongs here rather
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
    // Intake belongs to the orchestrator; disable only its interview hook for workers.
    if (!/orchestrator/i.test(name || '')) {
      args.push('-c', String.raw`hooks.state.'C:\Users\PFrew\.codex\hooks.json:user_prompt_submit:0:0'.enabled=false`)
    }
    if (model) args.push('--model', model)
    if (Array.isArray(cfg.reasoningArgs)) args.push(...cfg.reasoningArgs.map(String))
    args.push(...guardArgs)
  } else {
    args.push('--dangerously-skip-permissions')
    if (model) args.push('--model', model)
  }
  return args
}

export async function agentStart({ name, paneId, model, engine, kind, workspacePath, guardArgs, timeoutMs = 90000, session }) {
  assertPromptAllowed(session)
  const args = agentStartArgs({ name, paneId, model, engine, kind, workspacePath, guardArgs, timeoutMs })
  try {
    return await hold(paneId, () => herdr(args, { timeout: timeoutMs + 15000, session }))
  } catch (err) {
    if (!/agent_not_ready/.test(err.message)) throw err
    const screen = String(await paneRead(paneId, session).catch(() => '')).slice(-4000)
    throw Object.assign(new Error(`${err.message}; startup pane retained (${session}/${paneId}). Resolve the displayed startup prompt before continuing.\n${screen}`), { preservePane: true })
  }
}

export async function agentPrompt(target, text, { wait = false, timeoutMs = 20000, session } = {}) {
  assertPromptAllowed(session)
  const args = ['agent', 'prompt', target, text]
  // --wait makes herdr confirm the agent actually changed state after submission.
  // Without it a prompt that lands in the input box but never submits looks
  // identical to success.
  if (wait) args.push('--wait', '--until', 'working', '--timeout', String(timeoutMs))
  // Still idle until the prompt is submitted, so the pane needs the same cover.
  return hold(target, () => herdr(args, { timeout: timeoutMs + 10000, session }))
}

// `agent start` requires the pane to already be at an interactive shell prompt.
// A fresh tab is not: PowerShell has a profile to load first, and starting the
// agent into a shell that is not ready hangs until the timeout expires.
export async function waitForPrompt(paneId, { timeoutMs = 20000, everyMs = 400, session } = {}) {
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
  const result = await herdr(['pane', 'read', paneId], { session })
  return result?.raw ?? result?.output ?? result ?? ''
}

export async function focusAgent(paneId, session) {
  const agent = (await agentList(session, { ensureSession: false })).find(a => a.pane_id === paneId)
  if (!agent?.tab_id) throw new Error('Existing agent session/tab is unavailable')
  await herdr(['tab', 'focus', agent.tab_id], { session, ensureSession: false })
  const child = spawn(HERDR, ['session', 'attach', session], { detached: true, stdio: 'ignore', windowsHide: false })
  child.on('error', () => {})
  child.unref()
  return agent
}

export async function paneSendKeys(paneId, keys, session) {
  assertPromptAllowed(session)
  return herdr(['pane', 'send-keys', paneId, ...keys], { session })
}

export async function paneClose(paneId, session) {
  return herdr(['pane', 'close', paneId], { session })
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
