# Check-only watchdog: never kill an existing listener.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$log = Join-Path $root 'watchdog.log'
. (Join-Path $root 'watchdog-alert.ps1')
$state = Join-Path $root '.watchdog-outage'
try {
    $config = Get-Content (Join-Path $root 'board.config.json') -Raw | ConvertFrom-Json
    $port = $config.port
    $healthy = $false
    try {
        Invoke-WebRequest "http://127.0.0.1:$port/api/board" -UseBasicParsing -TimeoutSec 5 | Out-Null
        $healthy = $true
    } catch { }
    try {
        Update-BoardOutage -Healthy $healthy -StatePath $state -Send { Send-BoardDownPush }
    } catch {
        "$(Get-Date -Format o) ALERT FAILED - $($_.Exception.Message)" | Out-File -Append -Encoding utf8 $log
    }
    if (-not $healthy) {
        "$(Get-Date -Format o) DOWN - checking recovery" | Out-File -Append -Encoding utf8 $log
        $alive = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if (-not $alive) { & (Join-Path $root 'kanban.ps1') -Silent }
        Invoke-WebRequest "http://127.0.0.1:$port/api/board" -UseBasicParsing -TimeoutSec 5 | Out-Null
        Update-BoardOutage -Healthy $true -StatePath $state -Send { }
    }
    $herdr = (Get-Command herdr -ErrorAction Stop).Source
    # Board agents all live in herdr's default session.
    $session = 'default'
    & $herdr agent list *> $null
    if ($LASTEXITCODE -ne 0) {
        $started = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine = "`"$herdr`" server"
            CurrentDirectory = $root
        }
        if ($started.ReturnValue -ne 0) { throw "Herdr process create failed ($($started.ReturnValue))" }
        $ready = $false
        foreach ($i in 1..40) {
            Start-Sleep -Milliseconds 250
            & $herdr agent list *> $null
            if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        }
        if (-not $ready) { throw "Herdr session $session did not answer within 10s" }
        "$(Get-Date -Format o) HERDR - started session $session" | Out-File -Append -Encoding utf8 $log
    }
    "$(Get-Date -Format o) UP - board and Herdr check passed" | Out-File -Append -Encoding utf8 $log
    exit 0
} catch {
    "$(Get-Date -Format o) FAILED - $($_.Exception.Message)" | Out-File -Append -Encoding utf8 $log
    exit 1
}
