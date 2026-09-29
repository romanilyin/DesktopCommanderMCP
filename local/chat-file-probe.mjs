// Stage A only: observe the ChatGPT file-input contract without downloading,
// writing files, importing the Desktop Commander server or loading user config.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const fileProbeTool = {
  name: 'inspect_chat_file_source',
  title: 'Check ChatGPT file handoff (does not save)',
  description: 'Check whether ChatGPT can pass a selected attachment or generated image to this test MCP. '
    + 'Pass the actual file using the file parameter. Returns only field-presence flags and the HTTPS source host. '
    + 'Does not download, save, modify, or execute the file. Do not manufacture a file ID or download URL.',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'object',
        properties: {
          download_url: { type: 'string' },
          file_id: { type: 'string' },
          mime_type: { type: 'string' },
          file_name: { type: 'string' },
        },
        required: ['download_url', 'file_id'],
        additionalProperties: false,
      },
    },
    required: ['file'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true,
  },
  _meta: { 'openai/fileParams': ['file'] },
};

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorResult = () => ({
  isError: true,
  content: [{ type: 'text', text: 'INVALID_FILE_DESCRIPTOR: select a file in ChatGPT. '
    + 'The file must contain nonempty download_url and file_id strings; file_name and mime_type are optional strings. '
    + 'Only an HTTPS URL without embedded credentials is accepted. Nothing was downloaded or saved.' }],
});

export function inspectFileDescriptor(args) {
  try {
    if (!object(args) || Object.keys(args).some(key => key !== 'file') || !object(args.file)) return errorResult();
    const f = args.file;
    const properties = fileProbeTool.inputSchema.properties.file.properties;
    if (Object.keys(f).some(key => !Object.hasOwn(properties, key))) return errorResult();
    for (const key of ['download_url', 'file_id']) {
      if (typeof f[key] !== 'string' || f[key].trim().length === 0 || f[key].length > 16384) return errorResult();
    }
    for (const key of ['file_name', 'mime_type']) {
      if (Object.hasOwn(f, key) && (typeof f[key] !== 'string' || f[key].length > 1024)) return errorResult();
    }
    const url = new URL(f.download_url);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.hostname.length > 253) {
      return errorResult();
    }
    // Host only, never path/query/fragment, IDs, names, arbitrary MIME or raw args.
    // A host being observed does not make it approved for a future downloader.
    const observation = {
      stage: 'metadata_only',
      fields_present: {
        download_url: true, file_id: true,
        mime_type: Object.hasOwn(f, 'mime_type'), file_name: Object.hasOwn(f, 'file_name'),
      },
      source_host: url.hostname,
      standard_https_port: !url.port || url.port === '443',
      declared_image_type: ['image/png', 'image/jpeg', 'image/webp'].includes(f.mime_type) ? f.mime_type : 'unverified',
      download_checked: false,
      file_saved: false,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(observation) }],
      structuredContent: observation,
    };
  } catch {
    // Never echo a URL parser exception or a malformed argument value.
    return errorResult();
  }
}

export function createFileProbeServer() {
  const server = new Server({ name: 'desktop-commander-chat-file-probe', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [fileProbeTool] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name !== fileProbeTool.name) {
      return { isError: true, content: [{ type: 'text', text: 'UNKNOWN_TOOL: this test server only inspects file descriptors.' }] };
    }
    return inspectFileDescriptor(request.params.arguments);
  });
  return server;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const server = createFileProbeServer();
  server.onerror = () => { process.stderr.write('File probe protocol error; details omitted.\n'); };
  try {
    await server.connect(new StdioServerTransport());
  } catch {
    process.stderr.write('File probe startup failed; details omitted.\n');
    process.exitCode = 1;
  }
}
