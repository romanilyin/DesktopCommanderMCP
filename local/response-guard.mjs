// A service response was rejected at 10 MiB. Bound JSON before it reaches the
// SDK transport, leaving room for the tunnel envelope and additional escaping.
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ESCAPED_BYTES = 8 * 1024 * 1024;
const installed = Symbol.for('desktop-commander-local.response-guard');

function escapedEnvelopeBytes(json) {
  // Conservative allowance if the JSON is nested in a string and a Go encoder
  // additionally escapes HTML-sensitive characters and Unicode separators.
  return Buffer.byteLength(JSON.stringify(json).replace(/[<>&\u2028\u2029]/g,
    char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')), 'utf8');
}

export function boundMcpMessage(message) {
  const serialized = JSON.stringify(message);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= MAX_RESPONSE_BYTES && escapedEnvelopeBytes(serialized) <= MAX_ESCAPED_BYTES) {
    return { message, bytes, limited: false };
  }
  if (message.result && Array.isArray(message.result.content)) {
    const originalError = message.result.isError === true;
    let preview = '';
    for (const item of message.result.content) {
      if (preview.length >= 16000) break;
      if (item.type === 'text' && typeof item.text === 'string') {
        preview += item.text.slice(0, 16000 - preview.length) + '\n';
      }
    }
    const notice = `OUTPUT LIMITED BY LOCAL TUNNEL ADAPTER: original response ${bytes} bytes. ` +
      `The tool already ran; its reported isError was ${originalError}. ` +
      'Do not repeat file changes or process launches just to retrieve output. ' +
      'Read the existing file or process output in smaller portions (offset/length), or narrow the query. ' +
      'Large structured content, images and widget metadata are omitted. ' +
      'The text below is a partial preview, not the complete result.\n\n' + preview;
    return { bytes, limited: true, message: {
      jsonrpc: '2.0', id: message.id,
      result: { content: [{ type: 'text', text: notice }], isError: originalError }
    }};
  }
  if (Object.hasOwn(message, 'id')) {
    return { bytes, limited: true, message: {
      jsonrpc: '2.0', id: message.id,
      error: { code: -32000, message: `MCP response exceeds the local tunnel size budget (${bytes} bytes). Request a smaller resource or narrower result.` }
    }};
  }
  return { bytes, limited: true, message: {
    jsonrpc: '2.0', method: 'notifications/message',
    params: { level: 'warning', logger: 'local-tunnel-adapter', data: `Oversized notification omitted (${bytes} bytes).` }
  }};
}

export async function installResponseGuard() {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  if (StdioServerTransport.prototype[installed]) return;
  const originalSend = StdioServerTransport.prototype.send;
  StdioServerTransport.prototype.send = function (message) {
    const bounded = boundMcpMessage(message);
    if (bounded.limited) {
      process.stderr.write(`[local-tunnel-adapter] bounded SDK response; original_bytes=${bounded.bytes}\n`);
    }
    return originalSend.call(this, bounded.message);
  };
  StdioServerTransport.prototype[installed] = true;
}
