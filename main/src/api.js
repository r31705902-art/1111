'use strict';
const { rid, sign, fail, readJson, readBody, safeEq, bearer, send, log } = require('../../shared/lib');

const IMG = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' ? 'webp' : b[0] === 0x89 && b[1] === 0x50 ? 'png' : null);
const MIME = { jpg: 'image/jpeg', webp: 'image/webp', png: 'image/png' };

module.exports = (app, r) => {
  const { db, cfg, swarm, swift } = app;

  // ---------- caches ----------
  let ver = 1; const cache = new Map();
  app.bump = () => { ver++; cache.clear(); };
  const cached = (key, ttl, fn) => { const k = ver + ':' + key, e = cache.get(k); if (e && Date.now() - e.t < ttl) return e.v; const v = fn(); cache.set(k, { t: Date.now(), v }); if (cache.size > 400) cache.delete(cache.keys().next().value); return v; };
  const viewsSeen = new Map();

  const site = () => ({ title: db.setting('site.title', 'V_N'), tagline: db.setting('site.tagline', 'все эфиры в одном месте'), guestWatch: db.setting('site.guestWatch', true),
    registration: db.setting('site.registration', true), announce: db.setting('site.announce', ''), maintenance: db.setting('site.maintenance', ''), nickCooldownH: db.setting('site.nickCooldownH', 24), bot: cfg.botName });

  const card = (v) => ({ id: v.id, title: v.title, tags: JSON.parse(v.tags || '[]'), date: v.stream_date, dur: v.duration, cover: v.cover ? '/m/c/' + v.cover : null, views: v.views, pinned: !!v.pinned, created: v.created_at });
  const checkMaint = (req) => { const m = db.setting('site.maintenance', ''); const u = app.userOf(req); if (m && !(u && (u.role === 'admin' || u.role === 'mod'))) fail(503, m, { maintenance: true }); return u; };

  // ---------- public ----------
  r.get('/api/boot', (req) => { const u = app.userOf(req); return { site: site(), me: app.publicUser(u) }; });

  r.get('/api/videos', (req) => {
    checkMaint(req);
    const q = req.query;
    const key = q.toString();
    return cached('list:' + key, 20000, () => {
      const where = ["v.status = 'ready'", "v.visibility = 'public'"], args = [];
      let join = '', order;
      let text = String(q.get('q') || '').slice(0, 120);
      const tags = String(q.get('tags') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 8);
      text = text.replace(/#([\p{L}\p{N}_-]+)/gu, (_, t) => { tags.push(t.toLowerCase()); return ' '; });
      const dm = /\b(\d{4}(?:-\d{2}(?:-\d{2})?)?)\b/.exec(text);
      if (dm && /^\d{4}-\d{2}/.test(dm[1])) { where.push('v.stream_date LIKE ?'); args.push(dm[1] + '%'); text = text.replace(dm[1], ' '); }
      const toks = text.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0).slice(0, 8);
      if (toks.length) { join = 'JOIN (SELECT id AS fid, bm25(videos_fts) AS rk FROM videos_fts WHERE videos_fts MATCH ?) f ON f.fid = v.id'; args.unshift(toks.map((t) => '"' + t.replace(/"/g, '') + '"*').join(' ')); }
      for (const t of tags) { where.push('EXISTS (SELECT 1 FROM json_each(v.tags) WHERE lower(value) = ?)'); args.push(t); }
      if (q.get('from')) { where.push('v.stream_date >= ?'); args.push(q.get('from')); }
      if (q.get('to')) { where.push('v.stream_date <= ?'); args.push(q.get('to')); }
      if (q.get('dmin')) { where.push('v.duration >= ?'); args.push(Number(q.get('dmin')) * 60); }
      if (q.get('dmax')) { where.push('v.duration <= ?'); args.push(Number(q.get('dmax')) * 60); }
      const sort = q.get('sort') || (toks.length ? 'rel' : 'new');
      order = { rel: toks.length ? 'f.rk' : 'v.stream_date DESC', new: 'v.pinned DESC, v.stream_date DESC, v.created_at DESC', old: 'v.stream_date ASC, v.created_at ASC', views: 'v.views DESC', long: 'v.duration DESC', short: 'v.duration ASC', title: 'v.title COLLATE NOCASE ASC' }[sort] || 'v.stream_date DESC';
      const limit = Math.min(60, Math.max(1, Number(q.get('limit')) || 24)), page = Math.max(0, Number(q.get('page')) || 0);
      const base = `FROM videos v ${join} WHERE ${where.join(' AND ')}`;
      const total = db.get(`SELECT COUNT(*) n, COALESCE(SUM(v.duration),0) d ${base}`, ...args);
      const rows = db.all(`SELECT v.* ${base} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, limit, page * limit);
      return { total: total.n, hours: Math.round(total.d / 360) / 10, page, limit, items: rows.map(card) };
    });
  });

  r.get('/api/meta', (req) => cached('meta', 60000, () => {
    const tags = db.all("SELECT lower(j.value) tag, COUNT(*) n FROM videos v, json_each(v.tags) j WHERE v.status='ready' AND v.visibility='public' GROUP BY lower(j.value) ORDER BY n DESC LIMIT 60");
    const days = db.all("SELECT stream_date d, COUNT(*) n, SUM(duration) s FROM videos WHERE status='ready' AND visibility='public' AND stream_date IS NOT NULL GROUP BY stream_date ORDER BY d");
    const tot = db.get("SELECT COUNT(*) n, COALESCE(SUM(duration),0) d FROM videos WHERE status='ready' AND visibility='public'");
    return { tags, days, total: tot.n, hours: Math.round(tot.d / 360) / 10 };
  }));

  const getVideo = (req, id) => {
    const u = checkMaint(req);
    const v = db.get('SELECT * FROM videos WHERE id = ?', id);
    const staff = u && (u.role === 'admin' || u.role === 'mod');
    if (!v || (!staff && (v.status !== 'ready'))) fail(404, 'Видео не найдено');
    return { v, u, staff };
  };
  r.get('/api/videos/:id', (req) => {
    const { v, u } = getVideo(req, req.params.id);
    const media = v.media ? JSON.parse(v.media) : null;
    const out = { ...card(v), description: v.description, chapters: JSON.parse(v.chapters || '[]'), status: v.status, visibility: v.visibility, qualities: media ? media.renditions.map((x) => ({ h: x.h, codec: x.codec.slice(0, 4) })) : [], sb: media?.sb || null };
    out.watching = swarm.liveViewers().per[v.id] || 0;
    if (u) {
      out.fav = !!db.get('SELECT 1 FROM favorites WHERE user_id = ? AND video_id = ?', u.id, v.id);
      out.progress = db.get('SELECT pos FROM progress WHERE user_id = ? AND video_id = ?', u.id, v.id)?.pos || 0;
    }
    const tags = JSON.parse(v.tags || '[]');
    out.related = db.all(`SELECT v.* FROM videos v WHERE v.status='ready' AND v.visibility='public' AND v.id != ? ORDER BY (SELECT COUNT(*) FROM json_each(v.tags) WHERE value IN (SELECT value FROM json_each(?))) DESC, abs(julianday(v.stream_date) - julianday(?)) ASC LIMIT 8`, v.id, JSON.stringify(tags), v.stream_date || '2000-01-01').map(card);
    return out;
  });

  r.post('/api/videos/:id/play', async (req) => {
    const { v, u } = getVideo(req, req.params.id);
    if (v.status !== 'ready') fail(409, 'Видео ещё обрабатывается');
    if (!u && !db.setting('site.guestWatch', true)) fail(401, 'Войди через Telegram, чтобы смотреть');
    if (u && app.isBanned(u)) fail(403, 'Аккаунт заблокирован', { banned: true });
    const b = await readJson(req);
    app.limit('play:' + req.ip, 60, 30);
    const exp = Math.floor(Date.now() / 1000) + 6 * 3600;
    const sid = rid(6);
    const token = sign({ v: v.id, s: sid, u: u ? u.id : 0, exp }, app.playKey);
    const vk = (u ? 'u' + u.id : req.ip) + ':' + v.id;
    if (!viewsSeen.has(vk) || Date.now() - viewsSeen.get(vk) > 6 * 3600e3) { viewsSeen.set(vk, Date.now()); db.run('UPDATE videos SET views = views + 1 WHERE id = ?', v.id); if (viewsSeen.size > 50000) viewsSeen.clear(); }
    const nodes = swarm.pick(v.id, { tz: String(b.tz || '').slice(0, 40), off: Number(b.off) || 0, hint: String(b.rg || '').slice(0, 30) });
    return { token, exp, nodes, dur: v.duration };
  });

  r.post('/api/progress', async (req) => {
    const u = app.need(req); const b = await readJson(req);
    if (typeof b.v !== 'string' || !(b.p >= 0)) fail(400, 'bad');
    app.limit('prog:' + u.id, 20, 10);
    db.run('INSERT INTO progress(user_id, video_id, pos, dur, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id, video_id) DO UPDATE SET pos=excluded.pos, dur=excluded.dur, updated_at=excluded.updated_at', u.id, b.v, Math.round(b.p), Math.round(b.d || 0), Date.now());
    return { ok: true };
  });
  r.post('/api/videos/:id/fav', async (req) => {
    const u = app.need(req); const b = await readJson(req);
    if (b.on) db.run('INSERT OR IGNORE INTO favorites(user_id, video_id, created_at) VALUES(?,?,?)', u.id, req.params.id, Date.now());
    else db.run('DELETE FROM favorites WHERE user_id = ? AND video_id = ?', u.id, req.params.id);
    return { fav: !!b.on };
  });

  // ---------- me ----------
  r.get('/api/me', (req) => ({ me: app.publicUser(app.need(req)) }));
  r.get('/api/me/library', (req) => {
    const u = app.need(req);
    const hist = db.all("SELECT v.*, p.pos, p.dur pdur FROM progress p JOIN videos v ON v.id = p.video_id WHERE p.user_id = ? AND v.status='ready' ORDER BY p.updated_at DESC LIMIT 40", u.id).map((v) => ({ ...card(v), pos: v.pos }));
    const favs = db.all("SELECT v.* FROM favorites f JOIN videos v ON v.id = f.video_id WHERE f.user_id = ? AND v.status='ready' ORDER BY f.created_at DESC LIMIT 100", u.id).map(card);
    return { history: hist, favorites: favs };
  });
  r.patch('/api/me', async (req) => {
    const u = app.need(req); const b = await readJson(req);
    if (b.nick !== undefined && b.nick !== u.nick) {
      const nick = app.cleanNick(b.nick);
      if (nick.length < 3) fail(400, 'Ник: от 3 до 24 символов (буквы, цифры, _ . -)');
      const cd = db.setting('site.nickCooldownH', 24) * 3600e3;
      if (u.role === 'user' && Date.now() - u.nick_at < cd) fail(429, 'Ник можно менять раз в ' + db.setting('site.nickCooldownH', 24) + ' ч');
      const banned = db.setting('site.bannedWords', []);
      if (banned.some((w) => w && nick.toLowerCase().includes(String(w).toLowerCase()))) fail(400, 'Такой ник нельзя');
      const ex = db.get('SELECT id FROM users WHERE nick = ? AND id != ?', nick, u.id);
      if (ex) fail(409, 'Ник уже занят');
      db.run('UPDATE users SET nick = ?, nick_at = ? WHERE id = ?', nick, Date.now(), u.id);
    }
    if (b.notify !== undefined) db.run('UPDATE users SET notify = ? WHERE id = ?', b.notify ? 1 : 0, u.id);
    return { me: app.publicUser(db.get('SELECT * FROM users WHERE id = ?', u.id)) };
  });
  app.setAvatar = async (uid, buf) => {
    const ext = IMG(buf); if (!ext) fail(400, 'Нужна картинка JPG/PNG/WebP');
    const key = `${uid}_${rid(5)}.${ext}`;
    await swift.put('a/' + key, buf, MIME[ext]);
    const old = db.get('SELECT avatar FROM users WHERE id = ?', uid)?.avatar;
    db.run('UPDATE users SET avatar = ? WHERE id = ?', key, uid);
    if (old) swift.del('a/' + old).catch(() => {});
    return key;
  };
  r.post('/api/me/avatar', async (req) => {
    const u = app.need(req); app.limit('av:' + u.id, 6, 6);
    const buf = await readBody(req, 600 * 1024);
    await app.setAvatar(u.id, buf);
    return { me: app.publicUser(db.get('SELECT * FROM users WHERE id = ?', u.id)) };
  });
  r.del('/api/me/avatar', (req) => { const u = app.need(req); if (u.avatar) swift.del('a/' + u.avatar).catch(() => {}); db.run('UPDATE users SET avatar = NULL WHERE id = ?', u.id); return { ok: true }; });
  r.get('/api/me/sessions', (req) => { const u = app.need(req); const s = app.sessionOf(req); return { items: db.all('SELECT id, created_at, seen_at, ua, ip FROM sessions WHERE user_id = ? ORDER BY seen_at DESC', u.id).map((x) => ({ ...x, current: x.id === s.hash, id: x.id.slice(0, 10) })) }; });
  r.post('/api/me/logout-others', (req) => { const u = app.need(req); app.dropSessions(u.id, app.sessionOf(req).hash); return { ok: true }; });

  // ---------- auth (Telegram bot) ----------
  r.post('/api/auth/tg/start', (req) => {
    app.limit('tgstart:' + req.ip, 10, 5);
    const code = app.newCode(req.ip);
    return { code, link: `https://t.me/${cfg.botName}?start=${code}`, expiresIn: 600 };
  });
  r.get('/api/auth/tg/poll', (req, res) => new Promise((resolve) => {
    const code = String(req.query.get('code') || ''); const c = app.codes.get(code);
    if (!c) return resolve({ st: 'expired' });
    const finish = () => {
      clearTimeout(t);
      if (c.st === 'ok') { app.codes.delete(code); app.createSession(res, c.uid, req); resolve({ st: 'ok', me: app.publicUser(db.get('SELECT * FROM users WHERE id = ?', c.uid)) }); }
      else resolve({ st: c.st });
    };
    if (c.st !== 'wait') return finish();
    const t = setTimeout(() => { c.waiters.delete(finish); resolve({ st: 'wait' }); }, 25000);
    c.waiters.add(finish);
    req.on('close', () => { c.waiters.delete(finish); clearTimeout(t); });
  }));
  r.get('/auth/magic', (req, res) => {
    const k = String(req.query.get('k') || ''); const m = app.magic.get(k);
    app.magic.delete(k);
    if (m && m.exp > Date.now()) app.createSession(res, m.uid, req);
    res.writeHead(302, { Location: m ? '/me' : '/?login=expired' }); res.end();
  });
  r.post('/api/auth/logout', (req, res) => { const s = app.sessionOf(req); if (s) db.run('DELETE FROM sessions WHERE id = ?', s.hash); app.clearCookie(res); return { ok: true }; });

  // ---------- bot ↔ main ----------
  const botAuth = (req) => { if (!safeEq(req.headers['x-bot-secret'], cfg.botSecret)) fail(401, 'bot auth'); };
  const userByTg = (tg) => db.get('SELECT * FROM users WHERE tg_id = ?', Number(tg));
  r.post('/api/bot/confirm', async (req) => {
    botAuth(req); const b = await readJson(req);
    const c = app.codes.get(String(b.code || ''));
    if (!c || c.st !== 'wait') return { ok: false, error: 'Код входа устарел. Нажми «Войти» на сайте ещё раз.' };
    if (b.deny) { app.resolveCode(b.code, 'deny', 0); return { ok: true, denied: true }; }
    let res;
    try { res = app.upsertTgUser(b.tg || {}); } catch (e) { return { ok: false, error: e.message }; }
    if (app.isBanned(res.u)) { app.resolveCode(b.code, 'deny', 0); return { ok: false, banned: true, error: `Аккаунт заблокирован${res.u.ban_until > 0 ? ' до ' + new Date(res.u.ban_until).toLocaleString('ru-RU') : ' навсегда'}. ${res.u.ban_reason || ''}` }; }
    app.resolveCode(b.code, 'ok', res.u.id);
    db.audit(res.u.id, 'user.login', res.u.id, { via: 'code' });
    return { ok: true, created: res.created, nick: res.u.nick, needAvatar: !res.u.avatar, uid: res.u.id };
  });
  r.post('/api/bot/magic', async (req) => {
    botAuth(req); const b = await readJson(req);
    let res; try { res = app.upsertTgUser(b.tg || {}); } catch (e) { return { ok: false, error: e.message }; }
    if (app.isBanned(res.u)) return { ok: false, error: 'Аккаунт заблокирован. ' + (res.u.ban_reason || '') };
    const k = rid(24); app.magic.set(k, { uid: res.u.id, exp: Date.now() + 5 * 60e3 });
    return { ok: true, url: `${cfg.publicUrl}/auth/magic?k=${k}`, nick: res.u.nick, created: res.created, needAvatar: !res.u.avatar };
  });
  r.post('/api/bot/me', async (req) => {
    botAuth(req); const b = await readJson(req); const u = userByTg(b.tg);
    if (!u) return { ok: false };
    const watched = db.get('SELECT COUNT(*) n FROM progress WHERE user_id = ?', u.id).n;
    return { ok: true, me: app.publicUser(u), watched, url: cfg.publicUrl };
  });
  r.post('/api/bot/logout', async (req) => { botAuth(req); const b = await readJson(req); const u = userByTg(b.tg); if (u) app.dropSessions(u.id); return { ok: !!u }; });
  r.post('/api/bot/notify', async (req) => { botAuth(req); const b = await readJson(req); const u = userByTg(b.tg); if (u) db.run('UPDATE users SET notify = ? WHERE id = ?', b.on ? 1 : 0, u.id); return { ok: !!u }; });
  r.post('/api/bot/avatar', async (req) => { botAuth(req); const u = userByTg(req.query.get('tg')); if (!u || u.avatar) return { ok: false }; await app.setAvatar(u.id, await readBody(req, 600 * 1024)); return { ok: true }; });
  r.get('/api/bot/latest', (req) => { botAuth(req); return { items: db.all("SELECT id, title, stream_date, duration FROM videos WHERE status='ready' AND visibility='public' ORDER BY created_at DESC LIMIT 5"), url: cfg.publicUrl }; });

  app.notifyBot = async (payload) => {
    if (!cfg.botUrl) return false;
    try { const r = await fetch(cfg.botUrl + '/notify', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': cfg.botSecret }, body: JSON.stringify(payload), signal: AbortSignal.timeout(70000) }); return r.ok; }
    catch (e) { log('bot notify failed', e.message); return false; }
  };

  // ---------- swarm ----------
  const swarmAuth = (req) => { if (!safeEq(bearer(req), cfg.swarmSecret)) fail(401, 'swarm auth'); };
  r.post('/api/swarm/hb', async (req) => { swarmAuth(req); return swarm.heartbeat(await readJson(req, 64 * 1024)); });
  r.get('/api/swarm/storage', async (req) => { swarmAuth(req); await swift.auth(); return swift.creds(); });

  // ---------- encoder ----------
  const encAuth = (req) => { if (!safeEq(bearer(req), cfg.encoderToken)) fail(401, 'encoder auth'); };
  app.encoders = new Map();
  const jobOut = (j) => { const v = db.get('SELECT * FROM videos WHERE id = ?', j.video_id); return { id: j.id, videoId: j.video_id, rawParts: j.raw_parts, rawSize: j.raw_size, rawName: j.raw_name, opts: JSON.parse(j.opts || '{}'), hasCover: !!v?.cover, title: v?.title }; };
  r.post('/api/encoder/claim', async (req) => {
    encAuth(req); const b = await readJson(req);
    const name = String(b.name || 'encoder').slice(0, 40);
    app.encoders.set(name, { t: Date.now(), caps: b.caps || {}, ver: b.ver, busy: false });
    const j = db.get("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1");
    if (!j) return { job: null };
    db.run("UPDATE jobs SET status = 'encoding', encoder = ?, beat_at = ?, updated_at = ?, progress = 0 WHERE id = ?", name, Date.now(), Date.now(), j.id);
    db.run("UPDATE videos SET status = 'encoding' WHERE id = ?", j.video_id);
    await swift.auth();
    return { job: jobOut(j), storage: swift.creds() };
  });
  r.get('/api/encoder/pending', (req) => { encAuth(req); return { pending: db.get("SELECT COUNT(*) n FROM jobs WHERE status = 'queued'").n }; });
  r.get('/api/encoder/storage', async (req) => { encAuth(req); await swift.auth(); return swift.creds(); });
  r.post('/api/encoder/ingest', async (req) => {
    encAuth(req); const b = await readJson(req);
    const v = app.createVideo({ ...b, status: 'encoding' });
    const now = Date.now();
    const jr = db.run("INSERT INTO jobs(video_id, status, encoder, local, opts, raw_name, created_at, updated_at, beat_at) VALUES(?, 'encoding', ?, 1, ?, ?, ?, ?, ?)", v.id, String(b.encoder || 'cli').slice(0, 40), JSON.stringify({ profile: b.profile || db.setting('enc.profile', 'av1') }), String(b.file || '').slice(0, 200), now, now, now);
    db.audit(null, 'video.ingest', v.id, { title: v.title });
    await swift.auth();
    return { job: jobOut(db.get('SELECT * FROM jobs WHERE id = ?', Number(jr.lastInsertRowid))), storage: swift.creds() };
  });
  r.post('/api/encoder/jobs/:id/progress', async (req) => {
    encAuth(req); const b = await readJson(req);
    const j = db.get('SELECT * FROM jobs WHERE id = ?', Number(req.params.id));
    if (!j) fail(404, 'job');
    if (j.status !== 'encoding') return { cancel: true };
    db.run('UPDATE jobs SET progress = ?, info = ?, beat_at = ?, updated_at = ? WHERE id = ?', Number(b.progress) || 0, JSON.stringify(b.info || {}), Date.now(), Date.now(), j.id);
    const e = app.encoders.get(j.encoder); if (e) { e.t = Date.now(); e.busy = true; }
    return { cancel: false };
  });
  r.post('/api/encoder/jobs/:id/done', async (req) => {
    encAuth(req); const b = await readJson(req, 2 << 20);
    const j = db.get('SELECT * FROM jobs WHERE id = ?', Number(req.params.id)); if (!j) fail(404, 'job');
    const v = db.get('SELECT * FROM videos WHERE id = ?', j.video_id); if (!v) fail(404, 'video');
    const media = b.media; if (!media || !Array.isArray(media.renditions) || !media.renditions.length) fail(400, 'media');
    db.run("UPDATE videos SET media = ?, duration = ?, size_bytes = ?, status = 'ready', cover = COALESCE(cover, ?), updated_at = ? WHERE id = ?", JSON.stringify(media), Number(b.duration) || 0, Number(b.size) || 0, b.cover || null, Date.now(), v.id);
    db.run("UPDATE jobs SET status = 'done', progress = 1, updated_at = ? WHERE id = ?", Date.now(), j.id);
    const e = app.encoders.get(j.encoder); if (e) e.busy = false;
    app.bump(); log('job done', j.id, v.id);
    if (j.raw_parts && !db.setting('site.keepRaw', false)) app.deleteRaw(v.id, j.raw_parts).catch(() => {});
    if (v.visibility === 'public' && db.setting('site.notifyNew', true)) app.announceVideo(v.id);
    return { ok: true };
  });
  r.post('/api/encoder/jobs/:id/fail', async (req) => {
    encAuth(req); const b = await readJson(req);
    const j = db.get('SELECT * FROM jobs WHERE id = ?', Number(req.params.id)); if (!j) fail(404, 'job');
    db.run("UPDATE jobs SET status = 'error', error = ?, updated_at = ? WHERE id = ?", String(b.error || 'unknown').slice(0, 2000), Date.now(), j.id);
    db.run("UPDATE videos SET status = 'error' WHERE id = ?", j.video_id);
    const e = app.encoders.get(j.encoder); if (e) e.busy = false;
    return { ok: true };
  });
  r.post('/api/encoder/cover/:vid', async (req) => {
    encAuth(req);
    const buf = await readBody(req, 3 << 20); const ext = IMG(buf); if (!ext) fail(400, 'img');
    const key = `${req.params.vid}_${rid(4)}.${ext}`;
    await swift.put('c/' + key, buf, MIME[ext]);
    return { key };
  });

  // ---------- shared helpers used by admin ----------
  app.createVideo = (b) => {
    const id = rid(8).replace(/[-_]/g, 'x').slice(0, 10), now = Date.now();
    const tags = JSON.stringify([...new Set((Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',')).map((t) => String(t).trim().toLowerCase().replace(/^#/, '')).filter(Boolean))].slice(0, 20));
    const title = String(b.title || 'Без названия').slice(0, 200);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.stream_date || b.date || '') ? (b.stream_date || b.date) : new Date().toISOString().slice(0, 10);
    db.run('INSERT INTO videos(id, title, description, tags, stream_date, status, visibility, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)', id, title, String(b.description || '').slice(0, 5000), tags, date, b.status || 'uploading', b.visibility === 'hidden' ? 'hidden' : 'public', now, now);
    const v = db.get('SELECT * FROM videos WHERE id = ?', id); db.ftsSync(v); app.bump();
    return v;
  };
  app.deleteRaw = async (vid, parts) => { const names = []; for (let i = 1; i <= parts; i++) names.push(`raw/${vid}/p_${String(i).padStart(5, '0')}`); await swift.bulkDelete(names); };
  app.announceVideo = (vid) => {
    const v = db.get('SELECT * FROM videos WHERE id = ?', vid); if (!v) return;
    const chats = db.all('SELECT tg_id FROM users WHERE notify = 1 AND tg_id IS NOT NULL AND (ban_until = 0 OR (ban_until > 0 AND ban_until < ?))', Date.now()).map((x) => x.tg_id);
    if (!chats.length) return;
    const h = Math.floor(v.duration / 3600), m = Math.floor((v.duration % 3600) / 60);
    app.notifyBot({ chats, text: `📼 Новая запись в архиве\n\n<b>${esc(v.title)}</b>\n${v.stream_date} · ${h}ч ${m}м`, url: `${cfg.publicUrl}/v/${v.id}`, button: '▶ Смотреть' });
  };
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  app.esc = esc;
};
