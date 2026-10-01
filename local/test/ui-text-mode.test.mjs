import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { localMcpEnvironment } from '../start-local.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('text mode removes UI metadata while preserving tools and readable results, and can be reversed live',
  { timeout: 30000 }, async () => {
    const root = path.join(repo, '.local', 'tmp');
    await fs.mkdir(root, { recursive: true });
    const dir = await fs.mkdtemp(path.join(root, 'ui-mode-'));
    const configDir = path.join(dir, '.claude-server-commander');
    await fs.mkdir(configDir);
    await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({
      telemetryEnabled: false, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false,
      mcpUiPreviewsEnabled: true, allowedDirectories: [dir],
    }));
    const probe = path.join(dir, 'probe.txt');
    await fs.writeFile(probe, 'UI_TEXT_MODE_OK\n');
    const env = localMcpEnvironment({ ...process.env, HOME: dir, USERPROFILE: dir,
      DC_FLAG_URL: 'http://127.0.0.1:1/disabled-for-test' });
    const client = new Client({ name: 'local-ui-preference-test', version: '1.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.join(repo, 'local', 'start-local.mjs')], cwd: repo, env, stderr: 'pipe' });
    const hasUi = tool => tool._meta?.ui?.resourceUri || tool._meta?.['ui/resourceUri'] || tool._meta?.['openai/outputTemplate'];
    try {
      await client.connect(transport);
      const before = (await client.listTools()).tools;
      assert.ok(hasUi(before.find(tool => tool.name === 'read_file')));
      const changed = await client.callTool({ name: 'set_config_value',
        arguments: { key: 'mcpUiPreviewsEnabled', value: false } });
      assert.notEqual(changed.isError, true);
      const after = (await client.listTools()).tools;
      assert.deepEqual(after.map(tool => tool.name), before.map(tool => tool.name));
      assert.ok(after.every(tool => !hasUi(tool)), 'All tools omit optional UI templates');
      for (const name of ['start_process', 'write_file', 'read_file']) {
        assert.ok(after.some(tool => tool.name === name), `${name} remains available`);
      }
      const fileTool = after.find(tool => tool.name === 'inspect_chat_file_source');
      const importer = after.find(tool => tool.name === 'import_chat_file');
      assert.deepEqual(importer._meta['openai/fileParams'], ['file']);
      assert.equal(importer.annotations.readOnlyHint, false);
      assert.equal(after.find(tool => tool.name === 'get_chat_file_transfer').annotations.readOnlyHint, true);
      const transferStatus = await client.callTool({ name: 'get_chat_file_transfer', arguments: { transfer_id: 'isolated-unknown-transfer' } });
      assert.equal(transferStatus.structuredContent.status, 'unknown');
      const rejectedImport = await client.callTool({ name: 'import_chat_file', arguments: {
        file: { download_url: 'http://127.0.0.1/DO_NOT_LOG', file_id: 'PRIVATE_FILE_ID' },
        destination_path: path.join(dir, 'import.png'), transfer_id: 'isolated-rejected-import',
      } });
      assert.equal(rejectedImport.isError, true);
      assert.ok(!JSON.stringify(rejectedImport).includes('DO_NOT_LOG'));
      await assert.rejects(fs.stat(path.join(dir, 'import.png')), { code: 'ENOENT' });
      assert.deepEqual(fileTool._meta['openai/fileParams'], ['file']);
      assert.ok(fileTool.outputSchema, 'Structured file observation has an output schema');
      const fileObservation = await client.callTool({ name: 'inspect_chat_file_source', arguments: {
        file: { download_url: 'https://files.example.com/source?secret=DO_NOT_LOG', file_id: 'PRIVATE_FILE_ID' },
      } });
      assert.equal(fileObservation.structuredContent.source_host, 'files.example.com');
      assert.equal(fileObservation.structuredContent.file_saved, false);
      assert.equal(fileObservation.content.length, 1);
      assert.deepEqual(JSON.parse(fileObservation.content[0].text), fileObservation.structuredContent,
        'File observation is not modified by onboarding or feedback');
      assert.ok(!JSON.stringify(fileObservation).includes('DO_NOT_LOG'));
      assert.ok(!JSON.stringify(fileObservation).includes('PRIVATE_FILE_ID'));
      const result = await client.callTool({ name: 'read_file', arguments: { path: probe, offset: 0, length: 2 } });
      assert.notEqual(result.isError, true);
      assert.ok(result.content.some(item => item.type === 'text' && item.text.includes('UI_TEXT_MODE_OK')));
      const persisted = JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8'));
      assert.equal(persisted.mcpUiPreviewsEnabled, false);
      const restored = await client.callTool({ name: 'set_config_value',
        arguments: { key: 'mcpUiPreviewsEnabled', value: true } });
      assert.notEqual(restored.isError, true);
      const enabled = (await client.listTools()).tools;
      assert.ok(hasUi(enabled.find(tool => tool.name === 'read_file')), 'Preference is re-read without a restart');
    } finally {
      await client.close();
      const realRoot = await fs.realpath(root);
      const realDir = await fs.realpath(dir);
      const relative = path.relative(realRoot, realDir);
      assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      await fs.rm(realDir, { recursive: true, force: true });
    }
  });
