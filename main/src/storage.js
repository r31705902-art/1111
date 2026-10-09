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
  async restoreIfMissing() {
    if (fs.existsSync(this.file)) return false;
    try {
      const r = await this.swift.getBuffer('sys/db/latest.sqlite.gz', 512 << 20);
      if (!r) { log('backup: no remote DB, starting fresh'); return false; }
      fs.writeFileSync(this.file, zlib.gunzipSync(r.buf));
      log('backup: restored DB from Blomp,', r.buf.length, 'bytes gz');
      return true;
    } catch (e) { log('backup: restore failed', e.message); return false; }
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
      await this.swift.putRetry('sys/db/latest.sqlite.gz', gz, 'application/gzip');
      const day = new Date().toISOString().slice(0, 10);
      if (this.lastDay !== day) { this.lastDay = day; await this.swift.putRetry(`sys/db/daily/${day}.sqlite.gz`, gz, 'application/gzip').catch(() => {}); }
      this.last = Date.now(); this.lastSize = gz.length; this.lastErr = null;
      log('backup: ok', reason, gz.length, 'bytes');
    } catch (e) { this.lastErr = e.message; db.dirty = true; log('backup failed', e.message); }
    finally { this.running = false; try { fs.unlinkSync(tmp); } catch {} }
  }
}
module.exports = { makeSwift, Backup };
