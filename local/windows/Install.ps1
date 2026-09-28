param(
    [Parameter(Mandatory)][ValidatePattern('^tunnel_[a-fA-F0-9]{32}$')][string]$TunnelId,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Name,
    [string]$Alias,
    [string]$NodePath,
    [string]$TunnelClientPath
)
. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-WindowsPowerShell7

function Get-OfficialArchive([string]$BaseUrl, [string]$ArchiveName, [string]$ChecksumName, [string]$Destination) {
    $scratch = Join-Path ([IO.Path]::GetTempPath()) ('desktop-commander-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $scratch | Out-Null
    try {
        $zip = Join-Path $scratch $ArchiveName
        $sums = Join-Path $scratch $ChecksumName
        Invoke-WebRequest -Uri "$BaseUrl/$ArchiveName" -OutFile $zip
        Invoke-WebRequest -Uri "$BaseUrl/$ChecksumName" -OutFile $sums
        $escaped = [regex]::Escape($ArchiveName)
        $line = Get-Content -LiteralPath $sums | Where-Object { $_ -match "^([A-Fa-f0-9]{64})\s+\*?$escaped$" } | Select-Object -First 1
        if (-not $line) { throw "Official checksum for $ArchiveName was not found." }
        $expected = [regex]::Match($line, '^([A-Fa-f0-9]{64})').Groups[1].Value
        $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
        if ($actual -ine $expected) { throw "SHA-256 verification failed for $ArchiveName." }
        Expand-Archive -LiteralPath $zip -DestinationPath $Destination
    } finally {
        Assert-ChildPath $scratch ([IO.Path]::GetTempPath())
        Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$localRoot = Get-RepoRoot
$configDir = Join-Path $localRoot '.local'
$configPath = Join-Path $configDir 'config.json'
$runtimeDir = Join-Path $configDir 'runtime'
$nodeVersion = '24.21.0'
$tunnelVersion = 'v0.0.15'
if (-not $Alias) {
    $Alias = ($env:COMPUTERNAME.ToLowerInvariant() -replace '[^a-z0-9-]', '-').Trim('-')
    $Alias = "desktop-commander-$Alias"
}
if ($Alias -cnotmatch '^[a-z0-9][a-z0-9-]{0,62}$') { throw 'Alias must contain 1–63 lowercase letters, digits, or hyphens and start with a letter or digit.' }
if ($Name -match '[\r\n]' -or $Name.Length -gt 120) { throw 'Name must be a single line of at most 120 characters.' }

if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $existing = Get-LocalConfig
    if ($existing.tunnelId -cne $TunnelId) { throw "This checkout is configured for tunnel $($existing.tunnelId). Use a separate checkout for a different PC/tunnel." }
    if ($PSBoundParameters.ContainsKey('Alias') -and $existing.alias -cne $Alias) { throw 'Existing alias differs. The saved local configuration was left unchanged.' }
    if ($PSBoundParameters.ContainsKey('NodePath') -and $existing.nodePath -cne $NodePath) { throw 'Existing Node.js path differs. The saved local configuration was left unchanged.' }
    if ($PSBoundParameters.ContainsKey('TunnelClientPath') -and $existing.tunnelClientPath -cne $TunnelClientPath) { throw 'Existing tunnel client path differs. The saved local configuration was left unchanged.' }
    $config = $existing
} else {
    New-Item -ItemType Directory -Force -Path $configDir,$runtimeDir,(Join-Path $configDir 'state') | Out-Null
    if ($NodePath) {
        $NodePath = [IO.Path]::GetFullPath($NodePath)
        Assert-ExecutablePath $NodePath 'Node.js'
    } else {
        $nodeHome = Join-Path $runtimeDir "node-v$nodeVersion-win-x64"
        $NodePath = Join-Path $nodeHome 'node.exe'
        if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
            if (Test-Path -LiteralPath $nodeHome) { throw "Incomplete Node.js runtime at $nodeHome. Move it aside before retrying." }
            $staging = Join-Path $runtimeDir ('node-staging-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $staging | Out-Null
            try {
                Get-OfficialArchive "https://nodejs.org/download/release/v$nodeVersion" "node-v$nodeVersion-win-x64.zip" 'SHASUMS256.txt' $staging
                $expandedHome = Join-Path $staging "node-v$nodeVersion-win-x64"
                if (-not (Test-Path -LiteralPath (Join-Path $expandedHome 'node.exe') -PathType Leaf)) { throw 'Node.js archive did not contain node.exe.' }
                Assert-ChildPath $expandedHome $staging
                Assert-ChildPath $nodeHome $runtimeDir
                Move-Item -LiteralPath $expandedHome -Destination $nodeHome
            } finally {
                Assert-ChildPath $staging $runtimeDir
                Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
    $npmCli = Join-Path (Split-Path -Parent $NodePath) 'node_modules/npm/bin/npm-cli.js'
    if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) { throw "Node.js installation lacks npm: $npmCli" }

    if ($TunnelClientPath) {
        $TunnelClientPath = [IO.Path]::GetFullPath($TunnelClientPath)
        Assert-ExecutablePath $TunnelClientPath 'tunnel client'
    } else {
        $tunnelHome = Join-Path $runtimeDir "tunnel-client-$tunnelVersion-windows-amd64"
        $TunnelClientPath = Join-Path $tunnelHome 'tunnel-client.exe'
        if (-not (Test-Path -LiteralPath $TunnelClientPath -PathType Leaf)) {
            if (Test-Path -LiteralPath $tunnelHome) { throw "Incomplete tunnel client at $tunnelHome. Move it aside before retrying." }
            $staging = Join-Path $runtimeDir ('tunnel-staging-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $staging | Out-Null
            try {
                $archive = "tunnel-client-$tunnelVersion-windows-amd64.zip"
                Get-OfficialArchive "https://github.com/openai/tunnel-client/releases/download/$tunnelVersion" $archive 'SHA256SUMS.txt' $staging
                $expandedExe = Get-ChildItem -LiteralPath $staging -Filter 'tunnel-client.exe' -File -Recurse | Select-Object -First 1
                if (-not $expandedExe) { throw 'Tunnel client archive did not contain tunnel-client.exe.' }
                $expandedHome = Split-Path -Parent $expandedExe.FullName
                Assert-ChildPath $tunnelHome $runtimeDir
                if ($expandedHome -eq $staging) {
                    Assert-ChildPath $staging $runtimeDir
                    Move-Item -LiteralPath $staging -Destination $tunnelHome
                    $staging = $null
                } else {
                    Assert-ChildPath $expandedHome $staging
                    Move-Item -LiteralPath $expandedHome -Destination $tunnelHome
                }
            } finally {
                if ($staging -and (Test-Path -LiteralPath $staging)) {
                    Assert-ChildPath $staging $runtimeDir
                    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }

    $pwshPath = (Get-Process -Id $PID).Path
    Assert-ExecutablePath $pwshPath 'PowerShell 7'
    $config = [ordered]@{
        schemaVersion = 1
        name = $Name
        alias = $Alias
        tunnelId = $TunnelId
        nodePath = $NodePath
        tunnelClientPath = $TunnelClientPath
        powerShellPath = $pwshPath
    }
    $config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8 -NoNewline
}
& (Join-Path $PSScriptRoot 'Build.ps1')
Write-Host "Installed $($config.name) with alias $($config.alias). Next: run local/windows/Save-Key.ps1, then local/windows/Tunnel.ps1 -Action Connect."
