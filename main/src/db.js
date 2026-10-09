'use strict';
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, tg_id INTEGER UNIQUE, tg_username TEXT, tg_name TEXT,
  nick TEXT NOT NULL UNIQUE COLLATE NOCASE, avatar TEXT, role TEXT NOT NULL DEFAULT 'user',
  ban_until INTEGER NOT NULL DEFAULT 0, ban_reason TEXT, notify INTEGER NOT NULL DEFAULT 0,
  nick_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0, last_ip TEXT);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, seen_at INTEGER NOT NULL DEFAULT 0, ua TEXT, ip TEXT);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS videos(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
  stream_date TEXT, duration REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'uploading',
  visibility TEXT NOT NULL DEFAULT 'public', cover TEXT, views INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0, media TEXT, chapters TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS videos_date ON videos(stream_date);
CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(id UNINDEXED, title, description, tags, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS favorites(user_id INTEGER NOT NULL, video_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id, video_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS progress(user_id INTEGER NOT NULL, video_id TEXT NOT NULL, pos REAL NOT NULL, dur REAL NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, video_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS progress_recent ON progress(user_id, updated_at);
CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY, video_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
  progress REAL NOT NULL DEFAULT 0, info TEXT, encoder TEXT, raw_parts INTEGER NOT NULL DEFAULT 0, raw_size INTEGER NOT NULL DEFAULT 0,
  raw_name TEXT, local INTEGER NOT NULL DEFAULT 0, opts TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, beat_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY, video_id TEXT NOT NULL, name TEXT, size INTEGER NOT NULL, part_size INTEGER NOT NULL,
  parts INTEGER NOT NULL, got TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY, url TEXT NOT NULL, region TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  capacity INTEGER NOT NULL DEFAULT 0, render_key TEXT, render_service TEXT, note TEXT, month TEXT, month_bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor INTEGER, action TEXT NOT NULL, target TEXT, meta TEXT);
`;

class DB {
  constructor(file) {
    this.file = file;
    this.d = new DatabaseSync(file);
    this.d.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-6000; PRAGMA busy_timeout=3000;');
    this.d.exec(SCHEMA);
    this.st = new Map();
    this.dirty = false;
    this.onWrite = null;
  }
  q(sql) { let s = this.st.get(sql); if (!s) { s = this.d.prepare(sql); this.st.set(sql, s); } return s; }
  all(sql, ...p) { return this.q(sql).all(...p); }
  get(sql, ...p) { return this.q(sql).get(...p); }
  run(sql, ...p) { const r = this.q(sql).run(...p); this.dirty = true; this.onWrite?.(); return r; }
  tx(fn) { this.d.exec('BEGIN'); try { const r = fn(); this.d.exec('COMMIT'); this.dirty = true; return r; } catch (e) { this.d.exec('ROLLBACK'); throw e; } }
  close() { try { this.d.close(); } catch {} }

  // settings with in-memory cache
  setting(k, def) { if (!this._set) this._loadSettings(); return k in this._set ? this._set[k] : def; }
  _loadSettings() { this._set = {}; for (const r of this.all('SELECT k, v FROM settings')) { try { this._set[r.k] = JSON.parse(r.v); } catch {} } }
  setSetting(k, v) { if (!this._set) this._loadSettings(); this._set[k] = v; this.run('INSERT INTO settings(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v)); }

  audit(actor, action, target, meta) { this.run('INSERT INTO audit(at, actor, action, target, meta) VALUES(?,?,?,?,?)', Date.now(), actor || null, action, target == null ? null : String(target), meta ? JSON.stringify(meta) : null); }

  ftsSync(v) {
    this.run('DELETE FROM videos_fts WHERE id = ?', v.id);
    if (v.title !== undefined) this.run('INSERT INTO videos_fts(id, title, description, tags) VALUES(?,?,?,?)', v.id, v.title, v.description || '', JSON.parse(v.tags || '[]').join(' '));
  }
}
module.exports = { DB };
