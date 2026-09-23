$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\watchdog-alert.ps1"
$state = Join-Path $env:TEMP ([Guid]::NewGuid().ToString()+'.outage')
$script:sent = 0
$send = { $script:sent++ }
try {
    Update-BoardOutage $false $state $send
    Update-BoardOutage $false $state $send
    if ($script:sent -ne 1) { throw 'Repeated outage sent duplicate alerts' }
    Update-BoardOutage $true $state $send
    if ($script:sent -ne 1) { throw 'Recovery sent an alert' }
    Update-BoardOutage $false $state $send
    if ($script:sent -ne 2) { throw 'New outage did not send an alert' }
    Update-BoardOutage $true $state $send
    try { Update-BoardOutage $false $state { throw 'Simulated ambiguous timeout' } } catch { }
    Update-BoardOutage $false $state $send
    if ($script:sent -ne 2) { throw 'Ambiguous send was retried' }
    'PASS: outage deduplication, silent recovery, new outage, ambiguous timeout'
} finally { if (Test-Path $state) { Remove-Item -LiteralPath $state } }