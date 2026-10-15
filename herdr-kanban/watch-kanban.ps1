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
    if ($healthy) {
        Update-BoardOutage -Healthy $true -StatePath $state -SettleMinutes 15 -Send { }
    } else {
        "$(Get-Date -Format o) DOWN - checking recovery" | Out-File -Append -Encoding utf8 $log
        # Retries over about a minute (4 tries, 10 s timeout, 15 s apart); the test hook shortens the gap.
        $retryDelay = if ($env:WATCHDOG_RETRY_SECONDS) { [int]$env:WATCHDOG_RETRY_SECONDS } else { 15 }
        $recovery = Get-BoardFailureStatus -DelaySeconds $retryDelay -Request {
            Invoke-WebRequest "http://127.0.0.1:$port/api/board" -UseBasicParsing -TimeoutSec 10 | Out-Null
        } -ListenerCheck {
            # A failed listener query counts as a listener: only a clean "none" can end in a relaunch.
            try { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop) } catch { $true }
        } -ProcessCheck { Test-BoardProcessAlive (Join-Path $root '.server.pid') }
        if ($recovery -eq 'Gone') {
            try {
                Update-BoardOutage -Healthy $false -StatePath $state -SettleMinutes 15 -Send { Send-BoardDownPush }
            } catch {
                "$(Get-Date -Format o) ALERT FAILED - $($_.Exception.Message)" | Out-File -Append -Encoding utf8 $log
            }
            & (Join-Path $root 'kanban.ps1') -Silent
            Invoke-WebRequest "http://127.0.0.1:$port/api/board" -UseBasicParsing -TimeoutSec 5 | Out-Null
            Update-BoardOutage -Healthy $true -StatePath $state -SettleMinutes 15 -Send { }
        } elseif ($recovery -eq 'Slow') {
            "$(Get-Date -Format o) SLOW - retry passed" | Out-File -Append -Encoding utf8 $log
            Update-BoardOutage -Healthy $true -StatePath $state -SettleMinutes 15 -Send { }
        } else {
            try {
                Update-BoardOutage -Healthy $false -StatePath $state -SettleMinutes 15 -Send { Send-BoardDownPush }
            } catch {
                "$(Get-Date -Format o) ALERT FAILED - $($_.Exception.Message)" | Out-File -Append -Encoding utf8 $log
            }
            throw 'Board did not answer after retry'
        }
    }
    if ($healthy -and (Test-Path (Join-Path $root '.lan-on'))) {
        # The phone listener is bound to the address the board started with; DHCP moves it.
        $lan = Get-LanAddress
        $lanUp = $false
        if ($lan) {
            try {
                Invoke-WebRequest "http://${lan}:$port/api/board" -UseBasicParsing -TimeoutSec 5 | Out-Null
                $lanUp = $true
            } catch { }
        }
        if (-not $lan) {
            "$(Get-Date -Format o) LAN - no 192.168.1.x address; phone board unreachable" | Out-File -Append -Encoding utf8 $log
        } else {
            # A slow HTTP request is not evidence that DHCP moved the listener.
            # Only restart when the loopback board no longer owns the current LAN socket.
            $lanBound = $false
            if (-not $lanUp) {
                $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop)
                $boardPids = @($listeners | Where-Object LocalAddress -eq '127.0.0.1' | Select-Object -ExpandProperty OwningProcess)
                $lanBound = @($listeners | Where-Object {
                    $_.LocalAddress -in $lan, '0.0.0.0', '::' -and $_.OwningProcess -in $boardPids
                }).Count -gt 0
            }
            if (-not $lanUp -and $lanBound) {
                "$(Get-Date -Format o) LAN - no HTTP answer on ${lan}:$port; board still owns listener; keeping server" | Out-File -Append -Encoding utf8 $log
            }
            $lanOutage = Join-Path $root '.watchdog-lan-outage'
            $lanWait = Join-Path $root '.watchdog-lan-wait'
            if ($lanUp -or $lanBound) {
                Update-BoardOutage -Healthy $true -StatePath $lanWait -Send { }
                Update-BoardOutage -Healthy $true -StatePath $lanOutage -Send { }
            } else {
                # Only a relaunch re-binds the phone listener, and it kills any card run in flight
                # (builds, integration). Wait until no card is Working or integrating; one alert per wait.
                $inFlight = $null
                try {
                    $inFlight = [int](Get-InFlightCardCount -Port $port -ProjectsRoot $config.projectsRoot -Projects @($config.projects))
                } catch {
                    "$(Get-Date -Format o) LAN - cannot read card state ($($_.Exception.Message))" | Out-File -Append -Encoding utf8 $log
                }
                if ($inFlight -eq 0) {
                    Update-BoardOutage -Healthy $true -StatePath $lanWait -Send { }
                    Update-BoardOutage -Healthy $false -StatePath $lanOutage -Send {
                        "$(Get-Date -Format o) LAN - no answer on ${lan}:$port; no card in flight; relaunching with -Lan" | Out-File -Append -Encoding utf8 $log
                        & (Join-Path $root 'restart-kanban.ps1') -Lan
                        Invoke-WebRequest "http://127.0.0.1:$port/api/board" -UseBasicParsing -TimeoutSec 5 | Out-Null
                        Invoke-WebRequest "http://${lan}:$port/api/board" -UseBasicParsing -TimeoutSec 5 | Out-Null
                        Update-BoardOutage -Healthy $true -StatePath $lanOutage -Send { }
                    }
                } else {
                    $why = if ($null -eq $inFlight) { 'card state unreadable' } else { "$inFlight card(s) in flight" }
                    "$(Get-Date -Format o) LAN - no answer on ${lan}:$port; $why; waiting before relaunch" | Out-File -Append -Encoding utf8 $log
                    Update-BoardOutage -Healthy $false -StatePath $lanWait -Send {
                        try {
                            Send-Push 'Kanban phone board unreachable' "The phone address moved to $lan`:$port and the board has not re-bound it. It relaunches by itself once no card is Working or integrating ($why now)." 'BE'
                        } catch {
                            "$(Get-Date -Format o) ALERT FAILED - $($_.Exception.Message)" | Out-File -Append -Encoding utf8 $log
                        }
                    }
                }
            }
        }
    }
    # Orphaned Playwright browsers (dead test runners) hold memory; never fail the watchdog over it.
    try {
        $swept = @(& (Join-Path $root 'sweep-browser-orphans.ps1'))
        if ($swept.Count) { "$(Get-Date -Format o) SWEEP - killed $($swept.Count) orphaned Playwright browser processes" | Out-File -Append -Encoding utf8 $log }
    } catch { "$(Get-Date -Format o) SWEEP FAILED - $($_.Exception.Message)" | Out-File -Append -Encoding utf8 $log }
    "$(Get-Date -Format o) UP - board check passed" | Out-File -Append -Encoding utf8 $log
    exit 0
} catch {
    "$(Get-Date -Format o) FAILED - $($_.Exception.Message)" | Out-File -Append -Encoding utf8 $log
    exit 1
}
