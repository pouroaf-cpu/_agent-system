# Single launch: board server, browser, herdr.
# New agents: HERDR prefix+a uses herdr-roles.ps1 (Codex with full bypass).
# Select orchestrator to load C:\Users\PFrew\Projects\ORCHESTRATOR.md.
#
#   .\kanban.ps1              # board + browser + herdr
#   .\kanban.ps1 -NoHerdr     # board + browser only
#   .\kanban.ps1 -Lan         # also listen on this PC's 192.168.1.x for phones (sticky)
#   .\kanban.ps1 -Silent      # server only - no browser tab, no herdr focus-steal.
#                               For unattended restarts (scheduled tasks, watchdogs,
#                               anything not a human sitting at the shortcut) - opening
#                               a browser tab and attaching herdr on every restart was
#                               stealing the operator's active window on every scheduled
#                               fire, not just the first real launch.
#   .\kanban.ps1 -Stop        # stop the board server

[CmdletBinding()]
param(
    [switch]$NoHerdr,
    [switch]$Silent,
    [switch]$Lan,
    [switch]$Stop,
    [string]$Project
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pidFile = Join-Path $root '.server.pid'
# The phone (LAN) listener is sticky: once launched with -Lan, every later launch (the
# watchdog's recovery, restart-kanban.ps1) keeps it. Delete .lan-on to turn it off.
$lanFlag = Join-Path $root '.lan-on'
if ($Lan) { Set-Content $lanFlag '' } elseif (Test-Path $lanFlag) { $Lan = [switch]::Present }
$config = Get-Content (Join-Path $root 'board.config.json') -Raw | ConvertFrom-Json
$port = $config.port
if (-not $Project) { $Project = $config.projects[0] }
# The home address is DHCP (was .11, now .7): use this PC's current 192.168.1.x on a physical adapter.
$lanSubnet = '192.168.1.0/24'
$lanAddress = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -like '192.168.1.*' } | Select-Object -First 1).IPAddress

function Stop-Board {
    if (-not (Test-Path $pidFile)) { Write-Host 'board: not running'; return }
    $serverPid = Get-Content $pidFile
    Get-Process -Id $serverPid -ErrorAction SilentlyContinue | Stop-Process -Force
    Remove-Item $pidFile -Force
    Write-Host "board: stopped ($serverPid)"
}

if ($Stop) { Stop-Board; return }

# Reuse a server that is already up rather than fighting it for the port.
$alive = $false
try {
    Invoke-WebRequest "http://127.0.0.1:$port/api/board?project=$Project" -TimeoutSec 2 -UseBasicParsing | Out-Null
    $alive = $true
} catch { }

if ($alive) {
    Write-Host "board: already running on $port"
    if ($Lan) { Write-Warning "board: already running; stop it first, then relaunch with -Lan to add http://$lanAddress`:$port" }
} else {
    $lanPrefix = ''
    if ($Lan) {
        $lanIp = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $lanAddress -ErrorAction Stop | Select-Object -First 1
        $lanAdapter = Get-NetAdapter -InterfaceIndex $lanIp.InterfaceIndex -ErrorAction Stop
        if ($lanIp.PrefixLength -ne 24 -or -not $lanAdapter.HardwareInterface -or $lanAdapter.Status -ne 'Up') {
            throw "$lanAddress is not on an up physical /24 adapter"
        }
        $lanPrefix = "set `"KANBAN_LAN_HOST=$lanAddress`" && "
    }

    # Detached on purpose. Start-Process makes the server a child of whatever launched
    # this script, so a scheduled task or an agent's shell took the board down with it
    # when that parent exited — silently, no crash, no error log. Win32_Process.Create
    # gives the server no parent job, so nothing else owns its lifetime.
    $logOut = Join-Path $root 'server.log'
    $logErr = Join-Path $root 'server.err.log'
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine      = "cmd.exe /c $lanPrefix node server.mjs >> `"$logOut`" 2>> `"$logErr`""
        CurrentDirectory = $root
    }
    if ($created.ReturnValue -ne 0) { Write-Warning "board: process create failed ($($created.ReturnValue))" }

    $ready = $false
    foreach ($i in 1..40) {
        Start-Sleep -Milliseconds 250
        try {
            Invoke-WebRequest "http://127.0.0.1:$port/api/board?project=$Project" -TimeoutSec 2 -UseBasicParsing | Out-Null
            $ready = $true
            break
        } catch { }
    }
    if (-not $ready) {
        # Launched from the shortcut there is no console to read, so say it out loud.
        $detail = (Get-Content (Join-Path $root 'server.err.log') -Tail 10 -ErrorAction SilentlyContinue) -join "`n"
        Write-Warning "board: server did not answer on $port within 10s"
        Write-Warning $detail
        if ($Silent) { throw "board: server did not answer on port $port within 10s. $detail" }
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show(
            "The board server did not start on port $port.`n`n$detail",
            'Kanban', 'OK', 'Error') | Out-Null
        return
    }
    # The pid to record is node's, not the cmd.exe wrapper's — Stop-Board kills what is
    # in this file, and a stale/wrong pid is the exact failure this file exists to avoid.
    $serverPid = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1).OwningProcess
    if ($serverPid) { $serverPid | Set-Content $pidFile }
    Write-Host "board: http://127.0.0.1:$port (pid $serverPid)"
    if ($Lan) {
        Write-Host "phone: http://$lanAddress`:$port/?project=$Project"
        Write-Host "firewall (admin, if needed): New-NetFirewallRule -DisplayName 'Herdr Kanban LAN 7777' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress $lanAddress -LocalPort $port -RemoteAddress $lanSubnet -InterfaceAlias '$($lanAdapter.Name)'"
    }
}

if ($Silent) { return }

Start-Process "http://127.0.0.1:$port/?project=$Project"

if (-not $NoHerdr) {
    # Every board agent lives in herdr's default session, one workspace per project,
    # so plain `herdr` shows them all. It attaches if the session is running.
    Start-Process herdr
    Write-Host 'herdr: default session (one workspace per project)'
    Write-Host 'agents: prefix+a -> role (Codex, full bypass); orchestrator brief: C:\Users\PFrew\Projects\ORCHESTRATOR.md'

    # One workspace per project, labelled with the project name. Open them up front
    # rather than on the first spawn. Silently skipped if herdr is not answering
    # yet — the board's poll makes each one before it spawns there.
    foreach ($i in 1..6) {
        try {
            $ws = (herdr workspace list 2>$null | ConvertFrom-Json).result.workspaces
            foreach ($wsLabel in $config.projects) {
                if (-not ($ws | Where-Object { $_.label -eq $wsLabel })) {
                    herdr workspace create --label $wsLabel --no-focus 2>$null | Out-Null
                    Write-Host "herdr: workspace '$wsLabel' created"
                }
            }
            break
        } catch { Start-Sleep -Milliseconds 500 }
    }
}
