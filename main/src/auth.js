'use strict';
// Sessions, users, Telegram login codes, rate limiting.
const { rid, sha256, fail, log } = require('../../shared/lib');

module.exports = (app) => {
  const { db, cfg } = app;
  const SESSION_DAYS = 60;
  const sessCache = new Map(); // hash -> {uid, exp, t}
  const seenThrottle = new Map();

  app.cookies = (req) => { const o = {}; for (const part of (req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim(); } return o; };

  app.createSession = (res, uid, req) => {
    const tok = rid(32), h = sha256(tok), now = Date.now(), exp = now + SESSION_DAYS * 864e5;
    db.run('INSERT INTO sessions(id, user_id, created_at, expires_at, seen_at, ua, ip) VALUES(?,?,?,?,?,?,?)', h, uid, now, exp, now, String(req.headers['user-agent'] || '').slice(0, 200), req.ip);
    // cap sessions per user
    db.run('DELETE FROM sessions WHERE user_id = ? AND id NOT IN (SELECT id FROM sessions WHERE user_id = ? ORDER BY seen_at DESC LIMIT 15)', uid, uid);
    res.setHeader('Set-Cookie', `vn_s=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${cfg.secure ? '; Secure' : ''}`);
    return h;
  };
  app.clearCookie = (res) => res.setHeader('Set-Cookie', `vn_s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cfg.secure ? '; Secure' : ''}`);
  app.dropSessions = (uid, exceptHash) => { db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', uid, exceptHash || ''); for (const [k, v] of sessCache) if (v.uid === uid && k !== exceptHash) sessCache.delete(k); };

  app.sessionOf = (req) => {
    if (req._sess !== undefined) return req._sess;
    const tok = app.cookies(req).vn_s; req._sess = null;
    if (!tok || tok.length > 64) return null;
    const h = sha256(tok);
    let s = sessCache.get(h);
    if (!s || Date.now() - s.t > 60000) {
      const r = db.get('SELECT user_id, expires_at FROM sessions WHERE id = ?', h);
      if (!r) { sessCache.delete(h); return null; }
      s = { uid: r.user_id, exp: r.expires_at, t: Date.now() }; sessCache.set(h, s);
      if (sessCache.size > 5000) sessCache.delete(sessCache.keys().next().value);
    }
    if (s.exp < Date.now()) return null;
    req._sess = { hash: h, uid: s.uid };
    return req._sess;
  };

  app.isBanned = (u) => u && (u.ban_until === -1 || u.ban_until > Date.now());
  app.userOf = (req) => {
    if (req._user !== undefined) return req._user;
    const s = app.sessionOf(req); req._user = null;
    if (!s) return null;
    const u = db.get('SELECT * FROM users WHERE id = ?', s.uid);
    if (!u) return null;
    const last = seenThrottle.get(u.id) || 0;
    if (Date.now() - last > 300000) { seenThrottle.set(u.id, Date.now()); db.run('UPDATE users SET last_seen = ?, last_ip = ? WHERE id = ?', Date.now(), req.ip, u.id); db.run('UPDATE sessions SET seen_at = ? WHERE id = ?', Date.now(), s.hash); }
    req._user = u;
    return u;
  };
  app.need = (req, role) => {
    const u = app.userOf(req);
    if (!u) fail(401, 'Нужно войти');
    if (app.isBanned(u)) fail(403, 'Аккаунт заблокирован', { banned: true });
    if (role === 'mod' && u.role !== 'mod' && u.role !== 'admin') fail(403, 'Нет прав');
    if (role === 'admin' && u.role !== 'admin') fail(403, 'Нужны права администратора');
    return u;
  };
  app.publicUser = (u) => u && ({ id: u.id, nick: u.nick, avatar: u.avatar ? '/m/a/' + u.avatar : null, role: u.role, notify: !!u.notify, tg: u.tg_username || null,
    banned: app.isBanned(u) ? { until: u.ban_until, reason: u.ban_reason || '' } : null, created: u.created_at, nickAt: u.nick_at });

  // ---- rate limiting (token bucket per key) ----
  const buckets = new Map();
  app.limit = (key, perMin, burst = perMin) => {
    const now = Date.now(); let b = buckets.get(key);
    if (!b) { b = { tokens: burst, t: now }; buckets.set(key, b); }
    b.tokens = Math.min(burst, b.tokens + ((now - b.t) / 60000) * perMin); b.t = now;
    if (b.tokens < 1) fail(429, 'Слишком часто, подожди немного');
    b.tokens -= 1;
  };

  // ---- nick helpers ----
  app.cleanNick = (s) => String(s || '').normalize('NFKC').replace(/[^\p{L}\p{N}_.\- ]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  app.uniqueNick = (base) => {
    base = app.cleanNick(base) || 'viewer';
    if (base.length < 3) base = base + '_' + Math.floor(Math.random() * 900 + 100);
    let n = base;
    for (let i = 0; db.get('SELECT 1 FROM users WHERE nick = ?', n); i++) n = base.slice(0, 19) + '_' + Math.floor(Math.random() * 9000 + 1000);
    return n;
  };
  app.upsertTgUser = (tg) => {
    const id = Number(tg.id); if (!Number.isSafeInteger(id) || id <= 0) fail(400, 'bad tg');
    let u = db.get('SELECT * FROM users WHERE tg_id = ?', id), created = false;
    const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ').slice(0, 64);
    if (!u) {
      if (!db.setting('site.registration', true) && !cfg.adminTg.has(id)) fail(403, 'Регистрация временно закрыта');
      const nick = app.uniqueNick(tg.username || tg.first_name || 'viewer');
      const r = db.run('INSERT INTO users(tg_id, tg_username, tg_name, nick, role, created_at, last_seen) VALUES(?,?,?,?,?,?,?)', id, tg.username || null, name, nick, cfg.adminTg.has(id) ? 'admin' : 'user', Date.now(), Date.now());
      u = db.get('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid)); created = true;
      db.audit(u.id, 'user.register', u.id, { tg: id });
    } else {
      db.run('UPDATE users SET tg_username = ?, tg_name = ? WHERE id = ?', tg.username || null, name, u.id);
      if (cfg.adminTg.has(id) && u.role !== 'admin') db.run("UPDATE users SET role = 'admin' WHERE id = ?", u.id);
      u = db.get('SELECT * FROM users WHERE id = ?', u.id);
    }
    return { u, created };
  };

  // ---- Telegram login codes (site ↔ bot) ----
  app.codes = new Map(); // code -> {st:'wait'|'ok'|'deny', t, uid, ip, waiters:Set}
  app.magic = new Map(); // key -> {uid, exp}
  app.newCode = (ip) => {
    let pending = 0; for (const c of app.codes.values()) if (c.ip === ip && c.st === 'wait') pending++;
    if (pending >= 6) fail(429, 'Слишком много попыток входа');
    const code = rid(9).replace(/[-_]/g, 'x');
    app.codes.set(code, { st: 'wait', t: Date.now(), uid: 0, ip, waiters: new Set() });
    return code;
  };
  app.resolveCode = (code, st, uid) => {
    const c = app.codes.get(code); if (!c || c.st !== 'wait') return false;
    c.st = st; c.uid = uid; for (const w of c.waiters) w(); c.waiters.clear(); return true;
  };

  app.maintenance = () => {
    const now = Date.now();
    for (const [k, c] of app.codes) if (now - c.t > 10 * 60e3) { for (const w of c.waiters) w(); app.codes.delete(k); }
    for (const [k, m] of app.magic) if (m.exp < now) app.magic.delete(k);
    for (const [k, b] of buckets) if (now - b.t > 600000) buckets.delete(k);
    if (Math.random() < 0.05) db.run('DELETE FROM sessions WHERE expires_at < ?', now);
    // stale encoder jobs → back to queue
    const stale = db.all("SELECT id, video_id FROM jobs WHERE status = 'encoding' AND local = 0 AND beat_at < ?", now - 10 * 60e3);
    for (const j of stale) { db.run("UPDATE jobs SET status = 'queued', encoder = NULL, updated_at = ? WHERE id = ?", now, j.id); db.run("UPDATE videos SET status = 'queued' WHERE id = ?", j.video_id); log('job requeued', j.id); }
    db.run("UPDATE jobs SET status = 'error', error = 'local encoder lost' WHERE status = 'encoding' AND local = 1 AND beat_at < ?", now - 60 * 60e3);
  };
};
