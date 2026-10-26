import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const windows = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../windows');

test('hidden launcher waits, forwards failure and keeps PowerShell invisible', { skip: process.platform !== 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-hidden-launch-'));
  try {
    const probe = path.join(dir, 'RuntimeWatchdog.ps1');
    const output = path.join(dir, 'probe with spaces.json');
    await fs.writeFile(output, '{}');
    await fs.writeFile(probe, `
      param([string]$Action, [string]$ConfigPath)
      $ErrorActionPreference='Stop'
      Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class HiddenLaunchProbe {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
}
'@
      $visible=[HiddenLaunchProbe]::IsWindowVisible([HiddenLaunchProbe]::GetConsoleWindow())
      $foregroundPid=0u
      $null=[HiddenLaunchProbe]::GetWindowThreadProcessId([HiddenLaunchProbe]::GetForegroundWindow(),[ref]$foregroundPid)
      @{ action=$Action; consoleVisible=$visible; pid=$PID; foregroundPid=$foregroundPid } |
        ConvertTo-Json | Set-Content -LiteralPath $ConfigPath
      Start-Sleep -Milliseconds 1200
      exit 37
    `);
    const shell = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id $PID).Path'], { encoding: 'utf8', windowsHide: true });
    assert.equal(shell.status, 0, shell.stderr);
    const host = path.join(process.env.SystemRoot, 'System32', 'wscript.exe');
    const args = ['//B', '//NoLogo', path.join(windows, 'RuntimeWatchdogHidden.vbs'), shell.stdout.trim(), probe, output];
    const start = Date.now();
    const result = spawnSync(host, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 37, result.error?.message || result.stderr);
    assert.ok(Date.now() - start >= 1200, 'launcher must wait for PowerShell');
    const observation = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(observation.action, 'Check');
    assert.equal(observation.consoleVisible, false);
    assert.notEqual(observation.foregroundPid, observation.pid);
    assert.equal(spawnSync(host, args.slice(0, -1), { windowsHide: true, timeout: 5000 }).status, 64);
    assert.equal(spawnSync(host, [...args.slice(0, -1), output + '%'], { windowsHide: true, timeout: 5000 }).status, 64);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('hidden task migration accepts only owned actions and preserves other task fields', { skip: process.platform !== 'win32' }, async () => {
  // PowerShell expands 8.3 paths in $PSCommandPath/$PSScriptRoot (e.g. RUNNER~1 in CI).
  // Build the fixture's exact action arguments from the same resolved path.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dc-watchdog-migration-')));
  try {
    for (const name of ['RuntimeWatchdog.ps1', 'RuntimeWatchdogHidden.vbs', 'RuntimeRecoveryPolicy.ps1']) {
      await fs.copyFile(path.join(windows, name), path.join(dir, name));
    }
    const script = `
      $ErrorActionPreference='Stop'
      Set-StrictMode -Version Latest
      $dir=$env:WATCHDOG_MIGRATION_TEST_DIR
      $scriptPath=Join-Path $dir 'RuntimeWatchdog.ps1'
      $cfgPath=Join-Path $dir 'watchdog-config.json'
      $pwsh=(Get-Process -Id $PID).Path
      $cfg=@{tunnelClientPath=$pwsh;tunnelStateDir=$dir;nodePath=$pwsh;launcherRoot=$dir;
        connectScript=$scriptPath;powerShellPath=$pwsh;outputDir=$dir;alias='fixture';
        connectTaskName='fixture-connect';watchdogTaskName='fixture-watchdog';connectTaskArguments='unused'}
      $cfg | ConvertTo-Json | Set-Content -LiteralPath $cfgPath
      $oldArgs='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$scriptPath+'" -Action Check -ConfigPath "'+$cfgPath+'"'
      $hostPath=Join-Path ([Environment]::GetFolderPath('System')) 'wscript.exe'
      $newArgs='//B //NoLogo "'+(Join-Path $dir 'RuntimeWatchdogHidden.vbs')+'" "'+$pwsh+'" "'+$scriptPath+'" "'+$cfgPath+'"'
      Import-Module ScheduledTasks
      function Get-ScheduledTask { param($TaskPath,$TaskName,$ErrorAction) return $global:fixture }
      function Set-ScheduledTask { param($TaskPath,$TaskName,$Action)
        $global:updated=$true
        if ($PSBoundParameters.Count -ne 3 -or $TaskPath -cne '\\' -or $TaskName -cne 'fixture-watchdog') { throw 'Unexpected mutation' }
        if ($Action.Execute -ine $hostPath -or $Action.Arguments -cne $newArgs -or $Action.WorkingDirectory -ine $dir) { throw 'Wrong hidden action' }
        return $global:fixture }
      $results=@{}
      foreach($case in @('legacy','hidden','other-user','non-interactive','elevated','changed-executable','changed-script','changed-config','changed-wrapper','extra-argument','multiple-actions')) {
        # Use real CIM objects, including Scheduler's numeric logon/run-level values.
        # New-* constructs definitions only; Get/Set never reach the live Scheduler.
        $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -LogonType Interactive -RunLevel Limited
        $taskAction=New-ScheduledTaskAction -Execute $pwsh -Argument $oldArgs
        $trigger=New-ScheduledTaskTrigger -Once -At ([datetime]'2030-01-01T00:00:00')
        $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 50)
        $global:fixture=New-ScheduledTask -Action $taskAction -Principal $principal -Trigger $trigger -Settings $settings -Description 'Migration fixture'
        if($case -in @('hidden','changed-wrapper','extra-argument')) { $fixture.Actions[0].Execute=$hostPath;$fixture.Actions[0].Arguments=$newArgs }
        switch($case) {
          'other-user' {$fixture.Principal.UserId='S-1-5-19'}
          'non-interactive' {$fixture.Principal.LogonType=2}
          'elevated' {$fixture.Principal.RunLevel=1}
          'changed-executable' {$fixture.Actions[0].Execute=$hostPath}
          'changed-script' {$fixture.Actions[0].Arguments=$oldArgs.Replace('RuntimeWatchdog.ps1','Other.ps1')}
          'changed-config' {$fixture.Actions[0].Arguments=$oldArgs.Replace('watchdog-config.json','other-config.json')}
          'changed-wrapper' {$fixture.Actions[0].Arguments=$newArgs.Replace('RuntimeWatchdogHidden.vbs','Other.vbs')}
          'extra-argument' {$fixture.Actions[0].Arguments=$newArgs+' extra'}
          'multiple-actions' {$fixture.Actions+= $fixture.Actions[0]}
        }
        $before=$fixture | Select-Object Principal,Triggers,Settings,Description | ConvertTo-Json -Depth 20 -Compress
        $global:updated=$false
        try { & $scriptPath -Action UpdateHiddenLaunch -ConfigPath $cfgPath | Out-Null }
        catch { if($_.Exception.Message -ne 'Watchdog task identity differs.') { throw } }
        $after=$fixture | Select-Object Principal,Triggers,Settings,Description | ConvertTo-Json -Depth 20 -Compress
        if($before -cne $after) { throw 'Other task fields changed' }
        $results[$case]=$global:updated
      }
      $results | ConvertTo-Json -Compress
    `;
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, WATCHDOG_MIGRATION_TEST_DIR: dir }, encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    const results = JSON.parse(result.stdout);
    for (const [name, updated] of Object.entries(results)) {
      assert.equal(updated, ['legacy', 'hidden'].includes(name), name);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
