# ponytail: kills whatever process is bound to the configured port, then relaunches kanban.ps1.
param([switch]$Lan)
$ErrorActionPreference = 'Stop'
# Simpler than trusting .server.pid (stale PIDs are the exact bug this job exists to fix).
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content "$root\board.config.json" | ConvertFrom-Json
$port = $config.port

$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
# Keep the phone (LAN) listener across restarts: on with -Lan, or when it was already on.
$lan = $Lan -or ($conns | Where-Object { $_.LocalAddress -notin '127.0.0.1', '::1' })
foreach ($c in $conns) {
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2
# A restart from a Claude chat must not hand that chat's session env to the board and its agents.
@(Get-ChildItem env: | Where-Object Name -like 'CLAUDE*') | ForEach-Object { Remove-Item -LiteralPath "env:$($_.Name)" }
# -Silent: an unattended restart must never pop a browser tab or steal focus to herdr.
# kanban.ps1 detaches the server itself. Wait for its readiness check; a second
# asynchronous PowerShell let the watchdog report UP before the launch completed.
& "$root\kanban.ps1" -Silent -Lan:([bool]$lan)
