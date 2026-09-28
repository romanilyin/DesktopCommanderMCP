. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-WindowsPowerShell7
$config = Get-LocalConfig
$taskName = "Desktop Commander ($($config.alias))"
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $existing) { Write-Host "No autostart task found for $($config.alias)."; return }
$expectedScript = Join-Path $PSScriptRoot 'Tunnel.ps1'
if ($existing.Actions.Count -ne 1 -or -not $existing.Actions[0].Arguments.Contains('"' + $expectedScript + '"')) {
    throw "Task $taskName does not point to this checkout; it was left unchanged."
}
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Removed autostart task $taskName."
