# ponytail: fires the Issues sweep on a timer. Server owns the breaker/backoff logic —
# this script just calls the endpoint and logs the outcome, no retry loop of its own.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content "$root\board.config.json" | ConvertFrom-Json
$port = $config.port
$log = "$root\sweep.log"

# Every project the board serves, not just the first one - the server sweeps one
# project per call, so this walks the same list the board UI switches between.
foreach ($project in $config.projects) {
    try {
        $body = @{ project = $project } | ConvertTo-Json
        $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/sweep-issues" `
            -ContentType 'application/json' -Body $body -TimeoutSec 15
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $project sweep started: $($r.sweeper.cards -join ', ')" | Out-File -Append $log
    } catch {
        $msg = $_.ErrorDetails.Message
        # Windows PowerShell 5.1 (the scheduled-task host) leaves ErrorDetails empty on
        # Invoke-RestMethod failures - read the response body so expected no-ops match below.
        if (-not $msg -and $_.Exception.Response -and $_.Exception.Response.PSObject.Methods['GetResponseStream']) {
            try { $msg = [IO.StreamReader]::new($_.Exception.Response.GetResponseStream()).ReadToEnd() } catch {}
        }
        if (-not $msg) { $msg = $_.Exception.Message }
        if ($msg -match 'nothing in Issues' -or $msg -match 'already running') {
            # Expected no-ops - board empty or a manual sweep already in flight. Not worth logging.
        } else {
            "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $project sweep call failed: $msg" | Out-File -Append $log
        }
    }
}
