# PowerShell consumes a bare -- when calling a script (but not with pwsh -File).
# Restore it from the invocation syntax; quoted/splatted -- is already in $args.
$forwardArgs = [System.Collections.Generic.List[object]]::new([object[]] $args)
if ($MyInvocation.Statement) {
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($MyInvocation.Statement, [ref] $null, [ref] $null)
    $command = $ast.Find({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true)
    $index = 0
    foreach ($element in $command.CommandElements | Select-Object -Skip 1) {
        if ($element -is [System.Management.Automation.Language.CommandParameterAst] -and $element.Extent.Text -eq '--') {
            $forwardArgs.Insert($index, '--')
            break
        }
        $index += if ($element -is [System.Management.Automation.Language.VariableExpressionAst] -and $element.Splatted) {
            @($ExecutionContext.SessionState.PSVariable.GetValue($element.VariablePath.UserPath)).Count
        } else { 1 }
    }
}
& node "$PSScriptRoot/npm-guard.mjs" @forwardArgs
exit $LASTEXITCODE
