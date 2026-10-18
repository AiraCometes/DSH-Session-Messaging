import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Config, apply, applyWithDependencies } from '../src/plugin.js';
import { resolveConfig } from '../src/config.js';

const binding = {id:'control',role:'tower',address:'a',provider:'p',model:'m'};
function dormantHost() {
  const notices = {info:[],warn:[]};
  return { notices, ctx: {
    logger: { info(message) { notices.info.push(message); }, warn(message) { notices.warn.push(message); } },
    get agents() { throw new Error('Disabled plugin must not access agents'); },
  }};
}

test('both entry points and Cordis schema accept disabled drafts without side effects', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tower-disabled-'));
  t.after(() => rmSync(directory, { recursive:true, force:true }));
  const database = join(directory, 'should-not-exist.sqlite');
  for (const input of [
    {database},
    {enabled:false,database,pollMs:50,port:'not-a-port',sessions:[{role:'admin'}]},
  ]) {
    // Cordis calls this before apply(); bypassing only inside apply would not suffice.
    const result = Config['~standard'].validate(input);
    assert.equal(result.issues, undefined);
    const {ctx,notices} = dormantHost();
    await apply(ctx, result.value);
    await applyWithDependencies(ctx, input, () => { throw new Error('Must not load dependencies'); });
    assert.match(notices.info[0], /awaiting configuration/);
    assert.equal(existsSync(database), false);
  }
});

test('configured legacy sessions produce an actionable migration warning without auto-enabling', async () => {
  for (const input of [{sessions:[binding]}, {enabled:false,sessions:[binding]}]) {
    const {ctx,notices} = dormantHost();
    await apply(ctx, Config['~standard'].validate(input).value);
    assert.equal(notices.warn.length, 1);
    assert.match(notices.warn[0], /v0\.1\.0.*enabled: true/);
    assert.match(notices.warn[0], /No tools or deliveries/);
  }
  const {ctx,notices} = dormantHost();
  await apply(ctx, {});
  assert.equal(notices.warn.length, 0);
});

test('enabled Config supplies the single set of operational defaults', () => {
  assert.equal(Config({}).enabled, false);
  const config = Config({enabled:true});
  assert.deepEqual(config.sessions, []);
  assert.equal(config.pollMs, 500);
  assert.equal(config.port, 3091);
  assert.equal(config.viewerTokenEnv, 'DSH_TOWER_VIEWER_TOKEN');
  assert.equal(config.database, '.tower/control-tower.sqlite');
  assert.equal(config.limits.maxPending, 1000);
  assert.equal(typeof Config['~standard'].validate, 'function');
});

test('quoted decimal integers are normalized and invalid numeric strings are rejected', () => {
  const config = Config({enabled:true,port:'0',pollMs:'500',limits:{maxPending:'10'}});
  assert.equal(config.port, 0);
  assert.equal(config.pollMs, 500);
  assert.equal(config.limits.maxPending, 10);
  for (const port of ['65536', '-1', '3091.sock', '', ' ', '1e3', '1.5', '9007199254740993']) {
    assert.throws(() => resolveConfig({enabled:true,port}), {code:'INVALID_CONFIG'});
  }
});

test('enabled configuration errors have INVALID_CONFIG at both runtime entry points', async () => {
  for (const input of [
    {port:65536}, {pollMs:1}, {viewerTokenEnv:'TOKEN WITH SPACES'},
    {sessions:[{...binding,role:'admin'}]},
    {github:{target:'control',repositories:['not-a-repository']}},
  ]) {
    const config = {enabled:true,...input};
    assert.ok(Config['~standard'].validate(config).issues);
    for (const entry of [apply, applyWithDependencies]) {
      await assert.rejects(entry({}, config), {name:'TowerError',code:'INVALID_CONFIG'});
    }
  }
  for (const enabled of ['false', 0]) {
    assert.throws(() => resolveConfig({enabled}), {code:'INVALID_CONFIG'});
  }
  assert.throws(() => resolveConfig(null), {code:'INVALID_CONFIG'});
});

test('schema enforces runtime identifiers, nonblank text and UTF-8 byte limits', () => {
  const invalid = [
    {...binding,id:'my session'}, {...binding,id:'-x'}, {...binding,id:'x'.repeat(201)},
    {...binding,address:' '.repeat(2)}, {...binding,address:'a'.repeat(501)},
    {...binding,address:'あ'.repeat(167)}, {...binding,model:'あ'.repeat(67)},
    {...binding,provider:' '.repeat(2)},
  ];
  for (const value of invalid) {
    assert.ok(Config['~standard'].validate({enabled:true,sessions:[value]}).issues);
  }
  assert.equal(Config({enabled:true,sessions:[{...binding,address:'あ'.repeat(166)}]}).sessions.length, 1);
  for (const key of ['sender','target']) {
    assert.throws(() => resolveConfig({enabled:true,github:{
      target:'control',repositories:['owner/repo'],[key]:'-bad',
    }}), {code:'INVALID_CONFIG'});
  }
});

test('enabling requires explicit unique bindings before database creation at both entry points', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tower-invalid-bindings-'));
  t.after(() => rmSync(directory, { recursive:true, force:true }));
  const database = join(directory, 'should-not-exist.sqlite');
  for (const sessions of [
    [], ['first','second'].map(address=>({...binding,address})),
    ['first','second'].map(id=>({...binding,id})),
  ]) {
    for (const entry of [apply, applyWithDependencies]) {
      await assert.rejects(entry({}, {enabled:true,database,sessions}), {code:'INVALID_CONFIG'});
      assert.equal(existsSync(database), false);
    }
  }
});
