#!/usr/bin/env node
/** Passive, local-only tunnel/MCP health monitor. Never sends MCP requests. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSample, sanitizeMcpHealth, summarizeMetrics } from './monitor-core.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateRoot = path.join(repo, '.local', 'state');
const endpointPaths = ['/healthz', '/readyz', '/health/mcp', '/metrics'];
const maxBodyBytes = 1024 * 1024;
const maxLogChunkBytes = 256 * 1024;
const maxLogLineBytes = 8192;
const maxJournalBytes = 2 * 1024 * 1024;
const maxRecordBytes = 256 * 1024;
const journalGenerations = 4;

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function childFile(dir, name) {
  if (!/^[a-z][a-z0-9.-]*$/.test(name)) throw new Error('Invalid monitor filename');
  const target = path.join(dir, name);
  if (path.dirname(target) !== dir) throw new Error('Monitor file escaped output directory');
  return target;
}

export function validateLoopbackUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\r\n\0]/.test(raw)) throw new Error('Invalid health URL');
  let url;
  try { url = new URL(raw.trim()); } catch { throw new Error('Invalid health URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.port) {
    throw new Error('Health URL must be a plain loopback HTTP origin');
  }
  return url.origin;
}

export async function loadMonitorConfig(configPath) {
  let raw;
  if (configPath) {
    raw = JSON.parse(await fs.readFile(absolute(configPath, 'config'), 'utf8'));
  } else {
    const legacy = JSON.parse(await fs.readFile(path.join(repo, '.local', 'config.json'), 'utf8'));
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(legacy.alias || '')) throw new Error('Invalid local alias');
    raw = {
      healthUrlFile: path.join(stateRoot, 'tunnel', 'health', `${legacy.alias}.url`),
      tunnelLogFile: path.join(stateRoot, 'tunnel', 'logs', `${legacy.alias}.log`),
      outputDir: path.join(stateRoot, 'monitor'),
      intervalMs: 10000,
    };
  }
  const intervalMs = raw.intervalMs ?? 10000;
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) {
    throw new Error('intervalMs must be an integer from 1000 to 60000');
  }
  return {
    healthUrlFile: absolute(raw.healthUrlFile, 'healthUrlFile'),
    tunnelLogFile: absolute(raw.tunnelLogFile, 'tunnelLogFile'),
    outputDir: absolute(raw.outputDir, 'outputDir'),
    intervalMs,
  };
}

async function readHealthOrigin(filename) {
  let handle;
  try {
    handle = await fs.open(filename, 'r');
    const stat = await handle.stat();
    if (stat.size > 2048) return { error: 'health_url_invalid' };
    const data = await handle.readFile({ encoding: 'utf8' });
    return { origin: validateLoopbackUrl(data) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { error: 'health_url_missing' };
    return { error: 'health_url_invalid' };
  } finally { await handle?.close(); }
}

async function readBoundedBody(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBodyBytes) throw new Error('body_too_large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

async function probe(origin, suffix) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(origin + suffix, {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { Accept: suffix === '/metrics' ? 'text/plain' : 'application/json' },
    });
    const statusCode = response.status;
    if (statusCode >= 300 && statusCode < 400) return { state: 'redirect_rejected', statusCode };
    if (statusCode !== 200) return { state: 'http_error', statusCode };
    try { return { state: 'ok', statusCode, body: await readBoundedBody(response) }; }
    catch (error) { return { state: error?.message === 'body_too_large' ? 'body_too_large' : 'read_error', statusCode }; }
  } catch (error) {
    return { state: controller.signal.aborted ? 'timeout' : 'connection_error' };
  } finally { clearTimeout(timeout); }
}

const codeLike = value => typeof value === 'string' && /^[A-Za-z0-9._:/+@=-]{1,256}$/.test(value);
function hashId(value) {
  if (Number.isSafeInteger(value) && value >= 0) value = String(value);
  return codeLike(value) ? createHash('sha256').update(value).digest('hex').slice(0, 16) : undefined;
}

/** Parse transient tunnel log text into an allowlisted, privacy-safe event. */
export function classifyTunnelLine(line, observedAt) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > maxLogLineBytes) return null;
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const message = typeof entry.msg === 'string' ? entry.msg.slice(0, 2048).toLowerCase() : '';
  const component = typeof entry.component === 'string' ? entry.component.toLowerCase() : '';
  const level = typeof entry.level === 'string' ? entry.level.toLowerCase() : '';
  let event;
  // tunnel-client emits these failed deliveries at INFO, even while probes stay green.
  if (/command response deadline reached; dropping without posting a response|dropping command whose response deadline has passed/.test(message)) {
    event = 'command_deadline_expired';
  }
  else if (/mcp_initialization_required|initialization required/.test(message)) event = 'initialization_required_409';
  else if (/initialized notification|notifications\/initialized|initialize ack|initialized ack/.test(message)) event = 'initialized_ack';
  else if (/acknowledged notification|notification acknowledged/.test(message)) event = 'notification_ack';
  else if (/forwarded|forwarding|dispatch(?:ed|ing)? command/.test(message) &&
      /command|request|rpc|mcp/.test(message)) event = 'forwarded_command';
  else if ((level === 'error' || level === 'warn' || level === 'warning') &&
      /transport|connection|stdio|dispatcher/.test(message + ' ' + component)) event = 'transport_error';
  if (!event) return null;
  const at = typeof entry.time === 'string' && Number.isFinite(Date.parse(entry.time))
    ? new Date(entry.time).toISOString() : observedAt;
  const result = { at, event };
  for (const [source, target] of [
    ['request_id', 'requestIdHash'], ['cmd_request_id', 'commandRequestIdHash'],
    ['rpc_request_id', 'rpcRequestIdHash'], ['channel', 'channelHash'],
  ]) {
    const hashed = hashId(entry[source]);
    if (hashed) result[target] = hashed;
  }
  return result;
}

class TunnelTail {
  constructor(filename) { this.filename = filename; this.offset = null; this.identity = null; this.remainder = ''; this.attached = false; }
  async poll(observedAt) {
    let handle;
    try {
      handle = await fs.open(this.filename, 'r');
      const stat = await handle.stat();
      const identity = `${stat.dev}:${stat.ino}`;
      if (!this.attached) {
        this.offset = stat.size; // First attach starts at EOF: do not ingest historical logs.
        this.identity = identity;
        this.remainder = '';
        this.attached = true;
        return { state: 'attached', cursorBytes: this.offset, events: [] };
      }
      if (this.identity !== identity || this.offset === null || stat.size < this.offset) {
        // A fresh/truncated log belongs to the running monitor interval, so
        // read it from byte zero to retain the first restart evidence.
        this.offset = 0;
        this.identity = identity;
        this.remainder = '';
      }
      const bytes = Math.min(maxLogChunkBytes, stat.size - this.offset);
      if (bytes <= 0) return { state: 'ok', cursorBytes: this.offset, events: [] };
      const chunk = Buffer.allocUnsafe(bytes);
      const { bytesRead } = await handle.read(chunk, 0, bytes, this.offset);
      this.offset += bytesRead;
      const text = this.remainder + chunk.subarray(0, bytesRead).toString('utf8');
      const lines = text.split('\n');
      this.remainder = lines.pop() || '';
      if (Buffer.byteLength(this.remainder) > maxLogLineBytes) this.remainder = '';
      const events = [];
      for (const line of lines) {
        const event = classifyTunnelLine(line.replace(/\r$/, ''), observedAt);
        if (event) events.push(event);
      }
      return { state: 'ok', cursorBytes: this.offset, events };
    } catch (error) {
      if (error?.code === 'ENOENT') { this.offset = null; this.identity = null; this.remainder = ''; return { state: 'missing', cursorBytes: null, events: [] }; }
      return { state: 'read_error', cursorBytes: this.offset, events: [] };
    } finally { await handle?.close(); }
  }
}

async function rotateJournal(outputDir, name) {
  const current = childFile(outputDir, name);
  let size = 0;
  try { size = (await fs.stat(current)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (size < maxJournalBytes) return;
  const oldest = childFile(outputDir, `${name}.${journalGenerations}`);
  await fs.rm(oldest, { force: true });
  for (let n = journalGenerations - 1; n >= 1; n--) {
    const from = childFile(outputDir, `${name}.${n}`);
    const to = childFile(outputDir, `${name}.${n + 1}`);
    try { await fs.rename(from, to); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try { await fs.rename(current, childFile(outputDir, `${name}.1`)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function appendJournal(outputDir, name, record) {
  const json = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(json) > maxRecordBytes) throw new Error('Monitor record exceeds cap');
  await rotateJournal(outputDir, name);
  await fs.appendFile(childFile(outputDir, name), json, { encoding: 'utf8', mode: 0o600 });
}

async function atomicStatus(outputDir, value) {
  const temp = childFile(outputDir, `status-${process.pid}-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, childFile(outputDir, 'status.json'));
  } finally { await fs.rm(temp, { force: true }); }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function acquireLock(outputDir) {
  const file = childFile(outputDir, 'monitor.lock');
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      const owned = { pid: process.pid, startedAt: new Date().toISOString(), token };
      await handle.writeFile(JSON.stringify(owned));
      await handle.sync();
      return async () => {
        try {
          const current = JSON.parse(await fs.readFile(file, 'utf8'));
          if (current.token === token && current.pid === process.pid) await fs.unlink(file);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        finally { await handle.close(); }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let before;
      try { before = await fs.readFile(file, 'utf8'); } catch { continue; }
      let existing;
      try { existing = JSON.parse(before); } catch { throw new Error('Monitor lock is unreadable'); }
      if (pidAlive(existing.pid)) throw new Error('Monitor already running');
      // Remove only if the file is still the same stale lock observed above.
      if (await fs.readFile(file, 'utf8').catch(() => null) === before) await fs.unlink(file).catch(() => {});
    }
  }
  throw new Error('Unable to acquire monitor lock');
}

function sanitizeIncident(value, context, observedAt) {
  if (!value || typeof value.code !== 'string' || !/^[a-z0-9_]{1,64}$/.test(value.code)) return null;
  const severity = ['info', 'warning', 'error', 'critical'].includes(value.severity) ? value.severity : 'warning';
  // The core analysis only sees sanitized samples. Keep its evidence as bounded
  // JSON values so no accidental raw log or response text can enter the journal.
  const evidence = {};
  if (value.evidence && typeof value.evidence === 'object' && !Array.isArray(value.evidence)) {
    for (const [key, item] of Object.entries(value.evidence)) {
      if (/^[a-zA-Z][a-zA-Z0-9]{0,49}$/.test(key) &&
          (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)) ||
          (typeof item === 'string' && (
            (key === 'requestMethod' && /^(?:initialize|notifications\/initialized|tools\/(?:call|list)|resources\/(?:read|list)|prompts\/(?:get|list)|ping|logging\/setLevel|completion\/complete|other)$/.test(item)) ||
            /^[a-zA-Z0-9_.:-]{1,80}$/.test(item))))) evidence[key] = item;
    }
  }
  const compactContext = context.slice(-20).map(sample => ({
    observedAt: sample.observedAt,
    health: sample.health,
    probes: sample.probes,
    tunnelLog: sample.tunnelLog,
    metrics: { status: sample.metrics.status, gauges: sample.metrics.gauges,
      counters: { commands: sample.metrics.counters.commands
        .filter(item => item.tunnelServiceStatus === '409' || Number(item.tunnelServiceStatus) >= 500) } },
  }));
  const record = { observedAt, code: value.code, severity, evidence, context: compactContext };
  while (record.context.length > 1 && Buffer.byteLength(JSON.stringify(record) + '\n') > maxRecordBytes) {
    record.context.shift();
    record.contextTruncated = true;
  }
  return record;
}

export async function createMonitor(config) {
  const outputDir = absolute(config.outputDir, 'outputDir');
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const release = await acquireLock(outputDir);
  const tail = new TunnelTail(config.tunnelLogFile);
  const recent = [];
  let previous = null;
  let running = false;
  return {
    outputDir,
    async poll() {
      if (running) return;
      running = true;
      try {
        const observedAt = new Date().toISOString();
        const origin = await readHealthOrigin(config.healthUrlFile);
        const rawProbes = origin.origin
          ? await Promise.all(endpointPaths.map(suffix => probe(origin.origin, suffix)))
          : endpointPaths.map(() => ({ state: origin.error }));
        const probes = Object.fromEntries(endpointPaths.map((suffix, i) =>
          [suffix.slice(1).replace(/\//g, '_'), { state: rawProbes[i].state,
            ...(rawProbes[i].statusCode ? { statusCode: rawProbes[i].statusCode } : {}) }]));
        let mcpJson;
        if (rawProbes[2].state === 'ok') {
          try { mcpJson = JSON.parse(rawProbes[2].body); } catch { mcpJson = null; probes.health_mcp.state = 'invalid_json'; }
        }
        const sample = {
          observedAt, probes,
          health: sanitizeMcpHealth(mcpJson),
          metrics: summarizeMetrics(rawProbes[3].state === 'ok' ? rawProbes[3].body : ''),
        };
        const tailResult = await tail.poll(observedAt);
        sample.tunnelLog = { state: tailResult.state, eventCount: tailResult.events.length,
          deadlineDropCount: tailResult.events.filter(event => event.event === 'command_deadline_expired').length,
          cursorBytes: Number.isSafeInteger(tailResult.cursorBytes) ? tailResult.cursorBytes : null };
        for (const event of tailResult.events) await appendJournal(outputDir, 'events.jsonl', event);
        await appendJournal(outputDir, 'samples.jsonl', sample);
        recent.push(sample);
        if (recent.length > 20) recent.shift();
        const incidents = analyzeSample(sample, previous);
        for (const incident of incidents) {
          const safe = sanitizeIncident(incident, recent, observedAt);
          if (!safe) continue;
          await appendJournal(outputDir, 'incidents.jsonl', safe);
        }
        previous = sample;
        await atomicStatus(outputDir, {
          schemaVersion: 1, monitorPid: process.pid, heartbeatAt: observedAt,
          health: sample.health, metrics: sample.metrics, probes, tunnelLog: sample.tunnelLog,
          recentSamples: recent,
        });
        return sample;
      } finally { running = false; }
    },
    release,
  };
}

async function cli() {
  let configPath;
  let once = false;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--config' && i + 1 < process.argv.length) configPath = process.argv[++i];
    else if (process.argv[i] === '--once') once = true;
    else throw new Error('Usage: node local/monitor.mjs [--config <absolute-json-path>] [--once]');
  }
  const config = await loadMonitorConfig(configPath);
  const monitor = await createMonitor(config);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    do {
      await monitor.poll();
      if (once || stopping) break;
      await new Promise(resolve => setTimeout(resolve, config.intervalMs));
    } while (!stopping);
  } finally { await monitor.release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(error => {
    // Never print a raw exception: filesystem and network errors can contain secrets.
    console.error(error?.message?.startsWith('Usage:') ? error.message : 'Monitor failed; check configuration and output permissions.');
    process.exitCode = 1;
  });
}
