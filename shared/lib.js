'use strict';
// V_N shared helpers — zero dependencies (Node >= 22)
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const envInt = (k, d) => { const v = parseInt(env(k, ''), 10); return Number.isFinite(v) ? v : d; };
const now = () => Date.now();
const rid = (n = 16) => crypto.randomBytes(n).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('base64url');
const deriveKey = (secret, label) => crypto.createHmac('sha256', String(secret)).update(label).digest();

// compact signed tokens: base64url(json).sig
function sign(obj, key) {
  const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const s = crypto.createHmac('sha256', key).update(p).digest('base64url').slice(0, 27);
  return p + '.' + s;
}
function verify(tok, key) {
  if (typeof tok !== 'string' || tok.length > 2048) return null;
  const i = tok.lastIndexOf('.');
  if (i < 1) return null;
  const p = tok.slice(0, i), s = tok.slice(i + 1);
  const e = crypto.createHmac('sha256', key).update(p).digest('base64url').slice(0, 27);
  if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
  try {
    const o = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (o.exp && o.exp * 1000 < Date.now()) return null;
    return o;
  } catch { return null; }
}
function safeEq(a, b) {
  a = Buffer.from(String(a || '')); b = Buffer.from(String(b || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
function bearer(req) { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; }

class HttpError extends Error { constructor(code, msg, extra) { super(msg || 'error'); this.code = code; this.extra = extra; } }
const fail = (code, msg, extra) => { throw new HttpError(code, msg, extra); };

function send(req, res, code, body, headers = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers };
  if (buf.length > 1200 && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /json|text|javascript|css|svg|xml/.test(h['Content-Type'])) {
    buf = zlib.gzipSync(buf, { level: 5 }); h['Content-Encoding'] = 'gzip'; h['Vary'] = 'Accept-Encoding';
  }
  h['Content-Length'] = buf.length;
  res.writeHead(code, h);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new HttpError(413, 'Слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit = 256 * 1024) {
  const b = await readBody(req, limit);
  if (!b.length) return {};
  try { return JSON.parse(b.toString()); } catch { throw new HttpError(400, 'Bad JSON'); }
}

class Router {
  constructor() { this.routes = []; }
  add(method, path, fn) {
    const keys = [];
    const src = path.replace(/\/:(\w+)(\*)?/g, (_, k, star) => { keys.push(k); return star ? '/(.*)' : '/([^/]+)'; });
    this.routes.push({ method, re: new RegExp('^' + src + '/?$'), keys, fn });
    return this;
  }
  get(p, f) { return this.add('GET', p, f); }
  post(p, f) { return this.add('POST', p, f); }
  put(p, f) { return this.add('PUT', p, f); }
  patch(p, f) { return this.add('PATCH', p, f); }
  del(p, f) { return this.add('DELETE', p, f); }
  match(method, path) {
    for (const r of this.routes) {
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const m = r.re.exec(path);
      if (m) { const params = {}; r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch { params[k] = m[i + 1]; } }); return { fn: r.fn, params }; }
    }
    return null;
  }
}

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

// CPU usage relative to the cgroup quota (0.5 CPU on Render free => 100% means 0.5 core busy)
function cpuMeter() {
  let quota = require('node:os').availableParallelism?.() || 1;
  try {
    const [q, p] = require('node:fs').readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (q !== 'max') quota = Math.max(0.05, Number(q) / Number(p));
  } catch {}
  let last = process.cpuUsage(), lastT = process.hrtime.bigint();
  return { quota, sample() {
    const u = process.cpuUsage(), t = process.hrtime.bigint();
    const used = (u.user - last.user + u.system - last.system) / 1e6;
    const wall = Number(t - lastT) / 1e9;
    last = u; lastT = t;
    return wall > 0 ? Math.min(1, used / wall / quota) : 0;
  } };
}

function lagMeter() {
  const { monitorEventLoopDelay } = require('node:perf_hooks');
  const h = monitorEventLoopDelay({ resolution: 20 }); h.enable();
  return () => { const v = h.percentile(99) / 1e6; h.reset(); return Math.round(v); };
}

module.exports = { env, envInt, now, rid, sha256, deriveKey, sign, verify, safeEq, bearer, HttpError, fail, send, readBody, readJson, Router, log, cpuMeter, lagMeter };
