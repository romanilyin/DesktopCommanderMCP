import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileProbeTool, inspectFileDescriptor } from '../chat-file-probe.mjs';

const secret = 'DO_NOT_LOG_SOURCE_8e6c';
const file = {
  download_url: `https://files.example.com/${secret}/image.png?token=${secret}#${secret}`,
  file_id: secret, file_name: `${secret}.png`, mime_type: 'image/png',
};

test('file params declare all four properties with exactly two required', () => {
  assert.deepEqual(fileProbeTool._meta['openai/fileParams'], ['file']);
  assert.deepEqual(fileProbeTool.inputSchema.required, ['file']);
  const schema = fileProbeTool.inputSchema.properties.file;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['download_url', 'file_id', 'file_name', 'mime_type']);
  assert.deepEqual(schema.required.sort(), ['download_url', 'file_id']);
  assert.equal(schema.properties.file_name.type, 'string');
  assert.equal(fileProbeTool.annotations.readOnlyHint, true);
});

test('probe reports metadata presence without claiming a download or leaking file fields', () => {
  const result = inspectFileDescriptor({ file });
  assert.equal(result.isError, undefined);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(result.structuredContent.source_host, 'files.example.com');
  assert.equal(result.structuredContent.file_saved, false);
  assert.equal(result.structuredContent.download_checked, false);
  const minimal = inspectFileDescriptor({ file: { download_url: file.download_url, file_id: file.file_id } });
  assert.equal(minimal.structuredContent.fields_present.file_name, false);
  assert.equal(minimal.structuredContent.fields_present.mime_type, false);
});

test('malformed inputs produce fixed errors without raw values or parser exceptions', () => {
  const bad = [null, [], secret, {}, { file: null }, { file: [] },
    { file: { ...file, file_id: '' } }, { file: { ...file, download_url: secret } },
    { file: { ...file, download_url: `https://${secret}:password@files.example.com/x` } },
    { file: { ...file, download_url: `sandbox:/${secret}` } },
    { file: { ...file, download_url: `file:///C:/${secret}` } },
    { file: { ...file, mime_type: { secret } } }, { file: { ...file, file_name: null } },
    { file: { ...file, extra: secret } }, { file, extra: secret },
  ];
  for (const args of bad) {
    const result = inspectFileDescriptor(args);
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test('isolated stdio server preserves fileParams and produces no argument logs', { timeout: 15000 }, async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (['CONTROL_PLANE_API_KEY', 'OPENAI_ADMIN_KEY', 'OPENAI_API_KEY'].includes(key.toUpperCase())) delete env[key];
  }
  const client = new Client({ name: 'file-probe-isolated-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(repo, 'local/chat-file-probe.mjs')], env, stderr: 'pipe' });
  let stderr = '';
  try {
    await client.connect(transport);
    transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 1);
    assert.deepEqual(listed.tools[0]._meta['openai/fileParams'], ['file']);
    const result = await client.callTool({ name: 'inspect_chat_file_source', arguments: { file } });
    assert.equal(result.structuredContent.source_host, 'files.example.com');
    assert.equal(result.structuredContent.file_saved, false);
    assert.ok(!JSON.stringify(result).includes(secret));
    const invalid = await client.callTool({ name: 'inspect_chat_file_source', arguments: { file: { file_id: secret } } });
    assert.equal(invalid.isError, true);
    assert.ok(!JSON.stringify(invalid).includes(secret));
    const unknown = await client.callTool({ name: secret, arguments: { file } });
    assert.equal(unknown.isError, true);
    assert.ok(!JSON.stringify(unknown).includes(secret));
  } finally {
    await client.close();
  }
  assert.equal(stderr, '');
});
