param(
    [ValidateSet('Check','Install','Remove','Pause','Resume','Status')][string]$Action = 'Check',
    [Parameter(Mandatory)][string]$ConfigPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'RuntimeRecoveryPolicy.ps1')
if (-not $IsWindows -or $PSVersionTable.PSVersion -lt [version]'7.5') { throw 'PowerShell 7.5 or newer on Windows is required.' }
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json -AsHashtable -DateKind String
foreach ($key in @('tunnelClientPath','tunnelStateDir','nodePath','launcherRoot','connectScript','powerShellPath','outputDir')) {
    if (-not [IO.Path]::IsPathFullyQualified([string]$config[$key]) -or [string]$config[$key] -match '["\r\n]') { throw "Invalid $key" }
}
if ($config.alias -cnotmatch '^[a-z0-9][a-z0-9-]{0,62}$' -or -not $config.connectTaskName -or -not $config.watchdogTaskName) { throw 'Invalid task configuration.' }
if ($ConfigPath -match '["\r\n]') { throw 'Invalid config path.' }
$statusPath = Join-Path $config.outputDir 'status.json'
$pausePath = Join-Path $config.outputDir 'paused.json'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $PSCommandPath + '" -Action Check -ConfigPath "' + $ConfigPath + '"'

function Test-OwnedPrincipal($Task) {
    try {
        $value=[string]$Task.Principal.UserId
        $sid=if ($value -match '^S-1-') { [Security.Principal.SecurityIdentifier]::new($value) }
             else { [Security.Principal.NTAccount]::new($value).Translate([Security.Principal.SecurityIdentifier]) }
        return $sid.Equals([Security.Principal.WindowsIdentity]::GetCurrent().User) -and
            [string]$Task.Principal.LogonType -in @('Interactive','3') -and [string]$Task.Principal.RunLevel -in @('Limited','0')
    } catch { return $false }
}

function Get-OwnedConnectTask {
    $task = Get-ScheduledTask -TaskPath '\' -TaskName $config.connectTaskName -ErrorAction SilentlyContinue
    if (-not $task -or $task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ine $config.powerShellPath -or
        $task.Actions[0].Arguments -cne $config.connectTaskArguments -or
        -not $task.Actions[0].Arguments.Contains('"' + $config.connectScript + '"') -or
        $task.Actions[0].Arguments -notmatch '(?i)-Action\s+Connect(?:\s|$)' -or
        $task.Actions[0].Arguments -notmatch '(?i)\s-RespectRecoveryPause(?:\s|$)' -or
        -not (Test-OwnedPrincipal $task)) { throw 'Connect task identity differs.' }
    return $task
}
function Test-OwnedWatchdogTask($Task) {
    return $Task -and $Task.Actions.Count -eq 1 -and $Task.Actions[0].Execute -ieq $config.powerShellPath -and
        $Task.Actions[0].Arguments -ceq $arguments -and
        (Test-OwnedPrincipal $Task)
}
function Save-WatchdogStatus([hashtable]$Value) {
    $temporary = Join-Path $config.outputDir ('status-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $statusPath -Force
}
function Get-RuntimeStatus {
    # Keep raw CLI output only in memory: it can include a log tail with tool data.
    $start = [Diagnostics.ProcessStartInfo]::new($config.tunnelClientPath)
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    foreach ($arg in @('runtimes','status',$config.alias,'--json')) { $start.ArgumentList.Add($arg) }
    $start.Environment['TUNNEL_CLIENT_STATE_DIR']=$config.tunnelStateDir
    $process = [Diagnostics.Process]::new(); $process.StartInfo=$start
    try {
        if (-not $process.Start()) { return $null }
        $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) { $process.Kill(); return $null }
        $text=$stdout.GetAwaiter().GetResult(); $null=$stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0 -or $text.Length -gt 2000000) { return $null }
        return $text | ConvertFrom-Json -AsHashtable -DateKind String
    } catch { return $null } finally { $process.Dispose() }
}

if ($Action -eq 'Status') {
    if (Test-Path -LiteralPath $statusPath) { Get-Content -LiteralPath $statusPath -Raw }
    return
}
if ($Action -eq 'Remove') {
    $task = Get-ScheduledTask -TaskPath '\' -TaskName $config.watchdogTaskName -ErrorAction SilentlyContinue
    if ($task) {
        if (-not (Test-OwnedWatchdogTask $task)) { throw 'Watchdog task identity differs.' }
        New-Item -ItemType Directory -Force -Path $config.outputDir | Out-Null
        @{ pausedAt=[DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $pausePath -Encoding utf8
        Stop-ScheduledTask -TaskPath '\' -TaskName $config.watchdogTaskName
        Unregister-ScheduledTask -TaskPath '\' -TaskName $config.watchdogTaskName -Confirm:$false
    }
    return
}
New-Item -ItemType Directory -Force -Path $config.outputDir | Out-Null
if ($Action -eq 'Pause') {
    @{ pausedAt=[DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $pausePath -Encoding utf8
    return
}
if ($Action -eq 'Resume') { Remove-Item -LiteralPath $pausePath -Force -ErrorAction SilentlyContinue; return }
if ($Action -eq 'Install') {
    $connectTask=Get-OwnedConnectTask
    if ([int]$connectTask.Settings.RestartCount -ne 0) { throw 'Disable Connect task failure retries before enabling the watchdog retry policy.' }
    if (Get-ScheduledTask -TaskPath '\' -TaskName $config.watchdogTaskName -ErrorAction SilentlyContinue) { throw 'Watchdog task already exists; inspect or remove it explicitly.' }
    $userId=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    $taskAction=New-ScheduledTaskAction -Execute $config.powerShellPath -Argument $arguments -WorkingDirectory $PSScriptRoot
    $trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $logon=New-ScheduledTaskTrigger -AtLogOn -User $userId
    $logon.Delay='PT45S'
    $principal=New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 50)
    Register-ScheduledTask -TaskPath '\' -TaskName $config.watchdogTaskName -Action $taskAction -Trigger @($trigger,$logon) -Principal $principal -Settings $settings -Description 'Checks for an absent Desktop Commander runtime; bounded recovery through its owned connect task. No MCP calls or termination of running services.' | Select-Object TaskName,State
    return
}

$mutexId=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($ConfigPath.ToLowerInvariant())))
$mutex=[Threading.Mutex]::new($false, 'Local\DesktopCommanderWatchdog-' + $mutexId)
$locked=$false
try {
    try { $locked=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked=$true }
    if (-not $locked) { return }
    $previous=@{}
    if (Test-Path -LiteralPath $statusPath) {
        $previous=Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json -AsHashtable -DateKind String
        if ($previous -isnot [hashtable]) { throw 'Invalid previous watchdog status; recovery disabled.' }
    }
    $now=[DateTimeOffset]::UtcNow
    $observation=@{ paused=(Test-Path -LiteralPath $pausePath); statusKnown=$false; running=$false; healthy=$false; pidAbsentConfirmed=$false; targetMatches=$false }
    $runtimePid=$null
    if (-not $observation.paused) {
        $runtime=Get-RuntimeStatus
        if ($runtime -is [hashtable] -and $runtime['alias'] -ceq $config.alias -and $runtime['process'] -is [hashtable] -and
            ($runtime['process']['pid'] -is [long] -or $runtime['process']['pid'] -is [int])) {
            $runtimePid=0
            $null=[int]::TryParse([string]$runtime['process']['pid'], [ref]$runtimePid)
            if ($runtimePid -gt 0) {
                $owned=Get-CimInstance Win32_Process -Filter "ProcessId=$runtimePid" -ErrorAction Stop
                $target=[string]$runtime['process']['target_value']
                $normalized=$target.Replace('/','\')
                $expectedNode='"' + $config.nodePath.Replace('/','\') + '" '
                $launcherPrefix='"' + $config.launcherRoot.TrimEnd('\','/').Replace('/','\') + '\'
                $observation.targetMatches=$normalized.StartsWith($expectedNode + $launcherPrefix,[StringComparison]::OrdinalIgnoreCase) -and
                    $normalized.EndsWith('\local\start-local.mjs"',[StringComparison]::OrdinalIgnoreCase) -and
                    $normalized -notmatch '\\\.\.?\\'
                $observation.pidAbsentConfirmed=$null -eq $owned
                $observation.running=$null -ne $owned -and $owned.ExecutablePath -ieq $config.tunnelClientPath
                $observation.healthy=$runtime['healthy'] -eq $true -and $runtime['ready'] -eq $true
                $observation.statusKnown=$runtime['process_running'] -is [bool]
                if ($null -ne $owned -and -not $observation.running) { $observation.statusKnown=$false }
                if ($runtime['process_running'] -eq $true -and $observation.pidAbsentConfirmed) { $observation.statusKnown=$false }
            }
        }
    }
    $decision=Get-RuntimeRecoveryDecision -Observation $observation -Previous $previous -Now $now
    $decision.observedAt=$now.ToString('o'); $decision.runtimePid=$runtimePid
    $decision.paused=$observation.paused; $decision.runtimeRunning=$observation.running
    $decision.targetMatches=$observation.targetMatches; $decision.statusKnown=$observation.statusKnown
    Save-WatchdogStatus $decision
    if ($decision.action -eq 'start_connect_task') {
        # Recheck pause and task ownership immediately before the only recovery action.
        if (Test-Path -LiteralPath $pausePath) { return }
        $task=Get-OwnedConnectTask
        # An overlapping manual Connect may already have restored a different PID.
        $latest=Get-RuntimeStatus
        if ($latest -isnot [hashtable] -or $latest['alias'] -cne $config.alias -or
            $latest['process_running'] -isnot [bool] -or $latest['process_running'] -or
            $latest['process'] -isnot [hashtable] -or $latest['process']['pid'] -ne $runtimePid -or
            $latest['process']['target_value'] -cne $runtime['process']['target_value']) { return }
        if (Get-CimInstance Win32_Process -Filter "ProcessId=$runtimePid" -ErrorAction Stop) { return }
        if (Test-Path -LiteralPath $pausePath) { return }
        if ([string]$task.State -ne 'Running') { Start-ScheduledTask -TaskPath '\' -TaskName $config.connectTaskName }
    }
    if ($decision.code -ne $previous['code'] -or $decision.action -ne 'none') {
        $journal=Join-Path $config.outputDir 'events.jsonl'
        if ((Test-Path -LiteralPath $journal) -and (Get-Item -LiteralPath $journal).Length -ge 1MB) {
            Move-Item -LiteralPath $journal -Destination ($journal + '.1') -Force
        }
        $decision | ConvertTo-Json -Compress -Depth 8 | Add-Content -LiteralPath $journal -Encoding utf8
    }
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
