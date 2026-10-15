import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessAdapter } from '../src/adapters/harness.js';
import { applyWithDependencies } from '../src/plugin.js';
import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

function host(){
  const all=new Map(),hooks=new Map(),effects=[];
  for(const id of ['session-control','session-impl']){
    const tools=new Map();
    all.set(id,{id,status:'inactive',inbox:[],ctx:{tools:{register(def){tools.set(def.name,def);return ()=>tools.delete(def.name);}}},tools,
      steer(input){this.inbox.push(input);}});
  }
  return {all,hooks,effects,ctx:{agents:{get:id=>all.get(id),list:()=>[...all.values()]},
    on(event,listener){hooks.set(event,listener);},effect(fn){effects.push(fn());},logger:{info(){},warn(){}}}};
}

test('Harness adapter preserves sender identity and treats steer return as admission',async()=>{
  const {all,ctx}=host();
  const adapter=createHarnessAdapter({agents:ctx.agents,createUserMessage:input=>({...input,id:'inbox-id'})});
  const message={id:'message-id',from:'control',to:'impl',body:'Do work',taskId:'TASK',sender:{address:'session-control',role:'tower',model:'mA',provider:'pA'},recipient:{address:'session-impl'}};
  assert.deepEqual(await adapter.deliver(message),{id:'inbox-id'});
  assert.equal(all.get('session-impl').inbox[0].source.senderSessionId,'session-control');
  assert.match(all.get('session-impl').inbox[0].content[0].text,/message-id/);
  all.delete('session-impl');await assert.rejects(adapter.deliver(message),{name:'DeliveryRejected'});
});

test('Harness adapter rejects revoked bindings and labels external events as machine data',async()=>{
  const {all,ctx}=host();
  const message={id:'event-id',from:'github',to:'impl',body:'External event',sender:{address:'webhook',role:'integration',model:'none',provider:'github'},recipient:{address:'session-impl'}};
  const adapter=createHarnessAdapter({agents:ctx.agents,createUserMessage,bindings:new Map([['session-impl','impl']])});
  await adapter.deliver(message);
  assert.equal(all.get('session-impl').inbox[0].source.kind,'control-tower-github');
  await assert.rejects(adapter.deliver({...message,to:'revoked'}),{name:'DeliveryRejected'});
});

test('published Harness packages accept tool schemas and canonical message results',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'tower-real-api-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const {ctx,all}=host();
  const runtime=await applyWithDependencies(ctx,{database:join(dir,'tower.sqlite'),viewer:false,sessions:[
    {id:'control',role:'tower',address:'session-control',model:'a',provider:'p'},
    {id:'impl',role:'implementation',address:'session-impl',model:'b',provider:'p'},
  ]},{defineTool,createUserMessage});t.after(()=>runtime.dispose());
  const agent=all.get('session-control'),exec={agent,signal:new AbortController().signal};
  const tool=agent.tools.get('tower_send_message');
  await assert.rejects(tool.execute({to:'impl'},exec),{name:'ToolArgsError'});
  const message=await tool.execute({to:'impl',body:'Real API contract',idempotency_key:'real'},exec);
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema,message,''),[]);
  assert.equal(tool.output.render({},message)[0].type,'text');
  await runtime.tower.dispatchQueued();
  const input=all.get('session-impl').inbox[0];
  assert.equal(input.role,'user');assert.ok(Object.isFrozen(input));assert.ok(input.id);
  assert.equal(input.source.senderSessionId,agent.id);
});

test('plugin registers scoped tools, rejects spoofed callers, dispatches and disposes cleanly',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'tower-plugin-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const {ctx,all}=host();
  const runtime=await applyWithDependencies(ctx,{database:join(dir,'tower.sqlite'),viewer:false,pollMs:60000,sessions:[
    {id:'control',role:'tower',address:'session-control',model:'mA',provider:'pA'},
    {id:'impl',role:'implementation',address:'session-impl',model:'mB',provider:'pB'},
  ]},{defineTool:value=>value,createUserMessage:value=>({...value,id:'accepted-id'})});
  t.after(()=>runtime.dispose());
  const agent=all.get('session-control'),tool=agent.tools.get('tower_send_message');
  assert.ok(tool);assert.equal(agent.tools.size,7);
  const signal=new AbortController().signal;
  await assert.rejects(tool.execute({to:'impl',body:'Spoof',idempotency_key:'spoof'},{agent:all.get('session-impl'),signal}),e=>e.code==='FORBIDDEN');
  const message=await tool.execute({to:'impl',body:'Implement',idempotency_key:'one'},{agent,signal});
  await runtime.tower.dispatchQueued();assert.equal(runtime.tower.message(message.id).status,'accepted');
  assert.equal(all.get('session-impl').inbox.length,1);
  await runtime.dispose();assert.equal(agent.tools.size,0);
});
