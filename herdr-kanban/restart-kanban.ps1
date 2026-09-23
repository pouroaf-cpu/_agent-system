# ponytail: kills whatever process is bound to the configured port, then relaunches kanban.ps1.
# Simpler than trusting .server.pid (stale PIDs are the exact bug this job exists to fix).
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content "$root\board.config.json" | ConvertFrom-Json
$port = $config.port

$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2
# -Silent: an unattended restart must never pop a browser tab or steal focus to herdr.
Start-Process powershell -ArgumentList '-NoProfile','-File',"$root\kanban.ps1",'-Silent' -WindowStyle Hidden
