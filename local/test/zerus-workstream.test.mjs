import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {validateProfile,invocation,command,run} from '../zerus-workstream.mjs';
const root=path.resolve('fixture');
const profile=()=>({schema_version:1,transport:'local',hgs:path.join(root,'hgs'),config_dir:path.join(root,'config'),state_dir:path.join(root,'state'),machine:'pc-a',source_commit:'a'.repeat(40)});
const id='11111111-2222-4333-8444-555555555555';
test('explicit profiles reject unknown transport, fields and relative roots',()=>{
 assert.equal(validateProfile(profile()).machine,'pc-a');
 for(const change of [{transport:'ssh'},{extra:true},{hgs:'hgs'},{source_commit:'main'},{machine:'a;shutdown'}])assert.throws(()=>validateProfile({...profile(),...change}));
});
test('local argv never uses a shell and inherited hgs scope is replaced',()=>{
 const p=profile();const v=invocation(p,['external','checkpoint','--json'],{PATH:'fixture',HGS_STATE_DIR:'wrong',HGS_PEERS:'other'});
 assert.equal(v.file,p.hgs);assert.equal(v.env.HGS_STATE_DIR,p.state_dir);assert.equal(v.env.HGS_PEERS,'');assert.deepEqual(v.args,['external','checkpoint','--json']);
});
test('WSL argv names the exact distro, user and receiver and never forwards a Windows destination',()=>{
 const p={...profile(),transport:'wsl-local',wsl_executable:'C:\\Windows\\System32\\wsl.exe',distribution:'Exact Distro',user:'alice',hgs:'/home/alice/bin/hgs',config_dir:'/home/alice/config',state_dir:'/home/alice/state'};
 validateProfile(p);const v=invocation(p,['inspect','external/project/chat']);
 assert.deepEqual(v.args.slice(0,6),['--distribution','Exact Distro','--user','alice','--exec','env']);assert.equal(v.args.at(-1),'external/project/chat');
});
test('unknown commands and native lifecycle are not a hidden passthrough',()=>{
 for(const verb of ['terminate','start_process','approval','shell','run'])assert.throws(()=>command(verb,{}));
 assert.throws(()=>command('send',{name:'codex/project/session',request_id:id,text:'hi'}));
 assert.throws(()=>command('checkpoint',{name:'external/a/b'}));
});
test('exact send target is argv while payload remains JSON',()=>{
 const c=command('send',{request_id:id,name:'external/project/chat',text:'$(not a shell)'});
 assert.deepEqual(c.args,['send','external/project/chat','--json']);assert.equal(c.input.text,'$(not a shell)');assert.equal('name' in c.input,false);
});
test('unsupported older receiver is never sent an unknown command',async()=>{
 const calls=[];await assert.rejects(run(profile(),'list',{},async c=>{calls.push(c.args);return 'old help';}));assert.deepEqual(calls,[['--help']]);
});
test('dirty and mismatched receiver identity refuses before mutation',async()=>{
 for(const identity of [{source_commit:'b'.repeat(40),source_dirty:false,distribution:'romanilyin/zerus'},{source_commit:'a'.repeat(40),source_dirty:true,distribution:'romanilyin/zerus'}]){
 const calls=[];await assert.rejects(run(profile(),'register',{request_id:id},async c=>{calls.push(c.args);return calls.length===1?'external-workstream-v1':JSON.stringify(identity);}));assert.equal(calls.length,2);
 }
});
test('uncertain write is issued once and never automatically replayed',async()=>{
 let writes=0;
 const runner=async c=>{if(c.args[0]==='--help')return 'external-workstream-v1';if(c.args[0]==='version')return JSON.stringify({source_commit:'a'.repeat(40),source_dirty:false,distribution:'romanilyin/zerus'});writes++;throw Error('unknown outcome');};
 await assert.rejects(run(profile(),'checkpoint',{request_id:id},runner));assert.equal(writes,1);
});
