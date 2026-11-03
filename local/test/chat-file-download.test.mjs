import assert from 'node:assert/strict';
import { test } from 'node:test';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { downloadChatFile, withAbort } from '../../dist/utils/chat-file-download.js';

test('an already expired deadline observes a later rejection from underlying native work', async () => {
  let rejectWork;
  const work = new Promise((_, reject) => { rejectWork = reject; });
  await assert.rejects(withAbort(work, AbortSignal.abort()), { code: 'TRANSFER_TIMEOUT' });
  rejectWork(new Error('late native error'));
  // node:test fails on an unhandled rejection; give the event loop a full turn.
  await new Promise(resolve => setImmediate(resolve));
});

const url = 'https://sdmntprdenmarkeast.oaiusercontent.com/test?sig=TEST_SECRET';
const azureHosts = ['oaisdmntprdenmarkeast.blob.core.windows.net',
  'oaisdmntprnortheu.blob.core.windows.net', 'oaisdmntprindiasocentral.blob.core.windows.net',
  'oaisdmntprcentralus.blob.core.windows.net', 'oaisdmntprukwest.blob.core.windows.net',
  'oaisdmntprpolandcentral.blob.core.windows.net'];
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
    'oaisdmntprcentralus-evil.blob.core.windows.net', 'oaisdmntprcentralus.blob.core.windows.net.',
    'oaisdmntprukwest.blob.core.windows.net.attacker.test', 'sub.oaisdmntprukwest.blob.core.windows.net',
    'oaisdmntprukwest-evil.blob.core.windows.net', 'oaisdmntprukwest.blob.core.windows.net.',
    'oaisdmntprpolandcentral.blob.core.windows.net.attacker.test', 'sub.oaisdmntprpolandcentral.blob.core.windows.net',
    'oaisdmntprpolandcentral-evil.blob.core.windows.net', 'oaisdmntprpolandcentral.blob.core.windows.net.']) {
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
    diagnostics: { stage: 'redirect_validation', reason: 'HOST_NOT_ALLOWLISTED', redirect_count: 1 },
  });
  assert.equal(calls(), 1);
});
}

test('private DNS result is refused before any request', async t => {
  const calls = network(t, [], [{ address: '127.0.0.1', family: 4 }]);
  await assert.rejects(downloadChatFile(url, new AbortController().signal, 10, async () => {}), {
    code: 'SOURCE_NOT_ALLOWED', diagnostics: { stage: 'dns_lookup', reason: 'NON_PUBLIC_ADDRESS', redirect_count: 0 },
  });
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
    assert.deepEqual(error.diagnostics, { stage: 'http_response', reason: 'HTTP_STATUS', http_status: 403, redirect_count: 0 });
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
  stream.push(Buffer.from('abc'));
  network(t, [{ stream }]);
  const controller = new AbortController();
  const progress = [];
  const operation = downloadChatFile(url, controller.signal, 10, async () => {
    // Abort only after bytes were received; no wall-clock race.
    setImmediate(() => controller.abort());
  }, update => progress.push(update));
  await assert.rejects(operation, { code: 'TRANSFER_TIMEOUT', sourceHost: new URL(url).hostname,
    diagnostics: { stage: 'response_body', reason: 'DEADLINE_EXCEEDED', redirect_count: 0, http_status: 200 } });
  assert.equal(stream.destroyed, true);
  assert.deepEqual(progress.at(-1), { stage: 'response_body', source_host: new URL(url).hostname, redirect_count: 0, bytes_received: 3 });
  assert.equal(JSON.stringify(progress).includes('TEST_SECRET'), false);
});

test('URL policy errors name the failing rule, never the signed input, before any DNS request', async t => {
  const lookup = t.mock.method(dns, 'lookup', () => { throw new Error('must not resolve'); });
  const host = new URL(url).hostname;
  for (const [source, reason] of [
    ['TEST_SECRET not a URL', 'MALFORMED_URL'],
    ['https://unrelated.blob.core.windows.net/TEST_SECRET', 'HOST_NOT_ALLOWLISTED'],
    ['http://' + host + '/TEST_SECRET', 'HTTPS_REQUIRED'],
    ['https://user:TEST_SECRET@' + host + '/x', 'URL_CREDENTIALS_FORBIDDEN'],
    ['https://' + host + '/x#TEST_SECRET', 'URL_FRAGMENT_FORBIDDEN'],
    ['https://' + host + ':444/TEST_SECRET', 'NONSTANDARD_HTTPS_PORT'],
  ]) {
    await assert.rejects(downloadChatFile(source, new AbortController().signal, 10, async () => {}), e => {
      assert.equal(e.code, 'SOURCE_NOT_ALLOWED');
      assert.deepEqual(e.diagnostics, { stage: 'source_url_validation', reason, redirect_count: 0 });
      assert.equal(JSON.stringify(e).includes('TEST_SECRET'), false);
      return true;
    });
  }
  assert.equal(lookup.mock.callCount(), 0);
});

test('resolver errors do not disclose the underlying error or claim nonpublic DNS', async t => {
  t.mock.method(dns, 'lookup', async () => { throw new Error('TEST_SECRET: raw resolver error'); });
  const request = t.mock.method(https, 'get', () => { throw new Error('must not request'); });
  await assert.rejects(downloadChatFile(url, new AbortController().signal, 10, async () => {}), e => {
    assert.equal(e.code, 'TRANSFER_FAILED');
    assert.deepEqual(e.diagnostics, { stage: 'dns_lookup', reason: 'DNS_LOOKUP_FAILED', redirect_count: 0 });
    assert.equal(JSON.stringify(e).includes('TEST_SECRET'), false);
    return true;
  });
  assert.equal(request.mock.callCount(), 0);
});

test('a disk write failure from the consumer is not relabeled as an HTTP read failure', async t => {
  network(t, [{ chunks: [Buffer.from('abc')] }]);
  const diskError = Object.assign(new Error('write failed'), { code: 'ENOSPC' });
  await assert.rejects(downloadChatFile(url, new AbortController().signal, 10, async () => { throw diskError; }),
    e => e === diskError);
});
