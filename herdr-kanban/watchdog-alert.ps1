# One send attempt per outage: do not duplicate a push after an ambiguous timeout.
function Update-BoardOutage {
    param([bool]$Healthy, [string]$StatePath, [scriptblock]$Send)
    if ($Healthy) {
        if (Test-Path -LiteralPath $StatePath) { Remove-Item -LiteralPath $StatePath }
        return
    }
    if (Test-Path -LiteralPath $StatePath) { return }
    # Persist before sending so subsequent watchdog runs cannot repeat the alert.
    [IO.File]::WriteAllText($StatePath, (Get-Date -Format o))
    & $Send
}
# A board is only "Gone" (safe to relaunch) when it answers no request in the whole window,
# its port has no listener AND its process has exited. A live process is never relaunched:
# a slow board under memory pressure must not be killed (watchdog false DOWN, 2026-10-15).
function Get-BoardFailureStatus {
    param([scriptblock]$Request, [scriptblock]$ListenerCheck, [scriptblock]$ProcessCheck, [int]$Attempts = 4, [int]$DelaySeconds = 15)
    for ($i = 1; $i -le $Attempts; $i++) {
        try { & $Request; return 'Slow' } catch { }
        if ($i -lt $Attempts) { Start-Sleep -Seconds $DelaySeconds }
    }
    if ((& $ProcessCheck) -or (& $ListenerCheck)) { return 'Down' }
    return 'Gone'
}
# The board's node process, from the pid file kanban.ps1 writes. No node process under that pid reads as not alive.
function Test-BoardProcessAlive {
    param([string]$PidFile)
    if (-not (Test-Path -LiteralPath $PidFile)) { return $false }
    $serverPid = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ("$serverPid" -notmatch '^\d+$') { return $false }
    $proc = Get-Process -Id ([int]$serverPid) -ErrorAction SilentlyContinue
    return [bool]($proc -and $proc.ProcessName -eq 'node')
}
# Watchdog alerts go to the Kanban Manager inbox, not Pushover (operator, 2026-10-09).
function Send-Push {
    param([string]$Title, [string]$Message, [string]$Kind = 'GE')
    $inbox = Join-Path $PSScriptRoot '../_roles/KANBAN_MANAGER-INBOX.md'
    # Board event ID (HK57) from the shared helper; no ID, no line.
    $id = ((node (Join-Path $PSScriptRoot '../_roles/board-event-id.mjs') $Kind) -join ' ').Trim()
    if ($LASTEXITCODE -ne 0 -or -not $id) { throw "board event ID failed for kind $Kind" }
    $line = "- $id $(Get-NzAlertTime) $($Title): $Message`n"
    [IO.File]::AppendAllText($inbox, $line)
    [IO.File]::AppendAllText(($inbox -replace '\.md$', '.log'), $line) # permanent log, as lib/inbox.mjs
}
function Get-NzAlertTime {
    node --input-type=module -e "import { pathToFileURL } from 'node:url'; const { formatNZTime } = await import(pathToFileURL(process.argv[1])); console.log(formatNZTime())" (Join-Path $PSScriptRoot 'lib/nz-time.mjs')
}
function Send-BoardDownPush {
    Send-Push 'Kanban board down' "The Kanban board did not respond at $(Get-NzAlertTime). The watchdog is checking recovery." 'BE'
}
# Cards the board is running now: its Working cards, plus worktrees in the integrating state
# (the board's integration pass). Throws when the board or a registry cannot be read; the caller treats that as busy.
function Get-InFlightCardCount {
    param([int]$Port, [string]$ProjectsRoot, [string[]]$Projects)
    $total = 0
    foreach ($project in $Projects) {
        $board = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/board?project=$project" -TimeoutSec 10
        $working = $board.board.working
        if ($working) { $total += @($working).Count }
        $registry = Join-Path $ProjectsRoot "$project\TASKS\.board-worktrees.json"
        if (Test-Path -LiteralPath $registry) {
            $entries = Get-Content -LiteralPath $registry -Raw | ConvertFrom-Json
            $total += @($entries.PSObject.Properties | Where-Object { $_.Value.state -eq 'integrating' }).Count
        }
    }
    return $total
}
# This PC's phone (LAN) address: same rule as kanban.ps1 (DHCP, so it moves).
function Get-LanAddress {
    (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -like '192.168.1.*' } | Select-Object -First 1).IPAddress
}
