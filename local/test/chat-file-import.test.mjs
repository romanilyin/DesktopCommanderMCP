import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import sharp from 'sharp';
import { createChatFileImporter, importChatFileTool, getChatFileTransferTool, validateDestinationSyntax } from '../../dist/tools/chat-file-import.js';
import { isPublicAddress, validateSourceUrl, withAbort } from '../../dist/utils/chat-file-download.js';

const root = path.resolve('.local/tmp');
const png = await sharp({ create: { width: 17, height: 13, channels: 4, background: { r: 23, g: 70, b: 190, alpha: 0.4 } } }).png().toBuffer();
const digest = data => createHash('sha256').update(data).digest('hex');
const secret = 'FILE_PARAM_SECRET_83d7';
const file = { download_url: `https://sdmntprdenmarkeast.oaiusercontent.com/${secret}?sig=${secret}`, file_id: secret, mime_type: 'image/png' };

async function fixture(run, extra = {}) {
  const dir = path.join(root, `chat-import-${randomUUID()}`);
  const state = path.join(dir, 'receipts');
  await fs.mkdir(dir, { recursive: true });
  let requests = 0;
  const options = {
    stateDirectory: state,
    validatePath: async p => {
      if (!p.startsWith(dir + path.sep)) throw new Error('not allowed');
      return p;
    },
    download: async (_url, _signal, _limit, consume) => { requests++; await consume(png); },
    ...extra,
  };
  const input = { file, destination_path: path.join(dir, 'test.png'), transfer_id: 'test-transfer-001' };
  try { await run({ dir, state, options, input, importer: createChatFileImporter(options), requests: () => requests }); }
  finally {
    // This exact random test directory is the only deletion target.
    assert.ok(dir.startsWith(root + path.sep));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('file-input schema follows ChatGPT contract and separate status tool has no network/write annotation', () => {
  assert.deepEqual(importChatFileTool._meta['openai/fileParams'], ['file']);
  const schema = importChatFileTool.inputSchema.properties.file;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['download_url', 'file_id', 'file_name', 'mime_type']);
  assert.deepEqual(schema.required, ['download_url', 'file_id']);
  assert.equal(importChatFileTool.annotations.readOnlyHint, false);
  assert.equal(getChatFileTransferTool.annotations.openWorldHint, false);
  assert.equal(getChatFileTransferTool.annotations.readOnlyHint, true);
});

test('original transparent PNG bytes, hash and durable receipt survive instance restart', () => fixture(async t => {
  const saved = await t.importer.save(t.input);
  assert.equal(saved.structuredContent.status, 'saved');
  assert.equal(saved.structuredContent.sha256, digest(png));
  assert.equal(saved.structuredContent.bytes, png.length);
  assert.deepEqual(await fs.readFile(t.input.destination_path), png);
  const restarted = createChatFileImporter(t.options);
  const check = await restarted.get({ transfer_id: t.input.transfer_id });
  assert.equal(check.structuredContent.status, 'saved');
  const repeat = await restarted.save({ ...t.input, file: { ...file, download_url: 'https://sdmntprdenmarkeast.oaiusercontent.com/new-url' } });
  assert.equal(repeat.structuredContent.status, 'already_saved');
  assert.equal(t.requests(), 1, 'a replay must not issue a second network request');
  assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.equal((await fs.readFile(path.join(t.state, t.input.transfer_id + '.json'), 'utf8')).includes(secret), false);
  assert.ok(!(await fs.readdir(t.dir)).some(name => name.endsWith('.part')));
}));

test('existing file, disallowed path, malformed input and conflicting transfer never write', () => fixture(async t => {
  await fs.writeFile(t.input.destination_path, 'user-data');
  const existing = await t.importer.save(t.input);
  assert.match(existing.content[0].text, /DESTINATION_EXISTS/);
  assert.equal(await fs.readFile(t.input.destination_path, 'utf8'), 'user-data');
  assert.equal(t.requests(), 0);
  assert.equal((await t.importer.save({ ...t.input, destination_path: path.join(root, 'outside.png') })).isError, true);
  assert.equal((await t.importer.save({ ...t.input, extra: secret })).isError, true);
  const input = { ...t.input, destination_path: path.join(t.dir, 'new.png') };
  assert.equal((await t.importer.save(input)).structuredContent.status, 'saved');
  const conflict = await t.importer.save({ ...input, file: { ...file, file_id: 'different-file' } });
  assert.match(conflict.content[0].text, /TRANSFER_ID_CONFLICT/);
  assert.equal(t.requests(), 1);
}));

test('status detects modified or missing destinations instead of claiming success', () => fixture(async t => {
  await t.importer.save(t.input);
  await fs.writeFile(t.input.destination_path, Buffer.alloc(png.length));
  assert.equal((await t.importer.get({ transfer_id: t.input.transfer_id })).structuredContent.status, 'needs_verification');
  await fs.unlink(t.input.destination_path);
  assert.equal((await t.importer.get({ transfer_id: t.input.transfer_id })).structuredContent.status, 'needs_verification');
  assert.equal((await t.importer.get({ transfer_id: 'unknown-transfer' })).structuredContent.status, 'unknown');
  assert.equal(t.requests(), 1);
}));

test('interruption after publication is recovered by hash; earlier interruption is uncertain', () => fixture(async t => {
  await t.importer.save(t.input);
  const receiptPath = path.join(t.state, t.input.transfer_id + '.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  receipt.status = 'prepared';
  await fs.writeFile(receiptPath, JSON.stringify(receipt));
  const restarted = createChatFileImporter(t.options);
  assert.equal((await restarted.get({ transfer_id: t.input.transfer_id })).structuredContent.status, 'saved');
  await fs.unlink(t.input.destination_path);
  assert.equal((await restarted.get({ transfer_id: t.input.transfer_id })).structuredContent.status, 'needs_verification');
  receipt.status = 'in_progress';
  await fs.writeFile(receiptPath, JSON.stringify(receipt));
  assert.equal((await restarted.save(t.input)).structuredContent.status, 'needs_verification');
  assert.equal(t.requests(), 1);
}));

test('simultaneous requests to the same destination cannot replace one another', () => fixture(async t => {
  const results = await Promise.all([t.importer.save(t.input), t.importer.save({ ...t.input, transfer_id: 'second-transfer' })]);
  assert.equal(results.filter(r => r.structuredContent?.status === 'saved').length, 1);
  assert.equal(results.filter(r => r.isError).length, 1);
  assert.deepEqual(await fs.readFile(t.input.destination_path), png);
}));

test('simultaneous replay downloads once and never misattributes a conflicting file', () => fixture(async t => {
  const other = createChatFileImporter(t.options);
  const results = await Promise.all([t.importer.save(t.input), other.save(t.input)]);
  assert.equal(results.filter(r => r.structuredContent?.status === 'saved').length, 1);
  assert.equal(t.requests(), 1);
  assert.equal((await other.get({ transfer_id: t.input.transfer_id })).structuredContent.status, 'saved');
}));

test('HTML, truncated PNG, MIME-extension mismatch and oversize bodies leave no final file', async () => {
  for (const [body, extension, maxBytes] of [
    [Buffer.from('<html>error</html>'), '.png', 10000],
    [png.subarray(0, 45), '.png', 10000], [png, '.jpg', 10000], [png, '.png', 20],
  ]) await fixture(async t => {
    const input = { ...t.input, destination_path: path.join(t.dir, 'bad' + extension) };
    const result = await t.importer.save(input);
    assert.equal(result.isError, true);
    await assert.rejects(fs.stat(input.destination_path), { code: 'ENOENT' });
    assert.ok(!(await fs.readdir(t.dir)).some(name => name.endsWith('.part')));
    assert.equal((await t.importer.get({ transfer_id: input.transfer_id })).structuredContent.status, 'failed');
  }, { maxBytes, download: async (_url, _signal, _limit, consume) => consume(body) });
});

test('deadline remains active while reading the body, removes partial file and redacts errors', () => fixture(async t => {
  const result = await t.importer.save(t.input);
  assert.match(result.content[0].text, /TRANSFER_TIMEOUT/);
  assert.equal(JSON.stringify(result).includes(secret), false);
  await assert.rejects(fs.stat(t.input.destination_path), { code: 'ENOENT' });
  assert.ok(!(await fs.readdir(t.dir)).some(name => name.endsWith('.part')));
}, { timeoutMs: 40, download: async (_url, signal, _limit, consume) => {
  await consume(png.subarray(0, 30));
  await withAbort(new Promise(() => {}), signal);
} }));

test('JPEG and WebP use the same byte-preserving path', async () => {
  for (const format of ['jpeg', 'webp']) {
    const bytes = await sharp(png).toFormat(format).toBuffer();
    await fixture(async t => {
      const input = { ...t.input, destination_path: path.join(t.dir, 'image.' + format) };
      const result = await t.importer.save(input);
      assert.equal(result.structuredContent.status, 'saved');
      assert.equal(result.structuredContent.sha256, digest(bytes));
      assert.deepEqual(await fs.readFile(input.destination_path), bytes);
    }, { download: async (_url, _signal, _limit, consume) => consume(bytes) });
  }
});

test('URL policy rejects arbitrary hosts, userinfo, non-HTTPS, local addresses and lookalikes', () => {
  for (const url of ['http://sdmntprdenmarkeast.oaiusercontent.com/a', 'https://127.0.0.1/a',
    'https://files.oaiusercontent.com.evil.test/a', 'https://evil.test/a',
    'https://user:pass@files.oaiusercontent.com/a', 'https://files.oaiusercontent.com:444/a', 'sandbox:/mnt/a.png']) {
    assert.throws(() => validateSourceUrl(url));
  }
  assert.equal(validateSourceUrl(file.download_url).hostname, 'sdmntprdenmarkeast.oaiusercontent.com');
  for (const ip of ['0.0.0.0', '127.1.2.3', '10.2.3.4', '169.254.169.254', '100.100.100.200', '192.168.1.2', '172.20.1.1',
    '198.18.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2001:db8::1', '2002:7f00:1::']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('Windows alternate streams, UNC, device paths, reserved names and relative paths are rejected', () => {
  for (const name of ['relative.png', 'C:relative.png', '\\\\server\\share\\x.png', '\\\\?\\C:\\x.png',
    'C:\\temp\\x.png:stream', 'C:\\temp\\CON.png', 'C:\\temp\\LPT1.png', 'C:\\temp\\..\\x.png', 'C:\\temp \\x.png']) {
    assert.throws(() => validateDestinationSyntax(name, 'win32'), name);
  }
});
