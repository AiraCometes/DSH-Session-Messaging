import { randomUUID, randomBytes } from 'node:crypto';
import { Store, ControlTower } from '../src/core/index.js';
import { startServer } from '../src/http/server.js';

const store = new Store(process.env.DSH_TOWER_DEMO_DB ?? '.tower/demo.sqlite');
const tower = new ControlTower(store);
const token = process.env.DSH_TOWER_VIEWER_TOKEN ?? randomBytes(24).toString('hex');
const sessions = [
  ['control','tower','demo-model-A'], ['spec','spec','demo-model-B'],
  ['implementation','implementation','demo-model-C'], ['review','review','demo-model-D'],
];
for (const [id,role,model] of sessions) tower.registerSession({id,role,model,provider:'simulated',adapter:'demo',address:id});
tower.registerAdapter('demo', { async deliver() { return {id:`simulated:${randomUUID()}`}; } });
if (!store.get('tasks','DEMO-1')) {
  tower.createTask('control', {id:'DEMO-1',title:'通信ログを実装する',description:'これは模擬デモです。LLMやGitHubには接続しません。',owner:'implementation'});
  const request = tower.send('control', {to:'spec',body:'受け入れ条件を仕様書にまとめてください。',taskId:'DEMO-1',idempotencyKey:'demo-spec'});
  await tower.dispatch(request.id); tower.report('spec',request.id,'completed');
  tower.send('spec', {to:'implementation',body:'送信者・宛先・本文・配信状態を記録し、画面で確認できるようにします。',taskId:'DEMO-1',replyTo:request.id,idempotencyKey:'demo-implementation'});
  tower.send('implementation', {to:'review',body:'実装のレビューをお願いします。通信ログとタスク更新の競合制御を確認してください。',taskId:'DEMO-1',idempotencyKey:'demo-review'});
}
await tower.dispatchQueued();
const viewer = await startServer(tower,{token,port:Number(process.env.PORT ?? 3091)});
console.log(`Simulated demo (no models/GitHub connected): ${viewer.url}`);
console.log(`Viewer token: ${token}`);
let stopping = false;
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => {
  if (stopping) return; stopping = true;
  await viewer.close(); store.close();
});
