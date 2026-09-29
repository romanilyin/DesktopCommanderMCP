import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sanitizeToolArguments } from '../../dist/utils/sanitize-tool-arguments.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('file tool arguments retain only fixed presence flags, including malformed input', () => {
  const secret = 'SECRET_DOWNLOAD_URL_AND_PAYLOAD';
  const input = {
    file: { download_url: secret, file_id: secret, file_name: secret, payload: secret },
    destination_path: secret, transfer_id: secret, unexpected: { nested: secret },
  };
  const before = JSON.stringify(input);
  assert.deepEqual(sanitizeToolArguments('import_chat_file', input), {
    redacted: true, fields: { file: 'present', destination_path: 'present', transfer_id: 'present' },
  });
  assert.deepEqual(sanitizeToolArguments('inspect_chat_file_source', input), {
    redacted: true, fields: { file: 'present' },
  });
  assert.equal(JSON.stringify(input), before, 'input must remain usable by the handler');
  assert.equal(sanitizeToolArguments('read_file', input), input, 'unrelated tools retain their arguments');
  assert.deepEqual(sanitizeToolArguments('import_chat_file', secret), {
    redacted: true, fields: { file: 'absent', destination_path: 'absent', transfer_id: 'absent' },
  });
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(secret); } });
  const safe = sanitizeToolArguments('import_chat_file', hostile);
  assert.equal(JSON.stringify(safe).includes(secret), false);
  assert.deepEqual(safe.fields, { file: 'unknown', destination_path: 'unknown', transfer_id: 'unknown' });
});

test('both persistent stores write redacted arguments before serialization', async () => {
  const root = path.join(repo, '.local/tmp', `chat-file-redaction-${process.pid}-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  try {
    const trackUrl = pathToFileURL(path.join(repo, 'dist/utils/trackTools.js')).href;
    const historyUrl = pathToFileURL(path.join(repo, 'dist/utils/toolHistory.js')).href;
    const script = `
      const { trackToolCall } = await import(${JSON.stringify(trackUrl)});
      const { toolHistory } = await import(${JSON.stringify(historyUrl)});
      const secret = 'SECRET_URL_TOKEN_FILE_ID_NAME_PAYLOAD';
      const args = { file: { download_url: secret, file_id: secret, file_name: secret, payload: secret },
        destination_path: secret, transfer_id: secret, unexpected: secret };
      Object.defineProperty(args, 'trap', { enumerable: true, get() { throw new Error(secret); } });
      for (const name of ['import_chat_file', 'inspect_chat_file_source']) {
        await trackToolCall(name, args);
        toolHistory.addCall(name, args, { content: [{ type: 'text', text: 'ok' }] });
      }
      const recent = toolHistory.getRecentCalls({ maxResults: 2 });
      if (JSON.stringify(recent).includes(secret)) throw new Error('secret retained in memory');
      await toolHistory.cleanup();
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const store = path.join(root, '.claude-server-commander');
    const log = await fs.readFile(path.join(store, 'claude_tool_call.log'), 'utf8');
    const history = await fs.readFile(path.join(store, 'tool-history.jsonl'), 'utf8');
    for (const content of [log, history]) {
      assert.equal(content.includes('SECRET_URL_TOKEN_FILE_ID_NAME_PAYLOAD'), false);
      assert.equal(content.includes('download_url'), false);
      assert.equal(content.includes('file_id'), false);
      assert.equal(content.includes('file_name'), false);
      assert.equal(content.includes('payload'), false);
      assert.equal(content.includes('unexpected'), false);
      assert.match(content, /redacted/);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
