import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyTunnelLine, createMonitor, loadMonitorConfig, validateLoopbackUrl } from '../monitor.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.join(repo, '.local', 'tmp');

async function fixture() {
  await fs.mkdir(root, { recursive: true });
  const dir = path.join(root, `monitor-test-${process.pid}-${randomUUID()}`);
  await fs.mkdir(dir);
  const config = {
    healthUrlFile: path.join(dir, 'health.url'),
    tunnelLogFile: path.join(dir, 'tunnel.log'),
    outputDir: path.join(dir, 'output'),
    intervalMs: 1000,
  };
  const configFile = path.join(dir, 'config.json');
  await fs.writeFile(configFile, JSON.stringify(config));
  return {
    dir, config, configFile,
    async cleanup() {
      const resolvedRoot = await fs.realpath(root);
      const resolvedDir = await fs.realpath(dir);
      const relative = path.relative(resolvedRoot, resolvedDir);
      assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      await fs.rm(resolvedDir, { recursive: true, force: true });
    },
  };
}

function healthSnapshot() {
  return {
    schema_version: 1, status: 'ok', state: 'initialized',
    details: {
      child_state: 'running', child_generation: 'generation-secret-id', initialize_epoch: 7,
      initialize: { ok: true, observed_at: new Date().toISOString() },
    },
  };
}

function metricText(count) {
  const now = Math.floor(Date.now() / 1000);
  return [
    'commands_queue_length 0', 'commands_queue_capacity 8',
    'dispatcher_worker_pool_occupancy 1', 'dispatcher_worker_pool_capacity 4',
    `commands_poll_last_successful_timestamp_seconds ${now}`,
    'process_start_time_seconds 100',
    `command_end_to_end_latency_milliseconds_count{request_method="tools/call",tunnel_service_status="409",path="SECRET_PATH"} ${count}`,
    `command_end_to_end_latency_milliseconds_sum{request_method="tools/call",tunnel_service_status="409"} ${count * 15}`,
  ].join('\n') + '\n';
}

async function startServer(state) {
  const server = http.createServer((req, res) => {
    if (req.url === '/readyz' && state.redirectReady) {
      res.writeHead(302, { Location: 'http://example.com/SECRET_REDIRECT' }).end();
      return;
    }
    if (req.url === '/health/mcp') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(healthSnapshot()));
    } else if (req.url === '/metrics') {
      res.setHeader('content-type', 'text/plain');
      res.end(state.metricsOverride?.() ?? metricText(state.count));
    } else if (req.url === '/healthz' || req.url === '/readyz') res.end('ok');
    else res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function closeServer(server) { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

test('loopback URL validation excludes credentials, redirects, remote hosts, and URL extras', () => {
  assert.equal(validateLoopbackUrl('http://127.0.0.1:12345/'), 'http://127.0.0.1:12345');
  assert.equal(validateLoopbackUrl('http://[::1]:12345/'), 'http://[::1]:12345');
  for (const bad of [
    'https://127.0.0.1:12345', 'http://example.com:12345', 'http://127.0.0.2:12345',
    'http://user:secret@127.0.0.1:12345', 'http://127.0.0.1:12345/?token=secret',
    'http://127.0.0.1:12345/#secret', 'http://127.0.0.1:12345/other',
  ]) assert.throws(() => validateLoopbackUrl(bad));
});

test('passive monitor persists sanitized samples, incident context, and rotated journals', async () => {
  const files = await fixture();
  const state = { count: 0, redirectReady: true };
  const { server, origin } = await startServer(state);
  let monitor;
  try {
    await fs.writeFile(files.config.healthUrlFile, origin);
    await fs.writeFile(files.config.tunnelLogFile, 'historical SECRET_MUST_NOT_BE_TAILED\n');
    const config = await loadMonitorConfig(files.configFile);
    monitor = await createMonitor(config);
    await assert.rejects(createMonitor(config), /already running/);
    const first = await monitor.poll();
    assert.equal(first.probes.readyz.state, 'redirect_rejected');
    assert.equal(first.health.state, 'initialized');
    assert.equal(first.health.initializeEpoch, 7);
    assert.match(first.health.childGenerationHash, /^[0-9a-f]{16}$/);
    assert.equal(first.tunnelLog.eventCount, 0);

    // Ensure the next append rotates the owned sample journal only.
    await fs.appendFile(path.join(config.outputDir, 'samples.jsonl'), 'x'.repeat(2 * 1024 * 1024));
    state.count = 1;
    state.redirectReady = false;
    const logEntries = [
      { time: new Date().toISOString(), level: 'info', msg: 'forwarded command SECRET_TOKEN=abc',
        request_id: 'request-secret', cmd_request_id: 'command/secret', rpc_request_id: 1, channel: 'private-channel' },
      { time: new Date().toISOString(), level: 'info', msg: 'initialized notification acknowledged SECRET_TOKEN=def' },
      { time: new Date().toISOString(), level: 'error', component: 'transport', msg: 'mcp_initialization_required 409 SECRET_TOKEN=ghi' },
    ];
    await fs.appendFile(config.tunnelLogFile, logEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const second = await monitor.poll();
    assert.equal(second.tunnelLog.eventCount, 3);
    assert.equal(second.probes.readyz.state, 'ok');
    assert.equal(second.metrics.counters.commands.find(item => item.tunnelServiceStatus === '409')?.count, 1,
      JSON.stringify(second.metrics));
    const status = JSON.parse(await fs.readFile(path.join(config.outputDir, 'status.json'), 'utf8'));
    assert.equal(status.monitorPid, process.pid);
    assert.ok(Date.now() - Date.parse(status.heartbeatAt) < 5000);
    assert.equal(status.recentSamples.length, 2);
    const events = await fs.readFile(path.join(config.outputDir, 'events.jsonl'), 'utf8');
    const eventKinds = events.trim().split('\n').map(line => JSON.parse(line).event);
    assert.deepEqual(eventKinds, ['forwarded_command', 'initialized_ack', 'initialization_required_409']);
    assert.match(events, /"requestIdHash":"[0-9a-f]{16}"/);
    assert.match(events, /"rpcRequestIdHash":"[0-9a-f]{16}"/);
    const incidents = (await fs.readFile(path.join(config.outputDir, 'incidents.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line));
    const error409 = incidents.find(item => item.code === 'conflict_http_409');
    assert.ok(error409, 'A positive 409 counter delta should produce an incident');
    assert.equal(error409.context.length, 2);
    assert.equal(error409.evidence.requestMethod, 'tools/call');
    state.count = 2;
    await fs.rename(config.tunnelLogFile, path.join(files.dir, 'old-tunnel.log'));
    await fs.writeFile(config.tunnelLogFile, JSON.stringify({
      time: new Date().toISOString(), level: 'error', component: 'transport',
      msg: 'mcp_initialization_required 409 SECRET_TOKEN=rotated',
    }) + '\n');
    const third = await monitor.poll();
    assert.equal(third.tunnelLog.eventCount, 1, 'Read the first line after log rotation');
    const repeatedIncidents = (await fs.readFile(path.join(config.outputDir, 'incidents.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line)).filter(item => item.code === 'conflict_http_409');
    assert.equal(repeatedIncidents.length, 2, 'Each positive 409 interval is a separate incident');
    assert.ok((await fs.stat(path.join(config.outputDir, 'samples.jsonl.1'))).size >= 2 * 1024 * 1024);
    const persisted = [status, events, incidents, await fs.readFile(path.join(config.outputDir, 'samples.jsonl'), 'utf8')]
      .map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n');
    for (const forbidden of ['SECRET_TOKEN', 'SECRET_PATH', 'SECRET_REDIRECT', 'generation-secret-id',
      'request-secret', 'command/secret', 'private-channel']) {
      assert.ok(!persisted.includes(forbidden), `${forbidden} leaked into monitor state`);
    }
    await monitor.release(); monitor = null;
    const newMonitor = await createMonitor(config);
    await newMonitor.release();
  } finally {
    await monitor?.release();
    await closeServer(server);
    await files.cleanup();
  }
});

test('--once survives a missing URL file and exits with fixed, nonsecret status', async () => {
  const files = await fixture();
  try {
    const script = path.join(repo, 'local', 'monitor.mjs');
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, '--config', files.configFile, '--once'], {
        cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, stderr }));
      setTimeout(() => child.kill(), 8000).unref();
    });
    assert.equal(result.code, 0, result.stderr);
    const status = JSON.parse(await fs.readFile(path.join(files.config.outputDir, 'status.json'), 'utf8'));
    assert.equal(status.probes.healthz.state, 'health_url_missing');
    assert.equal(status.health.status, 'unknown');
    assert.equal(status.metrics.status, 'unknown');
    assert.ok(!result.stderr.includes(files.dir));
  } finally { await files.cleanup(); }
});

test('tunnel parser ignores arbitrary text and oversized/unrecognized records', () => {
  const at = new Date().toISOString();
  assert.equal(classifyTunnelLine('not json', at), null);
  assert.equal(classifyTunnelLine(JSON.stringify({ msg: 'SECRET_TOKEN=xyz', request_id: 'x' }), at), null);
  assert.equal(classifyTunnelLine('x'.repeat(9000), at), null);
  assert.equal(classifyTunnelLine(JSON.stringify({ msg: 'dispatcher acknowledged notification with control plane' }), at)?.event,
    'notification_ack');
  assert.equal(classifyTunnelLine(JSON.stringify({ level: 'error', component: 'transport', msg: 'generic 409 failure' }), at)?.event,
    'transport_error');
});

test('incident retains newest context and stays bounded at maximum metric cardinality', async () => {
  const files = await fixture();
  const state = { count: 0, redirectReady: false };
  const { server, origin } = await startServer(state);
  let monitor;
  try {
    await fs.writeFile(files.config.healthUrlFile, origin);
    const groups = [{ method: 'tools/call', status: 409 }];
    for (let status = 500; status <= 599; status++) groups.push({ method: 'tools/call', status });
    for (let status = 500; groups.length < 128; status++) groups.push({ method: 'resources/read', status });
    state.metricsOverride = () => {
      const lines = [
        'commands_queue_length 0', 'commands_queue_capacity 8',
        `commands_poll_last_successful_timestamp_seconds ${Math.floor(Date.now() / 1000)}`,
        'process_start_time_seconds 100',
      ];
      for (const { method, status } of groups) {
        const labels = `{request_method="${method}",tunnel_service_status="${status}"}`;
        const count = 987654321098765 + (status === 409 ? state.count : 0);
        lines.push(`command_end_to_end_latency_milliseconds_count${labels} ${count}`);
        lines.push(`command_end_to_end_latency_milliseconds_sum${labels} ${count * 15}`);
      }
      return lines.join('\n') + '\n';
    };
    monitor = await createMonitor(await loadMonitorConfig(files.configFile));
    for (let i = 0; i < 19; i++) await monitor.poll();
    state.count = 1;
    const latest = await monitor.poll();
    assert.equal(latest.metrics.counters.commands.length, 128);
    const incidentLines = (await fs.readFile(path.join(files.config.outputDir, 'incidents.jsonl'), 'utf8'))
      .trim().split('\n');
    const incidentLine = incidentLines.find(line => JSON.parse(line).code === 'conflict_http_409');
    assert.ok(incidentLine, 'Monitor remains alive to record new 409 with a full context window');
    assert.ok(Buffer.byteLength(incidentLine + '\n') <= 256 * 1024);
    const incident = JSON.parse(incidentLine);
    assert.equal(incident.contextTruncated, true);
    assert.equal(incident.context.at(-1).observedAt, latest.observedAt);
    assert.ok(incident.context.length < 20 && incident.context.length >= 1);
    const status = JSON.parse(await fs.readFile(path.join(files.config.outputDir, 'status.json'), 'utf8'));
    assert.equal(status.recentSamples.length, 20);
  } finally {
    await monitor?.release();
    await closeServer(server);
    await files.cleanup();
  }
});
