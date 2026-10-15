# Moves the board's KanbanProjects folder to another drive and leaves a directory junction at the old path,
# so every absolute path (git worktrees, board.config.json, chats) keeps working.
# Audit 2026-10-16 F6 (herdr-kanban hardware efficiency). Run by the Kanban Manager during a drain restart,
# never while cards are working. The board is not stopped or restarted by this script.
#
#   pwsh -NoProfile -File scripts\move-kanbanprojects-to-f.ps1 -PlanOnly
#   pwsh -NoProfile -File scripts\move-kanbanprojects-to-f.ps1 -ConfirmDrained
#
# Steps. Each one stops the script before anything is deleted:
#   1. Preflight: source is a real folder, target is absent or empty, target drive has room, no file links.
#   2. Walk the source with an own walker that never descends into a junction. Record files, sizes, junctions.
#   3. robocopy source to target with /XJ (junctions are skipped, never followed). Exit codes 0-7 are success.
#   4. Recreate each source junction inside the target, pointing where it pointed before.
#   5. Walk the target and compare every file path and size, and every junction. Any difference stops the
#      script; the source is untouched and the partial target is left for inspection.
#   6. Rename the source to <name>.moved-<stamp> and create a junction at the old path to the target.
#      If the junction fails, the rename is rolled back.
#   7. Check the junction shows the same top-level entries and the same target. If not, roll back.
#   8. Remove the junctions inside the moved copy (removes only the link), then delete the moved copy.
#      The moved copy is deleted only after steps 5 and 7 passed.

[CmdletBinding()]
param(
  [string]$From = 'C:\Users\PFrew\KanbanProjects',
  [string]$To = 'F:\KanbanProjects',
  [switch]$PlanOnly,
  [switch]$ConfirmDrained
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $env:TEMP "move-kanbanprojects-$stamp.log"

function Write-Step([string]$message) {
  $line = "$(Get-Date -Format 's') $message"
  Write-Host $line
  Add-Content -LiteralPath $log -Value $line
}

function Get-FreeGB([string]$path) {
  $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($path))
  [math]::Round($drive.AvailableFreeSpace / 1GB, 2)
}

function Get-TreeInfo([string]$root) {
  # Files: relative path -> length. Links: junctions (never descended into), relative path and target.
  $files = @{}
  $links = [System.Collections.Generic.List[object]]::new()
  $bytes = [int64]0
  $stack = [System.Collections.Generic.Stack[string]]::new()
  $stack.Push($root)
  $prefix = $root.Length + 1
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    foreach ($entry in [System.IO.DirectoryInfo]::new($dir).EnumerateFileSystemInfos()) {
      $rel = $entry.FullName.Substring($prefix)
      $isDir = [bool]($entry.Attributes -band [System.IO.FileAttributes]::Directory)
      if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        $target = @((Get-Item -LiteralPath $entry.FullName -Force).Target) -join ''
        if (-not $target) { throw "Link with no readable target: $($entry.FullName)" }
        $links.Add([pscustomobject]@{ Rel = $rel; Target = $target; IsDir = $isDir })
      } elseif ($isDir) {
        $stack.Push($entry.FullName)
      } else {
        $files[$rel] = $entry.Length
        $bytes += $entry.Length
      }
    }
  }
  [pscustomobject]@{ Files = $files; Links = $links; Bytes = $bytes }
}

function Get-LinkKey($links) {
  @($links | ForEach-Object { "$($_.Rel)|$($_.Target)" } | Sort-Object)
}

try {
  $From = $From.TrimEnd('\')
  $To = $To.TrimEnd('\')
  Write-Step "Plan: $From -> $To (log: $log)"

  if (-not (Test-Path -LiteralPath $From -PathType Container)) { throw "Source folder not found: $From" }
  $sourceItem = Get-Item -LiteralPath $From -Force
  if ($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    Write-Step "Source is already a link to $(@($sourceItem.Target) -join '') : nothing to move."
    exit 0
  }
  if ($To.StartsWith("$From\", [System.StringComparison]::OrdinalIgnoreCase) -or $From.StartsWith("$To\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Source and target must not be nested in each other.'
  }
  if (Test-Path -LiteralPath $To) {
    if (@(Get-ChildItem -LiteralPath $To -Force).Count -gt 0) { throw "Target exists and is not empty: $To" }
  }

  Write-Step "Walking source (read only)..."
  $src = Get-TreeInfo $From
  $fileCount = $src.Files.Count
  $linkCount = $src.Links.Count
  if (@($src.Links | Where-Object { -not $_.IsDir }).Count -gt 0) { throw 'Source has file links (not junctions). Handle by hand; nothing was changed.' }
  $needGB = [math]::Round($src.Bytes / 1GB, 2)
  $freeToGB = Get-FreeGB $To
  $freeCGB = Get-FreeGB $From
  Write-Step "Source: $fileCount files, $needGB GB, $linkCount junctions inside. Free before: source drive $freeCGB GB, target drive $freeToGB GB."
  if ($freeToGB -lt ($needGB + 2)) { throw "Target drive has $freeToGB GB free; needs about $($needGB + 2) GB. Nothing was changed." }
  if ($PlanOnly) { Write-Step 'PlanOnly: stopping before any change.'; exit 0 }
  if (-not $ConfirmDrained) { throw 'Refusing to move: pass -ConfirmDrained only when the board is drained (no card agent running).' }

  # 3. Copy. /XJ: junctions are skipped, not followed (a /SL run followed them and copied outside folders).
  New-Item -ItemType Directory -Path $To -Force | Out-Null
  Write-Step 'Copying with robocopy /E /XJ ...'
  $roboLog = "$log.robocopy.txt"
  & robocopy.exe $From $To /E /COPY:DAT /XJ /R:1 /W:1 /NP "/LOG:$roboLog" | Out-Null
  $code = $LASTEXITCODE
  Write-Step "robocopy exit code $code (0-7 is success; log: $roboLog)"
  if ($code -ge 8) { throw "robocopy failed with exit code $code. Source untouched; partial target at $To." }

  # 4. Recreate the junctions inside the copy.
  foreach ($link in $src.Links) {
    New-Item -ItemType Junction -Path (Join-Path $To $link.Rel) -Target $link.Target | Out-Null
  }
  Write-Step "Recreated $linkCount junction(s) in the copy."

  # 5. Verify the copy against the source. Nothing is deleted on a mismatch.
  Write-Step 'Verifying copy (read only)...'
  $dst = Get-TreeInfo $To
  $problems = [System.Collections.Generic.List[string]]::new()
  if ($dst.Files.Count -ne $fileCount) { $problems.Add("file count $($dst.Files.Count) vs $fileCount") }
  if ($dst.Bytes -ne $src.Bytes) { $problems.Add("bytes $($dst.Bytes) vs $($src.Bytes)") }
  foreach ($key in $src.Files.Keys) {
    if (-not $dst.Files.ContainsKey($key) -or $dst.Files[$key] -ne $src.Files[$key]) {
      $problems.Add("missing or different: $key")
      if ($problems.Count -gt 20) { break }
    }
  }
  $srcLinks = Get-LinkKey $src.Links
  $dstLinks = Get-LinkKey $dst.Links
  if (($srcLinks -join "`n") -ne ($dstLinks -join "`n")) { $problems.Add('junction list differs') }
  if ($problems.Count -gt 0) {
    $problems | Select-Object -First 20 | ForEach-Object { Write-Step "MISMATCH: $_" }
    throw "Copy does not match the source. Source untouched; target left at $To for inspection; nothing deleted."
  }
  Write-Step "Verified: $($dst.Files.Count) files, $($dst.Bytes) bytes, $($dstLinks.Count) junction(s) match the source."

  # 6. Swap: the old path becomes a junction to the verified copy. The old tree is renamed, not deleted yet.
  $movedName = "$(Split-Path -Leaf $From).moved-$stamp"
  $moved = Join-Path (Split-Path -Parent $From) $movedName
  Rename-Item -LiteralPath $From -NewName $movedName
  try {
    New-Item -ItemType Junction -Path $From -Target $To | Out-Null
  } catch {
    Rename-Item -LiteralPath $moved -NewName (Split-Path -Leaf $From)
    throw "Junction could not be created; rename rolled back. $($_.Exception.Message)"
  }

  # 7. Check the junction shows the same top-level entries and points at the copy.
  $linkTarget = @((Get-Item -LiteralPath $From -Force).Target) -join ''
  $topFrom = @(Get-ChildItem -LiteralPath $From -Force).Count
  $topMoved = @(Get-ChildItem -LiteralPath $moved -Force).Count
  if ($linkTarget.TrimEnd('\') -ne $To -or $topFrom -ne $topMoved) {
    [System.IO.Directory]::Delete($From, $false)
    Rename-Item -LiteralPath $moved -NewName (Split-Path -Leaf $From)
    throw "Junction check failed (target '$linkTarget', entries $topFrom vs $topMoved). Rolled back; source restored."
  }
  Write-Step "Junction $From -> $To checked ($topFrom top-level entries)."

  # 8. Delete the old copy. Its junctions are removed as links only (Directory.Delete without recursion
  # never touches the target of a junction), then the rest of the tree is deleted.
  foreach ($link in $src.Links) {
    [System.IO.Directory]::Delete((Join-Path $moved $link.Rel), $false)
  }
  Remove-Item -LiteralPath $moved -Recurse -Force
  if (Test-Path -LiteralPath $moved) { throw "Old copy still present at $moved; delete by hand after checking." }
  Write-Step "Old copy removed. Free after: source drive $(Get-FreeGB $From) GB, target drive $(Get-FreeGB $To) GB."
  Write-Step 'Done. The board needs no config change: board.config.json keeps the old path.'
  exit 0
} catch {
  Write-Step "STOPPED: $($_.Exception.Message)"
  exit 1
}
