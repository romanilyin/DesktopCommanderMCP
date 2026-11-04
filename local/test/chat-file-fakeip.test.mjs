import assert from 'node:assert/strict';
import { test } from 'node:test';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { downloadChatFile, isPublicAddress } from '../../dist/utils/chat-file-download.js';

const azure = 'oaisdmntprukwest.blob.core.windows.net';
const cdn = 'sdmntprwestus.oaiusercontent.com';
const uri = h => 'https://' + h + '/image?sig=REDACT_ME';
const v4 = address => ({ address, family: 4 });
const v6 = address => ({ address, family: 6 });
const fake = { allowOpenWrtFakeIp: true };
const run = (source, options) => downloadChatFile(source, new AbortController().signal,
  1024, async () => {}, undefined, options);

function net(t, answers, replies = []) {
  const lookups = [], requests = [];
  t.mock.method(dns, 'lookup', async (host, opts) => {
    assert.equal(opts.all, true);
    lookups.push(host);
    return answers[lookups.length - 1];
  });
  t.mock.method(https, 'get', (url, opts, cb) => {
    requests.push({ url, opts });
    const mock = replies[requests.length - 1];
    assert.ok(mock, 'unexpected HTTPS request');
    const stream = Readable.from([Buffer.from('image')]);
    stream.statusCode = mock.status ?? 200;
    stream.headers = mock.headers ?? {};
    queueMicrotask(() => cb(stream));
    return new EventEmitter();
  });
  return { lookups, requests };
}

test('opt-in routes only native FakeIP answers, pins TLS to each redirect hostname', async t => {
  const answers = [[v4('198.18.0.0')], [v4('198.19.255.255')]];
  const { lookups, requests } = net(t, answers, [
    { status: 302, headers: { location: uri(azure) } }, {},
  ]);
  await run(uri(cdn), fake);
  assert.deepEqual(lookups, [cdn, azure]);
  assert.equal(requests.length, 2);
  for (const [i, { url, opts }] of requests.entries()) {
    const host = lookups[i];
    assert.equal(url.hostname, host);
    assert.equal(opts.servername, host);
    assert.equal(opts.rejectUnauthorized, true);
    assert.equal(opts.agent, false);
    const pinned = await new Promise((resolve, reject) =>
      opts.lookup(host, { all: true }, (e, a) => e ? reject(e) : resolve(a)));
    assert.deepEqual(pinned, answers[i]);
    assert.equal(isPublicAddress(pinned[0].address), false);
  }
});

for (const [name, host, opts, addresses] of [
  ['default', cdn, undefined, [v4('198.18.0.5')]],
  ['default upper half', azure, undefined, [v4('198.19.17.1')]],
  ['mixed public first', cdn, fake, [v4('1.1.1.1'), v4('198.18.1.2')]],
  ['mixed fake first', azure, fake, [v4('198.19.1.2'), v4('8.8.8.8')]],
  ['mixed private', azure, fake, [v4('198.18.0.1'), v4('192.168.0.1')]],
  ['private only', cdn, fake, [v4('10.1.2.3')]],
  ['mapped IPv6', azure, fake, [v6('::ffff:198.18.2.4')]],
  ['arbitrary content hostname', 'files.oaiusercontent.com', fake, [v4('198.18.0.1')]],
  ['nested CDN hostname', 'sdmntprfoo.extra.oaiusercontent.com', fake, [v4('198.18.0.1')]],
]) {
  test('refuses ' + name + ' before sending HTTPS', async t => {
    const { requests } = net(t, [addresses]);
    await assert.rejects(run(uri(host), opts), { code: 'SOURCE_NOT_ALLOWED' });
    assert.equal(requests.length, 0);
  });
}

for (const target of [uri('unlisted.blob.core.windows.net'),
  'https://' + cdn + ':444/test', 'https://user:password@' + cdn + '/test',
  uri('sdmntprfoo.evil.oaiusercontent.com'), uri(cdn)]) {
  test('validates redirect and fresh DNS for ' + target.replace(/\?.*$/, ''), async t => {
    const nextAnswer = target === uri(cdn) ? v4('192.168.1.2') : v4('198.18.1.2');
    const { lookups, requests } = net(t, [[v4('198.18.1.1')], [nextAnswer]], [
      { status: 307, headers: { location: target } },
    ]);
    await assert.rejects(run(uri(cdn), fake), { code: 'SOURCE_NOT_ALLOWED' });
    assert.equal(requests.length, 1);
    if (target === uri(cdn)) assert.deepEqual(lookups, [cdn, cdn]);
  });
}

test('HTTP expiry on an allowed fake route keeps the original HTTP diagnosis', async t => {
  net(t, [[v4('198.18.1.1')]], [{ status: 403 }]);
  await assert.rejects(run(uri(azure), fake), e => {
    assert.equal(e.code, 'SOURCE_UNAVAILABLE');
    assert.equal(e.diagnostics.reason, 'HTTP_STATUS');
    assert.equal(e.diagnostics.http_status, 403);
    assert.doesNotMatch(JSON.stringify(e), /REDACT_ME/);
    return true;
  });
});

test('ordinary public DNS remains valid for regular CDN hosts in opt-in mode', async t => {
  const publicIp = '192.169.1.2';
  assert.equal(isPublicAddress(publicIp), true);
  const { requests } = net(t, [[v4(publicIp)]], [{}]);
  await run(uri('files.oaiusercontent.com'), fake);
  assert.equal(requests.length, 1);
});

test('a fake route TLS failure never causes an unpinned or insecure retry', async t => {
  const lookup = t.mock.method(dns, 'lookup', async () => [v4('198.19.1.3')]);
  const get = t.mock.method(https, 'get', (source, opts) => {
    assert.equal(source.hostname, cdn);
    assert.equal(opts.servername, cdn);
    assert.equal(opts.rejectUnauthorized, true);
    const request = new EventEmitter();
    const error = Object.assign(new Error('REDACT_ME certificate detail'), { code: 'CERT_HAS_EXPIRED' });
    queueMicrotask(() => request.emit('error', error));
    return request;
  });
  await assert.rejects(run(uri(cdn), fake), e => {
    assert.equal(e.code, 'DOWNLOAD_FAILED');
    assert.equal(e.diagnostics.reason, 'HTTPS_REQUEST_FAILED');
    assert.doesNotMatch(JSON.stringify(e), /REDACT_ME/);
    return true;
  });
  assert.equal(lookup.mock.callCount(), 1);
  assert.equal(get.mock.callCount(), 1);
});