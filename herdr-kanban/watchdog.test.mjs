// watch-kanban.ps1 under Windows PowerShell 5.1, the scheduled task's host (audit
// 2026-09-26 findings 2 and 13). Each test copies the watchdog into a temp board with a
// local HTTP server as the board, and stubbed push, LAN address and restart, so nothing
// real is started, pushed or restarted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync as rmSyncOnce } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'

// Node 24's rmSync ignores maxRetries for EPERM, which Windows gives while a just-killed child
// (or a scanner) still holds the directory: retry here instead.
const rmSync = (path, options) => {
  for (let i = 1; ; i++) {
    try { return rmSyncOnce(path, options) } catch (err) {
      if (i >= 100 || err.code !== 'EPERM') throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
}

const HERE = import.meta.dirname

async function fixture(t, extraAlertFunctions = '') {
  const root = mkdtempSync(join(tmpdir(), 'watchdog-'))
  const server = createServer((req, res) => res.end('{}'))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  t.after(() => { server.close(); rmSync(root, { recursive: true, force: true }) })
  mkdirSync(join(root, 'lib'))
  copyFileSync(join(HERE, 'lib', 'nz-time.mjs'), join(root, 'lib', 'nz-time.mjs'))
  copyFileSync(join(HERE, 'watch-kanban.ps1'), join(root, 'watch-kanban.ps1'))
  writeFileSync(join(root, 'watchdog-alert.ps1'), readFileSync(join(HERE, 'watchdog-alert.ps1'), 'utf8') + `
function Send-Push { param([string]$Title, [string]$Message, [string]$Kind) Add-Content -LiteralPath (Join-Path $PSScriptRoot 'pushes.txt') $Title }
function Get-LanAddress { $env:TEST_LAN_ADDRESS }
function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) if ($env:TEST_NO_LISTENER) { return }; [pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 1 } }
function Get-InFlightCardCount { $f = Join-Path $PSScriptRoot 'inflight.txt'; if (Test-Path -LiteralPath $f) { [int](Get-Content -LiteralPath $f -Raw).Trim() } else { 0 } }
${extraAlertFunctions}`)
  writeFileSync(join(root, 'board.config.json'), JSON.stringify({ port: server.address().port }))
  // The board's pid as kanban.ps1 records it: this test process is a live node process.
  writeFileSync(join(root, '.server.pid'), String(process.pid))
  writeFileSync(join(root, 'kanban.ps1'), `Add-Content (Join-Path $PSScriptRoot 'kanban-calls.txt') 'kanban'`)
  writeFileSync(join(root, 'restart-kanban.ps1'), `param([switch]$Lan)\nAdd-Content (Join-Path $PSScriptRoot 'restarts.txt') "restart Lan=$Lan"`)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k)))
  env.Path = [dirname(process.execPath), join(process.env.SystemRoot, 'System32'), join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';')
  const run = (lanAddress = '', extraEnv = {}) => new Promise(done => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'watch-kanban.ps1')],
    { env: { ...env, TEST_LAN_ADDRESS: lanAddress, WATCHDOG_RETRY_SECONDS: '0', ...extraEnv }, timeout: 45000, windowsHide: true }, (err, stdout, stderr) => done({ code: err?.code ?? 0, out: stdout + stderr })))
  const read = name => existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : ''
  const lines = name => read(name).split(/\r?\n/).filter(Boolean)
  return { root, run, read, lines }
}

test('board timeout with a live listener and successful retry sends no alert', async t => {
  const { root, run, read, lines } = await fixture(t, `
$script:boardRequestCount = 0
function Invoke-WebRequest {
  param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
  $script:boardRequestCount++
  if ($script:boardRequestCount -eq 1) { throw 'fixture first request timed out' }
}
`)
  const result = await run()
  assert.equal(result.code, 0, result.out + read('watchdog.log'))
  assert.deepEqual(lines('pushes.txt'), [])
  assert.equal(existsSync(join(root, '.watchdog-outage')), false, 'a recovered blip does not leave outage state')
  assert.match(read('watchdog.log'), /DOWN - checking recovery/)
  assert.match(read('watchdog.log'), /SLOW - retry passed/)
  assert.match(read('watchdog.log'), /UP - board check passed/)
  assert.equal(read('kanban-calls.txt'), '', 'a healthy board is never relaunched')
})

test('phone listener: with .lan-on, a board not answering on the current LAN address is relaunched with -Lan once per outage', async t => {
  const { root, run, read, lines } = await fixture(t)
  await run('127.0.0.2')
  assert.deepEqual(lines('restarts.txt'), [], 'no .lan-on: no LAN probe or restart')
  writeFileSync(join(root, '.lan-on'), '')
  await run('127.0.0.2'); await run('127.0.0.2')
  assert.deepEqual(lines('restarts.txt'), ['restart Lan=True'], read('watchdog.log'))
  assert.match(read('watchdog.log'), /LAN - no answer on 127\.0\.0\.2/)
  await run('127.0.0.1')
  assert.equal(existsSync(join(root, '.watchdog-lan-outage')), false, 'answering on the LAN address ends the outage')
  assert.deepEqual(lines('restarts.txt'), ['restart Lan=True'])
})

test('phone listener: a moved address waits while cards are in flight, alerts once, then relaunches once idle', async t => {
  const { root, run, read, lines } = await fixture(t)
  writeFileSync(join(root, '.lan-on'), '')
  writeFileSync(join(root, 'inflight.txt'), '2')
  await run('127.0.0.2'); await run('127.0.0.2')
  assert.deepEqual(lines('restarts.txt'), [], 'a relaunch would kill the cards in flight')
  assert.deepEqual(lines('pushes.txt'), ['Kanban phone board unreachable'], 'one alert while it waits')
  assert.match(read('watchdog.log'), /2 card\(s\) in flight; waiting before relaunch/)
  writeFileSync(join(root, 'inflight.txt'), '0')
  await run('127.0.0.2')
  assert.deepEqual(lines('restarts.txt'), ['restart Lan=True'], read('watchdog.log'))
  assert.deepEqual(lines('pushes.txt'), ['Kanban phone board unreachable'], 'the relaunch sends no second alert')
  assert.equal(existsSync(join(root, '.watchdog-lan-wait')), false, 'the wait ends with the relaunch')
})

test('phone listener: an unreadable card state waits rather than relaunches', async t => {
  const { root, run, read, lines } = await fixture(t, `function Get-InFlightCardCount { throw 'fixture board unreadable' }`)
  writeFileSync(join(root, '.lan-on'), '')
  await run('127.0.0.2')
  assert.deepEqual(lines('restarts.txt'), [], read('watchdog.log'))
  assert.match(read('watchdog.log'), /cannot read card state/)
  assert.deepEqual(lines('pushes.txt'), ['Kanban phone board unreachable'])
})

test('in-flight count is the Working cards each project reports plus its integrating worktrees', async t => {
  const projectsRoot = mkdtempSync(join(tmpdir(), 'watchdog-projects-'))
  const base = mkdtempSync(join(tmpdir(), 'watchdog-inflight-'))
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ board: { working: req.url.includes('project=Alpha') ? [{ id: 'A-3' }] : [] } }))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  t.after(() => { server.close(); rmSync(projectsRoot, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }) })
  mkdirSync(join(projectsRoot, 'Alpha', 'TASKS'), { recursive: true })
  writeFileSync(join(projectsRoot, 'Alpha', 'TASKS', '.board-worktrees.json'), JSON.stringify({ 'A-1': { state: 'integrating' }, 'A-2': { state: 'integrated' } }))
  copyFileSync(join(HERE, 'watchdog-alert.ps1'), join(base, 'watchdog-alert.ps1'))
  writeFileSync(join(base, 'run.ps1'), `. (Join-Path $PSScriptRoot 'watchdog-alert.ps1')\n'count=' + (Get-InFlightCardCount -Port ${server.address().port} -ProjectsRoot '${projectsRoot.replace(/\\/g, '/')}' -Projects @('Alpha', 'Beta'))`)
  const out = await new Promise((done, fail) => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(base, 'run.ps1')],
    { timeout: 45000, windowsHide: true }, (err, stdout, stderr) => err ? fail(new Error(stdout + stderr)) : done(stdout)))
  assert.match(out, /count=2/, 'one Working card (A-3) plus one integrating worktree (A-1); Beta has neither')
})

test('the real Send-Push writes "- <KIND> <n> <time> <title>: <message>" to the inbox .md and .log (HK57 AC7)', t => {
  const base = mkdtempSync(join(tmpdir(), 'watchdog-push-')), kanban = join(base, 'herdr-kanban'), roles = join(base, '_roles')
  t.after(() => rmSync(base, { recursive: true, force: true }))
  mkdirSync(join(kanban, 'lib'), { recursive: true }); mkdirSync(roles)
  copyFileSync(join(HERE, 'lib', 'nz-time.mjs'), join(kanban, 'lib', 'nz-time.mjs'))
  copyFileSync(join(HERE, 'watchdog-alert.ps1'), join(kanban, 'watchdog-alert.ps1'))
  copyFileSync('C:/Users/PFrew/Projects/_roles/board-event-id.mjs', join(roles, 'board-event-id.mjs'))
  const counter = join(base, 'counter.json')
  writeFileSync(counter, '{"next":20000}\n')
  writeFileSync(join(kanban, 'run.ps1'), `. (Join-Path $PSScriptRoot 'watchdog-alert.ps1')\nSend-Push 'Kanban board down' 'it did not answer' 'BE'`)
  return new Promise((done, fail) => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(kanban, 'run.ps1')],
    { env: { ...process.env, BOARD_EVENT_COUNTER: counter }, timeout: 45000, windowsHide: true }, (err, stdout, stderr) => {
      try {
        assert.equal(err, null, stdout + stderr)
        for (const name of ['KANBAN_MANAGER-INBOX.md', 'KANBAN_MANAGER-INBOX.log']) {
          const lines = readFileSync(join(roles, name), 'utf8').split(/\r?\n/).filter(Boolean)
          assert.equal(lines.length, 1, name)
          assert.match(lines[0], /^- BE 20000 \S.* Kanban board down: it did not answer$/, name)
        }
        assert.equal(JSON.parse(readFileSync(counter, 'utf8')).next, 20001)
        done()
      } catch (e) { fail(e) }
    }))
})

// A board that answers nothing: every request times out, as under memory pressure.
const NEVER_ANSWERS = `
$script:boardRequestCount = 0
function Invoke-WebRequest {
  param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
  $script:boardRequestCount++
  throw 'fixture board timed out'
}
`

test('a board that never answers but whose process is alive is not relaunched, and alerts once', async t => {
  const { read, lines, run } = await fixture(t, NEVER_ANSWERS)
  const first = await run()
  const second = await run()
  assert.equal(first.code, 1, first.out + read('watchdog.log'))
  assert.equal(second.code, 1, second.out + read('watchdog.log'))
  assert.match(read('watchdog.log'), /FAILED - Board did not answer after retry/)
  assert.deepEqual(lines('pushes.txt'), ['Kanban board down'], 'one alert per outage')
  assert.equal(read('kanban-calls.txt'), '', 'a live board process is never relaunched')
})

test('no listener and a board process that has exited is relaunched through kanban.ps1 after the whole retry window fails', async t => {
  const { root, read, lines, run } = await fixture(t, `
$script:boardRequestCount = 0
function Invoke-WebRequest {
  param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
  $script:boardRequestCount++
  if ($script:boardRequestCount -le 5) { throw 'fixture board is gone' }
}
`)
  // A pid that has just exited: no node process answers to it.
  const deadPid = await new Promise(done => { const child = execFile(process.execPath, ['-e', '0'], () => done(child.pid)) })
  writeFileSync(join(root, '.server.pid'), String(deadPid))
  const result = await run('', { TEST_NO_LISTENER: '1' })
  assert.equal(result.code, 0, result.out + read('watchdog.log'))
  assert.deepEqual(lines('kanban-calls.txt'), ['kanban'])
  assert.deepEqual(lines('pushes.txt'), ['Kanban board down'])
  assert.match(read('watchdog.log'), /UP - board check passed/)
})

test('no listener alone does not relaunch a board whose process is still alive', async t => {
  const { read, lines, run } = await fixture(t, NEVER_ANSWERS)
  const result = await run('', { TEST_NO_LISTENER: '1' })
  assert.equal(result.code, 1, result.out + read('watchdog.log'))
  assert.equal(read('kanban-calls.txt'), '', 'a live board process is never relaunched')
  assert.deepEqual(lines('pushes.txt'), ['Kanban board down'])
})
