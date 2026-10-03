# Kills Playwright browser processes whose parent is gone. Headless WebKit leaves
# WebKitNetworkProcess.exe behind when its test runner dies or browser.close() hangs
# (137 of them, ~1.4 GB, Injectbuddy I582, 2026-10-03). Only binaries under an
# ms-playwright* folder are touched; a live parent means the browser is still in use.
# Run by watch-kanban.ps1 every 5 minutes. -DryRun lists without killing.
param([switch]$DryRun)
$procs = @(Get-CimInstance Win32_Process)
$byId = @{}
foreach ($p in $procs) { $byId[[int]$p.ProcessId] = $p }
$killed = @()
foreach ($p in $procs) {
    if ($p.ExecutablePath -notmatch '\\ms-playwright[^\\]*\\') { continue }
    $parent = $byId[[int]$p.ParentProcessId]
    # A parent started after the child is a reused PID, not the real parent.
    if ($parent -and $parent.CreationDate -le $p.CreationDate) { continue }
    # Exited processes stay listed while some handle holds them; they cannot be killed, and
    # Windows PowerShell reports Stop-Process success on them anyway.
    try { if ([System.Diagnostics.Process]::GetProcessById([int]$p.ProcessId).HasExited) { continue } } catch { continue }
    if (-not $DryRun) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    $killed += "$($p.Name):$($p.ProcessId)"
}
$killed
