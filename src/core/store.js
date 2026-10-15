import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ensure } from './validation.js';

/** SQLite is the commit boundary; events and materialized state commit together. */
export class Store {
  constructor(filename = ':memory:') {
    this.filename = filename === ':memory:' ? filename : resolve(filename);
    if (filename !== ':memory:') {
      mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
      this.lock = `${this.filename}.lock`;
      try { mkdirSync(this.lock, { mode: 0o700 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        throw new Error(`Database ownership lock exists: ${this.lock}. Stop the owner before removing a stale lock.`);
      }
      writeFileSync(`${this.lock}/owner.json`, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    }
    try {
      this.db = new DatabaseSync(this.filename);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      ensure(version <= 1, 'SCHEMA_TOO_NEW', `Unsupported database version ${version}`);
      if (version === 0) this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE messages (id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX messages_status ON messages(status);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE github_deliveries (id TEXT PRIMARY KEY, digest TEXT NOT NULL);
        CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL, type TEXT NOT NULL, time TEXT NOT NULL, data TEXT NOT NULL);
        PRAGMA user_version=1;
        COMMIT;
      `);
    } catch (error) { this.close(); throw error; }
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  append(type, data) {
    const time = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO events(version,type,time,data) VALUES(1,?,?,?)')
      .run(type, time, JSON.stringify(data));
    return { seq: Number(result.lastInsertRowid), version: 1, type, time, data };
  }

  events(after = 0, limit = 100) {
    return this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(after, limit)
      .map(row => ({ ...row, data: JSON.parse(row.data) }));
  }

  get(table, id) {
    ensure(['sessions', 'messages', 'tasks'].includes(table), 'INTERNAL', 'Invalid table');
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
    return row ? JSON.parse(row.data) : undefined;
  }

  all(table) {
    ensure(['sessions', 'messages', 'tasks'].includes(table), 'INTERNAL', 'Invalid table');
    return this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(row.data));
  }

  put(table, value) {
    ensure(['sessions', 'tasks'].includes(table), 'INTERNAL', 'Invalid table');
    this.db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`)
      .run(value.id, JSON.stringify(value));
  }

  putMessage(value, insert = false) {
    if (insert) this.db.prepare('INSERT INTO messages(id,idem,status,data) VALUES(?,?,?,?)')
      .run(value.id, value.key, value.status, JSON.stringify(value));
    else this.db.prepare('UPDATE messages SET status=?,data=? WHERE id=?')
      .run(value.status, JSON.stringify(value), value.id);
  }

  close() {
    this.db?.close();
    this.db = undefined;
    if (this.lock) { rmSync(this.lock, { recursive: true, force: true }); this.lock = undefined; }
  }
}
