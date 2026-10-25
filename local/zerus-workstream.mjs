/** Optional Zerus cooperative workstream adapter. No cloud-chat API or shell. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const LIMIT = 128 * 1024;
const VERBS = new Set(['register','checkpoint','handoff','inbox','ack','list','inspect','send','history']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function require(value,message) { if(!value) throw new Error(message); }
export function validateProfile(value) {
  require(value && typeof value === 'object' && !Array.isArray(value),'Expected a profile object');
  const keys = ['schema_version','transport','hgs','config_dir','state_dir','machine','source_commit','distribution','user','wsl_executable'];
  require(Object.keys(value).every(k=>keys.includes(k)) && value.schema_version===1,'Unknown profile schema/field');
  require(['local','wsl-local'].includes(value.transport),'Explicit local or wsl-local transport required');
  for(const key of ['hgs','config_dir','state_dir','machine','source_commit'])
    require(typeof value[key]==='string' && value[key].length>0 && value[key].length<=4096 && !/[\x00-\x1f\x7f]/.test(value[key]),'Invalid profile field: '+key);
  require(/^[a-zA-Z0-9_.-]{1,64}$/.test(value.machine),'Invalid machine alias');
  require(/^[0-9a-f]{40}$/.test(value.source_commit),'Pin the exact reviewed Zerus source commit');
  if(value.transport==='wsl-local') {
    for(const key of ['distribution','user','wsl_executable']) require(typeof value[key]==='string'&&value[key].length>0&&value[key].length<=512&&!/[\x00-\x1f\x7f]/.test(value[key]),'Incomplete WSL profile');
    require(path.win32.isAbsolute(value.wsl_executable) && /[\\/]wsl[.]exe$/i.test(value.wsl_executable),'Select an absolute wsl.exe path');
    for(const key of ['hgs','config_dir','state_dir'])require(value[key].startsWith('/')&&!value[key].startsWith('//'),'Use explicit Linux absolute paths');
  } else {
    for(const key of ['hgs','config_dir','state_dir'])require(path.isAbsolute(value[key]),'Use absolute local paths');
    require(!['distribution','user','wsl_executable'].some(k=>k in value),'A local profile cannot hide WSL settings');
  }
  return value;
}
export function invocation(profile,args,environment=process.env) {
  const env = Object.fromEntries(Object.entries(environment).filter(([key])=>!key.toUpperCase().startsWith('HGS_')));
  if(profile.transport==='local') {
    Object.assign(env,{HGS_CONFIG_DIR:profile.config_dir,HGS_STATE_DIR:profile.state_dir,HGS_SELF:profile.machine,HGS_PEERS:''});
    return {file:profile.hgs,args:[...args],env};
  }
  return {file:profile.wsl_executable,args:['--distribution',profile.distribution,'--user',profile.user,'--exec','env',
    'HGS_CONFIG_DIR='+profile.config_dir,'HGS_STATE_DIR='+profile.state_dir,'HGS_SELF='+profile.machine,'HGS_PEERS=',profile.hgs,...args],env};
}
export function command(action,payload) {
  require(VERBS.has(action),'Unsupported operation; this adapter never runs arbitrary hgs commands');
  require(payload && typeof payload==='object' && !Array.isArray(payload),'Expected one JSON object');
  require(Buffer.byteLength(JSON.stringify(payload))<=LIMIT,'Request exceeds 128 KiB');
  if(!['list','inbox','inspect','history'].includes(action))require(typeof payload.request_id==='string'&&UUID.test(payload.request_id),'Provide and retain a unique request_id; an uncertain write is never automatically retried');
  if(['inspect','send','history'].includes(action)) {
    require(typeof payload.name==='string'&&/^external\/[^/\\:\x00-\x1f]{1,100}\/[^/\\:\x00-\x1f]{1,100}$/.test(payload.name),'Select an exact external/project/session');
    const {name,...rest}=payload;
    if(action==='inspect') {require(Object.keys(rest).length===0,'Inspect accepts only the exact name');return {args:['inspect',name,'--skip-processes'],input:null};}
    return {args:[action,name,'--json'],input:rest};
  }
  return {args:['external',action,'--json'],input:payload};
}
export function execute(call,input,timeout=15000) {
  return new Promise((resolve,reject)=>{
    const child=spawn(call.file,call.args,{env:call.env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    const chunks=[];let size=0,errors='',failed=false;
    const fail=message=>{if(failed)return;failed=true;child.kill();reject(new Error(message));};
    const timer=setTimeout(()=>fail('Local adapter timed out; delivery may be uncertain. Inspect before any retry.'),timeout);
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>3*1024*1024)fail('Output exceeds the bounded adapter response');else chunks.push(chunk);});
    child.stderr.on('data',chunk=>{if(errors.length<4096)errors+=chunk.toString('utf8').slice(0,4096-errors.length);});
    child.on('error',error=>{clearTimeout(timer);if(!failed){failed=true;reject(new Error('Could not start the explicitly selected receiver: '+error.code));}});
    child.on('close',code=>{clearTimeout(timer);if(failed)return;if(code!==0){reject(new Error('Receiver rejected the operation ('+code+'): '+errors));return;}resolve(Buffer.concat(chunks).toString('utf8'));});
    child.stdin.on('error',()=>{});
    child.stdin.end(input===null?'':JSON.stringify(input));
  });
}
export async function run(profile,action,payload,runner=execute) {
  validateProfile(profile);const request=command(action,payload);
  const help=await runner(invocation(profile,['--help']),null);
  require(help.includes('external-workstream-v1'),'Selected receiver does not advertise the cooperative workstream contract');
  const identity=JSON.parse(await runner(invocation(profile,['version','--json']),null));
  require(identity.source_commit===profile.source_commit&&identity.source_dirty===false&&identity.distribution==='romanilyin/zerus','Receiver source identity differs from the reviewed clean build');
  const raw=await runner(invocation(profile,request.args),request.input);
  return JSON.parse(raw);
}
export async function main(args=process.argv.slice(2)) {
  require(args.length===3 || args.length===5,'Usage: node local/zerus-workstream.mjs --profile ABSOLUTE_PROFILE action [--input-file ABSOLUTE_JSON]');
  require(args[0]==='--profile'&&path.isAbsolute(args[1]),'Choose an explicit absolute local profile');
  const info=fs.lstatSync(args[1]);require(info.isFile()&&!info.isSymbolicLink()&&info.size<=16384,'Unsafe or oversized adapter profile');
  const profile=JSON.parse(fs.readFileSync(args[1],'utf8'));
  let bytes;
  if(args.length===5){require(args[3]==='--input-file'&&path.isAbsolute(args[4]),'Expected an explicit input file');const st=fs.lstatSync(args[4]);require(st.isFile()&&!st.isSymbolicLink()&&st.size<=LIMIT,'Unsafe/oversized request file');bytes=fs.readFileSync(args[4]);}
  else {const chunks=[];let count=0;for await(const chunk of process.stdin){count+=chunk.length;require(count<=LIMIT,'Request exceeds 128 KiB');chunks.push(chunk);}bytes=Buffer.concat(chunks);}
  const payload=bytes.length?JSON.parse(bytes.toString('utf8')):{};
  process.stdout.write(JSON.stringify(await run(profile,args[2],payload))+'\n');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){main().catch(error=>{process.stderr.write('Zerus workstream: '+error.message+'\n');process.exitCode=2;});}
