#!/usr/bin/env node
// Nightly Injectbuddy e2e run with no AI (operator, 2026-10-02): run every Playwright spec
// against kanban-integration HEAD in a throwaway worktree, save the JSON report, and on
// failures add one line to the project chat's found inbox so it cards the fixes.
// Staged specs from TASKS/test-lab/specs run too (copied into e2e/test-lab; the repo is untouched).
// The board's Audits page reads TASKS/e2e/running.json and runs.jsonl (lib/test-runs.mjs).
// Usage: node scripts/e2e-nightly.mjs [--workers 4]
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { failedTests } from '../lib/test-runs.mjs'

const INTEG = 'C:/Users/PFrew/KanbanProjects/.worktrees/Injectbuddy/integration'
const ENV = 'C:/Users/PFrew/Projects/Injectbuddy/.env.local'
const TASKS = 'C:/Users/PFrew/KanbanProjects/Injectbuddy/TASKS'
const OUT = join(TASKS, 'e2e')
const STAGED = join(TASKS, 'test-lab', 'specs')
const INBOX = 'C:/Users/PFrew/Projects/_roles/inbox/Injectbuddy-INBOX.md'
const PORT = 3201
const workers = process.argv.includes('--workers') ? process.argv[process.argv.indexOf('--workers') + 1] : '4'
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
  server = spawn(process.execPath, [`--env-file=${ENV}`, 'node_modules/next/dist/bin/next', 'dev', '-p', String(PORT)], { cwd: dir, stdio: 'ignore' })
  for (let i = 0; i < 60; i++) { // wait up to 3 min for the first page
    try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break } catch {}
    await new Promise(r => setTimeout(r, 3000))
  }
  const report = join(OUT, `${stamp}.json`)
  const run = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--reporter=json', `--workers=${workers}`],
    { cwd: dir, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, E2E_BASE_URL: `http://localhost:${PORT}` } })
  writeFileSync(report, run.stdout)
  let parsed
  try { parsed = JSON.parse(run.stdout) } catch { throw new Error(`Playwright gave no report: ${(run.stderr || '').trim().split('\n').slice(-3).join(' ')}`) }
  const { stats } = parsed
  const failures = failedTests(parsed)
  record({ passed: stats.expected, failed: stats.unexpected, flaky: stats.flaky, skipped: stats.skipped, seconds: Math.round(stats.duration / 1000), report, failures: failures.slice(0, 50) })
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
