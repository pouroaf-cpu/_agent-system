#!/usr/bin/env node
// Nightly Injectbuddy e2e run with no AI (operator, 2026-10-02): run every Playwright spec
// against kanban-integration HEAD in a throwaway worktree, save the JSON report, and on
// failures add one line to the project chat's found inbox so it cards the fixes.
// Usage: node scripts/e2e-nightly.mjs [--workers 4]
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const INTEG = 'C:/Users/PFrew/KanbanProjects/.worktrees/Injectbuddy/integration'
const ENV = 'C:/Users/PFrew/Projects/Injectbuddy/.env.local'
const OUT = 'C:/Users/PFrew/KanbanProjects/Injectbuddy/TASKS/e2e'
const INBOX = 'C:/Users/PFrew/Projects/_roles/inbox/Injectbuddy-INBOX.md'
const PORT = 3201
const workers = process.argv.includes('--workers') ? process.argv[process.argv.indexOf('--workers') + 1] : '4'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const dir = join(process.env.TEMP || '/tmp', `ib-e2e-${stamp}`)
const git = (...a) => spawnSync('git', ['-C', INTEG, ...a], { encoding: 'utf8' })

mkdirSync(OUT, { recursive: true })
const head = git('rev-parse', '--short', 'HEAD').stdout.trim()
if (git('worktree', 'add', '--detach', dir, 'HEAD').status) throw new Error('worktree add failed')
symlinkSync(join(INTEG, 'node_modules'), join(dir, 'node_modules'), 'junction')
const server = spawn(process.execPath, [`--env-file=${ENV}`, 'node_modules/next/dist/bin/next', 'dev', '-p', String(PORT)], { cwd: dir, stdio: 'ignore' })
const report = join(OUT, `${stamp}.json`)
try {
  for (let i = 0; i < 60; i++) { // wait up to 3 min for the first page
    try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break } catch {}
    await new Promise(r => setTimeout(r, 3000))
  }
  const run = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--reporter=json', `--workers=${workers}`],
    { cwd: dir, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, env: { ...process.env, E2E_BASE_URL: `http://localhost:${PORT}` } })
  writeFileSync(report, run.stdout)
  const { stats } = JSON.parse(run.stdout)
  const line = `${new Date().toISOString()} e2e ${head}: ${stats.expected} passed, ${stats.unexpected} failed, ${stats.flaky} flaky, ${Math.round(stats.duration / 1000)}s. Report: ${report}`
  console.log(line)
  if (stats.unexpected) appendFileSync(INBOX, `- FOUND Injectbuddy nightly ${line}\n`)
} finally {
  spawnSync('taskkill', ['/pid', String(server.pid), '/t', '/f'])
  spawnSync('cmd', ['/c', 'rmdir', join(dir, 'node_modules')]) // unlink the junction only, never delete through it
  git('worktree', 'remove', '--force', dir)
}
