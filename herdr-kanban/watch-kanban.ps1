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
    } elseif (Test-Path (Join-Path $root '.lan-on')) {
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
            Update-BoardOutage -Healthy ($lanUp -or $lanBound) -StatePath (Join-Path $root '.watchdog-lan-outage') -Send {
                "$(Get-Date -Format o) LAN - no answer on ${lan}:$port; relaunching with -Lan" | Out-File -Append -Encoding utf8 $log
                & (Join-Path $root 'restart-kanban.ps1') -Lan
                Invoke-WebRequest "http://127.0.0.1:$port/api/board" -UseBasicParsing -TimeoutSec 5 | Out-Null
                Invoke-WebRequest "http://${lan}:$port/api/board" -UseBasicParsing -TimeoutSec 5 | Out-Null
                Update-BoardOutage -Healthy $true -StatePath (Join-Path $root '.watchdog-lan-outage') -Send { }
            }
        }
    }
    $herdr = (Get-Command herdr -ErrorAction Stop).Source
    # Board agents all live in herdr's default session.
    $session = 'default'
    # Windows PowerShell 5.1 (the scheduled task's host) turns herdr's stderr into a terminating
    # error under 'Stop', which skipped this recovery after every reboot: test the exit code instead.
    function Test-Herdr { $ErrorActionPreference = 'Continue'; & $herdr agent list *> $null; $LASTEXITCODE -eq 0 }
    $herdrState = Join-Path $root '.watchdog-herdr-outage'
    if (-not (Test-Herdr)) {
        $started = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine = "conhost.exe --headless `"$herdr`" --session $session server"
            CurrentDirectory = $root
        }
        $ready = $false
        if ($started.ReturnValue -eq 0) {
            foreach ($i in 1..40) {
                Start-Sleep -Milliseconds 250
                if (Test-Herdr) { $ready = $true; break }
            }
        }
        if (-not $ready) {
            try {
                Update-BoardOutage -Healthy $false -StatePath $herdrState -Send {
                    Send-Push 'Herdr down' "The watchdog could not start herdr session $session at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'). Board agents cannot run."
                }
            } catch {
                "$(Get-Date -Format o) ALERT FAILED - $($_.Exception.Message)" | Out-File -Append -Encoding utf8 $log
            }
            throw "Herdr session $session did not start (process create $($started.ReturnValue)) or did not answer within 10s"
        }
        "$(Get-Date -Format o) HERDR - started session $session" | Out-File -Append -Encoding utf8 $log
    }
    Update-BoardOutage -Healthy $true -StatePath $herdrState -Send { }
    # Orphaned Playwright browsers (dead test runners) hold memory; never fail the watchdog over it.
    try {
        $swept = @(& (Join-Path $root 'sweep-browser-orphans.ps1'))
        if ($swept.Count) { "$(Get-Date -Format o) SWEEP - killed $($swept.Count) orphaned Playwright browser processes" | Out-File -Append -Encoding utf8 $log }
    } catch { "$(Get-Date -Format o) SWEEP FAILED - $($_.Exception.Message)" | Out-File -Append -Encoding utf8 $log }
    "$(Get-Date -Format o) UP - board and Herdr check passed" | Out-File -Append -Encoding utf8 $log
    exit 0
} catch {
    "$(Get-Date -Format o) FAILED - $($_.Exception.Message)" | Out-File -Append -Encoding utf8 $log
    exit 1
}
