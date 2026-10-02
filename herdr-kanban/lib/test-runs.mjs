// Test runs for the Audits page (operator, 2026-10-02): when each project's nightly e2e last ran,
// what failed, and a Run now button. The runner script writes TASKS/e2e/running.json while it
// runs and appends one JSON line per finished run to TASKS/e2e/runs.jsonl.
import { readFileSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, relative } from 'node:path'

// ponytail: one runner per project, hard-coded; move to board.config.json when a second project gets one.
export const TEST_RUNNERS = { Injectbuddy: 'scripts/e2e-nightly.mjs' }

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
  if (readTestRuns(tasksDir).running) throw new Error('A test run is already going')
  const child = spawn(process.execPath, [join(boardDir, script)], { cwd: boardDir, detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  return { pid: child.pid }
}

// Failed test names, "file › title [project]", from Playwright's JSON report.
export function failedTests(report) {
  const out = []
  const walk = suite => {
    for (const spec of suite.specs || []) for (const t of spec.tests || []) if (t.status === 'unexpected') out.push(`${spec.file} › ${spec.title}${t.projectName ? ` [${t.projectName}]` : ''}`)
    for (const child of suite.suites || []) walk(child)
  }
  for (const suite of report.suites || []) walk(suite)
  return out
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
