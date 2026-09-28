import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSearchSessionId, pollSearchForMarker, textOf } from '../search-smoke.mjs';

const id = 'search_12_1780000000000';
const response = (text, extra = {}) => ({ content: [{ type: 'text', text }], ...extra });
const started = (kind = 'content', sessionId = id) => response(`Started ${kind} search session: ${sessionId}\nStatus: RUNNING`);

test('parses exact first line for content and file searches', () => {
  assert.equal(extractSearchSessionId(started('content')), id);
  assert.equal(extractSearchSessionId(started('file')), id);
});

test('valid structured session ID has priority over text', () => {
  const structuredId = 'search_3_1770000000000';
  const result = started();
  result.structuredContent = { sessionId: structuredId };
  assert.equal(extractSearchSessionId(result), structuredId);
  result.structuredContent = { sessionId: 'invalid' };
  assert.equal(extractSearchSessionId(result), id);
});

test('rejects malformed IDs and does not scan arbitrary output for a fake ID', () => {
  assert.throws(() => extractSearchSessionId(response('Started content search session: bad-id')),
    /Unexpected start_search response/);
  assert.throws(() => extractSearchSessionId(response('Matched text: Started content search session: search_1_2')),
    /Unexpected start_search response/);
  assert.throws(() => extractSearchSessionId(response('Status: RUNNING\nStarted file search session: search_3_4')),
    /Unexpected start_search response/);
});

test('always calls get_more_search_results even when initial output has the marker', async () => {
  const calls = [];
  const result = await pollSearchForMarker({
    sessionId: id,
    initialText: 'Initial results: probe.txt',
    marker: 'probe.txt',
    deadlineMs: 10000,
    callMore: async (sessionId, timeoutMs) => {
      calls.push({ sessionId, timeoutMs });
      return 'Search session: search_12_1780000000000\nStatus: COMPLETED\nResults: probe.txt';
    },
  });
  assert.equal(result.found, true);
  assert.equal(result.polls, 1);
  assert.deepEqual(calls.map(call => call.sessionId), [id]);
});

test('polls delayed empty pages with the exact extracted ID, then finds result', async () => {
  let clock = 0;
  const calls = [];
  const pages = [
    'Status: IN PROGRESS\nNo results yet',
    'Status: IN PROGRESS\nNo results yet',
    'Status: IN PROGRESS\nResults: probe.txt',
  ];
  const result = await pollSearchForMarker({
    sessionId: extractSearchSessionId(started()),
    initialText: 'Status: RUNNING', marker: 'probe.txt', deadlineMs: 1000,
    now: () => clock,
    wait: async ms => { clock += ms; },
    callMore: async (sessionId, timeoutMs) => {
      calls.push({ sessionId, timeoutMs });
      return pages.shift();
    },
  });
  assert.equal(result.polls, 3);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.sessionId === id));
});

test('fails immediately when search is complete without a match', async () => {
  let calls = 0;
  await assert.rejects(pollSearchForMarker({
    sessionId: id, initialText: '', marker: 'probe.txt', deadlineMs: 5000,
    callMore: async () => { calls++; return 'Status: COMPLETED\nNo matches found.'; },
  }), /Search completed without finding probe\.txt/);
  assert.equal(calls, 1);
});

test('caps each poll timeout and wait to the 10 second search deadline', async () => {
  let clock = 9950;
  let passedTimeout;
  let passedWait;
  await assert.rejects(pollSearchForMarker({
    sessionId: id, initialText: '', marker: 'probe.txt', deadlineMs: 10000,
    now: () => clock,
    wait: async ms => { passedWait = ms; clock += ms; },
    callMore: async (_sessionId, timeoutMs) => {
      passedTimeout = timeoutMs;
      return 'Status: IN PROGRESS\nNo results yet';
    },
  }), /Search deadline expired/);
  assert.equal(passedTimeout, 50);
  assert.equal(passedWait, 50);
});

test('textOf joins text blocks without interpreting non-text content', () => {
  assert.equal(textOf({ content: [{ type: 'text', text: 'one' }, { type: 'image', data: 'ignored' }, { type: 'text', text: 'two' }] }), 'one\ntwo');
});
