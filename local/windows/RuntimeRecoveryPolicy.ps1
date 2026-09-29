function Get-RuntimeRecoveryDecision {
    param([hashtable]$Observation, [hashtable]$Previous, [DateTimeOffset]$Now)
    $attempts = @()
    foreach ($value in @($Previous['attempts'])) {
        $time = [DateTimeOffset]::MinValue
        if ([DateTimeOffset]::TryParse([string]$value, [ref]$time) -and $time -gt $Now.AddMinutes(-10)) {
            $attempts += $time.ToString('o')
        }
    }
    $result = @{ action='none'; code='status_unknown'; absentSince=$null; attempts=$attempts }
    if ($Observation['paused']) { $result.code='paused'; return $result }
    if (-not $Observation['statusKnown']) { return $result }
    if ($Observation['running']) {
        $result.code = if ($Observation['healthy']) { 'running' } else { 'running_degraded_no_restart' }
        return $result
    }
    if (-not $Observation['pidAbsentConfirmed'] -or -not $Observation['targetMatches']) {
        $result.code='identity_unconfirmed'; return $result
    }
    $first = $Now
    $parsed = [DateTimeOffset]::MinValue
    if ($Previous['code'] -in @('absence_pending','recovery_requested','recovery_cooldown') -and
        [DateTimeOffset]::TryParse([string]$Previous['absentSince'], [ref]$parsed) -and $parsed -le $Now) {
        $first = $parsed
    }
    $result.absentSince = $first.ToString('o')
    $result.code='absence_pending'
    if (($Now - $first).TotalSeconds -lt 30) { return $result }
    if ($attempts.Count -ge 3 -or @($attempts | Where-Object { [DateTimeOffset]$_ -gt $Now.AddSeconds(-60) }).Count) {
        $result.code='recovery_cooldown'; return $result
    }
    $result.code='recovery_requested'; $result.action='start_connect_task'
    $result.attempts = @($attempts) + @($Now.ToString('o'))
    return $result
}

