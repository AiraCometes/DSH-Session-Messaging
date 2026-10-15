import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, ControlTower, DeliveryRejected } from '../src/core/index.js';

export function fixture(t, filename = ':memory:') {
  const store = new Store(filename);
  t.after(() => store.close());
  const tower = new ControlTower(store);
  for (const [id,role] of [['control','tower'],['spec','spec'],['impl','implementation'],['review','review']]) {
    tower.registerSession({id,role,adapter:'test',address:id,provider:'test',model:`${id}-model`});
  }
  return {store,tower};
}
const send = tower => tower.send('control',{to:'impl',body:'Implement feature',idempotencyKey:'request-1'});
const code = expected => error => error.code === expected;

test('send intent, state and audit events survive database reopen', async t => {
  const dir = mkdtempSync(join(tmpdir(),'tower-')); t.after(() => rmSync(dir,{recursive:true,force:true}));
  const path = join(dir,'test.sqlite');
  let store = new Store(path), tower = new ControlTower(store);
  for (const id of ['control','impl']) tower.registerSession({id,role:id==='control'?'tower':'implementation',adapter:'test',address:id,provider:'test',model:'m'});
  const message = send(tower); store.close();
  store = new Store(path); tower = new ControlTower(store);
  assert.equal(tower.message(message.id).body,'Implement feature');
  assert.equal(tower.events().at(-1).type,'message.queued');
  store.close();
});

test('idempotency prevents duplicate logical sends and rejects conflicting reuse', t => {
  const {tower} = fixture(t);
  const message = send(tower);
  assert.equal(send(tower).id,message.id);
  assert.equal(tower.snapshot().messages.length,1);
  assert.throws(() => tower.send('control',{to:'impl',body:'Different',idempotencyKey:'request-1'}),code('IDEMPOTENCY_CONFLICT'));
  assert.equal(tower.events().filter(e => e.type==='message.queued').length,1);
});

test('concurrent dispatch admits a message once; acceptance is separate from completion', async t => {
  const {tower} = fixture(t); let count = 0;
  tower.registerAdapter('test',{async deliver(){count++; await Promise.resolve(); return {id:'inbox-1'};}});
  const message = send(tower);
  await Promise.all([tower.dispatch(message.id),tower.dispatch(message.id)]);
  assert.equal(count,1); assert.equal(tower.message(message.id).status,'accepted');
  assert.throws(() => tower.report('spec',message.id,'completed'),code('FORBIDDEN'));
  tower.report('impl',message.id,'processing'); tower.report('impl',message.id,'completed');
  assert.deepEqual(tower.events().filter(e=>e.type.startsWith('message.')).map(e=>e.type),
    ['message.queued','message.delivering','message.accepted','message.processing','message.completed']);
});

test('known rejection is retryable; ambiguous delivery never resends automatically', async t => {
  const {tower} = fixture(t); let count=0;
  const remove=tower.registerAdapter('test',{async deliver(){count++;throw new DeliveryRejected('offline');}});
  const message=send(tower); await tower.dispatch(message.id);
  assert.equal(tower.message(message.id).status,'failed');
  tower.retry('control',message.id); remove();
  tower.registerAdapter('test',{async deliver(){count++;throw new Error('lost connection after send');}});
  await tower.dispatch(message.id); assert.equal(tower.message(message.id).status,'uncertain');
  await tower.dispatchQueued(); assert.equal(count,2);
  assert.throws(()=>tower.retry('control',message.id),code('RETRY_UNSAFE'));
  assert.throws(()=>tower.retry('impl',message.id,{confirmNotAccepted:true}),code('FORBIDDEN'));
  tower.retry('control',message.id,{confirmNotAccepted:true});
  assert.equal(tower.message(message.id).status,'queued');
});

test('restart marks interrupted sends uncertain and rejects a second database owner', t => {
  const dir=mkdtempSync(join(tmpdir(),'tower-crash-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'test.sqlite');
  let store=new Store(path),tower=new ControlTower(store);
  for(const id of ['control','impl'])tower.registerSession({id,role:id==='control'?'tower':'implementation',adapter:'test',address:id,provider:'test',model:'m'});
  assert.throws(()=>new Store(path),/ownership lock exists/);
  const message=send(tower);
  store.transaction(()=>tower.setMessage(message,'delivering'));
  store.close(); store=new Store(path);tower=new ControlTower(store);
  assert.equal(tower.message(message.id).status,'uncertain');
  assert.equal(tower.events().at(-1).type,'message.uncertain');store.close();
});

test('task CAS, role permissions, dependency cycles and current-SHA review guards', t => {
  const {tower}=fixture(t);
  tower.createTask('control',{id:'SPEC',title:'Spec',description:'spec',owner:'spec'});
  tower.createTask('control',{id:'BUILD',title:'Build',description:'build',owner:'impl'});
  tower.updateTask('control','BUILD',1,{blockedBy:['SPEC']});
  assert.throws(()=>tower.updateTask('impl','BUILD',2,{status:'in_progress'}),code('TASK_BLOCKED'));
  assert.throws(()=>tower.updateTask('control','SPEC',1,{blockedBy:['BUILD']}),code('DEPENDENCY_CYCLE'));
  tower.updateTask('spec','SPEC',1,{status:'completed'});
  assert.throws(()=>tower.updateTask('spec','SPEC',1,{title:'stale'}),code('STALE_REVISION'));
  const sha='a'.repeat(40), newer='b'.repeat(40);
  tower.updateTask('impl','BUILD',2,{status:'in_progress',headSha:sha});
  assert.throws(()=>tower.updateTask('impl','BUILD',3,{review:'approved',reviewedSha:sha}),code('FORBIDDEN'));
  assert.throws(()=>tower.updateTask('impl','BUILD',3,{status:'completed'}),code('MISSING_EVIDENCE'));
  tower.updateTask('control','BUILD',3,{owner:'review',status:'review'});
  tower.updateTask('review','BUILD',4,{review:'approved',reviewedSha:sha});
  tower.updateTask('control','BUILD',5,{ci:'passed',status:'completed'});
  const reopened=tower.updateTask('control','BUILD',6,{headSha:newer});
  assert.equal(reopened.status,'review');assert.equal(reopened.review,null);assert.equal(reopened.ci,null);
});

test('event and materialized task updates rollback together', t => {
  const {tower,store}=fixture(t);const last=tower.snapshot().lastSeq;
  assert.throws(()=>store.transaction(()=>{
    store.put('tasks',{id:'rolled-back'});store.append('test.rollback',{});throw new Error('rollback');
  }),/rollback/);
  assert.equal(store.get('tasks','rolled-back'),undefined);
  assert.equal(tower.snapshot().lastSeq,last);
});

test('reject malformed inputs, oversized messages and queue overflow', t => {
  const {tower,store}=fixture(t);
  assert.throws(()=>tower.send('control',{to:'impl',body:' ',idempotencyKey:'empty'}),code('INVALID_INPUT'));
  assert.throws(()=>tower.send('control',{to:'impl',body:'x'.repeat(65537),idempotencyKey:'huge'}),code('INVALID_INPUT'));
  const limited=new ControlTower(store,{maxPending:1}); send(limited);
  assert.throws(()=>limited.send('spec',{to:'impl',body:'more',idempotencyKey:'more'}),code('QUEUE_FULL'));
});

test('conversation and sender limits bound message loops without breaking idempotency', t => {
  const {store}=fixture(t);
  const tower=new ControlTower(store,{maxThreadMessages:2,maxSendsPerMinute:2});
  const first=send(tower);
  const second=tower.send('impl',{to:'control',body:'reply',idempotencyKey:'reply',replyTo:first.id});
  assert.equal(second.threadId,first.threadId);
  assert.throws(()=>tower.send('control',{to:'impl',body:'again',idempotencyKey:'again',replyTo:second.id}),code('THREAD_LIMIT'));
  tower.send('control',{to:'impl',body:'new task',idempotencyKey:'new'});
  assert.equal(send(tower).id,first.id);
  assert.throws(()=>tower.send('control',{to:'impl',body:'third',idempotencyKey:'third'}),code('RATE_LIMITED'));
});

test('implementation tasks cannot complete without a current SHA and evidence', t => {
  const {tower}=fixture(t);
  tower.createTask('control',{id:'CODE',kind:'implementation',title:'Code',description:'Implement',owner:'impl'});
  assert.throws(()=>tower.updateTask('impl','CODE',1,{status:'completed'}),code('MISSING_EVIDENCE'));
});
