#!/usr/bin/env node
import { formatNZTime } from '../lib/nz-time.mjs'
import { postInbox } from '../lib/inbox.mjs'
// Nightly Injectbuddy e2e run with no AI (operator, 2026-10-02): run every Playwright spec
// against kanban-integration HEAD in a throwaway worktree, save the JSON report, and on
// repeat failures add one line to the project chat's found inbox so it cards the fixes.
// Staged specs from TASKS/test-lab/specs run too (copied into e2e/test-lab; the repo is untouched).
// The board's Audits page reads TASKS/e2e/running.json and runs.jsonl (lib/test-runs.mjs).
// Usage: node scripts/e2e-nightly.mjs [--workers 4] [--repeat-each 3] [-- <playwright filters>]
// Smoke run: node scripts/e2e-nightly.mjs e2e/some.spec.ts [more specs]  (first argument is not a flag):
// those specs once, row printed to stdout, nothing written to runs.jsonl, the tally or the inbox.
// 2026-10-11: runs on `next build` + `next start`; next dev died ~16 min in and the staged specs need a build.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseReport, failedTests, serverAnswers, staticAppRoutes, pageResults, mergeTestTally, repeatFailures, readTestRuns, runSummary, TEST_TYPES } from '../lib/test-runs.mjs'

const INTEG = 'C:/Users/PFrew/KanbanProjects/.worktrees/Injectbuddy/integration'
const ENV = 'C:/Users/PFrew/Projects/Injectbuddy/.env.local'
const DEV_ENV = 'C:/Users/PFrew/Projects/Injectbuddy/.env.devtools.local' // dev test account for signed-in specs; never print it
const TASKS = 'C:/Users/PFrew/KanbanProjects/Injectbuddy/TASKS'
const OUT = join(TASKS, 'e2e')
const STAGED = join(TASKS, 'test-lab', 'specs')
const INBOX = 'C:/Users/PFrew/Projects/_roles/inbox/Injectbuddy-INBOX.md'
const PORT = 3201
const workers = process.argv.includes('--workers') ? process.argv[process.argv.indexOf('--workers') + 1] : '4'
const smoke = !!process.argv[2] && !process.argv[2].startsWith('-')
const repeatEach = process.argv.includes('--repeat-each') ? Number(process.argv[process.argv.indexOf('--repeat-each') + 1]) : smoke ? 1 : 3
if (!Number.isSafeInteger(repeatEach) || repeatEach < 1) throw new Error('--repeat-each must be a positive integer')
const filters = smoke ? process.argv.slice(2) : process.argv.includes('--') ? process.argv.slice(process.argv.indexOf('--') + 1) : []
const type = process.argv.includes('--type') ? process.argv[process.argv.indexOf('--type') + 1] : 'nightly'
if (type !== 'nightly' && !Object.hasOwn(TEST_TYPES, type)) throw new Error('Unknown e2e audit type')
const started = new Date().toISOString()
const stamp = started.replace(/[:.]/g, '-')
const dir = join(process.env.TEMP || '/tmp', `ib-e2e-${stamp}`)
const git = (...a) => spawnSync('git', ['-C', INTEG, ...a], { encoding: 'utf8', windowsHide: true })

mkdirSync(OUT, { recursive: true })
const head = git('rev-parse', '--short', 'HEAD').stdout.trim()
const running = join(OUT, 'running.json')
writeFileSync(running, JSON.stringify({ pid: process.pid, started, head }))
const record = entry => {
  const row = JSON.stringify({ started, finished: new Date().toISOString(), head, type, pages: {}, repeatEach, ...entry })
  if (smoke) console.log(row); else appendFileSync(join(OUT, 'runs.jsonl'), row + '\n')
}
let server
try {
  if (git('worktree', 'add', '--detach', dir, 'HEAD').status) throw new Error('worktree add failed')
  symlinkSync(join(INTEG, 'node_modules'), join(dir, 'node_modules'), 'junction')
  // 127.0.0.1, not localhost: the 05:37Z run's browser got ERR_CONNECTION_REFUSED on localhost.
  const base = `http://127.0.0.1:${PORT}`
  const serverLog = join(OUT, `${stamp}-server.log`)
  const logTail = () => { try { return readFileSync(serverLog, 'utf8').trim().split(/\r?\n/).slice(-5).join(' | ') } catch { return '(no server output)' } }
  const next = ['--env-file=' + ENV, 'node_modules/next/dist/bin/next']
  const built = spawnSync(process.execPath, [...next, 'build'], { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60000, windowsHide: true })
  appendFileSync(serverLog, `${built.stdout}\n${built.stderr}\n`)
  if (built.status !== 0) throw new Error(`next build failed (${built.error?.message || 'exit ' + built.status}): ${logTail()}`)
  // Staged specs go in after the build: next build type-checks every .ts file, and a type error in an
  // unreviewed staged spec stopped the whole run (2026-10-11 smoke run, test-lab/_core.ts).
  if (existsSync(STAGED)) cpSync(STAGED, join(dir, 'e2e', 'test-lab'), { recursive: true })
  // ponytail: one server for the whole run, no per-file restart. If the production server also dies
  // mid-run, upgrade to one Playwright call per spec file with a health check + restart between files.
  server = spawn(process.execPath, [...next, 'start', '-H', '127.0.0.1', '-p', String(PORT)], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  for (const stream of [server.stdout, server.stderr]) stream.on('data', d => appendFileSync(serverLog, d))
  let up = false
  for (let i = 0; i < 60 && !up && server.exitCode === null; i++) { // wait up to a minute
    up = await serverAnswers(base + '/', 3000)
    if (!up) await new Promise(r => setTimeout(r, 1000))
  }
  if (!up) throw new Error(`server did not start: ${logTail()}`)
  const routes = staticAppRoutes(join(dir, 'app'))
  const report = join(OUT, `${stamp}.json`)
  // --env-file gives Playwright the dev test account for signed-in specs (node keeps variables already set).
  const run = spawnSync(process.execPath, [...(existsSync(DEV_ENV) ? ['--env-file=' + DEV_ENV] : []), 'node_modules/@playwright/test/cli.js', 'test', '--reporter=json', `--workers=${workers}`, `--repeat-each=${repeatEach}`, ...filters],
    { cwd: dir, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, E2E_BASE_URL: base }, windowsHide: true })
  writeFileSync(report, run.stdout)
  if (run.stderr) writeFileSync(join(OUT, `${stamp}-playwright.log`), run.stderr)
  let parsed
  try { parsed = parseReport(run.stdout) } catch { throw new Error(`Playwright gave no report (${run.error?.message || 'exit ' + run.status}); see ${stamp}-playwright.log`) }
  const { stats } = parsed
  // A harness fault, not product failures: record the totals with the error, but keep its connection errors out of the tally, failures and inbox.
  const serverError = server.exitCode !== null ? 'server died during the run' : !await serverAnswers(base) ? 'server stopped answering during the run' : ''
  const failures = failedTests(parsed)
  const repeated = !serverError && !smoke && type === 'nightly' ? repeatFailures(failures, readTestRuns(TASKS, { limit: Infinity }).runs) : []
  if (!serverError && !smoke) {
    const tallyFile = join(TASKS, 'test-lab', 'tally.json')
    let tally = {}
    try { tally = JSON.parse(readFileSync(tallyFile, 'utf8')) } catch (err) { if (err.code !== 'ENOENT') throw err }
    mkdirSync(join(TASKS, 'test-lab'), { recursive: true })
    const temp = `${tallyFile}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(mergeTestTally(tally, parsed, routes, new Date().toISOString())))
    renameSync(temp, tallyFile)
  }
  record({ ...(filters.length && { filters }), ...(parsed.errors?.length && { errors: parsed.errors.map(e => (e.message || '').slice(0, 500)) }), ...(!serverError && { pages: pageResults(parsed, routes), failures: [...new Set(failures)] }), ...runSummary(stats, repeatEach, serverError && `${serverError}: ${logTail()}`), report })
  const line = `${formatNZTime()} e2e ${head}: ${stats.expected} passed, ${stats.unexpected} failed, ${stats.flaky} flaky, ${Math.round(stats.duration / 1000)}s. Report: ${report}`
  console.log(line)
  // 2026-10-05: first-night failures stay in the report/tally; only repeats reach chat.
  if (repeated.length) postInbox(INBOX, `- FOUND Injectbuddy nightly ${line} Repeat failures: ${repeated.slice(0, 20).map(title => title.replace(/[\r\n]+/g, ' ')).join('; ')}\n`)
  if (serverError) console.error(`${serverError}; totals are not reliable`)
  if (run.status !== 0 || serverError) {
    console.error(parsed.errors?.map(e => e.message).join('\n') || `${stats.unexpected} Playwright tests failed; report: ${report}`)
    process.exitCode = 1
  }
} catch (err) {
  record({ error: err.message })
  console.error(err.message)
  process.exitCode = 1
} finally {
  if (server) spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f'], { windowsHide: true })
  spawnSync('cmd', ['/c', 'rmdir', join(dir, 'node_modules')], { windowsHide: true }) // unlink the junction only, never delete through it
  git('worktree', 'remove', '--force', dir)
  rmSync(running, { force: true })
}
