// Stage A only: observe the ChatGPT file-input contract without downloading,
// writing files, importing the Desktop Commander server or loading user config.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { fileProbeTool, inspectFileDescriptor } from '../dist/tools/chat-file-probe.js';
export { fileProbeTool, inspectFileDescriptor };

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
