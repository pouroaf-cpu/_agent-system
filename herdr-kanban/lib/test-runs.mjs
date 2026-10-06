// Test runs for the Audits page (operator, 2026-10-02): when each project's nightly e2e last ran,
// what failed, and a Run now button. The runner script writes TASKS/e2e/running.json while it
// runs and appends one JSON line per finished run to TASKS/e2e/runs.jsonl.
import { readFileSync, readdirSync, mkdirSync, writeFileSync, appendFileSync, openSync, closeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join, relative } from 'node:path'

// ponytail: one runner per project, hard-coded; move to board.config.json when a second project gets one.
export const TEST_RUNNERS = { Injectbuddy: 'scripts/e2e-nightly.mjs' }
export const TEST_INTEGRATION = 'C:/Users/PFrew/KanbanProjects/.worktrees/Injectbuddy/integration'
export const TEST_TYPES = {
  'console-errors': 'no console errors, uncaught page errors or failed responses on each page; collect console messages of type error, pageerror events, and every response with status >= 400 as "<status> <url>", show them all on failure',
  'phone-layout': 'at a 390x844 viewport, no horizontal scroll (document.scrollingElement.scrollWidth <= innerWidth) and no element wider than the viewport',
  'broken-links': 'every same-origin <a href> on each page returns status < 400; resolve hrefs against the page URL, dedupe hrefs, and use page.request.get',
  axe: 'no serious or critical axe violations, using @axe-core/playwright',
}

export function listRequests(tasksDir) {
  const dir = join(tasksDir, 'test-lab', 'requests')
  let files
  try { files = readdirSync(dir) } catch (err) { if (err.code === 'ENOENT') return []; throw err }
  return files.filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    // Its process died (crash, reboot): report it failed so nothing waits on it.
    .map(r => ['writing', 'running'].includes(r.state) && r.pid && !alive(r.pid) ? { ...r, state: 'failed', error: r.error || 'the run stopped before finishing' } : r)
    .sort((a, b) => b.created.localeCompare(a.created))
}

export function addRequest(tasksDir, { type, pages, at }, appDir = join(TEST_INTEGRATION, 'app')) {
  if (!Object.hasOwn(TEST_TYPES, type)) throw new Error('Unknown e2e audit type')
  if (!Array.isArray(pages) || !pages.length) throw new Error('Select at least one page')
  const routes = staticAppRoutes(appDir)
  if (pages.some(p => !routes.includes(p))) throw new Error('Unknown page')
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw new Error('Invalid date/time')
  const request = { id: randomUUID(), type, pages: [...new Set(pages)], at: new Date(at).toISOString(), state: 'scheduled', created: new Date().toISOString() }
  const dir = join(tasksDir, 'test-lab', 'requests')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, request.id + '.json'), JSON.stringify(request))
  return request
}

export function dueRequest(tasksDir, now = Date.now()) {
  return listRequests(tasksDir).filter(r => r.state === 'scheduled' && Date.parse(r.at) <= new Date(now).getTime())
    .sort((a, b) => a.at.localeCompare(b.at) || a.created.localeCompare(b.created))[0] ?? null
}

export const busyRequest = tasksDir => listRequests(tasksDir).find(r => ['writing', 'running'].includes(r.state)) ?? null

const alive = pid => { try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' } }

export function readTestRuns(tasksDir, { limit = 20 } = {}) {
  const dir = join(tasksDir, 'e2e')
  let running = null
  try { running = JSON.parse(readFileSync(join(dir, 'running.json'), 'utf8')) } catch {}
  if (running && !alive(running.pid)) running = null // killed or rebooted mid-run
  let runs = []
  try {
    runs = readFileSync(join(dir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean)
      .flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  } catch {}
  return { running, runs: runs.slice(-limit).reverse() }
}

export function startTestRun({ project, tasksDir, boardDir }) {
  const script = TEST_RUNNERS[project]
  if (!script) throw new Error(`${project} has no test runner`)
  if (readTestRuns(tasksDir).running || busyRequest(tasksDir)) throw new Error('A test run is already going')
  // 2026-10-03: a misplaced shebang killed the detached runner without a run record.
  const started = new Date().toISOString(), dir = join(tasksDir, 'e2e')
  mkdirSync(dir, { recursive: true })
  const log = join(dir, `${started.replace(/[:.]/g, '-')}-runner.log`), fd = openSync(log, 'a')
  let child
  try { child = spawn(process.execPath, [join(boardDir, script)], { cwd: boardDir, detached: true, stdio: ['ignore', 'ignore', fd], windowsHide: true }) }
  finally { closeSync(fd) }
  let recorded = false
  const failed = error => {
    if (recorded) return
    recorded = true
    const { running, runs } = readTestRuns(tasksDir, { limit: Infinity })
    if (running?.pid === child.pid || runs.some(r => r.started >= started)) return
    const detail = readFileSync(log, 'utf8').trim().slice(-4000)
    appendFileSync(join(dir, 'runs.jsonl'), JSON.stringify({ started, finished: new Date().toISOString(), type: 'nightly', pages: {}, error: detail || error, log, repeatEach: 3, seconds: 0, secondsPerPass: 0 }) + '\n')
  }
  child.on('error', err => failed(err.message))
  child.on('exit', (code, signal) => { if (code !== 0) failed(`Runner exited ${signal || code} before recording a run; see ${log}`) })
  child.unref()
  return { pid: child.pid }
}

// Failed test names, "file › title [project]", from Playwright's JSON report.
// 2026-10-06: dotenv prints '◇ injected env' banner lines to stdout before Playwright's JSON.
export function parseReport(stdout) {
  const start = stdout.search(/^\{/m)
  return JSON.parse(start < 0 ? stdout : stdout.slice(start))
}

export function failedTests(report) {
  const out = []
  const walk = suite => {
    for (const spec of suite.specs || []) for (const t of spec.tests || []) if (t.status === 'unexpected') out.push(`${spec.file} › ${spec.title}${t.projectName ? ` [${t.projectName}]` : ''}`)
    for (const child of suite.suites || []) walk(child)
  }
  for (const suite of report.suites || []) walk(suite)
  return out
}

// Match whole routes, so / does not match /calendar and /about does not match /about-us.
const routePatterns = routes => routes.map(route => [route, new RegExp(`(?<![\\w/.-])${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w/.-])`)])

export function pageResults(report, routes) {
  const pages = {}
  const patterns = routePatterns(routes)
  const walk = suite => {
    for (const spec of suite.specs || []) {
      if (!spec.tests?.length) continue
      for (const [route, pattern] of patterns) if (pattern.test(spec.title)) {
        pages[route] = pages[route] === 'fail' || spec.tests.some(t => t.status === 'unexpected') ? 'fail' : 'pass'
      }
    }
    for (const child of suite.suites || []) walk(child)
  }
  for (const suite of report.suites || []) walk(suite)
  return pages
}

// Count each Playwright repetition once, excluding skipped tests and retry attempts.
export function mergeTestTally(tally, report, routes, lastRun) {
  const out = structuredClone(tally)
  for (const key of ['specs', 'routes', 'tests']) out[key] ||= {}
  const patterns = routePatterns(routes)
  const add = (items, key, failed, dated = true) => {
    const old = items[key] || { executed: 0, failed: 0 }
    items[key] = { ...old, executed: old.executed + 1, failed: old.failed + Number(failed), ...(dated && { lastRun }) }
  }
  const walk = suite => {
    for (const spec of suite.specs || []) for (const t of spec.tests || []) {
      if (t.status === 'skipped' || (t.results && !t.results.some(r => r.status !== 'skipped'))) continue
      const failed = t.status === 'unexpected'
      add(out.specs, spec.file, failed)
      add(out.tests, spec.title, failed, false)
      for (const [route, pattern] of patterns) if (pattern.test(spec.title)) add(out.routes, route, failed)
    }
    for (const child of suite.suites || []) walk(child)
  }
  for (const suite of report.suites || []) walk(suite)
  return out
}

export function repeatFailures(failures, runs) {
  const previous = runs.find(r => r.type === 'nightly' && Array.isArray(r.failures))
  const names = new Set(previous?.failures || [])
  return [...new Set(failures)].filter(name => names.has(name))
}

export function pageRuns(runs, route) {
  return runs.filter(run => run.type && Object.hasOwn(run.pages || {}, route))
    .map(run => ({ ...run, status: run.pages[route] }))
    .sort((a, b) => b.finished.localeCompare(a.finished))
}

export function pageHistory(runs) {
  const pages = new Map()
  for (const run of [...runs].sort((a, b) => (b.finished || '').localeCompare(a.finished || ''))) {
    if (!run.type) continue
    for (const [route, status] of Object.entries(run.pages || {})) {
      if (!pages.has(route)) pages.set(route, new Map())
      const types = pages.get(route)
      if (!types.has(run.type)) types.set(run.type, { status, finished: run.finished, report: run.report })
    }
  }
  return [...pages].sort(([a], [b]) => a.localeCompare(b)).map(([route, types]) => ({ route, types: Object.fromEntries(types) }))
}

// Static Next app routes ("/", "/calendar", ...) from app/**/page.*, for warming the dev server:
// a page's first compile can outlast Playwright's goto (ERR_ABORTED on /calendar, 2026-10-02).
// Route groups "(x)" drop out of the URL; dynamic "[x]" and private "_x" folders are skipped.
export function staticAppRoutes(appDir) {
  return readdirSync(appDir, { recursive: true, withFileTypes: true })
    .filter(d => d.isFile() && /^page\.[jt]sx?$/.test(d.name))
    .map(d => relative(appDir, d.parentPath).split(/[\\/]/).filter(s => s && !/^\(.*\)$/.test(s)))
    .filter(parts => !parts.some(s => s.includes('[') || s.startsWith('_')))
    .map(parts => '/' + parts.join('/'))
    .sort()
}
