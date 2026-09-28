Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-WindowsPowerShell7 {
    if (-not $IsWindows -or $PSVersionTable.PSVersion.Major -lt 7) {
        throw 'Windows and PowerShell 7 or newer are required.'
    }
}

function Get-LocalRoot {
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
}

function Get-RepoRoot {
    return (Resolve-Path -LiteralPath (Join-Path (Get-LocalRoot) '..')).Path
}

function Get-LocalConfig {
    $path = Join-Path (Get-RepoRoot) '.local/config.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing $path. Run local/windows/Install.ps1 first." }
    $config = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($config.schemaVersion -ne 1 -or $config.tunnelId -cnotmatch '^tunnel_[a-fA-F0-9]{32}$') { throw 'Invalid local configuration.' }
    if ($config.alias -cnotmatch '^[a-z0-9][a-z0-9-]{0,62}$') { throw 'Invalid tunnel alias in local configuration.' }
    foreach ($field in @('nodePath','tunnelClientPath','powerShellPath')) {
        if (-not [IO.Path]::IsPathFullyQualified([string]$config.$field)) { throw "Invalid $field in local configuration." }
    }
    return $config
}

function Assert-ExecutablePath([string]$Path, [string]$Label) {
    if (-not [IO.Path]::IsPathFullyQualified($Path) -or $Path -match '["\r\n]' -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Invalid or missing $Label path: $Path"
    }
}

function Assert-ExitCode([string]$Operation) {
    if ($LASTEXITCODE -ne 0) { throw "$Operation failed (exit code $LASTEXITCODE)." }
}

function Assert-NodeVersion([string]$NodePath) {
    Assert-ExecutablePath $NodePath 'Node.js'
    $reportedVersion = & $NodePath --version
    Assert-ExitCode 'Node.js version check'
    if ([string]$reportedVersion -notmatch '^v(\d+)\.(\d+)\.(\d+)$') {
        throw "Unrecognized Node.js version: $reportedVersion"
    }
    $version = [version]($Matches[1] + '.' + $Matches[2] + '.' + $Matches[3])
    if ($version -lt [version]'22.12.0') {
        throw "Node.js 22.12.0 or newer is required; found $reportedVersion. Use the installer's pinned runtime or provide a supported -NodePath."
    }
}

function Assert-ChildPath([string]$Target, [string]$Parent) {
    $resolvedParent = (Resolve-Path -LiteralPath $Parent).Path.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    if (Test-Path -LiteralPath $Target) {
        $resolvedTarget = (Resolve-Path -LiteralPath $Target).Path
    } else {
        $targetParent = (Resolve-Path -LiteralPath (Split-Path -Parent $Target)).Path
        $resolvedTarget = Join-Path $targetParent (Split-Path -Leaf $Target)
    }
    $resolvedTarget = [IO.Path]::GetFullPath($resolvedTarget)
    if (-not $resolvedTarget.StartsWith($resolvedParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside expected directory: $Target"
    }
}
