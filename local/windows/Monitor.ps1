param(
    [ValidateSet('Start','Stop','Status','InstallAutostart','RemoveAutostart')][string]$Action = 'Status',
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
    $processInfo = Get-OwnedMonitor (Get-MonitorStatus)
    if ($null -eq $processInfo) { Write-Host 'No matching monitor process is running.'; return }
    # Only the verified observer process is stopped; it has no MCP child process.
    Stop-Process -Id $processInfo.ProcessId -ErrorAction Stop
    Write-Host "Stopped monitor $($processInfo.ProcessId). The MCP tunnel is unchanged."
    return
}

if ($Action -eq 'RemoveAutostart') {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        $expectedScript = Quote-NativePath $PSCommandPath
        $matched = @($task.Actions | Where-Object {
            $_.Arguments.Contains($expectedScript, [StringComparison]::OrdinalIgnoreCase) -and
            $_.Arguments.Contains($configArg, [StringComparison]::OrdinalIgnoreCase)
        })
        if ($matched.Count -ne 1) { throw 'Task identity differs; refusing to remove it.' }
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    Write-Host "Monitor autostart removed: $TaskName"
    return
}

if (-not $NodePath) { throw 'Provide -NodePath when using a custom -ConfigPath.' }
Assert-NodeVersion $NodePath
Assert-ExecutablePath $scriptPath 'monitor script'
$nodeArg = Quote-NativePath $NodePath

if ($Action -eq 'InstallAutostart') {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        throw "Scheduled task $TaskName already exists; inspect it or remove it explicitly first."
    }
    $pwsh = (Get-Process -Id $PID).Path
    $userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File ' + (Quote-NativePath $PSCommandPath) +
        ' -Action Start -ConfigPath ' + $configArg + ' -NodePath ' + $nodeArg
    $taskAction = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory (Get-LocalRoot)
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    $trigger.Delay = 'PT25S'
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Description 'Starts passive local MCP diagnostics without calling MCP tools or restarting the tunnel.' | Select-Object TaskName,State
    return
}

$existing = Get-OwnedMonitor (Get-MonitorStatus)
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
