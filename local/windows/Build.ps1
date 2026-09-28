. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-WindowsPowerShell7
$config = Get-LocalConfig
Assert-ExecutablePath $config.nodePath 'Node.js'
$nodeDir = Split-Path -Parent $config.nodePath
$npmCli = Join-Path $nodeDir 'node_modules/npm/bin/npm-cli.js'
if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) { throw "npm CLI missing: $npmCli" }
$originalPath = $env:PATH
$originalTelemetry = $env:DESKTOP_COMMANDER_DISABLE_TELEMETRY
$originalNpmCache = $env:NPM_CONFIG_CACHE
$env:PATH = "$nodeDir;$originalPath"
$env:DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1'
$env:NPM_CONFIG_CACHE = Join-Path (Get-RepoRoot) '.local/state/npm-cache'
New-Item -ItemType Directory -Force -Path $env:NPM_CONFIG_CACHE | Out-Null
Push-Location (Get-RepoRoot)
try {
    & $config.nodePath $npmCli ci --include=dev --ignore-scripts
    Assert-ExitCode 'npm ci'
    & $config.nodePath $npmCli rebuild '@vscode/ripgrep' esbuild sharp
    Assert-ExitCode 'npm rebuild'
    & $config.nodePath $npmCli run build
    Assert-ExitCode 'npm run build'
} finally {
    Pop-Location
    $env:PATH = $originalPath
    $env:DESKTOP_COMMANDER_DISABLE_TELEMETRY = $originalTelemetry
    $env:NPM_CONFIG_CACHE = $originalNpmCache
}
