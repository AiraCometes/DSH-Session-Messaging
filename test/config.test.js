import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Config, apply } from '../src/plugin.js';

test('installed bundle can await configuration without opening a database or server', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tower-disabled-'));
  t.after(() => rmSync(directory, { recursive:true, force:true }));
  const database = join(directory, 'should-not-exist.sqlite');
  let notice;
  const ctx = {
    logger: { info(message) { notice = message; } },
    get agents() { throw new Error('Disabled plugin must not access agents'); },
  };
  await apply(ctx, { database });
  assert.match(notice, /awaiting configuration/);
  assert.equal(existsSync(database), false);
});

test('Config supplies operational defaults and exposes Standard Schema', () => {
  const config = Config({});
  assert.equal(config.enabled, false);
  assert.deepEqual(config.sessions, []);
  assert.equal(config.pollMs, 500);
  assert.equal(config.limits.maxPending, 1000);
  assert.equal(typeof Config['~standard'].validate, 'function');
});

test('Config rejects invalid ports, intervals, session roles and environment selectors', () => {
  for (const input of [
    {port:65536}, {pollMs:1}, {viewerTokenEnv:'TOKEN WITH SPACES'},
    {sessions:[{id:'x',role:'admin',address:'a',provider:'p',model:'m'}]},
    {github:{target:'control',repositories:['not-a-repository']}},
  ]) assert.throws(() => Config(input));
});

test('enabling requires an explicit session binding before database creation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tower-no-bindings-'));
  t.after(() => rmSync(directory, { recursive:true, force:true }));
  const database = join(directory, 'should-not-exist.sqlite');
  await assert.rejects(apply({}, {enabled:true, database}), error => error.code === 'INVALID_CONFIG');
  assert.equal(existsSync(database), false);
});

test('duplicate session identities fail before opening the database', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tower-duplicate-binding-'));
  t.after(() => rmSync(directory, { recursive:true, force:true }));
  const database = join(directory, 'should-not-exist.sqlite');
  const sessions = ['first','second'].map(address=>({id:'duplicate',address,role:'tower',provider:'p',model:'m'}));
  await assert.rejects(apply({}, {enabled:true, database, sessions}), error => error.code === 'INVALID_CONFIG');
  assert.equal(existsSync(database), false);
});
