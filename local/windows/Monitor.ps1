param(
    [ValidateSet('Start','Stop','Status','InstallAutostart','UpdateAutostart','RemoveAutostart')][string]$Action = 'Status',
    [string]$ConfigPath,
    [string]$NodePath,
    [string]$TaskName
)
. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-WindowsPowerShell7

function Quote-NativePath([string]$Value) {
    if (-not [IO.Path]::IsPathFullyQualified($Value) -or $Value -match '["\r\n]') {
        throw "Expected an absolute path without quotes or line breaks: $Value"
    }
    return '"' + $Value + '"'
}

if (-not $ConfigPath) {
    $localConfig = Get-LocalConfig
    if (-not $NodePath) { $NodePath = $localConfig.nodePath }
    $state = Join-Path (Get-RepoRoot) '.local/state'
    $ConfigPath = Join-Path $state 'monitor-config.json'
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        New-Item -ItemType Directory -Force -Path $state | Out-Null
        @{
            healthUrlFile = Join-Path $state "tunnel/health/$($localConfig.alias).url"
            tunnelLogFile = Join-Path $state "tunnel/logs/$($localConfig.alias).log"
            outputDir = Join-Path $state 'monitor'
            intervalMs = 10000
        } | ConvertTo-Json | Set-Content -LiteralPath $ConfigPath -Encoding utf8
    }
}
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$configArg = Quote-NativePath $ConfigPath
$monitorConfig = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$outputDir = [string]$monitorConfig.outputDir
if (-not [IO.Path]::IsPathFullyQualified($outputDir)) { throw 'Monitor outputDir must be absolute.' }
$scriptPath = Join-Path (Get-LocalRoot) 'monitor.mjs'
$scriptArg = Quote-NativePath $scriptPath
$statusPath = Join-Path $outputDir 'status.json'

function Get-MonitorStatus {
    if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json }
    catch { return $null }
}

function Get-OwnedMonitor($Status) {
    if ($null -eq $Status -or -not $Status.PSObject.Properties['monitorPid']) { return $null }
    $monitorId = 0
    if (-not [int]::TryParse([string]$Status.monitorPid, [ref]$monitorId) -or $monitorId -le 0) { return $null }
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$monitorId" -ErrorAction SilentlyContinue
    if ($null -eq $processInfo -or $processInfo.Name -ine 'node.exe') { return $null }
    $command = [string]$processInfo.CommandLine
    if (-not $command.Contains($scriptArg, [StringComparison]::OrdinalIgnoreCase) -or
        -not $command.Contains($configArg, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    return $processInfo
}

$identity = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($ConfigPath.ToLowerInvariant()))).Substring(0, 12)
if (-not $TaskName) { $TaskName = "Desktop Commander Monitor - $identity" }

function Get-MonitorTask {
    return Get-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Get-TaskKind($Task) {
    if ($null -eq $Task -or @($Task.Actions).Count -ne 1) { return $null }
    $taskAction = @($Task.Actions)[0]
    $args = [string]$taskAction.Arguments
    $executable = [string]$taskAction.Execute
    $expectedDirect = $scriptArg + ' --config ' + $configArg
    if ([IO.Path]::IsPathFullyQualified($executable) -and
        [IO.Path]::GetFileName($executable) -ieq 'node.exe' -and
        $args.Equals($expectedDirect, [StringComparison]::OrdinalIgnoreCase)) { return 'direct' }

    $oldPrefix = '-NoProfile -NonInteractive -WindowStyle Hidden -File ' + (Quote-NativePath $PSCommandPath) +
        ' -Action Start -ConfigPath ' + $configArg + ' -NodePath '
    if ([IO.Path]::IsPathFullyQualified($executable) -and
        [IO.Path]::GetFileName($executable) -ieq 'pwsh.exe' -and
        $args.StartsWith($oldPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $oldNode = $args.Substring($oldPrefix.Length)
        if ($oldNode -match '^"([^"\r\n]+)"$' -and
            [IO.Path]::IsPathFullyQualified($Matches[1]) -and
            [IO.Path]::GetFileName($Matches[1]) -ieq 'node.exe') { return 'legacy' }
    }
    return $null
}

function Assert-OwnedTask($Task) {
    if ($null -eq $Task) { return $null }
    $kind = Get-TaskKind $Task
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $taskSid = $null
    try {
        $userId = [string]$Task.Principal.UserId
        if ($userId -match '^S-\d-\d+(?:-\d+)+$') {
            $taskSid = ([Security.Principal.SecurityIdentifier]::new($userId)).Value
        } elseif ($userId) {
            $taskSid = ([Security.Principal.NTAccount]::new($userId)).Translate([Security.Principal.SecurityIdentifier]).Value
        }
    } catch { $taskSid = $null }
    $logonType = [string]$Task.Principal.LogonType
    $runLevel = [string]$Task.Principal.RunLevel
    if (-not $kind -or $taskSid -ne $currentSid -or
        $logonType -notin @('Interactive','3') -or
        $runLevel -notin @('Limited','0')) {
        throw "Scheduled task $TaskName exists but does not match this monitor; refusing to change or run it."
    }
    return $kind
}

function New-MonitorTaskDefinition {
    $userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $taskAction = New-ScheduledTaskAction -Execute $NodePath -Argument ($scriptArg + ' --config ' + $configArg) -WorkingDirectory (Get-LocalRoot)
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    $trigger.Delay = 'PT25S'
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    return @{ Action = $taskAction; Trigger = $trigger; Principal = $principal; Settings = $settings }
}

if ($Action -eq 'Status') {
    $status = Get-MonitorStatus
    @{
        running = ($null -ne (Get-OwnedMonitor $status))
        taskName = $TaskName
        outputDir = $outputDir
        status = $status
    } | ConvertTo-Json -Depth 12
    return
}

if ($Action -eq 'Stop') {
    $task = Get-MonitorTask
    $kind = Assert-OwnedTask $task
    if ($kind -and [string]$task.State -eq 'Running') {
        Stop-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction Stop
        if ($kind -eq 'direct') {
            Write-Host "Stopped scheduled monitor task $TaskName. The MCP tunnel is unchanged."
            return
        }
    }
    $processInfo = Get-OwnedMonitor (Get-MonitorStatus)
    if ($null -eq $processInfo) { Write-Host 'No matching monitor process is running.'; return }
    # Only the verified observer process is stopped; it has no MCP child process.
    Stop-Process -Id $processInfo.ProcessId -ErrorAction Stop
    Write-Host "Stopped monitor $($processInfo.ProcessId). The MCP tunnel is unchanged."
    return
}

if ($Action -eq 'RemoveAutostart') {
    $task = Get-MonitorTask
    if ($task) {
        $kind = Assert-OwnedTask $task
        if ([string]$task.State -eq 'Running') {
            throw 'Stop the scheduled monitor before removing autostart.'
        }
        Unregister-ScheduledTask -TaskPath '\' -TaskName $TaskName -Confirm:$false
    }
    Write-Host "Monitor autostart removed: $TaskName"
    return
}

if (-not $NodePath) { throw 'Provide -NodePath when using a custom -ConfigPath.' }
Assert-NodeVersion $NodePath
Assert-ExecutablePath $scriptPath 'monitor script'
$nodeArg = Quote-NativePath $NodePath

if ($Action -eq 'InstallAutostart') {
    if (Get-MonitorTask) {
        throw "Scheduled task $TaskName already exists; inspect it or remove it explicitly first."
    }
    $definition = New-MonitorTaskDefinition
    Register-ScheduledTask -TaskPath '\' -TaskName $TaskName -Action $definition.Action -Trigger $definition.Trigger -Principal $definition.Principal -Settings $definition.Settings -Description 'Runs passive local MCP diagnostics without calling MCP tools or restarting the tunnel.' | Select-Object TaskName,State
    return
}

if ($Action -eq 'UpdateAutostart') {
    $task = Get-MonitorTask
    if (-not $task) { throw "Scheduled task $TaskName is missing; use InstallAutostart." }
    $kind = Assert-OwnedTask $task
    if ([string]$task.State -eq 'Running') {
        throw 'Stop the scheduled monitor before updating autostart.'
    }
    if (Get-OwnedMonitor (Get-MonitorStatus)) {
        throw 'A verified monitor is running. Stop it with -Action Stop, then update and start the task.'
    }
    $definition = New-MonitorTaskDefinition
    Set-ScheduledTask -TaskPath '\' -TaskName $TaskName -Action $definition.Action -Trigger $definition.Trigger -Principal $definition.Principal -Settings $definition.Settings | Select-Object TaskName,State
    return
}

$task = Get-MonitorTask
$kind = Assert-OwnedTask $task
if ($kind -eq 'legacy') { throw 'Legacy monitor task exists. Stop the monitor, run -Action UpdateAutostart, then -Action Start.' }
$existing = Get-OwnedMonitor (Get-MonitorStatus)
if ($kind -eq 'direct') {
    if ($existing -and [string]$task.State -ne 'Running') {
        throw 'A verified monitor is running outside the scheduled task. Stop it with -Action Stop, then start the task.'
    }
    if ([string]$task.State -eq 'Running') { Write-Host "Scheduled monitor task is already running: $TaskName"; return }
    Start-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction Stop
    Write-Host "Scheduled monitor task started: $TaskName. Check -Action Status for a fresh heartbeat."
    return
}
if ($existing) { Write-Host "Monitor is already running (PID $($existing.ProcessId))."; return }
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$child = Start-Process -FilePath $NodePath -ArgumentList ($scriptArg + ' --config ' + $configArg) -WindowStyle Hidden -PassThru -WorkingDirectory (Get-LocalRoot) -RedirectStandardOutput (Join-Path $outputDir 'launcher.stdout.log') -RedirectStandardError (Join-Path $outputDir 'launcher.stderr.log')
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    $child.Refresh()
    if ($child.HasExited) { throw "Monitor exited with code $($child.ExitCode). Inspect launcher.stderr.log." }
    $status = Get-MonitorStatus
    if ($null -ne $status -and $status.PSObject.Properties['monitorPid'] -and $status.monitorPid -eq $child.Id) {
        Write-Host "Monitor started (PID $($child.Id)). Reports: $outputDir"
        return
    }
}
Write-Host "Monitor process started (PID $($child.Id)); first report is still pending in $outputDir."
