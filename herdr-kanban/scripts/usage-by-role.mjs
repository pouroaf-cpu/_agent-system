// On-demand ccusage report; reads session heads and board snapshots, writes nothing.
import { createReadStream, existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { dirname, delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const exec = promisify(execFile)
const nz = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' })
export const nzDate = value => nz.format(new Date(value))
const pathKey = value => String(value || '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase()
const slug = value => pathKey(value).replace(/[^a-z0-9-]/g, '-')
const worktrees = 'c:/users/pfrew/kanbanprojects/.worktrees/'
const roleNames = { planner: 'Planner', builder: 'Builder', plancheck: 'Plan check', 'plan-check': 'Plan check', reviewer: 'Reviewer' }
const chatNames = { 'Injectbuddy work': 'Orchestrator: Injectbuddy', 'Tradeflow project': 'Orchestrator: Tradeflow' }
const amount = value => Number(value) || 0
const costOf = row => amount(row.costUSD ?? row.totalCostUSD ?? row.totalCost ?? row.cost)

export function normalizeSession(row, engine, head = '') {
  const lines = head.split(/\r?\n/).slice(0, engine === 'claude' ? 300 : 1)
  let cwd = row.cwd, start = row.firstActivity, id = row.sessionId
  for (const line of lines) {
    try {
      const data = JSON.parse(line)
      cwd ||= data.cwd ?? data.payload?.cwd
      start ||= data.payload?.timestamp ?? data.timestamp
      if (engine === 'codex' && data.type === 'session_meta') id = data.payload.id || id
    } catch { /* Partial transcript lines are harmless. */ }
  }
  if (engine === 'codex') id = String(id).match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)?.[0] || id
  const rawModels = row.modelBreakdowns ?? row.models ?? []
  const models = Array.isArray(rawModels) ? rawModels : typeof rawModels === 'object'
    ? Object.entries(rawModels).map(([modelName, value]) => typeof value === 'number' ? { modelName, cost: value } : { modelName, ...value }) : []
  const split = {}
  for (const model of models) {
    const name = typeof model === 'string' ? model : model.modelName ?? model.model ?? model.name ?? 'Unknown model'
    split[name] = (split[name] || 0) + (typeof model === 'string' ? 0 : costOf(model))
  }
  const cost = costOf(row)
  // Codex model rows carry tokens only: share the session cost by each model's tokens.
  if (cost && models.length && !Object.values(split).some(Boolean)) { const all = models.reduce((n, m) => n + amount(m.totalTokens), 0); if (all) for (const m of models) split[m.modelName ?? m.model ?? m.name] = cost * amount(m.totalTokens) / all }
  const remainder = cost - Object.values(split).reduce((a, b) => a + b, 0)
  if (remainder > 1e-8 || !Object.keys(split).length) split['Unknown model'] = (split['Unknown model'] || 0) + remainder
  return { ...row, engine, id, cwd: cwd || '', start, head: lines.join('\n'), cost, tokens: amount(row.totalTokens), models: split }
}

function cardCwd(session, agent) {
  const cwd = pathKey(session.cwd), project = pathKey(agent.project), card = pathKey(agent.cardId)
  const visible = agent.cwd || agent.worktreePath || agent.snapshot?.path
  if (visible && (cwd === pathKey(visible) || pathKey(session.projectPath) === slug(visible))) return true
  const prefix = `${worktrees}${project}/`
  const dirs = ['cards', 'reviews', 'review', 'review-workspaces', 'plan-check', 'plan-checks', 'planchecks', 'plancheck']
  if (cwd.startsWith(prefix)) return dirs.some(dir => cwd.startsWith(`${prefix}${dir}/${card}-`) || cwd === `${prefix}${dir}/${card}`)
  const projectPath = pathKey(session.projectPath)
  return dirs.some(dir => projectPath.startsWith(slug(`${prefix}${dir}/${card}-`)))
}

export function joinSessions(sessions, boards) {
  const agents = Object.entries(boards).flatMap(([project, board]) => Object.entries(board.cardUsage || {}).flatMap(([cardId, usage]) =>
    (usage.agents || []).map(agent => ({ ...agent, project, cardId, sessionId: agent.runId?.split(':')[3] }))))
  const exact = new Map()
  for (const agent of agents) if (agent.sessionId && agent.sessionId !== 'unknown-session' && !exact.has(agent.sessionId)) exact.set(agent.sessionId, agent)
  const matches = sessions.map(session => exact.get(session.id) || null)
  // Exact joins reserve their sessions before unknown-session runs try the nearest start.
  const candidates = []
  for (const agent of agents.filter(a => a.sessionId === 'unknown-session')) sessions.forEach((session, index) => {
    if (matches[index] || !cardCwd(session, agent)) return
    const distance = Math.abs(Date.parse(session.start) - Date.parse(agent.startedAt))
    if (distance <= 120000) candidates.push({ agent, index, distance })
  })
  const used = new Set()
  for (const { agent, index } of candidates.sort((a, b) => a.distance - b.distance)) {
    if (!matches[index] && !used.has(agent)) { matches[index] = agent; used.add(agent) }
  }
  return matches
}

export function classifySession(session, agent, stateMap = {}) {
  if (agent) return { role: roleNames[agent.role] || String(agent.role || 'Unknown').replace(/^./, c => c.toUpperCase()), project: agent.project }
  if (pathKey(session.cwd).startsWith(worktrees) || pathKey(session.projectPath).startsWith(slug(worktrees))) return { role: 'Board agent (unmatched)', project: null }
  if (session.engine === 'claude') {
    // load-state.mjs writes 'You are the "<name>" chat' (JSON-escaped in the transcript); CLAUDE.md names every chat, so a bare name match is wrong.
    const at = name => Math.min(...[`You are the "${name}" chat`, `You are the \\"${name}\\" chat`].map(m => session.head?.indexOf(m) ?? -1).map(i => i < 0 ? Infinity : i))
    const name = Object.values(stateMap).map(value => value.name).filter(Boolean).filter(name => at(name) < Infinity).sort((a, b) => at(a) - at(b))[0]
    if (name) return { role: chatNames[name] || name, project: null }
  }
  if (session.engine === 'codex' && /^c:\/users\/pfrew\/projects\/\.claude\/worktrees\/[^/]+(?:\/|$)/.test(pathKey(session.cwd))) return { role: 'KM fix agents', project: null }
  return { role: `Other ${session.engine === 'claude' ? 'Claude' : 'Codex'}`, project: null }
}

export function aggregateSessions(sessions) {
  const groups = new Map()
  for (const session of sessions) {
    const key = JSON.stringify([session.role, session.project])
    if (!groups.has(key)) groups.set(key, { role: session.role, project: session.project, sessions: 0, tokens: 0, costUSD: 0, models: {} })
    const group = groups.get(key)
    group.sessions++; group.tokens += session.tokens; group.costUSD += session.cost
    for (const [model, cost] of Object.entries(session.models)) group.models[model] = (group.models[model] || 0) + cost
  }
  const rows = [...groups.values()].sort((a, b) => b.costUSD - a.costUSD || a.role.localeCompare(b.role))
  const totals = { sessions: sessions.length, tokens: sessions.reduce((n, s) => n + s.tokens, 0), costUSD: sessions.reduce((n, s) => n + s.cost, 0) }
  for (const row of rows) row.percent = totals.costUSD ? row.costUSD / totals.costUSD * 100 : 0
  return { rows, totals }
}

export function buildReport(sessions, boards, stateMap, period, sourceTotals) {
  const matches = joinSessions(sessions, boards)
  const classified = sessions.map((session, i) => ({ ...session, ...classifySession(session, matches[i], stateMap) }))
  const report = { period, ...aggregateSessions(classified), days: {}, otherCwds: {}, check: {} }
  const days = [...new Set(classified.map(s => s.lastActivity ? nzDate(s.lastActivity) : 'Unknown date'))].sort()
  for (const day of days) report.days[day] = aggregateSessions(classified.filter(s => (s.lastActivity ? nzDate(s.lastActivity) : 'Unknown date') === day))
  for (const role of ['Other Claude', 'Other Codex']) {
    const cwds = new Map()
    for (const s of classified.filter(s => s.role === role)) {
      const cwd = s.cwd || s.projectPath || '(unknown cwd)'
      cwds.set(cwd, (cwds.get(cwd) || 0) + s.cost)
    }
    report.otherCwds[role] = [...cwds].map(([cwd, costUSD]) => ({ cwd, costUSD })).sort((a, b) => b.costUSD - a.costUSD).slice(0, 3)
  }
  const expected = { costUSD: sourceTotals.reduce((n, t) => n + costOf(t), 0), tokens: sourceTotals.reduce((n, t) => n + amount(t.totalTokens), 0) }
  const difference = (actual, reference) => reference ? Math.abs(actual - reference) / Math.abs(reference) : actual ? Infinity : 0
  report.check = { expected, matches: difference(report.totals.costUSD, expected.costUSD) <= .01 && difference(report.totals.tokens, expected.tokens) <= .01 }
  report.dayApproximation = 'Daily attribution uses each session’s lastActivity date in Pacific/Auckland; all session usage is assigned to that day.'
  return report
}

export function formatReport(report, byDay = false) {
  const money = n => n.toFixed(2)
  const table = data => {
    const lines = ['Role | Sessions | Tokens (M) | Cost USD | % of cost']
    for (const row of data.rows) lines.push(`${row.role}${row.project ? ` (${row.project})` : ''} | ${row.sessions} | ${(row.tokens / 1e6).toFixed(3)} | $${money(row.costUSD)} | ${row.percent.toFixed(1)}%`)
    for (const row of data.rows) {
      lines.push(`${row.role}${row.project ? ` (${row.project})` : ''}:`)
      for (const [model, cost] of Object.entries(row.models).sort((a, b) => b[1] - a[1])) lines.push(`  ${model}: $${money(cost)}`)
    }
    return lines
  }
  const lines = [`Period: ${report.period.since} to ${report.period.until || 'today'} (Pacific/Auckland)`]
  if (byDay) for (const [day, data] of Object.entries(report.days)) lines.push('', day, ...table(data))
  else lines.push('', ...table(report))
  lines.push('', `Grand total: ${report.totals.sessions} sessions | ${(report.totals.tokens / 1e6).toFixed(3)}M tokens | $${money(report.totals.costUSD)} USD`,
    `${report.check.matches ? 'Check: matches ccusage within 1%' : 'WARNING: differs from ccusage totals by more than 1%'} (ccusage: ${report.check.expected.tokens} tokens, $${money(report.check.expected.costUSD)} USD)`)
  for (const [role, cwds] of Object.entries(report.otherCwds)) if (cwds.length) lines.push(`${role}, top cwds by cost: ${cwds.map(c => `${c.cwd} ($${money(c.costUSD)})`).join('; ')}`)
  if (byDay) lines.push(report.dayApproximation)
  return lines.join('\n')
}

export function parseArgs(args, now = new Date()) {
  const today = nzDate(now), prior = new Date(`${today}T12:00:00Z`)
  prior.setUTCDate(prior.getUTCDate() - 7)
  const options = { since: prior.toISOString().slice(0, 10) }
  const values = ['since', 'until', 'claude-json', 'codex-json', 'boards-dir']
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '')
    if (args[i] === '--by-day' || args[i] === '--json') options[key] = true
    else if (args[i].startsWith('--') && values.includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i]
    else throw new Error(`Invalid argument: ${args[i]}`)
  }
  for (const key of ['since', 'until']) if (options[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(options[key]) || !Number.isFinite(Date.parse(options[key])) || new Date(options[key]).toISOString().slice(0, 10) !== options[key])) throw new Error(`Invalid --${key} date`)
  if (options.until && options.until < options.since) throw new Error('--until must be on or after --since')
  return options
}

async function readHead(file, count) {
  const stream = createReadStream(file), reader = createInterface({ input: stream, crlfDelay: Infinity }), lines = []
  try { for await (const line of reader) { lines.push(line); if (lines.length >= count) break } }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  finally { reader.close(); stream.destroy() }
  return lines.join('\n')
}

async function source(engine, options) {
  if (options[`${engine}-json`]) return JSON.parse(await readFile(options[`${engine}-json`], 'utf8'))
  const args = ['-y', 'ccusage@latest', engine, 'session', '--json', '--since', options.since.replaceAll('-', '')]
  if (options.until) args.push('--until', options.until.replaceAll('-', ''))
  // Windows runs npm's JS entry directly; execFile cannot execute npx.cmd.
  const command = process.platform === 'win32' ? process.execPath : 'npx'
  if (process.platform === 'win32') {
    const dirs = [dirname(process.execPath), join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm'), ...(process.env.PATH || '').split(delimiter)]
    const cli = dirs.map(dir => join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js')).find(existsSync)
    if (!cli) throw new Error('Cannot locate npm/bin/npx-cli.js; use --claude-json and --codex-json')
    args.unshift(cli)
  }
  const { stdout } = await exec(command, args, { maxBuffer: 64 << 20, timeout: 120000 })
  return JSON.parse(stdout)
}

async function readBoards(dir) {
  if (dir) return Object.fromEntries(await Promise.all((await readdir(dir)).filter(f => f.endsWith('.json')).map(async f => [f.slice(0, -5), JSON.parse(await readFile(join(dir, f), 'utf8'))])))
  const get = async path => {
    const response = await fetch(`http://127.0.0.1:7777${path}`, { signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error(`Board ${path}: HTTP ${response.status}`)
    return response.json()
  }
  const summary = await get('/api/summary')
  return Object.fromEntries(await Promise.all(summary.projects.map(async p => [p.project, await get(`/api/board?project=${encodeURIComponent(p.project)}`)])))
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args)
  const [claude, codex, boards, stateMap] = await Promise.all([
    source('claude', options), source('codex', options), readBoards(options['boards-dir']),
    readFile('C:/Users/PFrew/Projects/_roles/state-map.json', 'utf8').then(JSON.parse),
  ])
  const sessions = []
  for (const [engine, data] of [['claude', claude], ['codex', codex]]) {
    if (!Array.isArray(data.sessions)) throw new Error(`${engine}: missing sessions array`)
    for (const row of data.sessions) {
      const file = engine === 'claude'
        ? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', row.projectPath, `${row.sessionId}.jsonl`)
        : join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions', `${row.sessionId}.jsonl`) // sessionFile is a bare rollout name
      sessions.push(normalizeSession(row, engine, await readHead(file, engine === 'claude' ? 300 : 1)))
    }
  }
  const totals = [claude, codex].map(data => data.totals || { totalCost: data.sessions.reduce((n, s) => n + costOf(s), 0), totalTokens: data.sessions.reduce((n, s) => n + amount(s.totalTokens), 0) })
  const report = buildReport(sessions, boards, stateMap, { since: options.since, until: options.until || null }, totals)
  console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report, options['by-day']))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(`usage-by-role: ${error.message}`); process.exitCode = 1 })
