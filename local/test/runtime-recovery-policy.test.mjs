import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('recovery requires confirmed absence and respects pause, ambiguity and retry limits', { skip: process.platform !== 'win32' }, () => {
  const policy = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../windows/RuntimeRecoveryPolicy.ps1');
  const script = `
    $ErrorActionPreference='Stop'
    Set-StrictMode -Version Latest
    . $env:RECOVERY_POLICY_TEST_PATH
    $now=[DateTimeOffset]'2026-09-29T14:00:00Z'
    $absent=@{statusKnown=$true;running=$false;pidAbsentConfirmed=$true;targetMatches=$true}
    $pending=@{code='absence_pending';absentSince=$now.AddSeconds(-31).ToString('o')}
    $results=@{}
    $results.first=Get-RuntimeRecoveryDecision $absent @{} $now
    $results.second=Get-RuntimeRecoveryDecision $absent $pending $now
    $results.early=Get-RuntimeRecoveryDecision $absent @{code='absence_pending';absentSince=$now.AddSeconds(-29).ToString('o')} $now
    $results.paused=Get-RuntimeRecoveryDecision ($absent + @{paused=$true}) $pending $now
    $results.unknown=Get-RuntimeRecoveryDecision @{} $pending $now
    $results.alive=Get-RuntimeRecoveryDecision @{statusKnown=$true;running=$true;healthy=$true} $pending $now
    $results.degraded=Get-RuntimeRecoveryDecision @{statusKnown=$true;running=$true;healthy=$false} $pending $now
    $results.identity=Get-RuntimeRecoveryDecision @{statusKnown=$true;running=$false;pidAbsentConfirmed=$true;targetMatches=$false} $pending $now
    $results.budget=Get-RuntimeRecoveryDecision $absent ($pending + @{attempts=@($now.AddMinutes(-2).ToString('o'),$now.AddMinutes(-4).ToString('o'),$now.AddMinutes(-6).ToString('o'))}) $now
    $results.cooldown=Get-RuntimeRecoveryDecision $absent ($pending + @{attempts=@($now.AddSeconds(-59).ToString('o'))}) $now
    $results.expired=Get-RuntimeRecoveryDecision $absent ($pending + @{attempts=@($now.AddMinutes(-11).ToString('o'),$now.AddMinutes(-12).ToString('o'),$now.AddMinutes(-13).ToString('o'))}) $now
    $results.afterPause=Get-RuntimeRecoveryDecision $absent @{code='paused';absentSince=$now.AddMinutes(-5).ToString('o')} $now
    $results | ConvertTo-Json -Depth 8 -Compress
  `;
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, RECOVERY_POLICY_TEST_PATH: policy }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  const r = JSON.parse(result.stdout);
  for (const name of ['first', 'early', 'paused', 'unknown', 'alive', 'degraded', 'identity', 'budget', 'cooldown', 'afterPause']) {
    assert.equal(r[name].action, 'none', name);
  }
  for (const name of ['second', 'expired']) {
    assert.equal(r[name].action, 'start_connect_task', name);
    assert.equal(r[name].attempts.length, 1, name);
  }
  assert.equal(r.budget.code, 'recovery_cooldown');
  assert.equal(r.degraded.code, 'running_degraded_no_restart');
  assert.equal(r.afterPause.code, 'absence_pending');
});

test('intentional Stop pauses recovery and scheduled Connect preserves the pause', { skip: process.platform !== 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-recovery-test-'));
  try {
    const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../windows/Tunnel.ps1');
    await fs.copyFile(source, path.join(dir, 'Tunnel.ps1'));
    await fs.writeFile(path.join(dir, 'Common.ps1'), `
      $ErrorActionPreference='Stop'
      function Assert-WindowsPowerShell7 {}
      function Assert-ExecutablePath($p,$label) {}
      function Get-RepoRoot { $env:RECOVERY_TEST_DIR }
      function Get-LocalRoot { $env:RECOVERY_TEST_DIR }
      function Get-LocalConfig { @{tunnelClientPath=(Join-Path $env:RECOVERY_TEST_DIR 'fake-cli.ps1');alias='fixture'} }
      function Assert-ExitCode($label) { if ($LASTEXITCODE -ne 0) { throw $label } }
    `);
    await fs.writeFile(path.join(dir, 'fake-cli.ps1'), `
      ($args -join ' ') | Add-Content -LiteralPath (Join-Path $env:RECOVERY_TEST_DIR 'calls.txt')
      $global:LASTEXITCODE=0
    `);
    const run = (...args) => spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(dir, 'Tunnel.ps1'), ...args], {
      env: { ...process.env, RECOVERY_TEST_DIR: dir }, encoding: 'utf8', timeout: 15000,
    });
    let r = run('-Action', 'Stop');
    assert.equal(r.status, 0, r.stderr);
    const pause = path.join(dir, '.local/state/watchdog/paused.json');
    assert.ok(JSON.parse(await fs.readFile(pause, 'utf8')).pausedAt);
    const before = await fs.readFile(path.join(dir, 'calls.txt'), 'utf8');
    assert.match(before, /runtimes stop fixture --json/);
    r = run('-Action', 'Connect', '-RespectRecoveryPause');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(await fs.readFile(path.join(dir, 'calls.txt'), 'utf8'), before);
    await fs.access(pause);
    r = run('-Action', 'Connect');
    assert.notEqual(r.status, 0); // Fixture intentionally has no runtime key.
    assert.match(r.stderr, /Runtime key missing/);
    await assert.rejects(fs.access(pause), { code: 'ENOENT' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
