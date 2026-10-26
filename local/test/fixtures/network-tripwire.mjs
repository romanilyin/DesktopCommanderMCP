import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';

// Test-only boundary: fail before any socket or HTTP request can leave the child.
function deny(kind) {
  return (...args) => {
    const value = args[0];
    const target = typeof value === 'string' ? value
      : value instanceof URL ? value.href
      : value?.hostname || value?.host || 'unspecified';
    fs.appendFileSync(process.env.SGG_NETWORK_AUDIT_FILE,
      JSON.stringify({ kind, target }) + '\n');
    throw new Error(`Unexpected outbound network operation: ${kind}`);
  };
}

globalThis.fetch = deny('fetch');
http.request = deny('http.request');
http.get = deny('http.get');
https.request = deny('https.request');
https.get = deny('https.get');
net.connect = deny('net.connect');
net.createConnection = deny('net.createConnection');
net.Socket.prototype.connect = deny('socket.connect');
tls.connect = deny('tls.connect');
dns.lookup = deny('dns.lookup');
syncBuiltinESMExports();
