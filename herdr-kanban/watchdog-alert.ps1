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
# Watchdog alerts go to the Kanban Manager inbox, not Pushover (operator, 2026-10-09).
function Send-Push {
    param([string]$Title, [string]$Message)
    $inbox = Join-Path $PSScriptRoot '../_roles/KANBAN_MANAGER-INBOX.md'
    [IO.File]::AppendAllText($inbox, "- $(Get-NzAlertTime) $($Title): $Message`n")
}
function Get-NzAlertTime {
    node --input-type=module -e "import { pathToFileURL } from 'node:url'; const { formatNZTime } = await import(pathToFileURL(process.argv[1])); console.log(formatNZTime())" (Join-Path $PSScriptRoot 'lib/nz-time.mjs')
}
function Send-BoardDownPush {
    Send-Push 'Kanban board down' "The Kanban board did not respond at $(Get-NzAlertTime). The watchdog is checking recovery."
}
# This PC's phone (LAN) address: same rule as kanban.ps1 (DHCP, so it moves).
function Get-LanAddress {
    (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -like '192.168.1.*' } | Select-Object -First 1).IPAddress
}
