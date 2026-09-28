. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-WindowsPowerShell7
$config = Get-LocalConfig
Assert-ExecutablePath $config.powerShellPath 'PowerShell 7'
$scriptPath = Join-Path $PSScriptRoot 'Tunnel.ps1'
if ($scriptPath -match '["\r\n]') { throw 'Script path contains unsupported characters.' }
$taskName = "Desktop Commander ($($config.alias))"
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $scriptPath + '" -Action Connect'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) { throw "Scheduled task $taskName already exists. Remove it explicitly before installing again." }
$action = New-ScheduledTaskAction -Execute $config.powerShellPath -Argument $arguments -WorkingDirectory (Get-RepoRoot)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$trigger.Delay = 'PT20S'
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Connects the local Desktop Commander tunnel at Windows logon.' | Select-Object TaskName,State
