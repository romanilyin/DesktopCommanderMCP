param([switch]$Browser)
. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-WindowsPowerShell7
$config = Get-LocalConfig
$keyPath = Join-Path (Get-RepoRoot) '.local/state/runtime-key.dpapi'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $keyPath) | Out-Null
if ($Browser) {
    Assert-ExecutablePath $config.nodePath 'Node.js'
    $helper = Join-Path (Get-LocalRoot) 'key-entry.mjs'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw "Missing browser helper: $helper" }
    & $config.nodePath $helper
    Assert-ExitCode 'browser key entry'
    return
}
$secureKey = Read-Host 'Paste the OpenAI runtime API key for this PC' -AsSecureString
try {
    if ($secureKey.Length -lt 8) { throw 'The runtime key is too short.' }
    $encrypted = ConvertFrom-SecureString -SecureString $secureKey
    # DPAPI uses this Windows user account; no portable encryption key is supplied.
    Set-Content -LiteralPath $keyPath -Value $encrypted -Encoding ascii -NoNewline
    Write-Host 'Runtime key saved with Windows DPAPI for this user.'
} finally { $secureKey.Dispose() }
