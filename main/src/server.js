'use strict';
// V_N main server: API + SPA + swarm coordinator + emergency origin. Zero npm dependencies.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const L = require('../../shared/lib');
const { env, envInt, rid, sha256, deriveKey, HttpError, send, log, Router } = L;
const { DB } = require('./db');
const { makeSwift, Backup } = require('./storage');
const { Swarm } = require('./swarm');
const { EdgeCore } = require('../../shared/edgecore');

const cfg = {
  port: envInt('PORT', 8080),
  publicUrl: env('PUBLIC_URL', env('RENDER_EXTERNAL_URL', 'http://localhost:8080')).replace(/\/$/, ''),
  dataDir: env('DATA_DIR', path.join(__dirname, '../../data')),
  swarmSecret: env('SWARM_SECRET', 'dev-swarm-secret'),
  botSecret: env('BOT_SECRET', 'dev-bot-secret'),
  encoderToken: env('ENCODER_TOKEN', 'dev-encoder-token'),
  botUrl: env('BOT_URL', '').replace(/\/$/, ''),
  botName: env('BOT_USERNAME', 'vn_archive_bot'),
  adminTg: new Set(env('ADMIN_TG_IDS', '').split(',').map((s) => s.trim()).filter(Boolean).map(Number)),
  secure: env('PUBLIC_URL', env('RENDER_EXTERNAL_URL', '')).startsWith('https'),
};
fs.mkdirSync(cfg.dataDir, { recursive: true });
const DB_FILE = path.join(cfg.dataDir, 'vn.sqlite');
const playKey = deriveKey(cfg.swarmSecret, 'play');

const app = { cfg, playKey, L };

async function boot() {
  app.swift = makeSwift();
  app.backup = new Backup(app.swift, DB_FILE);
  if (app.swift.o.user) {
    try { await app.swift.auth(); log('Blomp: authenticated, token until', new Date(app.swift.exp).toISOString()); } catch (e) { log('Blomp auth error:', e.message); }
    await app.backup.restoreIfMissing();
  }
  app.db = new DB(DB_FILE);
  app.swarm = new Swarm(app.db, app.swift, cfg);
  app.origin = new EdgeCore({ swift: app.swift, playKey, cacheMB: envInt('ORIGIN_CACHE_MB', 48), log });
  require('./auth')(app);
  const router = new Router();
  require('./api')(app, router);
  require('./admin')(app, router);
  app.router = router;
  loadStatic();
  // timers
  setInterval(() => app.swift.o.user && app.swift.auth().catch((e) => log('Blomp refresh', e.message)), 5 * 60e3).unref();
  setInterval(() => { if (app.db.dirty && Date.now() - app.backup.last > envInt('BACKUP_EVERY_SEC', 120) * 1000) app.backup.run(app.db); }, 15000).unref();
  setInterval(() => app.maintenance(), 60000).unref();
  setInterval(() => { app.originStats = app.origin.snapshot(15); }, 15000).unref();
  server.listen(cfg.port, () => log(`V_N main on :${cfg.port} (${cfg.publicUrl})`));
}

// ---------- static SPA (pre-compressed in RAM) ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
const statics = new Map();
function loadStatic() {
  const dir = path.join(__dirname, '../public');
  const files = fs.readdirSync(dir);
  const ver = {};
  for (const f of files) ver[f] = crypto.createHash('md5').update(fs.readFileSync(path.join(dir, f))).digest('hex').slice(0, 8);
  for (const f of files) {
    let buf = fs.readFileSync(path.join(dir, f));
    const ext = path.extname(f);
    if (ext === '.html' || ext === '.js') buf = Buffer.from(buf.toString().replace(/__V_([\w.]+)__/g, (_, n) => ver[n] || '0').replace(/__BOT__/g, cfg.botName));
    const e = { type: TYPES[ext] || 'application/octet-stream', raw: buf, etag: '"' + crypto.createHash('md5').update(buf).digest('hex').slice(0, 12) + '"' };
    if (/text|javascript|svg|json/.test(e.type)) { e.br = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); e.gz = zlib.gzipSync(buf, { level: 9 }); }
    statics.set('/' + f, e);
  }
}
function serveStatic(req, res, p) {
  let e = statics.get(p), spa = false;
  if (!e) { e = statics.get('/index.html'); spa = true; }
  const h = { 'Content-Type': e.type, ETag: e.etag, 'Cache-Control': spa || p === '/index.html' || p === '/sw.js' ? 'no-cache' : 'public, max-age=31536000, immutable', Vary: 'Accept-Encoding',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };
  if (spa || e.type.startsWith('text/html')) h['Content-Security-Policy'] = `default-src 'self'; img-src 'self' data: blob: https:${cfg.secure ? '' : ' http:'}; media-src 'self' blob: https: http:; connect-src 'self' https: http:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'`;
  if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, h); return res.end(); }
  const ae = req.headers['accept-encoding'] || '';
  let body = e.raw;
  if (e.br && /\bbr\b/.test(ae)) { body = e.br; h['Content-Encoding'] = 'br'; } else if (e.gz && /gzip/.test(ae)) { body = e.gz; h['Content-Encoding'] = 'gzip'; }
  h['Content-Length'] = body.length;
  res.writeHead(200, h); res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------- request handling ----------
const server = http.createServer(async (req, res) => {
  const u = req.url || '/';
  const qi = u.indexOf('?');
  const p = qi < 0 ? u : u.slice(0, qi);
  req.query = new URLSearchParams(qi < 0 ? '' : u.slice(qi + 1));
  req.ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  try {
    if (p === '/ping') return send(req, res, 200, { id: 'origin', rg: 'origin', l: 0.9, d: 0, m: 'active' }, { 'Access-Control-Allow-Origin': '*' });
    if (p === '/health') return send(req, res, 200, 'ok', { 'Content-Type': 'text/plain' });
    if (p.startsWith('/p/') || p.startsWith('/m/')) { if (await app.origin.handle(req, res, p)) return; }
    if (p.startsWith('/api/') || p.startsWith('/auth/')) {
      const m = app.router.match(req.method, p);
      if (!m) return send(req, res, 404, { error: 'Не найдено' });
      if (req.method !== 'GET' && req.method !== 'HEAD' && !p.startsWith('/api/swarm/') && !p.startsWith('/api/bot/') && !p.startsWith('/api/encoder/') && req.headers['x-vn'] !== '1') return send(req, res, 403, { error: 'csrf' });
      req.params = m.params;
      const out = await m.fn(req, res);
      if (out !== undefined && !res.headersSent) send(req, res, 200, out);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
    send(req, res, 405, { error: 'method' });
  } catch (e) {
    if (e instanceof HttpError) { if (!res.headersSent) send(req, res, e.code, { error: e.message, ...(e.extra || {}) }); return; }
    log('ERR', req.method, p, e.stack || e);
    if (!res.headersSent) send(req, res, 500, { error: 'Внутренняя ошибка' }); else res.destroy();
  }
});
server.keepAliveTimeout = 65000; server.headersTimeout = 70000; server.requestTimeout = 0;

async function shutdown() {
  log('shutting down…');
  server.close();
  try { if (app.db?.dirty) await app.backup.run(app.db, 'shutdown'); } catch {}
  app.db?.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => log('unhandled', e));
boot().catch((e) => { log('boot failed', e); process.exit(1); });
module.exports = app;
