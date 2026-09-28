import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMetrics, sanitizeMcpHealth, analyzeSample } from '../monitor-core.mjs';

const at = '2026-09-28T12:01:00.000Z';
const metric = (name, value, labels = '') => `${name}${labels ? `{${labels}}` : ''} ${value}`;
const labels = (method, status) => `request_method="${method}",tunnel_service_status="${status}"`;
const health = (overrides = {}) => ({
  status: 'ok', state: 'initialized', childState: 'running', childGenerationHash: 'aaaa',
  initializeEpoch: 4, initialize: { ok: true, observedAt: at }, ...overrides,
});
const sample = (metrics, h = health(), observedAt = at) => ({ metrics, health: h, observedAt });
const metrics = (commands = [], gauges = {}) => ({
  status: 'ok',
  gauges: { queueLength: 0, queueCapacity: 20, dispatcherOccupancy: 0,
    dispatcherCapacity: 10, lastSuccessfulPollTimestampSeconds: Date.parse(at) / 1000,
    processStartTimestampSeconds: 100, ...gauges },
  counters: { commands, initializeCount: 0 },
});
const command = (method, status, count, sumMilliseconds) => ({
  requestMethod: method, tunnelServiceStatus: status, count, sumMilliseconds,
});

test('metrics parser keeps only bounded allowlisted data', () => {
  const secret = 'personal-secret-and-raw-tunnel-id';
  const text = [
    metric('commands_queue_length', 13, `tunnel_id="${secret}"`),
    metric('commands_queue_capacity', 20),
    metric('dispatcher_worker_pool_occupancy', 10),
    metric('dispatcher_worker_pool_capacity', 10),
    metric('commands_poll_last_successful_timestamp_seconds', 1234),
    metric('process_start_time_seconds', 100),
    metric('command_end_to_end_latency_milliseconds_count', 4,
      `${labels('tools/call', '409')},url="https://${secret}.invalid"`),
    metric('command_end_to_end_latency_milliseconds_sum', 120000, labels('tools/call', '409')),
    metric('command_end_to_end_latency_milliseconds_count', 2, labels(secret, '503')),
    metric('command_end_to_end_latency_milliseconds_sum', 100, labels(secret, '503')),
    metric('command_end_to_end_latency_milliseconds_count', 1, labels('resources/templates/list', '200')),
    metric('some_unknown_metric', 999, `error="${secret}"`),
  ].join('\n');
  const parsed = summarizeMetrics(text);
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.gauges.queueLength, 13);
  assert.deepEqual(parsed.counters.commands, [
    command('other', '503', 2, 100),
    command('resources/templates/list', '200', 1, 0),
    command('tools/call', '409', 4, 120000),
  ]);
  assert.equal(JSON.stringify(parsed).includes(secret), false);
  assert.equal(summarizeMetrics('invalid').status, 'unknown');
  assert.equal(summarizeMetrics('x'.repeat(2_000_001)).status, 'unknown');
});

test('large status cardinality stays bounded and retains incident statuses', () => {
  const lines = Array.from({ length: 150 }, (_, index) =>
    metric('command_end_to_end_latency_milliseconds_count', 1, labels('tools/list', String(100 + index))));
  lines.push(metric('command_end_to_end_latency_milliseconds_count', 2, labels('tools/call', '409')));
  const parsed = summarizeMetrics(lines.join('\n'));
  assert.equal(parsed.counters.commands.length, 128);
  assert.equal(parsed.counters.commands.some(x => x.requestMethod === 'tools/call' && x.tunnelServiceStatus === '409'), true);
});

test('health parser rejects unknown schema and strips all unsanctioned fields', () => {
  const secret = 'do-not-persist-me';
  const parsed = sanitizeMcpHealth({
    schema_version: 1, status: 'ok', state: 'initialized', api_key: secret,
    details: { child_state: 'running', child_generation: secret, initialize_epoch: 348,
      initialize: { ok: true, observed_at: at, error: secret }, url: secret },
  });
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.state, 'initialized');
  assert.equal(parsed.childState, 'running');
  assert.equal(parsed.initializeEpoch, 348);
  assert.deepEqual(parsed.initialize, { ok: true, observedAt: at });
  assert.match(parsed.childGenerationHash, /^[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(parsed).includes(secret), false);
  assert.equal(sanitizeMcpHealth({ schema_version: 2, status: 'ok', details: {} }).status, 'unknown');
  assert.equal(sanitizeMcpHealth('{broken').state, 'unknown');
  assert.equal(sanitizeMcpHealth({ schema_version: 1, status: secret,
    state: secret, details: { child_state: secret, initialize: { observed_at: secret } } }).initialize.observedAt, null);
});

test('historical 409 and 5xx counts establish a quiet baseline', () => {
  const current = sample(metrics([
    command('tools/call', '409', 24, 3000), command('tools/call', '503', 2, 500),
  ]));
  assert.deepEqual(analyzeSample(current, null), []);
  assert.deepEqual(analyzeSample(current, current), []);
});

test('new HTTP failures and interval mean latency are reported without guessing root cause', () => {
  const before = sample(metrics([command('tools/call', '409', 24, 3000)]));
  const after = sample(metrics([
    command('tools/call', '409', 25, 35000),
    command('tools/call', '503', 1, 40000),
  ]));
  const incidents = analyzeSample(after, before);
  assert.deepEqual(incidents.map(({ code, severity }) => [code, severity]), [
    ['conflict_http_409', 'warning'], ['slow_commands', 'warning'],
    ['service_5xx', 'error'], ['slow_commands', 'warning'],
  ]);
  assert.deepEqual(incidents[0].evidence,
    { requestMethod: 'tools/call', tunnelServiceStatus: '409', count: 1 });
});

test('counter reset does not create a huge delta', () => {
  const before = sample(metrics([command('tools/call', '409', 100, 100000)]));
  const after = sample(metrics([command('tools/call', '409', 2, 1000)]));
  assert.deepEqual(analyzeSample(after, before), []);
});

test('metrics outage and recovery cannot turn cumulative history into a fresh alert', () => {
  const before = sample(metrics([command('tools/call', '409', 24, 3000)]));
  const outage = sample({ status: 'unknown', gauges: {}, counters: { commands: [], initializeCount: null } });
  const recovered = sample(metrics([command('tools/call', '409', 28, 4000)]));
  const next = sample(metrics([command('tools/call', '409', 29, 4100)]));
  assert.deepEqual(analyzeSample(outage, before).map(x => x.code), ['metrics_unknown']);
  assert.deepEqual(analyzeSample(recovered, outage), []);
  assert.deepEqual(analyzeSample(next, recovered).map(x => x.code), ['conflict_http_409']);
});

test('process and child restart suppress counter deltas while initialization churn stays informational', () => {
  const before = sample(metrics([command('tools/call', '409', 20, 2000)]));
  const after = sample(metrics([command('tools/call', '409', 21, 3000)]),
    health({ childGenerationHash: 'bbbb', initializeEpoch: 5 }), at);
  const incidents = analyzeSample(after, before);
  assert.deepEqual(incidents.map(x => [x.code, x.severity]), [
    ['child_restart', 'warning'], ['initialize_churn', 'info'],
  ]);
  const restarted = sample(metrics([], { processStartTimestampSeconds: 200 }));
  assert.equal(analyzeSample(restarted, before).some(x => x.code === 'process_restart'), true);
});

test('health, saturation, stale poll, and noninitialized state are surfaced with fixed evidence', () => {
  const before = sample(metrics());
  const after = sample(metrics([], { queueLength: 20, dispatcherOccupancy: 10,
    lastSuccessfulPollTimestampSeconds: Date.parse(at) / 1000 - 90 }),
  health({ status: 'unhealthy', state: 'connecting', initialize: { ok: false, observedAt: at } }));
  const incidents = analyzeSample(after, before);
  assert.deepEqual(incidents.map(x => x.code), [
    'health_failure', 'not_initialized', 'initialize_failed',
    'queue_saturated', 'dispatcher_saturated', 'poll_stale',
  ]);
  assert.equal(JSON.stringify(incidents).includes('error'), false);
  assert.equal(analyzeSample(sample(metrics(), sanitizeMcpHealth('{}')), null)[0].code, 'health_unknown');
  assert.deepEqual(analyzeSample(sample(metrics(), health({ state: 'not_initialized' })), before)
    .map(x => x.code), ['not_initialized']);
  assert.deepEqual(analyzeSample(sample(metrics(), health({ state: 'unknown' })), before)
    .map(x => x.code), ['health_state_unknown']);
});

test('probe failures and recovery use fixed endpoint names and numeric status only', () => {
  const before = { ...sample(metrics()), probes: { healthz: { state: 'ok', statusCode: 200 },
    readyz: { state: 'ok', statusCode: 200 } } };
  const failed = { ...sample(metrics()), probes: { healthz: { state: 'http_error', statusCode: 503,
    body: 'secret' }, readyz: { state: 'timeout', error: 'secret' },
    other: { state: 'http_error', statusCode: 503 } } };
  const incidents = analyzeSample(failed, before);
  assert.deepEqual(incidents.map(x => x.code), ['monitor_probe_failure', 'monitor_probe_failure']);
  assert.deepEqual(incidents[0].evidence, { probe: 'healthz', state: 'http_error', statusCode: 503 });
  assert.equal(JSON.stringify(incidents).includes('secret'), false);
  assert.deepEqual(analyzeSample(before, failed).map(x => x.code),
    ['monitor_probe_recovered', 'monitor_probe_recovered']);
});

test('malformed counter fields do not throw or leak payloads', () => {
  const malformed = sample({ status: 'ok', gauges: {}, counters: { commands: { api_key: 'secret' } } });
  assert.deepEqual(analyzeSample(malformed, sample(metrics())), []);
  assert.deepEqual(analyzeSample(null), [{ code: 'sample_unknown', severity: 'warning', evidence: {} }]);
});
