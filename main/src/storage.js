'use strict';
const fs = require('node:fs');
const zlib = require('node:zlib');
const { Swift } = require('../../shared/swift');
const { env, log } = require('../../shared/lib');

function makeSwift() {
  const user = env('BLOMP_USER');
  if (!user) { log('WARNING: BLOMP_USER not set — storage disabled'); }
  return new Swift({ authUrl: env('BLOMP_AUTH_URL', 'https://authenticate.blomp.com'), user, key: env('BLOMP_PASS'), tenant: env('BLOMP_TENANT', 'storage'), container: env('BLOMP_CONTAINER', user) });
}

class Backup {
  constructor(swift, dbFile) { this.swift = swift; this.file = dbFile; this.last = 0; this.lastSize = 0; this.lastErr = null; this.running = false; }
  // what a backup contains (for logs / choosing a restore point)
  inspect(gz) {
    const os = require('node:os'), path = require('node:path');
    const f = path.join(os.tmpdir(), 'vn-inspect-' + process.pid + '.sqlite');
    try {
      fs.writeFileSync(f, zlib.gunzipSync(gz));
      const { DatabaseSync } = require('node:sqlite');
      const d = new DatabaseSync(f, { readOnly: true });
      const c = (t) => { try { return d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return -1; } };
      const r = { videos: c('videos'), users: c('users'), jobs: c('jobs') };
      d.close(); return r;
    } catch (e) { return { error: e.message }; } finally { try { fs.unlinkSync(f); } catch {} }
  }
  async restoreIfMissing() {
    const spec = (process.env.DB_RESTORE || '').trim();
    if (spec) { const r = await this.restoreFrom(spec); if (r !== null) return r; }
    if (fs.existsSync(this.file)) { this.state = 'local'; return false; }
    try {
      const r = await this.swift.getBuffer('sys/db/latest.sqlite.gz', 512 << 20);
      if (!r) { this.state = 'none'; log('backup: no remote DB, starting fresh'); return false; }
      fs.writeFileSync(this.file, zlib.gunzipSync(r.buf));
      this.state = 'restored';
      log('backup: restored DB from Blomp,', r.buf.length, 'bytes gz', JSON.stringify(this.inspect(r.buf)));
      return true;
    } catch (e) { this.state = 'failed'; log('backup: RESTORE FAILED', e.message, '— will NOT overwrite remote backup'); return false; }
  }
  // DB_RESTORE=list | latest | YYYY-MM-DD  (applied once, marker kept in Blomp)
  async restoreFrom(spec) {
    const days = [];
    for (let i = 0; i < 21; i++) days.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
    if (spec === 'list') {
      log('backup: DB_RESTORE=list — available backups:');
      for (const name of ['latest', ...days]) {
        const key = name === 'latest' ? 'sys/db/latest.sqlite.gz' : `sys/db/daily/${name}.sqlite.gz`;
        try { const r = await this.swift.getBuffer(key, 512 << 20); if (r) log(`  ${name}: ${r.buf.length} bytes gz`, JSON.stringify(this.inspect(r.buf))); } catch (e) { log(`  ${name}: error ${e.message}`); }
      }
      return null;
    }
    const key = spec === 'latest' ? 'sys/db/latest.sqlite.gz' : /^\d{4}-\d{2}-\d{2}$/.test(spec) ? `sys/db/daily/${spec}.sqlite.gz` : null;
    if (!key) { log('backup: bad DB_RESTORE value', spec); return null; }
    const marker = `sys/db/restored-${spec}.txt`;
    try {
      if (await this.swift.getBuffer(marker, 4096)) { log(`backup: DB_RESTORE=${spec} already applied — remove the variable`); return null; }
      const r = await this.swift.getBuffer(key, 512 << 20);
      if (!r) { log('backup: DB_RESTORE source not found', key); return null; }
      const info = this.inspect(r.buf);
      if (info.error || info.videos < 0) { log('backup: DB_RESTORE source is broken', JSON.stringify(info)); return null; }
      const cur = await this.swift.getBuffer('sys/db/latest.sqlite.gz', 512 << 20).catch(() => null);
      if (cur) await this.swift.putRetry(`sys/db/pre-restore-${Date.now()}.sqlite.gz`, cur.buf, 'application/gzip');
      fs.writeFileSync(this.file, zlib.gunzipSync(r.buf));
      for (const x of ['-wal', '-shm']) { try { fs.unlinkSync(this.file + x); } catch {} }
      await this.swift.putRetry('sys/db/latest.sqlite.gz', r.buf, 'application/gzip');
      await this.swift.putRetry(marker, Buffer.from(new Date().toISOString()), 'text/plain');
      this.state = 'restored';
      log(`backup: RESTORED from ${key}`, JSON.stringify(info));
      return true;
    } catch (e) { log('backup: DB_RESTORE failed', e.message); return null; }
  }
  async run(db, reason = 'auto') {
    if (this.running || !this.swift.o.user) return;
    this.running = true;
    const tmp = this.file + '.bak';
    try {
      try { fs.unlinkSync(tmp); } catch {}
      db.d.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      db.dirty = false;
      const gz = zlib.gzipSync(fs.readFileSync(tmp), { level: 6 });
      if (this.state === 'failed') {
        // started without the remote DB (restore error) — never clobber the real backup
        await this.swift.putRetry('sys/db/unsafe-latest.sqlite.gz', gz, 'application/gzip');
        this.last = Date.now(); this.lastSize = gz.length; this.lastErr = 'restore failed at boot — backups go to sys/db/unsafe-latest.sqlite.gz';
        log('backup: saved to unsafe-latest (boot restore had failed)'); return;
      }
      await this.swift.putRetry('sys/db/latest.sqlite.gz', gz, 'application/gzip');
      const day = new Date().toISOString().slice(0, 10);
      if (this.lastDay !== day) {
        this.lastDay = day; const dk = `sys/db/daily/${day}.sqlite.gz`;
        // keep the first snapshot of the day — a fresh/broken boot must not replace it
        const ex = await this.swift.get(dk, 'bytes=0-0').catch(() => null); ex?.resume();
        if (!ex || ex.statusCode === 404) await this.swift.putRetry(dk, gz, 'application/gzip').catch(() => {});
      }
      this.last = Date.now(); this.lastSize = gz.length; this.lastErr = null;
      log('backup: ok', reason, gz.length, 'bytes');
    } catch (e) { this.lastErr = e.message; db.dirty = true; log('backup failed', e.message); }
    finally { this.running = false; try { fs.unlinkSync(tmp); } catch {} }
  }
}
module.exports = { makeSwift, Backup };
