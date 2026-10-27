import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Connect enables the supported initialized shim and restores caller environment on success and failure',
  {skip: process.platform !== 'win32'}, async () => {
    const parent = path.join(repo, '.local/tmp');
    await fs.mkdir(parent, {recursive: true});
    const dir = await fs.realpath(await fs.mkdtemp(path.join(parent, 'tunnel-init-')));
    try {
      await fs.copyFile(path.join(repo, 'local/windows/Tunnel.ps1'), path.join(dir, 'Tunnel.ps1'));
      await fs.writeFile(path.join(dir, 'start-local.mjs'), '// not executed\n');
      await fs.writeFile(path.join(dir, 'Common.ps1'), `
        $ErrorActionPreference='Stop'
        function Assert-WindowsPowerShell7 {}
        function Assert-ExecutablePath($Path,$Label) {}
        function Assert-NodeVersion($Path) {}
        function Get-RepoRoot { $env:TUNNEL_INIT_DIR }
        function Get-LocalRoot { $env:TUNNEL_INIT_DIR }
        function Get-LocalConfig { @{
          alias='fixture';tunnelId='tunnel_00000000000000000000000000000000';
          nodePath=$env:TUNNEL_INIT_NODE;tunnelClientPath=(Join-Path $env:TUNNEL_INIT_DIR 'fake-cli.ps1')
        } }
        function Assert-ExitCode($Label) { if($LASTEXITCODE) { throw 'fixture CLI failed' } }
      `);
      await fs.writeFile(path.join(dir, 'fake-cli.ps1'), `
        @{verb=$args[0];shim=$env:MCP_STDIO_SEND_INITIALIZED_NOTIFICATION} |
          ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $env:TUNNEL_INIT_DIR 'calls.jsonl')
        $global:LASTEXITCODE=if($env:TUNNEL_INIT_FAIL -eq '1'){7}else{0}
      `);
      const script = `
        $ErrorActionPreference='Stop'
        $dir=$env:TUNNEL_INIT_DIR
        $state=Join-Path $dir '.local/state'
        New-Item -ItemType Directory -Path $state -Force | Out-Null
        # Synthetic test data encrypted with local DPAPI; no real key or network.
        ConvertTo-SecureString 'fixture-key-not-a-real-secret' -AsPlainText -Force |
          ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $state 'runtime-key.dpapi')
        $launch=Join-Path $dir 'Tunnel.ps1'
        $env:MCP_STDIO_SEND_INITIALIZED_NOTIFICATION='false'
        & $launch -Action Connect
        if($env:MCP_STDIO_SEND_INITIALIZED_NOTIFICATION -cne 'false') { throw 'Caller value changed' }
        Remove-Item Env:MCP_STDIO_SEND_INITIALIZED_NOTIFICATION
        & $launch -Action Connect
        if(Test-Path Env:MCP_STDIO_SEND_INITIALIZED_NOTIFICATION) { throw 'Absent caller value not restored' }
        $env:MCP_STDIO_SEND_INITIALIZED_NOTIFICATION='false'
        & $launch -Action Doctor
        & $launch -Action Stop
        & $launch -Action Connect -RespectRecoveryPause
        if($env:MCP_STDIO_SEND_INITIALIZED_NOTIFICATION -cne 'false') { throw 'Pause path changed caller value' }
        $env:TUNNEL_INIT_FAIL='1'
        try { & $launch -Action Connect; throw 'Expected fixture failure' }
        catch { if($_.Exception.Message -ne 'fixture CLI failed') { throw } }
        if($env:MCP_STDIO_SEND_INITIALIZED_NOTIFICATION -cne 'false') { throw 'Failure path changed caller value' }
        if(Test-Path Env:CONTROL_PLANE_API_KEY) { throw 'Synthetic key retained' }
        Get-Content -LiteralPath (Join-Path $dir 'calls.jsonl')
      `;
      const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: 15000,
        env: {...process.env, TUNNEL_INIT_DIR: dir, TUNNEL_INIT_NODE: process.execPath, TUNNEL_INIT_FAIL: '0'},
      });
      assert.equal(result.status, 0, result.stderr);
      const calls = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      assert.deepEqual(calls, [
        {verb: 'runtimes', shim: 'true'}, {verb: 'runtimes', shim: 'true'},
        {verb: 'doctor', shim: 'false'}, {verb: 'runtimes', shim: 'false'},
        {verb: 'runtimes', shim: 'true'},
      ]);
    } finally { await fs.rm(dir, {recursive: true, force: true}); }
  });
