import assert from 'node:assert/strict';
import { test } from 'node:test';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { downloadChatFile } from '../../dist/utils/chat-file-download.js';

const url = 'https://sdmntprdenmarkeast.oaiusercontent.com/test?sig=TEST_SECRET';
const azureHosts = ['oaisdmntprdenmarkeast.blob.core.windows.net',
  'oaisdmntprnortheu.blob.core.windows.net', 'oaisdmntprindiasocentral.blob.core.windows.net',
  'oaisdmntprcentralus.blob.core.windows.net'];
function network(t, replies, addresses = [{ address: '8.8.8.8', family: 4 }]) {
  let calls = 0;
  t.mock.method(dns, 'lookup', async () => addresses);
  t.mock.method(https, 'get', (source, options, done) => {
    const reply = replies[calls++];
    assert.ok(source.hostname.endsWith('.oaiusercontent.com') ||
      azureHosts.includes(source.hostname));
    assert.equal(options.agent, false);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Authorization, undefined);
    options.lookup(source.hostname, {}, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, addresses[0].address); assert.equal(family, addresses[0].family);
    });
    const request = new EventEmitter();
    const body = reply.stream ?? Readable.from(reply.chunks ?? [Buffer.from('image')]);
    body.statusCode = reply.status ?? 200;
    body.headers = reply.headers ?? {};
    const abort = () => body.destroy(new Error('abort'));
    options.signal.addEventListener('abort', abort, { once: true });
    body.once('close', () => options.signal.removeEventListener('abort', abort));
    queueMicrotask(() => done(body));
    return request;
  });
  return () => calls;
}

test('HTTPS downloader pins validated DNS and streams exact bytes', async t => {
  const calls = network(t, [{ headers: { 'content-length': '6' }, chunks: [Buffer.from('abc'), Buffer.from('def')] }]);
  const result = [];
  await downloadChatFile(url, new AbortController().signal, 10, async chunk => { result.push(chunk); });
  assert.equal(Buffer.concat(result).toString(), 'abcdef'); assert.equal(calls(), 1);
});

for (const host of azureHosts) {
test(`observed web ChatGPT Azure source ${host} retains DNS and TLS controls`, async t => {
  const calls = network(t, [{ chunks: [Buffer.from('azure-image')] }]);
  const result = [];
  await downloadChatFile(`https://${host}/test?sig=TEST_SECRET`,
    new AbortController().signal, 100, async chunk => result.push(chunk));
  assert.equal(Buffer.concat(result).toString(), 'azure-image');
  assert.equal(calls(), 1);
});
}

test('unrelated Azure accounts and source-host lookalikes are rejected before DNS or HTTP', async t => {
  const lookup = t.mock.method(dns, 'lookup', () => { throw new Error('must not resolve'); });
  const request = t.mock.method(https, 'get', () => { throw new Error('must not request'); });
  for (const host of ['unrelated.blob.core.windows.net', 'oaisdmntprdenmarkeast.blob.core.windows.net.attacker.test',
    'sub.oaisdmntprdenmarkeast.blob.core.windows.net', 'oaisdmntprdenmarkeast-evil.blob.core.windows.net',
    'oaisdmntprnortheu.blob.core.windows.net.attacker.test', 'sub.oaisdmntprnortheu.blob.core.windows.net',
    'oaisdmntprnortheu-evil.blob.core.windows.net',
    'oaisdmntprindiasocentral.blob.core.windows.net.attacker.test', 'sub.oaisdmntprindiasocentral.blob.core.windows.net',
    'oaisdmntprindiasocentral-evil.blob.core.windows.net', 'oaisdmntprindiasocentral.blob.core.windows.net.',
    'oaisdmntprcentralus.blob.core.windows.net.attacker.test', 'sub.oaisdmntprcentralus.blob.core.windows.net',
    'oaisdmntprcentralus-evil.blob.core.windows.net', 'oaisdmntprcentralus.blob.core.windows.net.']) {
    await assert.rejects(downloadChatFile(`https://${host}/test?sig=TEST_SECRET`,
      new AbortController().signal, 100, async () => {}), /SOURCE_NOT_ALLOWED/);
  }
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(request.mock.callCount(), 0);
});

for (const host of azureHosts.slice(1)) {
test(`${host} rejects credentials, fragments and non-HTTPS/default ports before network access`, async t => {
  const lookup = t.mock.method(dns, 'lookup', () => { throw new Error('must not resolve'); });
  const request = t.mock.method(https, 'get', () => { throw new Error('must not request'); });
  for (const source of [`http://${host}/test`, `https://${host}:8443/test`,
    `https://user:password@${host}/test`, `https://${host}/test#fragment`,
    `https://${host}@attacker.test/test`]) {
    await assert.rejects(downloadChatFile(source, new AbortController().signal, 100, async () => {}), /SOURCE_NOT_ALLOWED/);
  }
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(request.mock.callCount(), 0);
});

test(`${host} rejects mixed public/private DNS answers before HTTPS`, async t => {
  const calls = network(t, [], [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  await assert.rejects(downloadChatFile(`https://${host}/test`,
    new AbortController().signal, 100, async () => {}), { code: 'SOURCE_NOT_ALLOWED', sourceHost: host });
  assert.equal(calls(), 0);
});

test(`redirect to the exact host ${host} retains the validated download path`, async t => {
  const calls = network(t, [{ status: 302, headers: { location: `https://${host}/test` } },
    { chunks: [Buffer.from('redirected-image')] }]);
  const result = [];
  await downloadChatFile(url, new AbortController().signal, 100, async chunk => result.push(chunk));
  assert.equal(Buffer.concat(result).toString(), 'redirected-image');
  assert.equal(calls(), 2);
});

test(`redirect to a lookalike of ${host} is never requested`, async t => {
  const calls = network(t, [{ status: 302,
    headers: { location: `https://${host}.attacker.test/test` } }]);
  await assert.rejects(downloadChatFile(url, new AbortController().signal, 100, async () => {}), {
    code: 'SOURCE_NOT_ALLOWED', sourceHost: `${host}.attacker.test`,
  });
  assert.equal(calls(), 1);
});
}

test('private DNS result is refused before any request', async t => {
  const calls = network(t, [], [{ address: '127.0.0.1', family: 4 }]);
  await assert.rejects(downloadChatFile(url, new AbortController().signal, 10, async () => {}), /SOURCE_NOT_ALLOWED/);
  assert.equal(calls(), 0);
});

test('redirect target is revalidated and arbitrary host is never contacted', async t => {
  const calls = network(t, [{ status: 302, headers: { location: 'http://127.0.0.1/private' } }]);
  await assert.rejects(downloadChatFile(url, new AbortController().signal, 10, async () => {}), /SOURCE_NOT_ALLOWED/);
  assert.equal(calls(), 1);
});

test('403 returns fixed unavailable code with no retry or secret-bearing exception', async t => {
  const calls = network(t, [{ status: 403 }]);
  await assert.rejects(downloadChatFile(url, new AbortController().signal, 10, async () => {}), error => {
    assert.equal(error.code, 'SOURCE_UNAVAILABLE');
    assert.equal(error.sourceHost, new URL(url).hostname);
    assert.equal(JSON.stringify(error).includes('TEST_SECRET'), false);
    return true;
  });
  assert.equal(calls(), 1);
});

test('unknown content length cannot exceed the streaming byte limit', async t => {
  network(t, [{ chunks: [Buffer.alloc(6), Buffer.alloc(6)] }]);
  let consumed = 0;
  await assert.rejects(downloadChatFile(url, new AbortController().signal, 10, async chunk => { consumed += chunk.length; }), /FILE_TOO_LARGE/);
  assert.equal(consumed, 6);
});

test('abort after headers destroys a stalled body', async t => {
  const stream = new Readable({ read() {} });
  network(t, [{ stream }]);
  const controller = new AbortController();
  const operation = downloadChatFile(url, controller.signal, 10, async () => {});
  const timer = setTimeout(() => controller.abort(), 30);
  try { await assert.rejects(operation); assert.equal(stream.destroyed, true); }
  finally { clearTimeout(timer); }
});
