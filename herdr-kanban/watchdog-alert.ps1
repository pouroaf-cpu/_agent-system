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
function Send-Push {
    param([string]$Title, [string]$Message)
    $token = [Environment]::GetEnvironmentVariable('PUSHOVER_APP_TOKEN', 'User')
    $userKey = [Environment]::GetEnvironmentVariable('PUSHOVER_USER_KEY', 'User')
    if (-not $token -or -not $userKey) { throw 'Pushover credentials are not configured' }
    $response = Invoke-RestMethod -Uri 'https://api.pushover.net/1/messages.json' -Method Post -TimeoutSec 10 -Body @{
        token = $token
        user = $userKey
        title = $Title
        message = $Message
        priority = 0
    }
    if ($response.status -ne 1) { throw 'Pushover did not accept the alert' }
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
