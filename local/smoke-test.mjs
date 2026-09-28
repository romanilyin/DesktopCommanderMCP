import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(await fs.readFile(path.join(root,'.local','config.json'),'utf8'));
const state=path.join(root,'.local','state');
const temporaryRoot=path.join(root,'.local','tmp');
await fs.mkdir(state,{recursive:true});
await fs.mkdir(temporaryRoot,{recursive:true});
const fixture=await fs.mkdtemp(path.join(temporaryRoot,'smoke-'));
const client=new Client({name:'local-deployment-smoke-test',version:'1.0.0'});
const transport=new StdioClientTransport({command:config.nodePath,args:[path.join(root,'local','start-local.mjs')],stderr:'pipe'});
let stderr='';
transport.stderr?.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-32000);});
const report={date:new Date().toISOString(),hostname:os.hostname(),transport:'local stdio (no tunnel)',checks:[]};
const textOf=result=>(result.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
async function call(name,args={}) {
  const result=await client.callTool({name,arguments:args},undefined,{timeout:30000});
  assert(!result.isError,`${name}: ${textOf(result).slice(0,2000)}`);
  return result;
}
try {
  await client.connect(transport);
  report.server=client.getServerVersion();
  const {tools}=await client.listTools();
  report.toolCount=tools.length;
  for(const name of ['get_config','read_file','write_file','edit_block','start_search','start_process','read_process_output']) {
    assert(tools.some(tool=>tool.name===name),`Missing ${name}`);
  }
  report.checks.push('initialize and tools/list');
  await call('get_config');
  report.checks.push('get_config');

  const probe=path.join(fixture,'probe.txt');
  const marker='DESKTOP_COMMANDER_SMOKE_ORIGINAL';
  const edited='DESKTOP_COMMANDER_SMOKE_EDITED';
  await call('write_file',{path:probe,content:marker,mode:'rewrite'});
  assert(textOf(await call('read_file',{path:probe})).includes(marker));
  await call('edit_block',{file_path:probe,old_string:marker,new_string:edited});
  assert(textOf(await call('read_file',{path:probe})).includes(edited));
  report.checks.push('file write, read and edit');

  const search=await call('start_search',{path:fixture,pattern:edited,searchType:'content',literalSearch:true,maxResults:5,timeout_ms:10000,includeHidden:true});
  let searchText=textOf(search);
  const searchId=search.structuredContent?.sessionId ?? /(?:Session ID:|sessionId["']?\s*:)\s*["']?([^\s"',}]+)/i.exec(searchText)?.[1];
  if(!searchText.includes('probe.txt') && searchId) {
    for(let attempt=0;attempt<10;attempt++) {
      await new Promise(resolve=>setTimeout(resolve,100));
      searchText=textOf(await call('get_more_search_results',{sessionId:searchId,offset:0,length:5}));
      if(searchText.includes('probe.txt')) break;
    }
  }
  assert(searchText.includes('probe.txt'),'Search did not find the fixture');
  report.checks.push('content search');

  const started=await call('start_process',{command:"Start-Sleep -Milliseconds 800; Write-Output 'LOCAL_MCP_ASYNC_OK'; Write-Output $PSVersionTable.PSVersion.ToString()",shell:config.powerShellPath,timeout_ms:100});
  const processText=textOf(started);
  const pid=started.structuredContent?.pid ?? Number(/(?:PID|process\s+id)["']?\s*[:=]?\s*(\d+)/i.exec(processText)?.[1]);
  let output=processText;
  if(!output.includes('LOCAL_MCP_ASYNC_OK')) {
    assert(Number.isInteger(pid)&&pid>0,'No process PID returned');
    for(let attempt=0;attempt<6;attempt++) {
      output+=textOf(await call('read_process_output',{pid,timeout_ms:1000,offset:0,length:30}));
      if(output.includes('LOCAL_MCP_ASYNC_OK')) break;
    }
  }
  assert(output.includes('LOCAL_MCP_ASYNC_OK'),'PowerShell output missing');
  report.checks.push('PowerShell launch and asynchronous output');

  const large=path.join(fixture,'large-output.txt');
  await fs.writeFile(large,'L'.repeat(11*1024*1024));
  const bounded=await call('read_file',{path:large,offset:0,length:1});
  assert(textOf(bounded).includes('OUTPUT LIMITED BY LOCAL TUNNEL ADAPTER'));
  assert(Buffer.byteLength(JSON.stringify(bounded))<2*1024*1024);
  await call('get_config');
  report.checks.push('11 MiB output bounded; next request succeeds');

  const {resources}=await client.listResources();
  for(const resource of resources) {
    const result=await client.readResource({uri:resource.uri});
    assert(result.contents.length>0,`Empty resource ${resource.uri}`);
  }
  report.resourceCount=resources.length;
  report.checks.push('UI resources remain readable');
  report.success=true;
} catch(error) {
  report.success=false;
  report.error=String(error);
  process.exitCode=1;
} finally {
  await client.close().catch(()=>{});
  const relative=path.relative(temporaryRoot,path.resolve(fixture));
  if(relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    await fs.rm(fixture,{recursive:true,force:true});
  }
  await fs.writeFile(path.join(state,'smoke-test-report.json'),JSON.stringify(report,null,2)+'\n');
  await fs.writeFile(path.join(state,'smoke-test-stderr.log'),stderr);
}
console.log(JSON.stringify(report,null,2));
