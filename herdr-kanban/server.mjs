// Local kanban board over the filesystem. Phase 1+2: read, serve, move.

import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, watch } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCardPlanner, readCardPlanners } from './lib/card-planner.mjs'
import { readManagerTasks } from './lib/manager-tasks.mjs'
import { isHardHold, notifyManagerException } from './lib/manager-alerts.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC = join(HERE, 'public')
const CONFIG_PATH = process.env.KANBAN_CONFIG ?? join(HERE, 'board.config.json')
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
const lanHost = process.env.KANBAN_LAN_HOST
const REQUESTS_PATH = process.env.KANBAN_REQUESTS ?? join(config.projectsRoot, 'ORCHESTRATOR-REQUESTS.md')

const { COLUMNS, ARCHIVE, createCard, readBoard, moveCard, setAutoReview, setPriority, findCard } = await import('./lib/cards.mjs')
const { agentList, agentsForProject, isRunning, paneRead, openProjects, ensureAgentWorkspace, herdrLog, sessionOf } = await import('./lib/herdr.mjs')
const { readBindings, bind, reap } = await import('./lib/bindings.mjs')
const { stopCard } = await import('./lib/spawn.mjs')
const { autoSpawn, autoReview, promoteAutoReview, promotePlanned, routeReviewVerdicts, spawnReviewer, spawnIssuesSweeper, slotsFree, closeFinished, holdsFor, reviewerBusy } = await import('./lib/autospawn.mjs')
const { computeReviewPlan } = await import('./lib/review-plan.mjs')
const { readRetries } = await import('./lib/retries.mjs')
const { recordSpawn, breakerState, resetBreaker } = await import('./lib/breaker.mjs')
const { cardUsageSummary, mergeUsageSummaries, reconcileUsage, recordUsageFinish, usageSummary, readUsage, recordUsageStart } = await import('./lib/request-usage.mjs')

const projectPathOf = (project) => join(config.projectsRoot, project)
const tasksDirOf = (project) => join(config.projectsRoot, project, 'TASKS')
const engineFor = (role) => config.engines?.[role] ?? config.engine ?? { kind: 'claude' }
const missionAllowsProject = (project) => !config.mission?.project || config.mission.project.toLowerCase() === project.toLowerCase()

function ensureTasks(project) {
  const dir = tasksDirOf(project)
  for (const c of [...COLUMNS, ARCHIVE]) mkdirSync(join(dir, c.dir), { recursive: true })
  return dir
}

// Last known agent state per project, refreshed by each SSE client's poll.
const agentCache = new Map() // project -> { agents, herdrUp }
let herdrFailed = false

// The configured limit, saved off when the breaker forces it to 0, so a reset
// can put it back rather than guessing what it used to be.
let savedMaxConcurrentAgents = null

function tripBreakerIfNeeded() {
  const state = breakerState()
  if (state.breakerTripped && savedMaxConcurrentAgents === null) {
    savedMaxConcurrentAgents = config.maxConcurrentAgents
    config.maxConcurrentAgents = 0 // in memory only — never written to disk
    console.log(`circuit breaker tripped: ${state.reason} — auto-spawn halted, reset from Settings`)
    herdrLog(`circuit breaker tripped: ${state.reason}`, 'error')
  }
}

async function pollAgents(project) {
  try {
    const allAgents = await agentList(sessionOf(project), { ensureSession: config.maxConcurrentAgents > 0 && missionAllowsProject(project) })
    reconcileUsage(tasksDirOf(project), allAgents)
    const normPath = p => String(p || '').replaceAll('\\', '/').toLowerCase().replace(/\/$/, '')
    const agents = allAgents.filter(a => normPath(a.cwd) === normPath(projectPathOf(project)))
    if (herdrFailed) { console.log('herdr: back up'); herdrFailed = false }
    const state = { agents, herdrUp: true }
    agentCache.set(project, state)
    return state
  } catch (err) {
    if (!herdrFailed) { console.log('herdr: unavailable —', err.message); herdrFailed = true }
    if (missionAllowsProject(project)) {
      await notifyManagerException({
        boardRoot: HERE,
        key: `herdr:${project}`,
        title: `${project} HERDR unavailable`,
        detail: err.message,
      })
    }
    const state = { agents: [], herdrUp: false }
    agentCache.set(project, state)
    return state
  }
}

function boardPayload(project) {
  const cached = agentCache.get(project) ?? { agents: [], herdrUp: false }
  const breaker = breakerState()
  return {
    project,
    projectPath: projectPathOf(project),
    columns: COLUMNS,
    archive: ARCHIVE,
    board: readBoard(tasksDirOf(project)),
    cardUsage: cardUsageSummary(tasksDirOf(project)),
    planners: readCardPlanners(tasksDirOf(project)),
    bindings: readBindings(tasksDirOf(project)),
    retries: readRetries(tasksDirOf(project)),
    // Why a queued card did not start on the last tick — an unmet Blocked-by, or
    // files another card is still holding. Without it a held card is visually
    // identical to one simply waiting its turn.
    holds: holdsFor(project),
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
      mission: config.mission ?? null,
    },
  }
}

// --- the spawner -----------------------------------------------------------

// Runs on every agent poll. Does nothing unless a card is sitting in Queue and a
// slot is free; autoSpawn holds its own lock so a slow spawn cannot re-enter.
async function tick(project, agents) {
  // Auto-Manager mode: Planned is not a gate, it is a staging shelf — every card on
  // it belongs in the Queue (operator, 2026-08-17). No agent is needed to decide
  // that, so the move happens here rather than costing a sweep. Queue order still
  // holds the cards back: autoSpawn skips anything with an unmet "**Blocked by:**"
  // or a dirty preflight, and only one card runs at a time.
  const tasksDir = tasksDirOf(project)
  const max = config.maxConcurrentAgents
  if (max <= 0) return []
  if (config.mode === 'manager' || config.autoQueuePlanned === true) {
    for (const id of promotePlanned(tasksDir, { mission: config.mission, project })) console.log(`queued: ${id}`)
  }
  // The cap is builders only. Slots are counted from card bindings, so the
  // operator's own panes — kanban manager, planner, reviewer, sweeper — are not
  // builders and never eat one (operator, 2026-08-18: keep 4 builders running).
  const started = await autoSpawn({
    project,
    projectPath: projectPathOf(project),
    tasksDir,
    boardRoot: HERE,
      model: config.models.working,
      trivialModel: config.models.trivial ?? config.models.working,
      engine: engineFor('working'),
      trivialEngine: engineFor('trivial'),
    max,
    agents,
    onChange: () => broadcastBoard(project),
    log: (msg) => console.log(msg),
    mission: config.mission,
  })
  if (started.length) {
    console.log(`spawned: ${started.join(', ')}`)
    for (const _id of started) recordSpawn()
    tripBreakerIfNeeded()
  }

  return started
}

// Runs on a fixed interval per project, independent of whether any browser is
// connected — a card must still get spawned when the board is opened headless.
async function pollProject(project) {
  const { agents, herdrUp } = await pollAgents(project)
  broadcast(project, 'agents', { project, agents, herdrUp })
  if (!herdrUp) return

  // Put the agents workspace back if it was closed, before anything spawns into it.
  await ensureAgentWorkspace(agents, (msg) => console.log(msg), sessionOf(project))

  // Only herdr knows a pane died; drop bindings it no longer lists.
  const beforeReap = readBindings(tasksDirOf(project))
  const reaped = reap(tasksDirOf(project), agents)
  for (const id of reaped) {
    try { await recordUsageFinish({ tasksDir: tasksDirOf(project), paneId: beforeReap[id]?.pane_id, binding: beforeReap[id], status: 'ambiguous' }) } catch {}
  }
  let dirty = reaped.length > 0
  const autoEnabled = config.maxConcurrentAgents > 0 && missionAllowsProject(project) && !breakerState().breakerTripped
  if (autoEnabled) {
    dirty = promoteAutoReview(tasksDirOf(project), { all: config.mode === 'manager' }).length > 0 || dirty
    dirty = routeReviewVerdicts(tasksDirOf(project), {
      log: (msg) => console.log(msg),
      reviewBusy: reviewerBusy(project, agents),
      includeCompleted: true,
    }).length > 0 || dirty
  }
  if (dirty) broadcastBoard(project)

  // Finished agents are observed every poll, but panes are only retired by the
  // hourly housekeeping gate so ordinary polling does not churn HERDR windows.
  const now = Date.now()
  await closeFinished({ tasksDir: tasksDirOf(project), agents, project, now, retire: cleanupDue(project, now) })

  if (autoEnabled) {
    if (config.leadPlanner?.autoIssues) {
      const planner = await runCardPlanner({
        project,
        projectPath: projectPathOf(project),
        tasksDir: tasksDirOf(project),
        boardRoot: HERE,
        model: config.models.planning ?? config.models.issues,
        engine: engineFor('planning'),
        mission: config.mission,
      }).catch((err) => {
        if (!err.busy && !/nothing in Issues/.test(err.message)) console.log(`lead planner skipped — ${err.message}`)
        return null
      })
      if (!planner && readBoard(tasksDirOf(project)).issues.some(c => !c.cardOwned)) {
        await spawnIssuesSweeper({ project, projectPath: projectPathOf(project), tasksDir: tasksDirOf(project), boardRoot: HERE, model: config.models.planning, engine: engineFor('planning'), mission: config.mission }).catch(err => {
          if (!err.busy && !/nothing in Issues/.test(err.message)) console.log(`legacy planner skipped — ${err.message}`)
        })
      }
      if (planner) {
        recordSpawn()
        tripBreakerIfNeeded()
        herdrLog(`Lead Planner started for ${planner.cards.length} card(s): ${planner.cards.join(', ')}`)
        broadcastBoard(project)
      }
    }

    const reviewer = await autoReview({
      project,
      projectPath: projectPathOf(project),
      tasksDir: tasksDirOf(project),
      boardRoot: HERE,
      model: config.models.review,
      engine: engineFor('review'),
      agents,
      log: (msg) => console.log(msg),
    })
    if (reviewer) {
      recordSpawn()
      tripBreakerIfNeeded()
      herdrLog(`review started for ${reviewer.cards.length} card(s): ${reviewer.cards.join(', ')}`)
      broadcastBoard(project)
    }
  }

  await tick(project, agents)
  const breaker = breakerState()
  if (breaker.breakerTripped) {
    await notifyManagerException({
      boardRoot: HERE,
      key: 'circuit-breaker',
      title: 'Kanban circuit breaker tripped',
      detail: breaker.reason || 'auto-spawn halted',
    })
  }
  for (const [id, reason] of Object.entries(holdsFor(project))) {
    if (!isHardHold(reason)) continue
    await notifyManagerException({
      boardRoot: HERE,
      key: `hold:${project}:${id}`,
      title: `${project} ${id} held`,
      detail: reason,
    })
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
    await pollAgents(project)
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
      const { project: p, title, brief, category = 'code', workspace = '.', audit = '', tools = '' } = JSON.parse(body)
      if (!config.projects.includes(p)) throw new Error('Unknown project')
      const mission = !audit && missionAllowsProject(p) ? config.mission?.id || '' : ''
      const card = createCard(tasksDirOf(p), { title, brief, category, workspace, audit, tools, mission })
      broadcastBoard(p)
      return json(res, 201, { ok: true, card })
    } catch (err) { return json(res, 400, { ok: false, error: err.message }) }
  }

  if (req.method === 'POST' && url.pathname === '/api/move') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const { project: p = config.projects[0], id, to } = JSON.parse(body)
      const card = moveCard(tasksDirOf(p), id, to)
      herdrLog(`${card.id} → ${to} (board)`)
      json(res, 200, { ok: true, card })
      broadcastBoard(p)
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
      if (breakerState().breakerTripped) throw new Error('circuit breaker tripped — auto-spawn halted, reset from Settings')
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
        reap(tasksDir, agents) // the pane died; clear the stale binding and carry on
      }

      const polled = await pollAgents(p)
      if (!polled.herdrUp) throw new Error('herdr agent state unknown; refusing explicit spawn')
      const [startedId] = await autoSpawn({
        project: p,
        projectPath: projectPathOf(p),
        tasksDir,
        boardRoot: HERE,
        model: config.models.working,
        trivialModel: config.models.trivial ?? config.models.working,
        engine: engineFor('working'),
        trivialEngine: engineFor('trivial'),
        max: config.maxConcurrentAgents,
        agents: polled.agents,
        onChange: () => broadcastBoard(p),
        log: (msg) => console.log(msg),
        mission: config.mission,
        onlyIds: [card.id],
      })
      if (!startedId) throw new Error(holdsFor(p)[card.id] || `${card.id} did not start`)
      herdrLog(`${startedId} spawned by hand`)
      json(res, 200, { ok: true, started: startedId })
    } catch (err) {
      json(res, 400, { ok: false, error: err.message })
    }
    broadcastBoard(p)
    return
  }

  // Settings are applied to the running server and written back to disk, so a
  // change takes effect on the next poll rather than at the next restart.
  if (req.method === 'POST' && url.pathname === '/api/config') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const patch = JSON.parse(body || '{}')
      if ('maxConcurrentAgents' in patch) {
        const n = Number(patch.maxConcurrentAgents)
        if (!Number.isInteger(n) || n < 0 || n > 10) {
          throw new Error('maxConcurrentAgents must be a whole number from 0 to 10')
        }
        config.maxConcurrentAgents = n
        savedMaxConcurrentAgents = null // An explicit operator setting supersedes pre-breaker capacity.
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
    if (savedMaxConcurrentAgents !== null) {
      config.maxConcurrentAgents = savedMaxConcurrentAgents
      savedMaxConcurrentAgents = null
    }
    json(res, 200, { ok: true, config: { maxConcurrentAgents: config.maxConcurrentAgents } })
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
    const { project: p = config.projects[0], id } = JSON.parse(body || '{}')
    try {
      const card = findCard(tasksDirOf(p), id)
      // shell:true is required because `code` is a .cmd shim, and it concatenates
      // rather than escapes — so quote the path ourselves. Windows forbids `"` in
      // filenames, which makes the quotes airtight rather than merely hopeful.
      spawn(config.editor ?? 'code', [`"${card.path}"`], {
        shell: true, detached: true, stdio: 'ignore',
      }).unref()
      return json(res, 200, { ok: true, path: card.path })
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

  if (req.method === 'POST' && url.pathname === '/api/review') {
    let body = ''
    for await (const chunk of req) body += chunk
    const { project: p = config.projects[0], cardIds } = JSON.parse(body || '{}')
    try {
      if (breakerState().breakerTripped) throw new Error('circuit breaker tripped — auto-spawn halted, reset from Settings')
      const result = await spawnReviewer({
        project: p,
        projectPath: projectPathOf(p),
        tasksDir: tasksDirOf(p),
        boardRoot: HERE,
        model: config.models.review,
        engine: engineFor('review'),
        cardIds,
      })
      recordSpawn()
      tripBreakerIfNeeded()
      herdrLog(`review started for ${result.cards.length} card(s): ${result.cards.join(', ')}`)
      json(res, 200, { ok: true, reviewer: result })
    } catch (err) {
      // 409: the tick or another click is already spawning one; not a failure.
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
      if (breakerState().breakerTripped) throw new Error('circuit breaker tripped — auto-spawn halted, reset from Settings')
      const result = await spawnIssuesSweeper({
        project: p,
        projectPath: projectPathOf(p),
        tasksDir: tasksDirOf(p),
        boardRoot: HERE,
        model: config.models.planning ?? config.models.issues,
        engine: engineFor('planning'),
        mission: p === config.mission?.project ? config.mission : null,
      })
      recordSpawn()
      tripBreakerIfNeeded()
      herdrLog(`Lead Planner started for ${result.cards.length} card(s)`)
      json(res, 200, { ok: true, planner: result })
    } catch (err) {
      // 409: the tick or another click is already spawning one; not a failure.
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
const server = createServer(handleRequest)

async function startPollers() {
  if (pollersStarted) return
  pollersStarted = true
  console.log(`kanban: http://127.0.0.1:${port}`)
  console.log(`herdr: ${(await isRunning()) ? 'up' : 'down'}`)

  // Spawner must run whether or not a browser tab is open — a headless restart
  // still has to pick up queued cards.
  for (const project of config.projects) {
    setInterval(() => pollProject(project), config.agentPollMs)
  }
}

function startLan() {
  if (!lanHost) return
  const lanServer = createServer(handleRequest)
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
