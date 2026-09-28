import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startKeyEntry } from '../key-entry.mjs';

function request(origin, {method='GET', route='/', headers={}, body=''} = {}) {
  return new Promise((resolve,reject) => {
    const req = http.request(origin+route,{method,headers,agent:false},res => {
      let text=''; res.setEncoding('utf8'); res.on('data',chunk => text+=chunk);
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));
    });
    req.on('error',reject); req.end(body);
  });
}

test('loopback form enforces Host, Origin, CSRF and one-shot encrypted save', async t => {
  const saves=[];
  const {server,origin} = await startKeyEntry({encrypt:async ()=>'encrypted-synthetic',save:async value=>saves.push(value)});
  t.after(()=>{server.closeAllConnections(); server.close();});
  const page=await request(origin);
  assert.equal(page.status,200);
  assert.match(page.headers['content-security-policy'],/form-action 'self'/);
  assert.equal(page.headers['cache-control'],'no-store');
  assert.match(page.text,/type="password"/);
  const csrf=/name="csrf" value="([a-f0-9]+)"/.exec(page.text)[1];
  const redirect=await request(origin,{route:'/save'});
  assert.equal(redirect.status,303); assert.equal(redirect.headers.location,'/');
  assert.equal((await request(origin,{headers:{Host:'untrusted.example'}})).status,403);
  const headers={Origin:origin,'Content-Type':'application/x-www-form-urlencoded'};
  const body=new URLSearchParams({csrf,key:'sk-'+ 'SYNTHETIC_ONLY_'.repeat(3)}).toString();
  assert.equal((await request(origin,{method:'POST',route:'/save',headers:{...headers,Origin:'https://untrusted.example'},body})).status,403);
  assert.equal((await request(origin,{method:'POST',route:'/save',headers,body:body.replace(csrf,'wrong')})).status,400);
  assert.equal((await request(origin,{method:'POST',route:'/save',headers,body:new URLSearchParams({csrf,key:'invalid'}).toString()})).status,400);
  assert.equal(saves.length,0);
  assert.equal((await request(origin,{method:'POST',route:'/save',headers,body})).status,200);
  assert.deepEqual(saves,['encrypted-synthetic']);
});

test('expired local form closes without saving', async () => {
  let saves=0;
  const {server} = await startKeyEntry({encrypt:async()=>'',save:async()=>saves++,lifetimeMs:40});
  await new Promise(resolve=>server.once('close',resolve));
  assert.equal(saves,0);
});

test('concurrent submissions cannot overwrite an in-progress save', async t => {
  let release;
  const gate=new Promise(resolve=>release=resolve);
  let count=0;
  const {server,origin}=await startKeyEntry({encrypt:async()=>{await gate;return 'encrypted';},save:async()=>count++});
  t.after(()=>{release();server.closeAllConnections();server.close();});
  const page=await request(origin);
  const csrf=/name="csrf" value="([a-f0-9]+)"/.exec(page.text)[1];
  const options={method:'POST',route:'/save',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,key:'sk-'+ 'SYNTHETIC_ONLY_'.repeat(3)}).toString()};
  const first=request(origin,options);
  const second=request(origin,options);
  const blocked=await Promise.race([first,second]);
  assert.equal(blocked.status,409);
  release();
  const replies=await Promise.all([first,second]);
  assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);
  assert.equal(count,1);
});
