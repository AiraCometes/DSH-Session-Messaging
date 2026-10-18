import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';

// Opt-in, real DSH CLI test. Uses a new DSH_HOME and never submits an LLM request.
const root = resolve(import.meta.dirname, '..');
const binary = process.env.DSH_BIN;
assert.ok(binary, 'Set DSH_BIN to an installed dsh executable (0.2.1-rc.2). pnpm must also be on PATH.');
const mode = process.env.DSH_INSTALL_MODE ?? 'tarball';
assert.ok(['tarball','link'].includes(mode), 'DSH_INSTALL_MODE must be tarball or link');
const directory = await mkdtemp(join(tmpdir(), 'dsh-bundle-install-'));
const profile = 'session-messaging-smoke';
const home = join(directory, 'home');
const profileDir = join(home, 'profiles', profile);
const database = join(directory, 'tower.sqlite');
const token = randomBytes(32).toString('hex');
const env = {...process.env, DSH_HOME:home, DSH_TOWER_VIEWER_TOKEN:token};
let child, childExited, logs = '';
function command(file, args, cwd = directory) {
  const result = spawnSync(file, args, { cwd, env, encoding:'utf8', timeout:180000, maxBuffer:8*1024*1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${file} ${args.join(' ')} failed:\n${result.error ?? ''}\n${result.stderr}\n${result.stdout?.slice(-10000)}`);
  return result.stdout;
}
async function waitFor(check, label, timeoutMs = 30000) {
  const deadline = Date.now()+timeoutMs;
  while (Date.now()<deadline) {
    try { const result=await check(); if (result) return result; } catch { /* Wait for boot. */ }
    if (child && child.exitCode!==null) throw new Error(`DSH exited ${child.exitCode}: ${logs}`);
    await pause(100);
  }
  throw new Error(`Timeout: ${label}\n${logs}`);
}
async function stop() {
  if (!child) return;
  if (child.exitCode===null) child.kill('SIGTERM');
  let code = await Promise.race([childExited, pause(15000, undefined, {ref:false}).then(()=>'timeout')]);
  if (code==='timeout') {
    child.kill('SIGKILL');
    await childExited;
    child=undefined;
    throw new Error(`DSH shutdown timeout\n${logs}`);
  }
  child=undefined;
  assert.ok(code===0 || code===null, `DSH shutdown failed (${code}): ${logs}`);
}
try {
  assert.match(command(binary, ['--version']), /0\.2\.1-rc\.2/);
  command(binary, ['--profile',profile,'--from-default-profile','web','--dump-config']);
  const packed = JSON.parse(command('npm', ['pack','--json','--ignore-scripts','--pack-destination',directory], root))[0];
  const packedPaths = new Set(packed.files.map(file=>file.path));
  for (const required of ['cordis.patch.yml','src/plugin.js','src/config.js','src/http/viewer.html','src/http/viewer.js','locale/en.json']) {
    assert.ok(packedPaths.has(required), `Packed bundle is missing ${required}`);
  }
  command(binary, ['plugin','--profile',profile,'add',mode==='link'?root:join(directory,packed.filename)]);
  const installed = JSON.parse(await readFile(join(profileDir,'package.json'),'utf8'));
  assert.ok(installed.dsh.profile.bundles.includes('dsh-session-messaging'));
  const initial = command(binary,['--profile',profile,'--dump-config']);
  assert.match(initial,/id: session-messaging/);
  assert.match(initial,/enabled: false/);
  // DSH rc.2 can emit a partial schema and exit 1 for unrelated built-in preset rows.
  // Require our own row to be fully projected, rather than treating that as our success.
  const schemaDump = spawnSync(binary,['--profile',profile,'--dump-config-schema'],
    {cwd:directory,env,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
  assert.ifError(schemaDump.error);
  assert.ok([0,1].includes(schemaDump.status), `Schema collection failed: ${schemaDump.error ?? schemaDump.stderr}`);
  const schema = JSON.parse(schemaDump.stdout);
  const schemaEntry = schema['x-cordis'].entries.find(entry=>entry.id==='session-messaging');
  assert.equal(schemaEntry?.status,'schema','DSH must discover the exported Config schema');
  if (schemaDump.status===1) console.log('NOTE: DSH reported partial schemas for other rows; this bundle Config projected successfully.');
  console.log(`PASS: ${mode} bundle installs and contributes its dormant configuration layer`);

  const reservation=createServer();
  await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);});
  const viewerUrl=`http://127.0.0.1:${reservation.address().port}`;
  const viewerPort=reservation.address().port;
  await new Promise((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()));

  // Bootstrap a host plugin in the real profile; it makes idle Agents only.
  const ids = [randomUUID(), randomUUID()];
  const probe = join(directory,'probe.mjs'), report = join(directory,'probe.json');
  const exportedPackage = join(profileDir,'node_modules','dsh-session-messaging','package.json');
  await access(exportedPackage);
  await writeFile(probe, `
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
export const name='session-messaging-install-probe';
export const inject=['agents','tools','agentLoop'];
export async function apply(ctx) {
  const handles=[];
  ctx.effect(()=>async()=>{for(const handle of handles.reverse())await handle.dispose();});
  for(const sessionId of ${JSON.stringify(ids)})handles.push(await ctx.agents.create({sessionId,meta:{cwd:${JSON.stringify(directory)}}}));
  const agent=handles[0].agent;
  let definition;
  for(let i=0;i<100;i++){
    definition=ctx.tools.get('tower_get_state',agent);
    if(definition)break;
    await pause(50);
  }
  assert.ok(definition,'configured Agent must receive messaging tools');
  assert.equal(ctx.tools.get('tower_get_state'),undefined,'tools must not leak to global scope');
  const state=await definition.execute({}, {agent,signal:new AbortController().signal});
  assert.equal(state.sessions.length,2);
  assert.equal(ctx.tools.schemas(agent).filter(tool=>tool.name.startsWith('tower_')).length,7);
  await writeFile(${JSON.stringify(report)},JSON.stringify({tools:7,sessions:2,requestsToLLM:0}));
}
`);
  // No telemetry/upload providers are needed for this model-free smoke test.
  const config = {enabled:true,database,port:viewerPort,sessions:[
    {id:'control',role:'tower',address:ids[0],provider:'smoke',model:'not-called'},
    {id:'review',role:'review',address:ids[1],provider:'smoke',model:'not-called'},
  ]};
  await writeFile(join(profileDir,'cordis.patch.yml'), [
    {id:'session-log-deepseek',disabled:true},
    {id:'session-telemetry-otel',disabled:true},
    {id:'hmr',disabled:true},
    {id:'session-messaging',config},
    {insert:[{id:'messaging-install-probe',name:pathToFileURL(probe).href}]},
  ].map(row=>`- ${JSON.stringify(row)}`).join('\n')+'\n');
  const configured = command(binary,['--profile',profile,'--dump-config']);
  assert.match(configured,/enabled: true/);
  child=spawn(binary,['--profile',profile,'--port','0','--no-open'],{cwd:directory,env,stdio:['ignore','pipe','pipe']});
  childExited=new Promise(resolve=>child.once('close',resolve));
  child.on('error',error=>{logs+=error.message;});
  for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{
    logs=(logs+data.toString().replace(/([?&]token=)[^&\s]+/g,'$1[redacted]')).slice(-100000);
  });
  const result=await waitFor(async()=>JSON.parse(await readFile(report,'utf8')),'real Agent tool registration');
  assert.equal(result.tools,7);
  const snapshot=await waitFor(async()=>{
    const response=await fetch(`${viewerUrl}/api/snapshot`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(1000)});
    return response.ok?response.json():undefined;
  },'viewer authentication and snapshot');
  assert.equal(snapshot.sessions.length,2);
  assert.equal((await fetch(`${viewerUrl}/api/snapshot`)).status,401);
  console.log('PASS: DSH boots, 7 tools register on real Agents, and the authenticated viewer responds');
  await stop();
  await assert.rejects(access(database+'.lock'));
  console.log('PASS: shutdown releases the SQLite ownership lock');

  // Remove our user-layer override before uninstalling, so it cannot recreate the row.
  await writeFile(join(profileDir,'cordis.patch.yml'),'[]\n');
  command(binary,['plugin','--profile',profile,'remove','dsh-session-messaging']);
  const removed=JSON.parse(await readFile(join(profileDir,'package.json'),'utf8'));
  assert.ok(!removed.dsh.profile.bundles.includes('dsh-session-messaging'));
  assert.doesNotMatch(command(binary,['--profile',profile,'--dump-config']),/id: session-messaging/);
  console.log('PASS: uninstall removes the package and its configuration layer');
} finally {
  try { await stop(); } finally { await rm(directory,{recursive:true,force:true}); }
}
