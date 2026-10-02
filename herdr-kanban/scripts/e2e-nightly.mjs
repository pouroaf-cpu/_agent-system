#!/usr/bin/env node
// Nightly Injectbuddy e2e run with no AI (operator, 2026-10-02): run every Playwright spec
// against kanban-integration HEAD in a throwaway worktree, save the JSON report, and on
// failures add one line to the project chat's found inbox so it cards the fixes.
// Staged specs from TASKS/test-lab/specs run too (copied into e2e/test-lab; the repo is untouched).
// The board's Audits page reads TASKS/e2e/running.json and runs.jsonl (lib/test-runs.mjs).
// Usage: node scripts/e2e-nightly.mjs [--workers 4] [-- <playwright filters, e.g. e2e/test-lab>]
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { failedTests, staticAppRoutes } from '../lib/test-runs.mjs'

const INTEG = 'C:/Users/PFrew/KanbanProjects/.worktrees/Injectbuddy/integration'
const ENV = 'C:/Users/PFrew/Projects/Injectbuddy/.env.local'
const TASKS = 'C:/Users/PFrew/KanbanProjects/Injectbuddy/TASKS'
const OUT = join(TASKS, 'e2e')
const STAGED = join(TASKS, 'test-lab', 'specs')
const INBOX = 'C:/Users/PFrew/Projects/_roles/inbox/Injectbuddy-INBOX.md'
const PORT = 3201
const workers = process.argv.includes('--workers') ? process.argv[process.argv.indexOf('--workers') + 1] : '4'
const filters = process.argv.includes('--') ? process.argv.slice(process.argv.indexOf('--') + 1) : []
const started = new Date().toISOString()
const stamp = started.replace(/[:.]/g, '-')
const dir = join(process.env.TEMP || '/tmp', `ib-e2e-${stamp}`)
const git = (...a) => spawnSync('git', ['-C', INTEG, ...a], { encoding: 'utf8' })

mkdirSync(OUT, { recursive: true })
const head = git('rev-parse', '--short', 'HEAD').stdout.trim()
const running = join(OUT, 'running.json')
writeFileSync(running, JSON.stringify({ pid: process.pid, started, head }))
const record = entry => appendFileSync(join(OUT, 'runs.jsonl'), JSON.stringify({ started, finished: new Date().toISOString(), head, ...entry }) + '\n')
let server
try {
  if (git('worktree', 'add', '--detach', dir, 'HEAD').status) throw new Error('worktree add failed')
  symlinkSync(join(INTEG, 'node_modules'), join(dir, 'node_modules'), 'junction')
  if (existsSync(STAGED)) cpSync(STAGED, join(dir, 'e2e', 'test-lab'), { recursive: true })
  // 127.0.0.1, not localhost: the 05:37Z run's browser got ERR_CONNECTION_REFUSED on localhost.
  const base = `http://127.0.0.1:${PORT}`
  const serverLog = join(OUT, `${stamp}-server.log`)
  server = spawn(process.execPath, [`--env-file=${ENV}`, 'node_modules/next/dist/bin/next', 'dev', '-H', '127.0.0.1', '-p', String(PORT)], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [server.stdout, server.stderr]) stream.on('data', d => appendFileSync(serverLog, d))
  const logTail = () => { try { return readFileSync(serverLog, 'utf8').trim().split(/\r?\n/).slice(-5).join(' | ') } catch { return '(no server output)' } }
  let up = false
  for (let i = 0; i < 60 && !up && server.exitCode === null; i++) { // wait up to 3 min for the first page
    try { up = (await fetch(base + '/')).status < 500 } catch {}
    if (!up) await new Promise(r => setTimeout(r, 3000))
  }
  if (!up) throw new Error(`dev server did not start: ${logTail()}`)
  // Compile every page once, one at a time, so no spec's goto waits on a first compile.
  for (const route of staticAppRoutes(join(dir, 'app'))) {
    try { await fetch(base + route, { signal: AbortSignal.timeout(120000) }) } catch {}
  }
  const report = join(OUT, `${stamp}.json`)
  const run = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--reporter=json', `--workers=${workers}`, ...filters],
    { cwd: dir, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, E2E_BASE_URL: base } })
  writeFileSync(report, run.stdout)
  if (run.stderr) writeFileSync(join(OUT, `${stamp}-playwright.log`), run.stderr)
  // A harness fault, not product failures: don't send the manager a list of dead-server errors.
  if (server.exitCode !== null) throw new Error(`dev server died during the run: ${logTail()}`)
  let parsed
  try { parsed = JSON.parse(run.stdout) } catch { throw new Error(`Playwright gave no report (${run.error?.message || 'exit ' + run.status}); see ${stamp}-playwright.log`) }
  const { stats } = parsed
  const failures = failedTests(parsed)
  record({ ...(filters.length && { filters }), passed: stats.expected, failed: stats.unexpected, flaky: stats.flaky, skipped: stats.skipped, seconds: Math.round(stats.duration / 1000), report, failures: failures.slice(0, 50) })
  const line = `${new Date().toISOString()} e2e ${head}: ${stats.expected} passed, ${stats.unexpected} failed, ${stats.flaky} flaky, ${Math.round(stats.duration / 1000)}s. Report: ${report}`
  console.log(line)
  if (stats.unexpected) appendFileSync(INBOX, `- FOUND Injectbuddy nightly ${line}\n`)
} catch (err) {
  record({ error: err.message })
  console.error(err.message)
  process.exitCode = 1
} finally {
  if (server) spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f'])
  spawnSync('cmd', ['/c', 'rmdir', join(dir, 'node_modules')]) // unlink the junction only, never delete through it
  git('worktree', 'remove', '--force', dir)
  rmSync(running, { force: true })
}
