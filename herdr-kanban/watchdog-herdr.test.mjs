// watch-kanban.ps1 under Windows PowerShell 5.1, the scheduled task's host (audit
// 2026-09-26 findings 2 and 13). Each test copies the watchdog into a temp board with a
// stub herdr on PATH, a local HTTP server as the board, and stubbed push, LAN address
// and restart, so nothing real is started, pushed or restarted.
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
const STUB_HERDR = `@echo off
echo %*>>"%~dp0calls.txt"
if "%1"=="agent" goto agent
if "%3"=="server" if exist "%~dp0can-start" echo up>"%~dp0up"
exit /b 0
:agent
if exist "%~dp0up" exit /b 0
echo {"id":"cli:agent:list","error":{"code":"server_not_running"}} 1>&2
exit /b 1
`

async function fixture(t, extraAlertFunctions = '') {
  const root = mkdtempSync(join(tmpdir(), 'watchdog-herdr-')), bin = join(root, 'bin')
  const server = createServer((req, res) => res.end('{}'))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  t.after(() => { server.close(); rmSync(root, { recursive: true, force: true }) })
  mkdirSync(bin)
  mkdirSync(join(root, 'lib'))
  copyFileSync(join(HERE, 'lib', 'nz-time.mjs'), join(root, 'lib', 'nz-time.mjs'))
  writeFileSync(join(bin, 'herdr.cmd'), STUB_HERDR)
  copyFileSync(join(HERE, 'watch-kanban.ps1'), join(root, 'watch-kanban.ps1'))
  writeFileSync(join(root, 'watchdog-alert.ps1'), readFileSync(join(HERE, 'watchdog-alert.ps1'), 'utf8') + `
function Send-Push { param([string]$Title, [string]$Message, [string]$Kind) Add-Content -LiteralPath (Join-Path $PSScriptRoot 'pushes.txt') $Title }
function Get-LanAddress { $env:TEST_LAN_ADDRESS }
function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) [pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 1 } }
${extraAlertFunctions}`)
  writeFileSync(join(root, 'board.config.json'), JSON.stringify({ port: server.address().port }))
  writeFileSync(join(root, 'kanban.ps1'), `Add-Content (Join-Path $PSScriptRoot 'kanban-calls.txt') 'kanban'`)
  writeFileSync(join(root, 'restart-kanban.ps1'), `param([switch]$Lan)\nAdd-Content (Join-Path $PSScriptRoot 'restarts.txt') "restart Lan=$Lan"`)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k)))
  env.Path = [bin, dirname(process.execPath), join(process.env.SystemRoot, 'System32'), join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';')
  const run = (lanAddress = '') => new Promise(done => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'watch-kanban.ps1')],
    { env: { ...env, TEST_LAN_ADDRESS: lanAddress }, timeout: 45000, windowsHide: true }, (err, stdout, stderr) => done({ code: err?.code ?? 0, out: stdout + stderr })))
  const read = name => existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : ''
  const lines = name => read(name).split(/\r?\n/).filter(Boolean)
  return { root, bin, run, read, lines }
}

test('board timeout with a live listener and successful retry sends no alert', async t => {
  const { root, bin, run, read, lines } = await fixture(t, `
$script:boardRequestCount = 0
function Invoke-WebRequest {
  param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
  $script:boardRequestCount++
  if ($script:boardRequestCount -eq 1) { throw 'fixture first request timed out' }
}
`)
  writeFileSync(join(bin, 'up'), '')
  const result = await run()
  assert.equal(result.code, 0, result.out + read('watchdog.log'))
  assert.deepEqual(lines('pushes.txt'), [])
  assert.equal(existsSync(join(root, '.watchdog-outage')), false, 'a recovered blip does not leave outage state')
  assert.match(read('watchdog.log'), /DOWN - checking recovery/)
  assert.match(read('watchdog.log'), /SLOW - retry passed/)
})

test('herdr down: the watchdog starts the default session and logs it instead of failing on herdr stderr', async t => {
  const { bin, run, read, lines } = await fixture(t)
  writeFileSync(join(bin, 'can-start'), '')
  const result = await run()
  assert.equal(result.code, 0, result.out + read('watchdog.log'))
  assert.ok(readFileSync(join(bin, 'calls.txt'), 'utf8').includes('--session default server'), 'herdr server was started')
  assert.match(read('watchdog.log'), /HERDR - started session default/)
  assert.match(read('watchdog.log'), /UP - board and Herdr check passed/)
  assert.deepEqual(lines('pushes.txt'), [])
  assert.equal(read('kanban-calls.txt'), '', 'a healthy board is never relaunched')
})

test('herdr that cannot be started sends one push per outage', async t => {
  const { root, bin, run, read, lines } = await fixture(t)
  await run(); await run()
  assert.equal(lines('pushes.txt').length, 1, read('watchdog.log'))
  assert.match(lines('pushes.txt')[0], /Herdr/)
  assert.match(read('watchdog.log'), /FAILED - Herdr session default/)
  writeFileSync(join(bin, 'up'), '')
  await run()
  assert.equal(existsSync(join(root, '.watchdog-herdr-outage')), false, 'recovery ends the outage')
})

test('phone listener: with .lan-on, a board not answering on the current LAN address is relaunched with -Lan once per outage', async t => {
  const { root, bin, run, read, lines } = await fixture(t)
  writeFileSync(join(bin, 'up'), '')
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
