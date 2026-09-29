import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(repo, 'local/windows/Monitor.ps1');
const pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
const node = process.execPath;

const mockCommon = String.raw`
$ErrorActionPreference = 'Stop'
$script:fixtureDir = $env:MONITOR_LIFECYCLE_FIXTURE
$script:taskFile = Join-Path $script:fixtureDir 'task.json'
$script:callsFile = Join-Path $script:fixtureDir 'calls.jsonl'
function Record-Call([string]$Name, $Value) {
    @{ name = $Name; value = $Value } | ConvertTo-Json -Depth 10 -Compress | Add-Content -LiteralPath $script:callsFile
}
function Get-RepoRoot { return $script:fixtureDir }
function Get-LocalRoot { return $script:fixtureDir }
function Get-LocalConfig { return @{ nodePath = $env:MONITOR_LIFECYCLE_NODE } }
function Assert-WindowsPowerShell7 {}
function Assert-NodeVersion($Path) {}
function Assert-ExecutablePath($Path, $Label) {}
function Assert-ExitCode($Label) {}
function Get-ScheduledTask {
    param($TaskPath, $TaskName, $ErrorAction)
    if (Test-Path -LiteralPath $script:taskFile) { return Get-Content -LiteralPath $script:taskFile -Raw | ConvertFrom-Json }
}
function New-ScheduledTaskAction {
    param($Execute, $Argument, $WorkingDirectory)
    return @{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory }
}
function New-ScheduledTaskTrigger {
    param([switch]$AtLogOn, $User)
    return @{ User = $User; Delay = $null }
}
function New-ScheduledTaskPrincipal {
    param($UserId, $LogonType, $RunLevel)
    return @{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel }
}
function New-ScheduledTaskSettingsSet {
    param([switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries,
          $MultipleInstances, $ExecutionTimeLimit, $RestartCount, $RestartInterval)
    return @{ MultipleInstances = $MultipleInstances; ExecutionTimeLimit = [string]$ExecutionTimeLimit;
              RestartCount = $RestartCount; RestartInterval = [string]$RestartInterval }
}
function Register-ScheduledTask {
    param($TaskPath, $TaskName, $Action, $Trigger, $Principal, $Settings, $Description)
    $task = @{ Actions = @($Action); Principal = $Principal; Settings = $Settings; State = 'Ready' }
    $task | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $script:taskFile
    Record-Call 'register' $task
    return $task
}
function Set-ScheduledTask {
    param($TaskPath, $TaskName, $Action, $Trigger, $Principal, $Settings)
    $task = @{ Actions = @($Action); Principal = $Principal; Settings = $Settings; State = 'Ready' }
    $task | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $script:taskFile
    Record-Call 'update' $task
    return $task
}
function Start-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) Record-Call 'start' $TaskName }
function Stop-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) Record-Call 'stop' $TaskName }
function Unregister-ScheduledTask {
    param($TaskPath, $TaskName, $Confirm)
    Record-Call 'remove' $TaskName
    Remove-Item -LiteralPath $script:taskFile
}
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) return $null }
function Stop-Process { param($Id, $ErrorAction) Record-Call 'stop-process' $Id }
`;

async function fixture() {
  const dir = path.join(repo, '.local/tmp', `monitor-lifecycle-${process.pid}-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(source, path.join(dir, 'Monitor.ps1'));
  await fs.writeFile(path.join(dir, 'Common.ps1'), mockCommon);
  await fs.writeFile(path.join(dir, 'monitor.mjs'), '// mock monitor\n');
  const configPath = path.join(dir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ outputDir: path.join(dir, 'output') }));
  return {
    dir, configPath,
    async task() { return JSON.parse(await fs.readFile(path.join(dir, 'task.json'), 'utf8')); },
    async putTask(task) { await fs.writeFile(path.join(dir, 'task.json'), JSON.stringify(task)); },
    async calls() {
      try { return (await fs.readFile(path.join(dir, 'calls.jsonl'), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
    run(action) {
      const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', path.join(dir, 'Monitor.ps1'),
        '-Action', action, '-ConfigPath', configPath, '-NodePath', node, '-TaskName', 'Lifecycle test'], {
        encoding: 'utf8', env: { ...process.env, MONITOR_LIFECYCLE_FIXTURE: dir, MONITOR_LIFECYCLE_NODE: node },
      });
      return { code: result.status, output: `${result.stdout}\n${result.stderr}` };
    },
    async cleanup() { await fs.rm(dir, { recursive: true, force: true }); },
  };
}

test('direct task owns the long-running node action and Start routes through Scheduler', async () => {
  const f = await fixture();
  try {
    const install = f.run('InstallAutostart');
    assert.equal(install.code, 0, install.output);
    const task = await f.task();
    assert.equal(task.Actions[0].Execute, node);
    assert.equal(task.Actions[0].Arguments, `"${path.join(f.dir, 'monitor.mjs')}" --config "${f.configPath}"`);
    assert.equal(task.Settings.MultipleInstances, 'IgnoreNew');
    assert.equal(task.Settings.ExecutionTimeLimit, '00:00:00');
    assert.equal(task.Settings.RestartCount, 3);
    assert.equal(task.Settings.RestartInterval, '00:01:00');
    const start = f.run('Start');
    assert.equal(start.code, 0, start.output);
    assert.deepEqual((await f.calls()).map(x => x.name), ['register', 'start']);
    await f.putTask({ ...task, State: 'Running' });
    const prematureRemove = f.run('RemoveAutostart');
    assert.notEqual(prematureRemove.code, 0);
    const stop = f.run('Stop');
    assert.equal(stop.code, 0, stop.output);
    assert.deepEqual((await f.calls()).map(x => x.name), ['register', 'start', 'stop']);
    await f.putTask(task);
    const remove = f.run('RemoveAutostart');
    assert.equal(remove.code, 0, remove.output);
    assert.deepEqual((await f.calls()).map(x => x.name), ['register', 'start', 'stop', 'remove']);
  } finally { await f.cleanup(); }
});

test('migration updates only a matching legacy launcher and keeps unrelated tasks untouched', async () => {
  const f = await fixture();
  try {
    const user = spawnSync(pwsh, ['-NoProfile', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().Name'], { encoding: 'utf8' }).stdout.trim();
    const legacy = { Actions: [{ Execute: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      Arguments: `-NoProfile -NonInteractive -WindowStyle Hidden -File "${path.join(f.dir, 'Monitor.ps1')}" -Action Start -ConfigPath "${f.configPath}" -NodePath "${node}"` }],
    Principal: { UserId: user.split('\\').at(-1), LogonType: 3, RunLevel: 0 }, State: 'Ready' };
    await f.putTask(legacy);
    const update = f.run('UpdateAutostart');
    assert.equal(update.code, 0, update.output);
    assert.equal((await f.task()).Actions[0].Execute, node);
    assert.deepEqual((await f.calls()).map(x => x.name), ['update']);
    const sid = spawnSync(pwsh, ['-NoProfile', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8' }).stdout.trim();
    await f.putTask({ ...legacy, Principal: { ...legacy.Principal, UserId: sid } });
    const sidUpdate = f.run('UpdateAutostart');
    assert.equal(sidUpdate.code, 0, sidUpdate.output);
    const wrongPrincipal = { ...legacy, Principal: { ...legacy.Principal, UserId: 'S-1-5-18' } };
    await f.putTask(wrongPrincipal);
    const wrongUserUpdate = f.run('UpdateAutostart');
    assert.notEqual(wrongUserUpdate.code, 0, 'another principal must not be migrated');
    const foreign = { ...legacy, Actions: [{ ...legacy.Actions[0], Arguments: legacy.Actions[0].Arguments + ' -Foreign' }] };
    await f.putTask(foreign);
    for (const action of ['Start', 'Stop', 'UpdateAutostart', 'RemoveAutostart']) {
      const result = f.run(action);
      assert.notEqual(result.code, 0, `${action} unexpectedly accepted foreign task`);
    }
    assert.deepEqual(await f.task(), foreign);
    assert.deepEqual((await f.calls()).map(x => x.name), ['update', 'update']);
  } finally { await f.cleanup(); }
});
