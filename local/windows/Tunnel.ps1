param([ValidateSet('Connect','Status','Stop','Doctor')][string]$Action = 'Connect', [switch]$RespectRecoveryPause)
. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-WindowsPowerShell7
$config = Get-LocalConfig
Assert-ExecutablePath $config.tunnelClientPath 'tunnel client'
$localRoot = Get-LocalRoot
$stateDir = Join-Path (Get-RepoRoot) '.local/state'
$recoveryDir = Join-Path $stateDir 'watchdog'
$recoveryPause = Join-Path $recoveryDir 'paused.json'
if ($Action -eq 'Stop') {
    New-Item -ItemType Directory -Force -Path $recoveryDir | Out-Null
    @{ pausedAt=[DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $recoveryPause -Encoding utf8
} elseif ($Action -eq 'Connect') {
    if ($RespectRecoveryPause -and (Test-Path -LiteralPath $recoveryPause)) { return }
    if (-not $RespectRecoveryPause) { Remove-Item -LiteralPath $recoveryPause -Force -ErrorAction SilentlyContinue }
}
$profileDir = Join-Path $stateDir 'profiles'
$tunnelStateDir = Join-Path $stateDir 'tunnel'
New-Item -ItemType Directory -Force -Path $profileDir,$tunnelStateDir | Out-Null
$oldStateDir = $env:TUNNEL_CLIENT_STATE_DIR
$env:TUNNEL_CLIENT_STATE_DIR = $tunnelStateDir
try {
    if ($Action -eq 'Status') {
        & $config.tunnelClientPath runtimes status $config.alias --json
        Assert-ExitCode 'tunnel status'
        return
    }
    if ($Action -eq 'Stop') {
        & $config.tunnelClientPath runtimes stop $config.alias --json
        Assert-ExitCode 'tunnel stop'
        return
    }

    $keyPath = Join-Path $stateDir 'runtime-key.dpapi'
    if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) { throw 'Runtime key missing. Run local/windows/Save-Key.ps1 on this PC.' }
    $secureKey = (Get-Content -LiteralPath $keyPath -Raw).Trim() | ConvertTo-SecureString
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    try {
        $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
        if ($Action -eq 'Doctor') {
            & $config.tunnelClientPath doctor --profile $config.alias --profile-dir $profileDir --explain
            Assert-ExitCode 'tunnel doctor'
        } else {
            Assert-NodeVersion $config.nodePath
            $launcher = Join-Path $localRoot 'start-local.mjs'
            if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Missing launcher: $launcher" }
            if ($launcher -match '["\r\n]') { throw 'Launcher path contains unsupported characters.' }
            $mcpCommand = '"' + $config.nodePath.Replace('\','/') + '" "' + $launcher.Replace('\','/') + '"'
            & $config.tunnelClientPath runtimes connect --alias $config.alias --profile $config.alias --profile-dir $profileDir --runtime-api-key 'env:CONTROL_PLANE_API_KEY' --mcp-command $mcpCommand --tunnel-id $config.tunnelId --json
            Assert-ExitCode 'tunnel connect'
        }
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
        $secureKey.Dispose()
        Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    }
} finally {
    if ($null -eq $oldStateDir) { Remove-Item Env:TUNNEL_CLIENT_STATE_DIR -ErrorAction SilentlyContinue }
    else { $env:TUNNEL_CLIENT_STATE_DIR = $oldStateDir }
}
