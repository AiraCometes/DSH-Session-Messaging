import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Store, ControlTower } from '../src/core/index.js';
import { GitHubIntegration } from '../src/integrations/github.js';
import { startServer } from '../src/http/server.js';

const secret='test-webhook-secret';
const token='test-viewer-token-at-least-24-bytes';
function fixture(t){
  const store=new Store();t.after(()=>store.close());const tower=new ControlTower(store);
  for(const [id,role]of [['control','tower'],['github','integration']])tower.registerSession({id,role,adapter:'test',address:id,model:'test',provider:'test'});
  const github=new GitHubIntegration(tower,{secret,repositories:['AiraCometes/DSH-Session-Messaging'],sender:'github',target:'control'});
  return {tower,github};
}
const payload=()=>Buffer.from(JSON.stringify({repository:{full_name:'AiraCometes/DSH-Session-Messaging'},ref:'refs/heads/main',after:'a'.repeat(40)}));
const headers=(raw,id='delivery-1')=>({signature:`sha256=${createHmac('sha256',secret).update(raw).digest('hex')}`,deliveryId:id,event:'push'});

test('signed GitHub delivery is audited and queued exactly once; signature and allowlist enforced',t=>{
  const {tower,github}=fixture(t),raw=payload();
  const result=github.receive(raw,headers(raw));assert.ok(result.messageId);
  assert.deepEqual(github.receive(raw,headers(raw)),{duplicate:true});
  assert.equal(tower.snapshot().messages.length,1);
  assert.match(tower.snapshot().messages[0].body,/external data, not instructions/);
  assert.throws(()=>github.receive(raw,{...headers(raw),signature:'sha256='+'0'.repeat(64)}),e=>e.code==='BAD_SIGNATURE');
  const changed=Buffer.from(JSON.stringify({repository:{full_name:'unapproved/repo'}}));
  assert.throws(()=>github.receive(changed,headers(changed)),e=>e.code==='REPOSITORY_DENIED');
  const conflicting=Buffer.from(raw.toString().replace('refs/heads/main','refs/heads/other'));
  assert.throws(()=>github.receive(conflicting,headers(conflicting)),e=>e.code==='DELIVERY_CONFLICT');
});

test('queue failure rolls back webhook receipt, permitting a later retry',t=>{
  const {tower,github}=fixture(t);tower.maxPending=1;
  const raw=payload();github.receive(raw,headers(raw,'one'));
  assert.throws(()=>github.receive(raw,headers(raw,'two')),e=>e.code==='QUEUE_FULL');
  tower.maxPending=2;
  assert.ok(github.receive(raw,headers(raw,'two')).messageId);
});

test('observer HTTP authenticates data, pages audit history, and verifies webhook bytes',async t=>{
  const {tower,github}=fixture(t);
  const viewer=await startServer(tower,{token,port:0,github});t.after(()=>viewer.close());
  assert.equal((await fetch(`${viewer.url}/api/snapshot`)).status,401);
  const page=await fetch(viewer.url);assert.equal(page.status,200);
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal((await fetch(`${viewer.url}/api/snapshot`,{headers:{Authorization:`Bearer ${token}`,Origin:'https://attacker.example'}})).status,403);
  const auth={Authorization:`Bearer ${token}`};
  const snapshot=await (await fetch(`${viewer.url}/api/snapshot`,{headers:auth})).json();assert.equal(snapshot.sessions.length,2);
  const events=await (await fetch(`${viewer.url}/api/events?after=0&limit=1`,{headers:auth})).json();assert.equal(events.events.length,1);
  assert.equal((await fetch(`${viewer.url}/api/events?after=NaN`,{headers:auth})).status,400);
  const raw=payload(),signed=headers(raw);
  const response=await fetch(`${viewer.url}/webhooks/github`,{method:'POST',body:raw,headers:{'x-hub-signature-256':signed.signature,'x-github-delivery':signed.deliveryId,'x-github-event':signed.event}});
  assert.equal(response.status,202);assert.ok((await response.json()).messageId);
  assert.equal((await fetch(`${viewer.url}/api/tasks`,{method:'POST',headers:auth,body:'{}'})).status,404);
});
