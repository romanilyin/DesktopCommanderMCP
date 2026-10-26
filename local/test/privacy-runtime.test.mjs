import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { localMcpEnvironment } from '../start-local.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = path.join(repo, '.local', 'tmp');
const legacyTools = ['give_feedback_to_desktop_commander', 'get_prompts', 'track_ui_event'];

test('legacy configuration migrates without network calls, promotion or loss of local functionality',
  { timeout: 45000 }, async () => {
    await fs.mkdir(temporary, { recursive: true });
    const home = await fs.mkdtemp(path.join(temporary, 'privacy-'));
    const configDir = path.join(home, '.claude-server-commander');
    await fs.mkdir(configDir);
    const configPath = path.join(configDir, 'config.json');
    const auditPath = path.join(home, 'network.jsonl');
    const flagsPath = path.join(configDir, 'feature-flags.json');
    const initial = {
      telemetryEnabled: true, clientId: 'retired-analytics-id',
      feedbackGiven: false, onboardingState: { attemptsShown: 1 },
      onboarding_injection: true, pendingWelcomeOnboarding: true,
      welcomeOnboardingEligible: true, sawOnboardingPage: true,
      abTest_McpUiPreviews: 'notShowMCPUi',
      mcpUiPreviewsEnabled: false, allowedDirectories: [home],
      blockedCommands: ['fixture-blocked-command'], fileReadLineLimit: 234,
      defaultShell: process.platform === 'win32' ? 'pwsh.exe' : '/bin/sh',
      customUserSetting: { keep: 'user-owned' },
      usageStats: { totalToolCalls: 17, successfulCalls: 16, failedCalls: 1,
        toolCounts: { read_file: 17 }, firstUsed: 100, lastUsed: 200, totalSessions: 2,
        feedbackAttempts: 3, feedbackGiven: true, lastFeedbackPrompt: 42,
        lastFeedbackPromptDate: '2025-01-01' },
    };
    await fs.writeFile(configPath, JSON.stringify(initial));
    await fs.writeFile(flagsPath, JSON.stringify({ flags: { user_surveys: true, onboarding_injection: true } }));
    await fs.writeFile(auditPath, '');
    const file = path.join(home, 'local-file.txt');
    await fs.writeFile(file, 'before cleanup\n');
    const environment = localMcpEnvironment({ ...process.env, HOME: home, USERPROFILE: home,
      SGG_NETWORK_AUDIT_FILE: auditPath });
    // The absence of network calls must not depend on old opt-out flags.
    delete environment.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
    delete environment.DC_FLAG_URL;
    const client = new Client({ name: 'sgg-local-privacy-test', version: '1.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', pathToFileURL(path.join(repo, 'local/test/fixtures/network-tripwire.mjs')).href,
        path.join(repo, 'local/start-local.mjs')], cwd: repo, env: environment, stderr: 'pipe' });
    let diagnostics = '';
    transport.stderr?.on('data', data => { diagnostics += data.toString(); });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      for (const name of legacyTools) assert.ok(!tools.some(tool => tool.name === name), name);
      for (const name of ['start_process', 'read_file', 'write_file', 'edit_block',
        'get_usage_stats', 'get_recent_tool_calls', 'import_chat_file']) {
        assert.ok(tools.some(tool => tool.name === name), name);
      }
      assert.ok(tools.every(tool => !tool._meta?.ui?.resourceUri && !tool._meta?.['ui/resourceUri']),
        'Explicit local text-mode setting survives retired UI experiment');
      const read = await client.callTool({ name: 'read_file', arguments: { path: file } });
      assert.notEqual(read.isError, true);
      assert.match(JSON.stringify(read), /before cleanup/);
      const edit = await client.callTool({ name: 'edit_block', arguments: {
        file_path: file, old_string: 'before cleanup', new_string: 'after cleanup' } });
      assert.notEqual(edit.isError, true);
      assert.equal(await fs.readFile(file, 'utf8'), 'after cleanup\n');
      const stats = await client.callTool({ name: 'get_usage_stats', arguments: {} });
      assert.notEqual(stats.isError, true);
      const changed = await client.callTool({ name: 'set_config_value', arguments: {
        key: 'fileReadLineLimit', value: 345 } });
      assert.notEqual(changed.isError, true);
      const history = await client.callTool({ name: 'get_recent_tool_calls', arguments: { maxResults: 5 } });
      assert.notEqual(history.isError, true);
      for (const name of legacyTools) {
        const rejected = await client.callTool({ name, arguments: {} });
        assert.equal(rejected.isError, true, `${name} cannot be invoked through an unlisted route`);
      }
      const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
      for (const key of ['telemetryEnabled', 'clientId', 'feedbackGiven', 'onboardingState',
        'onboarding_injection', 'pendingWelcomeOnboarding', 'welcomeOnboardingEligible',
        'sawOnboardingPage', 'abTest_McpUiPreviews']) assert.ok(!(key in persisted), key);
      for (const key of ['feedbackAttempts', 'feedbackGiven', 'lastFeedbackPrompt', 'lastFeedbackPromptDate']) {
        assert.ok(!(key in persisted.usageStats), key);
      }
      assert.deepEqual(persisted.allowedDirectories, initial.allowedDirectories);
      assert.deepEqual(persisted.blockedCommands, initial.blockedCommands);
      assert.deepEqual(persisted.customUserSetting, initial.customUserSetting);
      assert.equal(persisted.defaultShell, initial.defaultShell);
      assert.equal(persisted.fileReadLineLimit, 345);
      assert.equal(persisted.mcpUiPreviewsEnabled, false);
      assert.ok(persisted.usageStats.totalToolCalls >= 17);
      assert.equal(persisted.usageStats.firstUsed, 100);
      await assert.rejects(fs.stat(flagsPath), { code: 'ENOENT' });
      assert.doesNotMatch(JSON.stringify([read, edit, changed, stats, history]), /\[SYSTEM INSTRUCTION\]|Desktop Commander Team|tally\.so/);
      assert.equal(await fs.readFile(auditPath, 'utf8'), '', diagnostics);
    } catch (error) {
      error.message += '\nChild diagnostics: ' + diagnostics;
      throw error;
    } finally {
      await client.close();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

test('retired CLI commands fail promptly with migration guidance', { timeout: 15000 }, async () => {
  await fs.mkdir(temporary, { recursive: true });
  const cliHome = await fs.mkdtemp(path.join(temporary, 'retired-cli-'));
  try {
  for (const command of ['remote', 'setup', 'remove']) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(repo, 'dist/index.js'), command],
        { cwd: repo, env: { ...process.env, HOME: cliHome, USERPROFILE: cliHome },
          stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} started an idle server`)); }, 4000);
      child.stdout.on('data', data => { stdout += data.toString(); });
      child.stderr.on('data', data => { stderr += data.toString(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /removed|retired|no longer supported/i);
  }
  } finally {
    await fs.rm(cliHome, { recursive: true, force: true });
  }
});
