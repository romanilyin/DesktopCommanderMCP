import test from 'node:test';
import assert from 'node:assert/strict';
import { boundMcpMessage, MAX_RESPONSE_BYTES } from '../response-guard.mjs';
import { localMcpEnvironment } from '../start-local.mjs';

test('small text, image and UI resources pass through unchanged', () => {
  for (const message of [
    {jsonrpc:'2.0', id:1, result:{content:[{type:'text',text:'ok'}]}},
    {jsonrpc:'2.0', id:'image', result:{content:[{type:'image',data:'YWJj',mimeType:'image/png'}]}},
    {jsonrpc:'2.0', id:3, result:{contents:[{uri:'ui://local/test',mimeType:'text/html',text:'<div>widget</div>'}]}}
  ]) {
    const result = boundMcpMessage(message);
    assert.equal(result.limited, false);
    assert.equal(result.message, message);
  }
});

for (const isError of [false, true]) test(`oversized tool preserves operation outcome isError=${isError}`, () => {
  const result = boundMcpMessage({jsonrpc:'2.0',id:'request-42',result:{isError,
    content:[{type:'text',text:'x'.repeat(11*1024*1024)}], structuredContent:{secret:'omit'}, _meta:{widget:'omit'}}});
  assert.equal(result.limited,true);
  assert.equal(result.message.id,'request-42');
  assert.equal(result.message.result.isError,isError);
  assert.match(result.message.result.content[0].text,/tool already ran/);
  assert.match(result.message.result.content[0].text,/partial preview/);
  assert.equal(result.message.result.structuredContent,undefined);
  assert.equal(result.message.result._meta,undefined);
  assert(Buffer.byteLength(JSON.stringify(result.message)) < MAX_RESPONSE_BYTES);
});

test('HTML-heavy results are bounded before envelope escaping expands them', () => {
  const message = {jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'<'.repeat(1500000)}]}};
  assert(Buffer.byteLength(JSON.stringify(message)) < MAX_RESPONSE_BYTES);
  assert.equal(boundMcpMessage(message).limited,true);
});

test('oversized resources and notifications produce small valid protocol messages', () => {
  const blob = 'x'.repeat(MAX_RESPONSE_BYTES+1);
  const response = boundMcpMessage({jsonrpc:'2.0',id:0,result:{contents:[{text:blob}]}}).message;
  assert.equal(response.id,0);
  assert.equal(response.error.code,-32000);
  const notification = boundMcpMessage({jsonrpc:'2.0',method:'notifications/message',params:{data:blob}}).message;
  assert.equal(notification.method,'notifications/message');
  assert.equal(notification.params.level,'warning');
  assert(!Object.hasOwn(notification,'id'));
});

test('launcher strips privileged tunnel credentials case-insensitively without changing parent', () => {
  const original = {Path:'original', control_plane_api_key:'synthetic', OPENAI_ADMIN_KEY:'synthetic', KEEP:'yes'};
  const child = localMcpEnvironment(original);
  assert.equal(child.control_plane_api_key,undefined);
  assert.equal(child.OPENAI_ADMIN_KEY,undefined);
  assert.equal(child.KEEP,'yes');
  assert.equal(child.DESKTOP_COMMANDER_DISABLE_TELEMETRY,'1');
  assert.equal(original.control_plane_api_key,'synthetic');
  assert(child.Path.endsWith('original'));
});
