import { createHash } from 'node:crypto';

const METHODS = new Set([
  'initialize', 'notifications/initialized', 'tools/call', 'tools/list',
  'resources/read', 'resources/list', 'prompts/get', 'prompts/list',
  'resources/templates/list', 'ping', 'logging/setLevel',
]);
const HEALTH_STATUS = new Set(['ok', 'degraded', 'unhealthy', 'error']);
const HEALTH_STATE = new Set(['initialized', 'initializing', 'uninitialized', 'not_initialized',
  'awaiting_initialize', 'connecting', 'disconnected', 'stopped', 'failed']);
const CHILD_STATE = new Set(['running', 'starting', 'stopped', 'failed']);
const PROBE_NAMES = ['healthz', 'readyz', 'health_mcp', 'metrics'];
const PROBE_FAILURES = new Set(['http_error', 'redirect_rejected', 'body_too_large',
  'read_error', 'timeout', 'connection_error', 'health_url_missing', 'health_url_invalid', 'invalid_json']);
const GAUGE_NAMES = new Map([
  ['commands_queue_length', 'queueLength'],
  ['commands_queue_capacity', 'queueCapacity'],
  ['dispatcher_worker_pool_occupancy', 'dispatcherOccupancy'],
  ['dispatcher_worker_pool_capacity', 'dispatcherCapacity'],
  ['commands_poll_last_successful_timestamp_seconds', 'lastSuccessfulPollTimestampSeconds'],
  ['process_start_time_seconds', 'processStartTimestampSeconds'],
]);

const finiteNonnegative = value => Number.isFinite(value) && value >= 0 ? value : null;
const methodName = value => METHODS.has(value) ? value : 'other';
const statusCode = value => /^(?:[1-5][0-9]{2})$/.test(String(value)) ? String(value) : null;
const knownValue = (value, allowed) => allowed.has(value) ? value : 'unknown';

function label(labels, name) {
  const match = new RegExp(`(?:^|,)${name}="((?:\\\\.|[^"\\\\])*)"`).exec(labels);
  return match?.[1] ?? null;
}

/** Parse only a bounded, fixed set of Prometheus metrics. Every other label is discarded. */
export function summarizeMetrics(text) {
  const gauges = {
    queueLength: null, queueCapacity: null, dispatcherOccupancy: null,
    dispatcherCapacity: null, lastSuccessfulPollTimestampSeconds: null,
    processStartTimestampSeconds: null,
  };
  const empty = { status: 'unknown', gauges, counters: { commands: [], initializeCount: null } };
  if (typeof text !== 'string' || text.length > 2_000_000) return empty;
  const groups = new Map();
  let recognized = false;
  for (const line of text.split(/\r?\n/)) {
    const metric = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*$/.exec(line);
    if (!metric) continue;
    const [, name, labels = '', raw] = metric;
    const value = finiteNonnegative(Number(raw));
    if (value === null) continue;
    if (GAUGE_NAMES.has(name)) {
      gauges[GAUGE_NAMES.get(name)] = value;
      recognized = true;
      continue;
    }
    const kind = name === 'command_end_to_end_latency_milliseconds_count' ? 'count'
      : name === 'command_end_to_end_latency_milliseconds_sum' ? 'sum' : null;
    if (!kind) continue;
    const status = statusCode(label(labels, 'tunnel_service_status'));
    if (!status) continue;
    const method = methodName(label(labels, 'request_method'));
    const key = `${method}\0${status}`;
    const group = groups.get(key) ?? { requestMethod: method, tunnelServiceStatus: status, count: 0, sumMilliseconds: 0 };
    group[kind === 'count' ? 'count' : 'sumMilliseconds'] += value;
    groups.set(key, group);
    recognized = true;
  }
  // Bound journal size even if a future server emits many status codes.
  const allCommands = [...groups.values()]
    .filter(group => Number.isFinite(group.count) && Number.isFinite(group.sumMilliseconds))
    .sort((a, b) => a.requestMethod.localeCompare(b.requestMethod) || a.tunnelServiceStatus.localeCompare(b.tunnelServiceStatus));
  const initializeCount = allCommands.reduce((total, group) => total +
    (group.requestMethod === 'initialize' ? group.count : 0), 0);
  const commands = allCommands.length <= 128 ? allCommands : allCommands
    .sort((a, b) => {
      const priority = item => item.tunnelServiceStatus === '409' || Number(item.tunnelServiceStatus) >= 500 ? 0 : 1;
      return priority(a) - priority(b) || a.requestMethod.localeCompare(b.requestMethod) ||
        a.tunnelServiceStatus.localeCompare(b.tunnelServiceStatus);
    }).slice(0, 128);
  return { status: recognized ? 'ok' : 'unknown', gauges,
    counters: { commands, initializeCount: allCommands.length ? initializeCount : null } };
}

function isoDate(value) {
  if (typeof value !== 'string' || value.length > 40 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Return fixed health fields only. Generation is hashed so runtime identifiers never leave this layer. */
export function sanitizeMcpHealth(json) {
  const unknown = { status: 'unknown', state: 'unknown', childState: 'unknown',
    childGenerationHash: null, initializeEpoch: null, initialize: { ok: null, observedAt: null } };
  let input = json;
  if (typeof input === 'string') {
    if (input.length > 100_000) return unknown;
    try { input = JSON.parse(input); } catch { return unknown; }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schema_version !== 1 ||
      !input.details || typeof input.details !== 'object' || Array.isArray(input.details)) return unknown;
  const details = input.details;
  const generation = details.child_generation;
  const childGenerationHash = typeof generation === 'string' && generation.length > 0 && generation.length <= 256
    ? createHash('sha256').update(generation).digest('hex').slice(0, 16) : null;
  return {
    status: knownValue(input.status, HEALTH_STATUS),
    state: knownValue(input.state, HEALTH_STATE),
    childState: knownValue(details.child_state, CHILD_STATE),
    childGenerationHash,
    initializeEpoch: Number.isSafeInteger(details.initialize_epoch) && details.initialize_epoch >= 0
      ? details.initialize_epoch : null,
    initialize: {
      ok: typeof details.initialize?.ok === 'boolean' ? details.initialize.ok : null,
      observedAt: isoDate(details.initialize?.observed_at),
    },
  };
}

function gauge(sample, name) {
  return finiteNonnegative(sample?.metrics?.gauges?.[name]);
}
function health(sample) {
  return sample?.health && typeof sample.health === 'object' ? sample.health : null;
}
function counterMap(sample) {
  const result = new Map();
  const commands = sample?.metrics?.counters?.commands;
  if (!Array.isArray(commands)) return result;
  for (const raw of commands.slice(0, 128)) {
    const status = statusCode(raw?.tunnelServiceStatus);
    if (!status) continue;
    const method = methodName(raw?.requestMethod);
    const count = finiteNonnegative(raw?.count);
    const sum = finiteNonnegative(raw?.sumMilliseconds);
    if (count === null || sum === null) continue;
    result.set(`${method}\0${status}`, { requestMethod: method, tunnelServiceStatus: status, count, sumMilliseconds: sum });
  }
  return result;
}
function incident(code, severity, evidence) { return { code, severity, evidence }; }
function probeState(sample, name) {
  const value = sample?.probes?.[name];
  if (!value || typeof value !== 'object') return null;
  if (value.state === 'ok') return { state: 'ok', statusCode: 200 };
  if (!PROBE_FAILURES.has(value.state)) return { state: 'unknown', statusCode: null };
  return { state: value.state, statusCode: statusCode(value.statusCode) ? Number(value.statusCode) : null };
}

/** Compare two sanitized samples. Counter alerts require a positive interval delta. */
export function analyzeSample(current, previous = null) {
  if (!current || typeof current !== 'object') return [incident('sample_unknown', 'warning', {})];
  const incidents = [];
  const now = isoDate(current.observedAt);
  // Tail counts cover only newly consumed records, not cumulative metrics. A dropped
  // response may never increment a 5xx counter and can coexist with healthy probes.
  const deadlineDrops = current.tunnelLog?.deadlineDropCount;
  if (Number.isSafeInteger(deadlineDrops) && deadlineDrops > 0) {
    incidents.push(incident('command_response_deadline', 'error', { count: deadlineDrops }));
  }
  if (current.metrics?.status !== 'ok' && (!previous || previous.metrics?.status === 'ok')) {
    incidents.push(incident('metrics_unknown', 'warning', {}));
  }
  const currentHealth = health(current);
  const previousHealth = health(previous);
  const processStart = gauge(current, 'processStartTimestampSeconds');
  const previousProcessStart = gauge(previous, 'processStartTimestampSeconds');
  const processRestarted = previous && processStart !== null && previousProcessStart !== null && processStart > previousProcessStart;
  const childRestarted = previousHealth?.childGenerationHash && currentHealth?.childGenerationHash &&
    previousHealth.childGenerationHash !== currentHealth.childGenerationHash;
  if (processRestarted) incidents.push(incident('process_restart', 'warning', { processStartTimestampSeconds: processStart }));
  if (childRestarted) incidents.push(incident('child_restart', 'warning', { changed: true }));

  const currentEpoch = finiteNonnegative(currentHealth?.initializeEpoch);
  const previousEpoch = finiteNonnegative(previousHealth?.initializeEpoch);
  if (previous && currentEpoch !== null && previousEpoch !== null && currentEpoch !== previousEpoch) {
    incidents.push(incident('initialize_churn', 'info', { initializeEpoch: currentEpoch }));
  }

  const status = knownValue(currentHealth?.status, HEALTH_STATUS);
  const previousStatus = knownValue(previousHealth?.status, HEALTH_STATUS);
  if (status === 'unknown' && (!previous || previousStatus !== 'unknown')) incidents.push(incident('health_unknown', 'warning', {}));
  else if (status !== 'unknown' && status !== 'ok' && status !== previousStatus) {
    incidents.push(incident('health_failure', 'warning', { status }));
  }
  const state = knownValue(currentHealth?.state, HEALTH_STATE);
  const previousState = knownValue(previousHealth?.state, HEALTH_STATE);
  if (state !== 'unknown' && state !== 'initialized' && state !== previousState) {
    incidents.push(incident('not_initialized', 'warning', { state }));
  } else if (state === 'unknown' && status === 'ok' && (!previous || previousState !== 'unknown')) {
    incidents.push(incident('health_state_unknown', 'warning', {}));
  }
  if (currentHealth?.initialize?.ok === false && previousHealth?.initialize?.ok !== false) {
    incidents.push(incident('initialize_failed', 'warning', {}));
  }

  const length = gauge(current, 'queueLength');
  const capacity = gauge(current, 'queueCapacity');
  const prevLength = gauge(previous, 'queueLength');
  const prevCapacity = gauge(previous, 'queueCapacity');
  const queueFull = length !== null && capacity !== null && capacity > 0 && length >= capacity;
  const wasQueueFull = prevLength !== null && prevCapacity !== null && prevCapacity > 0 && prevLength >= prevCapacity;
  if (queueFull && !wasQueueFull) incidents.push(incident('queue_saturated', 'warning', { queueLength: length, queueCapacity: capacity }));
  const occupancy = gauge(current, 'dispatcherOccupancy');
  const workers = gauge(current, 'dispatcherCapacity');
  const prevOccupancy = gauge(previous, 'dispatcherOccupancy');
  const prevWorkers = gauge(previous, 'dispatcherCapacity');
  if (occupancy !== null && workers > 0 && occupancy >= workers &&
      !(prevOccupancy !== null && prevWorkers > 0 && prevOccupancy >= prevWorkers)) {
    incidents.push(incident('dispatcher_saturated', 'warning', { dispatcherOccupancy: occupancy, dispatcherCapacity: workers }));
  }
  const poll = gauge(current, 'lastSuccessfulPollTimestampSeconds');
  const prevPoll = gauge(previous, 'lastSuccessfulPollTimestampSeconds');
  const age = now && poll !== null ? Math.max(0, Date.parse(now) / 1000 - poll) : null;
  const previousAt = isoDate(previous?.observedAt);
  const previousAge = previousAt && prevPoll !== null ? Math.max(0, Date.parse(previousAt) / 1000 - prevPoll) : null;
  if (age !== null && age > 60 && (previousAge === null || previousAge <= 60)) {
    incidents.push(incident('poll_stale', 'warning', { ageSeconds: Math.floor(age) }));
  }

  for (const name of PROBE_NAMES) {
    const currentProbe = probeState(current, name);
    const previousProbe = probeState(previous, name);
    if (!currentProbe) continue;
    if (currentProbe.state !== 'ok' && (!previousProbe || previousProbe.state === 'ok' || previousProbe.state !== currentProbe.state)) {
      incidents.push(incident('monitor_probe_failure', 'warning', {
        probe: name, state: currentProbe.state, statusCode: currentProbe.statusCode,
      }));
    } else if (currentProbe.state === 'ok' && previousProbe && previousProbe.state !== 'ok') {
      incidents.push(incident('monitor_probe_recovered', 'info', { probe: name }));
    }
  }

  // A process/child restart may reset counters. New incidents then start in the next interval.
  if (previous && current.metrics?.status === 'ok' && previous.metrics?.status === 'ok' &&
      !processRestarted && !childRestarted) {
    const before = counterMap(previous);
    for (const [key, entry] of counterMap(current)) {
      const old = before.get(key) ?? { count: 0, sumMilliseconds: 0 };
      if (entry.count < old.count || entry.sumMilliseconds < old.sumMilliseconds) continue;
      const count = entry.count - old.count;
      if (count <= 0) continue;
      const evidence = { requestMethod: entry.requestMethod, tunnelServiceStatus: entry.tunnelServiceStatus, count };
      if (entry.tunnelServiceStatus === '409') incidents.push(incident('conflict_http_409', 'warning', evidence));
      else if (Number(entry.tunnelServiceStatus) >= 500) incidents.push(incident('service_5xx', 'error', evidence));
      const mean = (entry.sumMilliseconds - old.sumMilliseconds) / count;
      if (Number.isFinite(mean) && mean > 30_000) {
        incidents.push(incident('slow_commands', 'warning', { ...evidence, meanMilliseconds: Math.round(mean) }));
      }
    }
  }
  return incidents;
}
