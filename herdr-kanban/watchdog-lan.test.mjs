// Offline Windows PowerShell regression: all sockets, kills and launches are stubs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('LAN timeouts keep the board; a missing listener waits for recovery before UP', async t => {
  const root = mkdtempSync(join(tmpdir(), 'watchdog-lan-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of ['watch-kanban.ps1', 'restart-kanban.ps1', 'watchdog-alert.ps1']) {
    copyFileSync(join(import.meta.dirname, name), join(root, name))
  }
  writeFileSync(join(root, 'board.config.json'), '{"port":12345}')
  writeFileSync(join(root, '.lan-on'), '')
  writeFileSync(join(root, 'herdr.cmd'), '@echo off\r\nexit /b 0\r\n')
  writeFileSync(join(root, 'kanban.ps1'), `param([switch]$Silent, [switch]$Lan)
if (-not $Silent -or -not $Lan) { throw 'Missing silent LAN flags' }
Add-Content "$PSScriptRoot/events.txt" 'launch'
Start-Sleep -Milliseconds 300
if ($env:TEST_CASE -eq 'failed') { throw 'fixture launch failed' }
Set-Content "$PSScriptRoot/ready" ''
Add-Content "$PSScriptRoot/events.txt" 'ready'
`)
  writeFileSync(join(root, 'run.ps1'), `
function Get-NetIPAddress { param($AddressFamily, $ErrorAction) [pscustomobject]@{ IPAddress = '192.168.1.11' } }
function Get-NetTCPConnection {
  param($LocalPort, $State, $ErrorAction)
  [pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 123 }
  if ($env:TEST_CASE -eq 'bound') { [pscustomobject]@{ LocalAddress = '192.168.1.11'; OwningProcess = 123 } }
  if ($env:TEST_CASE -eq 'foreign') { [pscustomobject]@{ LocalAddress = '192.168.1.11'; OwningProcess = 456 } }
}
function Stop-Process { param($Id, [switch]$Force, $ErrorAction) Add-Content "$PSScriptRoot/events.txt" "kill $Id" }
function Invoke-WebRequest {
  param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
  if ($Uri -like '*192.168.1.11*' -and -not (Test-Path "$PSScriptRoot/ready")) { throw 'fixture LAN timeout' }
}
function Get-Command { param($Name, $ErrorAction) [pscustomobject]@{ Source = "$PSScriptRoot/herdr.cmd" } }
& "$PSScriptRoot/watch-kanban.ps1"
exit $LASTEXITCODE
`)
  const read = name => { try { return readFileSync(join(root, name), 'utf8') } catch { return '' } }
  for (const scenario of ['bound', 'missing', 'foreign', 'failed']) {
    for (const name of ['ready', 'events.txt', 'watchdog.log', '.watchdog-lan-outage']) rmSync(join(root, name), { force: true })
    const result = await new Promise(done => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'run.ps1')],
      { env: { ...process.env, TEST_CASE: scenario }, timeout: 30000 }, (err, stdout, stderr) => done({ code: err?.code ?? 0, out: stdout + stderr })))
    const log = read('watchdog.log'), events = read('events.txt')
    if (scenario === 'bound') {
      assert.equal(events, '', 'a healthy board must not be killed or relaunched on a LAN HTTP timeout')
      assert.equal(result.code, 0, result.out + log)
      assert.match(log, /keeping server/)
    } else if (scenario === 'failed') {
      assert.equal(result.code, 1, result.out + log)
      assert.match(log, /FAILED - fixture launch failed/)
      assert.doesNotMatch(log, /UP -/)
    } else {
      assert.equal(result.code, 0, result.out + log)
      assert.match(events, /kill 123[\s\S]*launch[\s\S]*ready/, result.out + log)
      assert.match(log, /UP -/)
      assert.equal(read('.watchdog-lan-outage'), '', 'successful LAN recovery clears the outage')
    }
  }
})
