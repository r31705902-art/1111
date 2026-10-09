'use strict';
// V_N swarm edge node — 0.5 CPU / 512MB friendly. No dependencies.
const http = require('node:http');
const os = require('node:os');
const { env, envInt, deriveKey, rid, safeEq, bearer, log, cpuMeter, lagMeter } = require('../../shared/lib');
const { Swift } = require('../../shared/swift');
const { EdgeCore } = require('../../shared/edgecore');

const VERSION = '1.0.0';
const MAIN_URL = env('MAIN_URL', 'http://localhost:8080').replace(/\/$/, '');
const SECRET = env('SWARM_SECRET', 'dev-swarm-secret');
const PUBLIC_URL = env('PUBLIC_URL', env('RENDER_EXTERNAL_URL', `http://localhost:${env('PORT', '10000')}`)).replace(/\/$/, '');
const REGION = env('EDGE_REGION', 'frankfurt').toLowerCase();
const NODE_ID = env('NODE_ID', new URL(PUBLIC_URL).host.split('.')[0].replace(/[^a-z0-9-]/gi, '').slice(0, 40) || os.hostname());
const BOOT = rid(6);

async function fetchCreds() {
  const r = await fetch(MAIN_URL + '/api/swarm/storage', { headers: { Authorization: 'Bearer ' + SECRET }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('storage creds: ' + r.status);
  return r.json();
}
const swift = env('BLOMP_USER')
  ? new Swift({ authUrl: env('BLOMP_AUTH_URL', 'https://authenticate.blomp.com'), user: env('BLOMP_USER'), key: env('BLOMP_PASS'), tenant: 'storage', container: env('BLOMP_CONTAINER', env('BLOMP_USER')) })
  : new Swift({ provider: fetchCreds });

const core = new EdgeCore({ swift, playKey: deriveKey(SECRET, 'play'), cacheMB: envInt('EDGE_CACHE_MB', 160), log });
const cpu = cpuMeter(), lag = lagMeter();
const state = { mode: 'active', draining: false, cap: envInt('CAPACITY', 40), idleSince: Date.now(), lastHb: Date.now(), hbOk: 0, hbFail: 0, mainRtt: 0, lastLoad: 0, cpu: 0 };

function load() { return Math.min(1.5, Math.max(core.c.conns / Math.max(1, state.cap * 3), state.cpu, state.lastViewers / Math.max(1, state.cap))); }
state.lastViewers = 0;

const server = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Timing-Allow-Origin': '*' });
    if (state.mode === 'sleep') { state.mode = 'active'; core.lowPower = false; } // inbound traffic = wake up
    return res.end(JSON.stringify({ id: NODE_ID, rg: REGION, l: +load().toFixed(3), d: state.draining ? 1 : 0, m: state.mode }));
  }
  if (path === '/health' || path === '/') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('V_N edge ' + NODE_ID + ' ok'); }
  if (path === '/diag') {
    if (!safeEq(bearer(req), SECRET)) { res.writeHead(401); return res.end(); }
    const t0 = Date.now(); let blomp = 'ok';
    try { await swift.stat(); } catch (e) { blomp = e.message; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const m = process.memoryUsage();
    return res.end(JSON.stringify({ id: NODE_ID, ver: VERSION, node: process.version, blompMs: Date.now() - t0, blomp, mem: { rss: m.rss, heap: m.heapUsed, ext: m.external, buf: m.arrayBuffers }, cache: { bytes: core.cache.size, items: core.cache.m.size, max: core.cacheMax }, inflight: core.inflight.size, errors: core.errors, state, cpuQuota: cpu.quota, loadavg: os.loadavg(), uptime: process.uptime() }));
  }
  if (await core.handle(req, res, path)) return;
  res.writeHead(404); res.end();
});
server.keepAliveTimeout = 65000; server.headersTimeout = 70000; server.requestTimeout = 120000;

async function heartbeat() {
  const dt = Math.max(1, (Date.now() - state.lastHb) / 1000); state.lastHb = Date.now();
  const snap = core.snapshot(dt);
  state.cpu = cpu.sample(); state.lastViewers = snap.viewers;
  const busy = snap.viewers > 0 || snap.conns > 0;
  if (busy) { state.idleSince = Date.now(); if (state.mode !== 'active') { state.mode = 'active'; core.lowPower = false; } }
  else if (state.mode === 'active' && Date.now() - state.idleSince > 120000) state.mode = 'idle';
  const m = process.memoryUsage();
  const body = { id: NODE_ID, url: PUBLIC_URL, region: REGION, ver: VERSION, boot: BOOT, cap: state.cap,
    st: { ...snap, cpu: +state.cpu.toFixed(3), lag: lag(), rss: m.rss, heap: m.heapUsed, up: Math.round(process.uptime()), idleFor: Math.round((Date.now() - state.idleSince) / 1000), mode: state.mode, draining: state.draining, load: +load().toFixed(3), mainRtt: state.mainRtt },
    errs: core.errors.slice(-5) };
  const t0 = Date.now();
  try {
    const r = await fetch(MAIN_URL + '/api/swarm/hb', { method: 'POST', headers: { Authorization: 'Bearer ' + SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
    state.mainRtt = Date.now() - t0;
    if (!r.ok) throw new Error('hb ' + r.status);
    const j = await r.json();
    state.hbOk++;
    if (j.storage && !env('BLOMP_USER')) swift.setCreds(j.storage);
    if (j.revoked) core.revoked = new Set(j.revoked);
    if (j.cap) state.cap = j.cap;
    if (j.cacheMB && j.cacheMB * 1048576 !== core.cacheMax) { core.cacheMax = core.cache.max = j.cacheMB * 1048576; core.cache.trimTo(core.cacheMax); }
    for (const c of j.cmds || []) runCmd(c);
  } catch (e) { state.hbFail++; if (state.hbFail % 5 === 1) log('heartbeat failed:', e.message); }
  const next = state.mode === 'active' ? 15000 : state.mode === 'idle' ? 45000 : 120000;
  setTimeout(heartbeat, next).unref?.();
}

function runCmd(c) {
  log('cmd', c.t);
  switch (c.t) {
    case 'drain': state.draining = true; break;
    case 'undrain': state.draining = false; break;
    case 'flush': core.cache.clear(); break;
    case 'sleep': state.mode = 'sleep'; core.lowPower = true; core.cache.clear(); if (global.gc) global.gc(); break;
    case 'wake': state.mode = 'active'; core.lowPower = false; state.idleSince = Date.now(); break;
    case 'restart': setTimeout(() => process.exit(0), 1500); break;
  }
}

server.listen(envInt('PORT', 10000), () => { log(`V_N edge ${NODE_ID} (${REGION}) on :${server.address().port} → main ${MAIN_URL}`); heartbeat(); });
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { state.draining = true; server.close(); setTimeout(() => process.exit(0), 3000).unref(); });
process.on('uncaughtException', (e) => { core.noteErr(e.message); log('uncaught', e); });
process.on('unhandledRejection', (e) => { core.noteErr(String(e)); });
