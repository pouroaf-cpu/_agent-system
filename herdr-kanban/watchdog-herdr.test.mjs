// watch-kanban.ps1 under Windows PowerShell 5.1, the scheduled task's host (audit
// 2026-09-26 findings 2 and 13). Each test copies the watchdog into a temp board with a
// stub herdr on PATH, a local HTTP server as the board, and stubbed push, LAN address
// and restart, so nothing real is started, pushed or restarted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'

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

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'watchdog-herdr-')), bin = join(root, 'bin')
  const server = createServer((req, res) => res.end('{}'))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  t.after(() => { server.close(); rmSync(root, { recursive: true, force: true }) })
  mkdirSync(bin)
  writeFileSync(join(bin, 'herdr.cmd'), STUB_HERDR)
  copyFileSync(join(HERE, 'watch-kanban.ps1'), join(root, 'watch-kanban.ps1'))
  writeFileSync(join(root, 'watchdog-alert.ps1'), readFileSync(join(HERE, 'watchdog-alert.ps1'), 'utf8') + `
function Send-Push { param([string]$Title, [string]$Message) Add-Content -LiteralPath (Join-Path $PSScriptRoot 'pushes.txt') $Title }
function Get-LanAddress { $env:TEST_LAN_ADDRESS }
function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) [pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 1 } }
`)
  writeFileSync(join(root, 'board.config.json'), JSON.stringify({ port: server.address().port }))
  writeFileSync(join(root, 'kanban.ps1'), `Add-Content (Join-Path $PSScriptRoot 'kanban-calls.txt') 'kanban'`)
  writeFileSync(join(root, 'restart-kanban.ps1'), `param([switch]$Lan)\nAdd-Content (Join-Path $PSScriptRoot 'restarts.txt') "restart Lan=$Lan"`)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k)))
  env.Path = [bin, join(process.env.SystemRoot, 'System32'), join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';')
  const run = (lanAddress = '') => new Promise(done => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'watch-kanban.ps1')],
    { env: { ...env, TEST_LAN_ADDRESS: lanAddress }, timeout: 45000 }, (err, stdout, stderr) => done({ code: err?.code ?? 0, out: stdout + stderr })))
  const read = name => existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : ''
  const lines = name => read(name).split(/\r?\n/).filter(Boolean)
  return { root, bin, run, read, lines }
}

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
