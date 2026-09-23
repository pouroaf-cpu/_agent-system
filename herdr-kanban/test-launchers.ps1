# Offline regression check: captures commands; never launches HERDR or Codex agents.
$ErrorActionPreference = 'Stop'
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
$userRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$projectsPath = Join-Path $userRoot 'Projects'
$scripts = @('herdr-roles.ps1','herdr-spawn.ps1','herdr-crew.ps1','Projects\aimenu.ps1','Projects\herdr-kanban\kanban.ps1')
foreach ($relative in $scripts) {
    $parseErrors = $null
    $source = Get-Content (Join-Path $userRoot $relative) -Raw -Encoding UTF8
    $tree = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$parseErrors)
    Assert ($parseErrors.Count -eq 0) "$relative syntax errors: $parseErrors"
    if ($relative -eq 'Projects\aimenu.ps1') { $menuTree = $tree }
}
. (Join-Path $userRoot 'herdr-roles.ps1')
$script:calls = @()
function Invoke-Herdr { param([string[]]$HerdrArgs) $script:calls += ,$HerdrArgs }
foreach ($key in $HerdrRoles.Keys) {
    $script:calls = @()
    Start-HerdrRoleAgent -RoleKey $key -PaneId 'test:p1' -Project Injectbuddy -ProjDir (Join-Path $projectsPath 'Injectbuddy') -Label $key -AgentName "test-$key"
    $start = $script:calls[1]
    $expectedModel = 'gpt-5.5'
    Assert ($start[$start.IndexOf('--kind') + 1] -eq 'codex') "$key engine"
    Assert ($start -contains '--dangerously-bypass-approvals-and-sandbox') "$key bypass"
    Assert ($start[$start.IndexOf('--model') + 1] -eq $expectedModel) "$key model"
    Assert ($start -contains 'check_for_update_on_startup=false') "$key update check"
    Assert ($start -contains ('model_reasoning_effort="{0}"' -f $HerdrRoles[$key].Effort)) "$key reasoning"
    Assert ($script:calls[2][3] -match [regex]::Escape($HerdrRoles[$key].RoleFile)) "$key role prompt"
}
$HerdrRoles.reviewer.Model = 'gpt-6-astra'
$blocked = $false
try {
    Start-HerdrRoleAgent -RoleKey reviewer -PaneId 'test:p1' -Project Injectbuddy -ProjDir (Join-Path $projectsPath 'Injectbuddy') -Label reviewer -AgentName test-reviewer
} catch {
    $blocked = $_.Exception.Message -match 'gpt-5.5'
}
Assert $blocked 'Astra reviewer launch must be rejected before HERDR start'
$HerdrRoles.reviewer.Model = 'gpt-5.5'
# Load only menu definitions and role assignments, skipping cleanup, SSH and interactive loop.
foreach ($statement in $menuTree.EndBlock.Statements) {
    $source = $statement.Extent.Text
    if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst] -or
        $source.StartsWith('$Roles =') -or $source.StartsWith('foreach ($role in $Roles.Values)') -or
        $source.StartsWith('$Roles[')) { Invoke-Expression $source }
}
Assert ($Roles.Count -eq 9) 'Menu roles missing'
foreach ($role in $Roles.Values) { Assert ($role.Engine -eq 'codex') "$($role.Name) menu engine" }
Assert ($Roles['2'].MacModel -eq 'claude-opus-4-6') 'Mac model must remain compatible with its remote script'
function Test-CommandExists { return $true }
function Start-Sleep { param($Milliseconds) }
function New-AITab { param($TabTitle, $WorkingDir, $Command, $ProfileName) $script:launchCommand = $Command }
function codex { $script:codexArgs = $args }
$AgentWords = @('test')
foreach ($role in $Roles.Values) {
    Start-CodexSession -Role $role -ProjectName PFrew -Folder "C:\Users\PFrew\test's folder" -WtProfile '' -IsHome $true
    Invoke-Expression $script:launchCommand
    $expectedModel = 'gpt-5.5'
    Assert ($script:codexArgs -contains '--dangerously-bypass-approvals-and-sandbox') 'Menu bypass missing'
    Assert ($script:codexArgs -contains $expectedModel) 'Menu model missing'
    Assert ($script:codexArgs -contains "C:\Users\PFrew\test's folder") 'Folder quoting broken'
    if ($role.Key -eq 'orchestrator') {
        Assert ($script:codexArgs[-1] -match 'ORCHESTRATOR.md') 'Orchestrator brief missing'
        Assert ($script:codexArgs[-1] -match 'primary controller') 'Competing controller guard missing'
    }
}
Assert ($HerdrRoles.kanban.FixedName -eq 'kanban-observer') 'Kanban fixed HERDR name missing'
Assert ((Get-Content (Join-Path $userRoot 'herdr-spawn.ps1') -Raw) -match 'FixedName') 'HERDR spawn must reuse fixed kanban-observer'
Write-Output 'PASS: five scripts parse; all nine HERDR/menu roles use Codex full bypass; role prompts, model and path quoting verified without starting agents.'
