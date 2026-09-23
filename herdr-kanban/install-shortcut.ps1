# Puts a one-click "Kanban" shortcut on the Desktop and in the Start menu.
# Run once. Re-run after moving the repo.

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$launcher = Join-Path $root 'kanban.ps1'
$targets = @(
    Join-Path ([Environment]::GetFolderPath('Desktop')) 'Kanban.lnk'
    Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Kanban.lnk'
)

if ($Remove) {
    $targets | Where-Object { Test-Path $_ } | ForEach-Object { Remove-Item $_ -Force; Write-Host "removed $_" }
    return
}

# pwsh if it is installed, otherwise Windows PowerShell — both run the launcher fine.
$shellExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $shellExe) { $shellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }

$ws = New-Object -ComObject WScript.Shell
foreach ($path in $targets) {
    $dir = Split-Path $path -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

    $lnk = $ws.CreateShortcut($path)
    $lnk.TargetPath = $shellExe
    $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
    $lnk.WorkingDirectory = $root          # so the shortcut works from anywhere
    $lnk.IconLocation = "$((Get-Command herdr).Source),0"
    $lnk.Description = 'Open the kanban board and herdr'
    $lnk.WindowStyle = 7                   # minimised: no console flash
    $lnk.Save()
    Write-Host "created $path"
}
