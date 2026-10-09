'use strict';
// Edge delivery core: token check → RAM LRU → single-flight Blomp fetch → prefetch next segment.
// Used by every swarm edge node and by the main server as emergency origin.
const { verify } = require('./lib');

const TYPES = { m3u8: 'application/vnd.apple.mpegurl', m4s: 'video/iso.segment', mp4: 'video/mp4', webp: 'image/webp', jpg: 'image/jpeg', json: 'application/json', png: 'image/png' };
const FILE_RE = /^(?:[a-z0-9_]{1,24}\/)?[a-z0-9_]{1,40}\.(m3u8|m4s|mp4|webp|jpg|json)$/i;
const MEDIA_RE = /^(a|c)\/[a-z0-9_\-]{1,60}\.(webp|jpg|png)$/i;
const VID_RE = /^[A-Za-z0-9_-]{4,24}$/;

class LRU {
  constructor(max) { this.max = max; this.size = 0; this.m = new Map(); }
  get(k) { const e = this.m.get(k); if (!e) return; this.m.delete(k); this.m.set(k, e); return e; }
  has(k) { return this.m.has(k); }
  set(k, e) {
    if (e.buf.length > this.max / 6) return;
    const o = this.m.get(k); if (o) { this.size -= o.buf.length; this.m.delete(k); }
    this.m.set(k, e); this.size += e.buf.length;
    while (this.size > this.max) this.evictOne();
  }
  evictOne() { const f = this.m.keys().next(); if (f.done) return; const e = this.m.get(f.value); this.m.delete(f.value); this.size -= e.buf.length; }
  trimTo(bytes) { while (this.size > bytes) this.evictOne(); }
  clear() { this.m.clear(); this.size = 0; }
}

class EdgeCore {
  constructor({ swift, playKey, cacheMB = 160, log = console.log }) {
    this.swift = swift; this.playKey = playKey; this.log = log;
    this.cache = new LRU(cacheMB * 1048576); this.cacheMax = cacheMB * 1048576;
    this.inflight = new Map();
    this.revoked = new Set();
    this.viewers = new Map(); // sid -> {v, t}
    this.errors = [];
    this.c = { reqs: 0, bytes: 0, hits: 0, miss: 0, err: 0, upMs: 0, upN: 0, conns: 0, totalBytes: 0 };
    this.lowPower = false;
  }
  noteErr(msg) { this.c.err++; this.errors.push({ t: Date.now(), m: String(msg).slice(0, 200) }); if (this.errors.length > 25) this.errors.shift(); }

  async fetchObj(key) {
    const hit = this.cache.get(key);
    if (hit) { this.c.hits++; return hit; }
    let p = this.inflight.get(key);
    if (p) { this.c.hits++; return p; }
    this.c.miss++;
    const t0 = Date.now();
    p = (async () => {
      const r = await this.swift.getBuffer(key, 48 << 20);
      if (!r) return null;
      const ext = key.split('.').pop().toLowerCase();
      const e = { buf: r.buf, type: TYPES[ext] || r.type || 'application/octet-stream', etag: (r.etag || '').replace(/"/g, ''), t: Date.now() };
      this.cache.set(key, e);
      this.c.upMs += Date.now() - t0; this.c.upN++;
      return e;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  prefetch(vid, file) {
    if (this.lowPower) return;
    const m = /^(.*seg_)(\d+)\.m4s$/.exec(file); if (!m) return;
    const ahead = this.cache.size < this.cacheMax * 0.7 ? 2 : 1;
    for (let i = 1; i <= ahead; i++) {
      const n = String(Number(m[2]) + i).padStart(m[2].length, '0');
      const key = `v/${vid}/${m[1]}${n}.m4s`;
      if (!this.cache.has(key) && !this.inflight.has(key)) this.fetchObj(key).catch(() => {});
    }
  }

  cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, X-Node');
    res.setHeader('Timing-Allow-Origin', '*');
  }

  serve(req, res, e, cacheCtl) {
    const total = e.buf.length;
    const h = { 'Content-Type': e.type, 'Cache-Control': cacheCtl, 'Accept-Ranges': 'bytes', ETag: '"' + e.etag + '"' };
    if (req.headers['if-none-match'] && e.etag && req.headers['if-none-match'].includes(e.etag)) { res.writeHead(304, h); return res.end(); }
    let body = e.buf, code = 200;
    const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (rg) {
      let s = rg[1] === '' ? total - Number(rg[2]) : Number(rg[1]);
      let en = rg[1] === '' || rg[2] === '' ? total - 1 : Math.min(Number(rg[2]), total - 1);
      if (s >= total || s < 0 || en < s) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
      body = e.buf.subarray(s, en + 1); code = 206; h['Content-Range'] = `bytes ${s}-${en}/${total}`;
    }
    h['Content-Length'] = body.length;
    res.writeHead(code, h);
    if (req.method === 'HEAD') return res.end();
    this.c.bytes += body.length; this.c.totalBytes += body.length;
    res.end(body);
  }

  err(res, code, msg) { res.writeHead(code, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(msg); }

  /** returns true when handled */
  async handle(req, res, path) {
    if (!path.startsWith('/p/') && !path.startsWith('/m/')) return false;
    this.cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Max-Age': '86400' }); res.end(); return true; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { this.err(res, 405, 'method'); return true; }
    if (!this.swift.ready && !this.swift.o.authUrl) { this.err(res, 503, 'storage not ready'); return true; }
    this.c.reqs++; this.c.conns++;
    res.on('close', () => { this.c.conns--; });
    try {
      if (path.startsWith('/m/')) {
        const key = path.slice(3);
        if (!MEDIA_RE.test(key)) return this.err(res, 404, 'nf'), true;
        const e = await this.fetchObj(key);
        if (!e) return this.err(res, 404, 'nf'), true;
        this.serve(req, res, e, 'public, max-age=31536000, immutable');
        return true;
      }
      // /p/<token>/<vid>/<file...>
      const parts = path.split('/'); // ['', 'p', tok, vid, ...file]
      const tok = parts[2], vid = parts[3], file = parts.slice(4).join('/');
      const t = verify(tok, this.playKey);
      if (!t || t.v !== vid || !VID_RE.test(vid)) return this.err(res, 403, 'token'), true;
      if (t.u && this.revoked.has(t.u)) return this.err(res, 403, 'revoked'), true;
      if (!FILE_RE.test(file) || file.includes('..')) return this.err(res, 404, 'nf'), true;
      this.viewers.set(t.s, { v: vid, t: Date.now() });
      const key = `v/${vid}/${file}`;
      const e = await this.fetchObj(key);
      if (!e) return this.err(res, 404, 'nf'), true;
      const ext = file.split('.').pop();
      this.serve(req, res, e, ext === 'm3u8' ? 'private, max-age=600' : 'private, max-age=31536000, immutable');
      if (ext === 'm4s') this.prefetch(vid, file);
    } catch (e) {
      this.noteErr(e.message);
      if (!res.headersSent) this.err(res, 502, 'upstream');
      else res.destroy();
    }
    return true;
  }

  snapshot(dtSec) {
    const cut = Date.now() - 30000, perVideo = {};
    let viewers = 0;
    for (const [sid, x] of this.viewers) {
      if (x.t < cut) { this.viewers.delete(sid); continue; }
      viewers++; perVideo[x.v] = (perVideo[x.v] || 0) + 1;
    }
    const c = this.c;
    const s = {
      conns: Math.max(0, c.conns), viewers, perVideo,
      rps: +(c.reqs / dtSec).toFixed(2), bps: Math.round(c.bytes * 8 / dtSec),
      hits: c.hits, miss: c.miss, err: c.err, upMs: c.upN ? Math.round(c.upMs / c.upN) : 0,
      cacheBytes: this.cache.size, cacheMax: this.cacheMax, cacheItems: this.cache.m.size, totalBytes: c.totalBytes,
    };
    c.reqs = 0; c.bytes = 0; c.hits = 0; c.miss = 0; c.err = 0; c.upMs = 0; c.upN = 0;
    return s;
  }
}
module.exports = { EdgeCore, LRU };
