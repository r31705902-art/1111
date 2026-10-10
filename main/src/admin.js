'use strict';
const os = require('node:os');
const { rid, fail, readJson, readBody, log, cpuMeter, lagMeter } = require('../../shared/lib');

const IMG = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' ? 'webp' : b[0] === 0x89 && b[1] === 0x50 ? 'png' : null);
const MIME = { jpg: 'image/jpeg', webp: 'image/webp', png: 'image/png' };
const PART = 16 * 1048576;

module.exports = (app, r) => {
  const { db, swift, swarm, cfg } = app;
  const cpu = cpuMeter(), lag = lagMeter();
  let storageStat = null, storageAt = 0;
  const parseUA = (ua = '') => (/(Edg|OPR|Chrome|Firefox|Safari)\/[\d.]+/.exec(ua)?.[0] || 'browser') + (/(Android|iPhone|iPad|Windows|Mac OS X|Linux)/.exec(ua)?.[1] ? ' · ' + /(Android|iPhone|iPad|Windows|Mac OS X|Linux)/.exec(ua)[1] : '');

  // ---------- overview ----------
  r.get('/api/admin/overview', async (req) => {
    app.need(req, 'mod');
    if (Date.now() - storageAt > 300000 && swift.o.user) { storageAt = Date.now(); swift.stat().then((s) => (storageStat = s)).catch(() => {}); }
    const m = process.memoryUsage();
    const snap = swarm.snapshot();
    const states = {}; for (const n of snap.nodes) states[n.state] = (states[n.state] || 0) + 1;
    const lv = swarm.liveViewers();
    const os_ = app.originStats || {};
    return {
      users: db.get('SELECT COUNT(*) n, SUM(CASE WHEN ban_until = -1 OR ban_until > ? THEN 1 ELSE 0 END) banned, SUM(CASE WHEN last_seen > ? THEN 1 ELSE 0 END) active24 FROM users', Date.now(), Date.now() - 864e5),
      videos: db.all('SELECT status, COUNT(*) n, COALESCE(SUM(duration),0) dur, COALESCE(SUM(size_bytes),0) size FROM videos GROUP BY status'),
      views: db.get('SELECT COALESCE(SUM(views),0) n FROM videos').n,
      top: db.all("SELECT id, title, views FROM videos WHERE status='ready' ORDER BY views DESC LIMIT 5"),
      live: { viewers: lv.v + (os_.viewers || 0), per: lv.per, originViewers: os_.viewers || 0, bps: snap.nodes.reduce((a, n) => a + (n.st && ['online', 'idle', 'dozing', 'draining'].includes(n.state) ? n.st.bps || 0 : 0), 0) + (os_.bps || 0) },
      swarm: { total: snap.nodes.length, states, hist: snap.hist },
      jobs: db.all("SELECT status, COUNT(*) n FROM jobs GROUP BY status"),
      encoders: [...app.encoders].map(([name, e]) => ({ name, ...e, online: Date.now() - e.t < 120000 })),
      storage: storageStat, blompTokenExp: swift.exp,
      backup: { last: app.backup.last, size: app.backup.lastSize, err: app.backup.lastErr, dirty: db.dirty },
      main: { rss: m.rss, heap: m.heapUsed, cpu: +cpu.sample().toFixed(3), lag: lag(), up: Math.round(process.uptime()), node: process.version, load: os.loadavg(), origin: os_ },
    };
  });

  // ---------- videos ----------
  r.get('/api/admin/videos', (req) => {
    app.need(req, 'mod');
    const q = String(req.query.get('q') || ''), st = String(req.query.get('status') || '');
    const where = ['1=1'], args = [];
    if (q) { where.push('(title LIKE ? OR id = ? OR tags LIKE ?)'); args.push('%' + q + '%', q, '%' + q.toLowerCase() + '%'); }
    if (st) { where.push('status = ?'); args.push(st); }
    const page = Math.max(0, Number(req.query.get('page')) || 0);
    const rows = db.all(`SELECT id, title, description, tags, stream_date, duration, status, visibility, cover, views, size_bytes, chapters, pinned, created_at, updated_at FROM videos WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 50 OFFSET ?`, ...args, page * 50);
    const total = db.get(`SELECT COUNT(*) n FROM videos WHERE ${where.join(' AND ')}`, ...args).n;
    return { total, items: rows.map((v) => ({ ...v, tags: JSON.parse(v.tags), chapters: JSON.parse(v.chapters), cover: v.cover ? '/m/c/' + v.cover : null, job: db.get('SELECT id, status, progress, info, error, encoder FROM jobs WHERE video_id = ? ORDER BY id DESC LIMIT 1', v.id) })) };
  });
  r.patch('/api/admin/videos/:id', async (req) => {
    const u = app.need(req, 'admin'); const b = await readJson(req, 512 * 1024);
    const v = db.get('SELECT * FROM videos WHERE id = ?', req.params.id); if (!v) fail(404, 'Нет видео');
    const set = {};
    if (b.title !== undefined) { set.title = String(b.title).trim().slice(0, 200); if (!set.title) fail(400, 'Пустое название'); }
    if (b.description !== undefined) set.description = String(b.description).slice(0, 5000);
    if (b.tags !== undefined) set.tags = JSON.stringify([...new Set((Array.isArray(b.tags) ? b.tags : String(b.tags).split(',')).map((t) => String(t).trim().toLowerCase().replace(/^#/, '')).filter(Boolean))].slice(0, 20));
    if (b.stream_date !== undefined) { if (!/^\d{4}-\d{2}-\d{2}$/.test(b.stream_date)) fail(400, 'Дата: ГГГГ-ММ-ДД'); set.stream_date = b.stream_date; }
    if (b.visibility !== undefined) set.visibility = b.visibility === 'hidden' ? 'hidden' : 'public';
    if (b.pinned !== undefined) set.pinned = b.pinned ? 1 : 0;
    if (b.chapters !== undefined) set.chapters = JSON.stringify((Array.isArray(b.chapters) ? b.chapters : []).filter((c) => c && c.t >= 0 && c.title).map((c) => ({ t: Math.round(c.t), title: String(c.title).slice(0, 120) })).sort((a, b2) => a.t - b2.t).slice(0, 300));
    const keys = Object.keys(set); if (!keys.length) return { ok: true };
    db.run(`UPDATE videos SET ${keys.map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => set[k]), Date.now(), v.id);
    db.ftsSync(db.get('SELECT * FROM videos WHERE id = ?', v.id));
    db.audit(u.id, 'video.edit', v.id, { fields: keys }); app.bump();
    return { ok: true };
  });
  r.post('/api/admin/videos/:id/cover', async (req) => {
    const u = app.need(req, 'admin');
    const v = db.get('SELECT * FROM videos WHERE id = ?', req.params.id); if (!v) fail(404, 'Нет видео');
    const buf = await readBody(req, 3 << 20); const ext = IMG(buf); if (!ext) fail(400, 'Нужна картинка');
    const key = `${v.id}_${rid(4)}.${ext}`;
    await swift.put('c/' + key, buf, MIME[ext]);
    db.run('UPDATE videos SET cover = ?, updated_at = ? WHERE id = ?', key, Date.now(), v.id);
    if (v.cover) swift.del('c/' + v.cover).catch(() => {});
    db.audit(u.id, 'video.cover', v.id); app.bump();
    return { cover: '/m/c/' + key };
  });
  r.post('/api/admin/videos/:id/announce', (req) => { app.need(req, 'admin'); app.announceVideo(req.params.id); return { ok: true }; });
  r.del('/api/admin/videos/:id', async (req) => {
    const u = app.need(req, 'admin');
    const v = db.get('SELECT * FROM videos WHERE id = ?', req.params.id); if (!v) fail(404, 'Нет видео');
    app.deleteVideo(v.id, null, u.id);
    return { ok: true };
  });
  app.deleteVideo = (id, why, actor) => {
    const v = db.get('SELECT * FROM videos WHERE id = ?', id); if (!v) return false;
    const jobs = db.all('SELECT raw_parts FROM jobs WHERE video_id = ?', v.id);
    db.tx(() => {
      for (const t of ['favorites', 'progress', 'jobs']) db.run(`DELETE FROM ${t} WHERE video_id = ?`, v.id);
      db.run('DELETE FROM uploads WHERE video_id = ?', v.id);
      db.run('DELETE FROM videos WHERE id = ?', v.id);
      db.run('DELETE FROM videos_fts WHERE id = ?', v.id);
    });
    db.audit(actor || null, 'video.delete', v.id, { title: v.title, why: why || undefined }); app.bump();
    purgeVideo(v, jobs).catch((e) => log('purge failed', v.id, e.message));
    return true;
  };
  async function purgeVideo(v, jobs) {
    const names = new Set();
    const media = v.media ? JSON.parse(v.media) : null;
    if (media) {
      names.add(`v/${v.id}/master.m3u8`);
      for (const rd of [...media.renditions, ...(media.audio ? [media.audio] : [])]) {
        names.add(`v/${v.id}/${rd.name}/index.m3u8`); names.add(`v/${v.id}/${rd.name}/init.mp4`);
        const pl = await swift.getBuffer(`v/${v.id}/${rd.name}/index.m3u8`).catch(() => null);
        if (pl) for (const line of pl.buf.toString().split('\n')) { const s = line.trim(); const mu = /^#EXT-X-MAP:URI="([^"]+)"/.exec(s); if (mu) names.add(`v/${v.id}/${rd.name}/${mu[1]}`); if (s && !s.startsWith('#')) names.add(`v/${v.id}/${rd.name}/${s}`); }
        else for (let i = 0; i < (rd.segs || 0) + 2; i++) names.add(`v/${v.id}/${rd.name}/seg_${String(i).padStart(5, '0')}.m4s`);
      }
      if (media.subs) names.add(`v/${v.id}/subs.json`);
      if (media.sb) { names.add(`v/${v.id}/sb/index.json`); for (let i = 1; i <= media.sb.sheets; i++) names.add(`v/${v.id}/sb/sb_${String(i).padStart(3, '0')}.${media.sb.ext || 'webp'}`); }
    }
    for (const o of await swift.list(`v/${v.id}/`).catch(() => [])) names.add(o.name);
    for (const j of jobs) for (let i = 1; i <= (j.raw_parts || 0); i++) names.add(`raw/${v.id}/p_${String(i).padStart(5, '0')}`);
    if (v.cover) names.add('c/' + v.cover);
    const n = await swift.bulkDelete([...names]);
    log('purged video', v.id, n, '/', names.size, 'objects');
  }

  // ---------- chunked resumable upload ----------
  r.post('/api/admin/uploads', async (req) => {
    const u = app.need(req, 'admin'); const b = await readJson(req);
    const size = Number(b.size); if (!(size > 0)) fail(400, 'Размер файла?');
    const partSize = Math.max(PART, Math.ceil(size / 9000 / 1048576) * 1048576);
    const parts = Math.ceil(size / partSize);
    const v = app.createVideo({ ...b, status: 'uploading' });
    const id = rid(12);
    db.run('INSERT INTO uploads(id, video_id, name, size, part_size, parts, created_at) VALUES(?,?,?,?,?,?,?)', id, v.id, String(b.name || '').slice(0, 200), size, partSize, parts, Date.now());
    db.audit(u.id, 'video.upload', v.id, { name: b.name, size });
    return { id, videoId: v.id, partSize, parts, got: [] };
  });
  const upl = (id) => { const x = db.get('SELECT * FROM uploads WHERE id = ?', id); if (!x) fail(404, 'Загрузка не найдена'); return x; };
  const gotSet = (x) => new Set(x.got ? x.got.split(',').map(Number) : []);
  r.get('/api/admin/uploads/:id', (req) => { app.need(req, 'admin'); const x = upl(req.params.id); return { id: x.id, videoId: x.video_id, partSize: x.part_size, parts: x.parts, size: x.size, got: [...gotSet(x)], done: !!x.done }; });
  r.put('/api/admin/uploads/:id/:n', async (req) => {
    app.need(req, 'admin');
    const x = upl(req.params.id), n = Number(req.params.n);
    if (!(n >= 1 && n <= x.parts) || x.done) fail(400, 'Неверная часть');
    const expect = n < x.parts ? x.part_size : x.size - x.part_size * (x.parts - 1);
    const len = Number(req.headers['content-length']);
    if (len !== expect) fail(400, `Часть ${n}: ожидалось ${expect} байт`);
    const res = await swift.req('PUT', `raw/${x.video_id}/p_${String(n).padStart(5, '0')}`, { headers: { 'Content-Length': len, 'Content-Type': 'application/octet-stream' }, body: req, timeout: 900000 });
    res.resume();
    if (res.statusCode >= 300) fail(502, 'Blomp отклонил часть: ' + res.statusCode);
    const cur = upl(req.params.id); const g = gotSet(cur); g.add(n);
    db.run('UPDATE uploads SET got = ? WHERE id = ?', [...g].join(','), x.id);
    return { ok: true, got: g.size };
  });
  r.post('/api/admin/uploads/:id/complete', async (req) => {
    const u = app.need(req, 'admin'); const b = await readJson(req);
    const x = upl(req.params.id); const g = gotSet(x);
    if (g.size !== x.parts) fail(400, `Загружено ${g.size} из ${x.parts} частей`);
    if (x.done) return { ok: true };
    const now = Date.now();
    db.run('UPDATE uploads SET done = 1 WHERE id = ?', x.id);
    db.run("INSERT INTO jobs(video_id, status, raw_parts, raw_size, raw_name, opts, created_at, updated_at) VALUES(?, 'queued', ?, ?, ?, ?, ?, ?)", x.video_id, x.parts, x.size, x.name, JSON.stringify({ profile: b.profile || db.setting('enc.profile', 'av1') }), now, now);
    db.run("UPDATE videos SET status = 'queued' WHERE id = ?", x.video_id);
    db.audit(u.id, 'video.queued', x.video_id); app.bump();
    return { ok: true };
  });

  // ---------- encoder jobs ----------
  r.get('/api/admin/jobs', (req) => {
    app.need(req, 'mod');
    return { items: db.all('SELECT j.*, v.title FROM jobs j LEFT JOIN videos v ON v.id = j.video_id ORDER BY j.id DESC LIMIT 100').map((j) => ({ ...j, info: j.info ? JSON.parse(j.info) : null })),
      encoders: [...app.encoders].map(([name, e]) => ({ name, ...e, online: Date.now() - e.t < 120000 })) };
  });
  r.post('/api/admin/jobs/:id/:action', (req) => {
    const u = app.need(req, 'admin');
    const j = db.get('SELECT * FROM jobs WHERE id = ?', Number(req.params.id)); if (!j) fail(404, 'job');
    if (req.params.action === 'retry') {
      const o = JSON.parse(j.opts || '{}');
      if (!j.raw_parts && !o.url) fail(400, 'Нет исходника в хранилище (локальный ingest) — перезапусти кодировщик с файлом');
      if (o.autocut) { app.dropParts(j); o.autocut.partIds = []; }
      db.run("UPDATE jobs SET status = 'queued', error = NULL, progress = 0, encoder = NULL, opts = ?, updated_at = ? WHERE id = ?", JSON.stringify(o), Date.now(), j.id);
      db.run("UPDATE videos SET status = 'queued' WHERE id = ?", j.video_id);
    } else if (req.params.action === 'cancel') {
      db.run("UPDATE jobs SET status = 'canceled', updated_at = ? WHERE id = ?", Date.now(), j.id);
      app.dropParts(j);
      db.run("UPDATE videos SET status = 'error' WHERE id = ? AND status != 'ready'", j.video_id);
    } else fail(400, 'action');
    db.audit(u.id, 'job.' + req.params.action, j.id); app.bump();
    return { ok: true };
  });

  // ---------- авто-нарезка: ссылка на стрим → ферма скачает, закодирует, расшифрует, нарежет ----------
  const DEFAULT_STYLE = `T2x2 СМОТРИТ: С МАМАМИ МАЛЬЧИКОВ ЧТО-ТО НЕ ТАК
T2x2 ИГРАЕТ в BACKROOM COMPANY / МАЗЕЛЛОВ, Laufeech
T2x2 СМОТРИТ: думаешь тебя трудно НАПУГАТЬ?
T2x2 СМОТРИТ: УЖАСЫ, КОТОРЫЕ ВАМ НЕ ПОКАЗАЛИ В ФИЛЬМАХ
T2x2 ИГРАЕТ в HAPPY WHEELS
T2x2 СМОТРИТ: Я Приготовил Ютуберам Их Последние Блюда
T2x2 СМОТРИТ: Съешь Всё В Продуктовом Магазине, Выиграй $1,000,000
T2x2 СМОТРИТ: 🎉 Угадай 50 ПЕРСОНАЖЕЙ по голосу! Большой EmojiCool Челлендж! 🎤
T2x2 И АСЛАН ШУКАША УСТРАИВАЮТ ПРОВЕРКУ УЧИТЕЛЯМ / ШОУ ИНТУИЦИЯ
T2x2 ПРОХОДИТ МАЙНКРАФТ СБОРКУ с АЛЬТУШКОЙ
T2x2 СМОТРИТ: Уйти любой ценой / 6 диких погонь
T2x2 СМОТРИТ: 1 000 муравьёв VS испытания
T2x2 СМОТРИТ: Аварии на реальных событиях в BeamNG.Drive #71
T2x2 УЧИТ СЕСТРУ ВОДИТЬ МАШИНУ
T2x2 ИГРАЕТ в СИМУЛЯТОР ЖЕНЩИНЫ
T2x2 СМОТРИТ: ВСЕ НЕНАВИДЯТ СИДНИ СУИНИ
T2x2 СМОТРИТ: ВСЕ МЕМЫ СЕНТЯБРЯ
T2x2 ИГРАЕТ в ПРИВЕТ СОСЕД 2 - Hello Neighbor 2 #2
T2x2 СМОТРИТ: Айсберг УЖАСОВ ТИКТОКА
T2x2 СМОТРИТ: Minecraft Live - Обновление 26.4 | Ледяное Обновление и Новое измерение Сифт
T2x2 СТРИМ В ГАРАЖЕ`;
  const acCfg = () => ({ intro: db.setting('autocut.intro', null), style: db.setting('autocut.style', DEFAULT_STYLE), streamer: db.setting('autocut.streamer', 'T2x2'), minPart: db.setting('autocut.minPart', 8), lang: db.setting('autocut.lang', 'ru') });
  r.get('/api/admin/autocut', (req) => {
    app.need(req, 'mod');
    const items = db.all("SELECT j.id, j.video_id, j.status, j.progress, j.info, j.error, j.opts, j.created_at, j.updated_at, v.title FROM jobs j LEFT JOIN videos v ON v.id = j.video_id WHERE json_extract(COALESCE(j.opts, '{}'), '$.url') IS NOT NULL ORDER BY j.id DESC LIMIT 30")
      .map((j) => { const o = JSON.parse(j.opts || '{}'); return { ...j, opts: undefined, url: o.url, info: j.info ? JSON.parse(j.info) : null, parts: (o.autocut?.partIds || []).map((id) => db.get('SELECT id, title, status, duration FROM videos WHERE id = ?', id)).filter(Boolean) }; });
    return { cfg: acCfg(), items };
  });
  r.post('/api/admin/autocut/config', async (req) => {
    const me = app.need(req, 'admin'); const b = await readJson(req, 64 * 1024);
    if (b.style !== undefined) db.setSetting('autocut.style', String(b.style).slice(0, 20000));
    if (b.streamer !== undefined) db.setSetting('autocut.streamer', String(b.streamer).trim().slice(0, 60));
    if (b.minPart !== undefined) db.setSetting('autocut.minPart', Math.min(120, Math.max(1, Number(b.minPart) || 8)));
    if (b.lang !== undefined) db.setSetting('autocut.lang', String(b.lang).slice(0, 8));
    db.audit(me.id, 'autocut.config'); return acCfg();
  });
  r.post('/api/admin/autocut', async (req) => {
    const u = app.need(req, 'admin'); const b = await readJson(req, 64 * 1024);
    const url = String(b.url || '').trim();
    if (!/^https?:\/\/[^\s]{4,2000}$/i.test(url)) fail(400, 'Нужна ссылка на стрим/VOD (https://…)');
    const c = acCfg();
    const keepFull = b.keepFull !== false, vis = b.visibility === 'hidden' ? 'hidden' : 'public';
    const v = app.createVideo({ title: b.title || 'Стрим (скачивается…)', stream_date: b.stream_date || undefined, tags: b.tags, description: b.description, status: 'queued', visibility: keepFull ? vis : 'hidden' });
    const opts = { profile: b.profile || db.setting('enc.profile', 'av1'), url, autocut: {
      keepFull, visibility: vis, autoTitle: !String(b.title || '').trim(), autoDate: !b.stream_date, streamer: String(b.streamer || c.streamer || '').slice(0, 60),
      lang: String(b.lang || c.lang || 'ru').slice(0, 8), intro: b.intro !== false && c.intro ? c.intro : null, style: c.style, minPart: Number(b.minPart) || c.minPart, cut: b.cut !== false, partIds: [] } };
    const now = Date.now();
    db.run("INSERT INTO jobs(video_id, status, raw_parts, raw_size, raw_name, opts, created_at, updated_at) VALUES(?, 'queued', 0, 0, ?, ?, ?, ?)", v.id, url.slice(0, 200), JSON.stringify(opts), now, now);
    db.audit(u.id, 'autocut.add', v.id, { url }); app.bump();
    return { ok: true, videoId: v.id };
  });
  // вступление: один файл в Blomp (sys/intro/…), ферма сама перекодирует его под каждый стрим
  r.put('/api/admin/autocut/intro', async (req) => {
    const u = app.need(req, 'admin');
    const len = Number(req.headers['content-length']); if (!(len > 1000) || len > 300 * 1048576) fail(400, 'Вступление: файл до 300 МБ');
    const name = String(req.query.get('name') || 'intro.mp4').slice(0, 120); const ext = (/\.(mp4|mov|mkv|webm)$/i.exec(name)?.[1] || 'mp4').toLowerCase();
    const key = `sys/intro/intro_${rid(6)}.${ext}`;
    const res = await swift.req('PUT', key, { headers: { 'Content-Length': len, 'Content-Type': 'application/octet-stream' }, body: req, timeout: 900000 });
    res.resume(); if (res.statusCode >= 300) fail(502, 'Blomp отклонил файл: ' + res.statusCode);
    const old = db.setting('autocut.intro', null);
    db.setSetting('autocut.intro', { key, size: len, name, at: Date.now() });
    if (old?.key) swift.del(old.key).catch(() => {});
    db.audit(u.id, 'autocut.intro', key); return acCfg();
  });
  r.del('/api/admin/autocut/intro', (req) => { const u = app.need(req, 'admin'); const old = db.setting('autocut.intro', null); if (old?.key) swift.del(old.key).catch(() => {}); db.setSetting('autocut.intro', null); db.audit(u.id, 'autocut.intro.del'); return acCfg(); });

  // ---------- users ----------
  r.get('/api/admin/users', (req) => {
    app.need(req, 'mod');
    const q = String(req.query.get('q') || '').trim(), f = req.query.get('filter') || '';
    const where = ['1=1'], args = [];
    if (q) { where.push('(nick LIKE ? OR tg_username LIKE ? OR CAST(tg_id AS TEXT) = ? OR CAST(id AS TEXT) = ? OR last_ip = ?)'); args.push('%' + q + '%', '%' + q.replace(/^@/, '') + '%', q, q, q); }
    if (f === 'banned') { where.push('(ban_until = -1 OR ban_until > ?)'); args.push(Date.now()); }
    if (f === 'staff') where.push("role IN ('admin','mod')");
    if (f === 'notify') where.push('notify = 1');
    const page = Math.max(0, Number(req.query.get('page')) || 0);
    const total = db.get(`SELECT COUNT(*) n FROM users WHERE ${where.join(' AND ')}`, ...args).n;
    const items = db.all(`SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) sessions, (SELECT COUNT(*) FROM progress p WHERE p.user_id = u.id) watched FROM users u WHERE ${where.join(' AND ')} ORDER BY u.last_seen DESC LIMIT 50 OFFSET ?`, ...args, page * 50)
      .map((u) => ({ ...app.publicUser(u), tg_id: u.tg_id, tg_name: u.tg_name, last_seen: u.last_seen, last_ip: u.last_ip, sessions: u.sessions, watched: u.watched }));
    return { total, items };
  });
  r.get('/api/admin/users/:id', (req) => {
    app.need(req, 'mod');
    const u = db.get('SELECT * FROM users WHERE id = ?', Number(req.params.id)); if (!u) fail(404, 'Нет юзера');
    return { user: { ...app.publicUser(u), tg_id: u.tg_id, tg_name: u.tg_name, last_ip: u.last_ip, last_seen: u.last_seen },
      sessions: db.all('SELECT created_at, seen_at, ua, ip FROM sessions WHERE user_id = ? ORDER BY seen_at DESC', u.id).map((s) => ({ ...s, ua: parseUA(s.ua) })),
      history: db.all('SELECT p.video_id, p.pos, p.updated_at, v.title FROM progress p LEFT JOIN videos v ON v.id = p.video_id WHERE p.user_id = ? ORDER BY p.updated_at DESC LIMIT 20', u.id),
      audit: db.all("SELECT * FROM audit WHERE target = ? AND action LIKE 'user.%' ORDER BY id DESC LIMIT 30", String(u.id)) };
  });
  r.post('/api/admin/users/:id/:action', async (req) => {
    const me = app.need(req, 'mod'); const b = await readJson(req);
    const u = db.get('SELECT * FROM users WHERE id = ?', Number(req.params.id)); if (!u) fail(404, 'Нет юзера');
    const a = req.params.action;
    if (u.id === me.id && a !== 'kick') fail(400, 'Нельзя применить к себе');
    if (u.role === 'admin' && me.role !== 'admin') fail(403, 'Нельзя трогать администратора');
    switch (a) {
      case 'ban': {
        const mins = Number(b.minutes); const until = mins > 0 ? Date.now() + mins * 60000 : -1;
        db.run('UPDATE users SET ban_until = ?, ban_reason = ? WHERE id = ?', until, String(b.reason || '').slice(0, 300), u.id);
        swarm.revoke(u.id);
        if (u.tg_id && b.notify !== false) app.notifyBot({ chats: [u.tg_id], text: `⛔ Доступ к архиву ограничен ${until === -1 ? 'навсегда' : 'до ' + new Date(until).toLocaleString('ru-RU', { timeZone: 'UTC' }) + ' UTC'}.${b.reason ? '\nПричина: ' + app.esc(b.reason) : ''}` });
        break;
      }
      case 'unban': db.run('UPDATE users SET ban_until = 0, ban_reason = NULL WHERE id = ?', u.id); swarm.revoked.delete(u.id); break;
      case 'role': if (me.role !== 'admin') fail(403, 'Только админ'); if (!['user', 'mod', 'admin'].includes(b.role)) fail(400, 'role'); db.run('UPDATE users SET role = ? WHERE id = ?', b.role, u.id); break;
      case 'reset-nick': db.run('UPDATE users SET nick = ?, nick_at = 0 WHERE id = ?', app.uniqueNick('viewer'), u.id); break;
      case 'reset-avatar': if (u.avatar) swift.del('a/' + u.avatar).catch(() => {}); db.run('UPDATE users SET avatar = NULL WHERE id = ?', u.id); break;
      case 'set-nick': { const n = app.cleanNick(b.nick); if (n.length < 3) fail(400, 'Короткий ник'); if (db.get('SELECT 1 FROM users WHERE nick = ? AND id != ?', n, u.id)) fail(409, 'Занят'); db.run('UPDATE users SET nick = ? WHERE id = ?', n, u.id); break; }
      case 'kick': app.dropSessions(u.id); swarm.revoke(u.id); break;
      case 'message': if (!u.tg_id) fail(400, 'Нет Telegram'); if (!(await app.notifyBot({ chats: [u.tg_id], text: '✉️ Сообщение от администрации:\n\n' + app.esc(String(b.text || '').slice(0, 2000)) }))) fail(502, 'Бот недоступен'); break;
      case 'delete': if (me.role !== 'admin') fail(403, 'Только админ'); if (u.avatar) swift.del('a/' + u.avatar).catch(() => {}); db.tx(() => { for (const t of ['favorites', 'progress', 'sessions']) db.run(`DELETE FROM ${t} WHERE user_id = ?`, u.id); db.run('DELETE FROM users WHERE id = ?', u.id); }); swarm.revoke(u.id); break;
      default: fail(400, 'action');
    }
    db.audit(me.id, 'user.' + a, u.id, b);
    return { ok: true };
  });
  r.post('/api/admin/broadcast', async (req) => {
    const me = app.need(req, 'admin'); const b = await readJson(req);
    const text = String(b.text || '').trim().slice(0, 3000); if (!text) fail(400, 'Пустой текст');
    const chats = db.all(`SELECT tg_id FROM users WHERE tg_id IS NOT NULL AND (ban_until = 0 OR (ban_until > 0 AND ban_until < ?)) ${b.all ? '' : 'AND notify = 1'}`, Date.now()).map((x) => x.tg_id);
    const ok = await app.notifyBot({ chats, text: app.esc(text), url: b.url || undefined, button: b.url ? 'Открыть' : undefined });
    db.audit(me.id, 'broadcast', null, { n: chats.length });
    if (!ok) fail(502, 'Бот недоступен');
    return { sent: chats.length };
  });

  // ---------- swarm ----------
  r.get('/api/admin/swarm', (req) => {
    app.need(req, 'mod');
    const s = swarm.snapshot();
    s.origin = app.originStats || null;
    return s;
  });
  r.post('/api/admin/swarm/settings', async (req) => {
    const me = app.need(req, 'admin'); const b = await readJson(req);
    const num = { warmMin: [0, 50], idleSleepMin: [5, 1440], defaultCap: [1, 2000], nodeMbps: [10, 10000], budgetGB: [0, 100000], edgeCacheMB: [16, 400], scaleAt: [0.2, 0.95] };
    for (const [k, [lo, hi]] of Object.entries(num)) if (b[k] !== undefined) db.setSetting('swarm.' + k, Math.min(hi, Math.max(lo, Number(b[k]))));
    for (const k of ['keepAllWarm', 'autoApprove', 'mainFallback']) if (b[k] !== undefined) db.setSetting('swarm.' + k, !!b[k]);
    db.audit(me.id, 'swarm.settings', null, b);
    return swarm.settings();
  });
  r.post('/api/admin/swarm/nodes', async (req) => {
    const me = app.need(req, 'admin'); const b = await readJson(req);
    const url = String(b.url || '').replace(/\/$/, ''); if (!/^https?:\/\/[^/]+$/.test(url)) fail(400, 'URL вида https://name.onrender.com');
    const id = String(b.id || new URL(url).host.split('.')[0]).replace(/[^\w.-]/g, '').slice(0, 40);
    if (swarm.nodes.has(id)) fail(409, 'Узел уже есть');
    const row = { id, url, region: String(b.region || 'frankfurt').toLowerCase(), enabled: 1, capacity: Number(b.capacity) || 0, render_key: b.render_key || null, render_service: b.render_service || null, note: b.note || null, month: new Date().toISOString().slice(0, 7), month_bytes: 0, created_at: Date.now() };
    db.run('INSERT INTO nodes(id,url,region,enabled,capacity,render_key,render_service,note,month,month_bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', ...Object.values(row));
    const n = swarm.mk(row); swarm.nodes.set(id, n); swarm.ping(n);
    db.audit(me.id, 'node.add', id);
    return { ok: true, id };
  });
  r.patch('/api/admin/swarm/nodes/:id', async (req) => {
    const me = app.need(req, 'admin'); const b = await readJson(req);
    const n = swarm.nodes.get(req.params.id); if (!n) fail(404, 'Нет узла');
    for (const k of ['region', 'note', 'render_key', 'render_service']) if (b[k] !== undefined) n[k] = b[k] === '' ? null : String(b[k]).slice(0, 200);
    if (b.capacity !== undefined) n.capacity = Math.max(0, Number(b.capacity) || 0);
    if (b.resetTraffic) { n.month_bytes = 0; n.overBudget = false; n.cmds.push({ t: 'undrain' }); }
    db.run('UPDATE nodes SET region=?, note=?, render_key=?, render_service=?, capacity=?, month_bytes=? WHERE id=?', n.region, n.note, n.render_key, n.render_service, n.capacity, n.month_bytes, n.id);
    db.audit(me.id, 'node.edit', n.id, { ...b, render_key: b.render_key ? '***' : undefined });
    return { ok: true };
  });
  r.post('/api/admin/swarm/nodes/:id/:action', async (req) => {
    const me = app.need(req, req.params.action === 'ping' || req.params.action === 'diag' ? 'mod' : 'admin');
    const n = swarm.nodes.get(req.params.id); if (!n) fail(404, 'Нет узла');
    const a = req.params.action; let out = { ok: true };
    switch (a) {
      case 'enable': n.enabled = true; n.manualDrain = false; db.run('UPDATE nodes SET enabled = 1 WHERE id = ?', n.id); n.cmds.push({ t: 'undrain' }, { t: 'wake' }); swarm.wake(n); break;
      case 'disable': n.enabled = false; db.run('UPDATE nodes SET enabled = 0 WHERE id = ?', n.id); n.cmds.push({ t: 'drain' }, { t: 'sleep' }); break;
      case 'drain': n.manualDrain = true; n.cmds.push({ t: 'drain' }); break;
      case 'undrain': n.manualDrain = false; n.cmds.push({ t: 'undrain' }); break;
      case 'flush': n.cmds.push({ t: 'flush' }); break;
      case 'restart': n.cmds.push({ t: 'drain' }, { t: 'restart' }); break;
      case 'wake': swarm.wake(n); break;
      case 'sleep': n.sleepWanted = true; n.cmds.push({ t: 'sleep' }); break;
      case 'suspend': await swarm.renderApi(n, 'suspend'); n.enabled = false; db.run('UPDATE nodes SET enabled = 0 WHERE id = ?', n.id); break;
      case 'resume': await swarm.renderApi(n, 'resume'); n.enabled = true; db.run('UPDATE nodes SET enabled = 1 WHERE id = ?', n.id); break;
      case 'render-restart': await swarm.renderApi(n, 'restart'); break;
      case 'remove': swarm.nodes.delete(n.id); db.run('DELETE FROM nodes WHERE id = ?', n.id); break;
      case 'ping': { const t0 = Date.now(); const j = await swarm.ping(n); out = { ok: !!j, rtt: Date.now() - t0, reply: j }; break; }
      case 'diag': {
        const t0 = Date.now();
        try { const res = await fetch(n.url + '/diag', { headers: { Authorization: 'Bearer ' + cfg.swarmSecret }, signal: AbortSignal.timeout(30000) }); out = { ok: res.ok, rtt: Date.now() - t0, diag: res.ok ? await res.json() : await res.text() }; }
        catch (e) { out = { ok: false, error: e.message, rtt: Date.now() - t0 }; }
        break;
      }
      default: fail(400, 'action');
    }
    if (a !== 'ping' && a !== 'diag') db.audit(me.id, 'node.' + a, n.id);
    return out;
  });

  // ---------- settings / audit / system ----------
  const SITE_KEYS = { 'site.title': 's', 'site.tagline': 's', 'site.announce': 's', 'site.maintenance': 's', 'site.guestWatch': 'b', 'site.registration': 'b', 'site.notifyNew': 'b', 'site.keepRaw': 'b', 'site.nickCooldownH': 'n', 'enc.profile': 's', 'site.bannedWords': 'a' };
  r.get('/api/admin/settings', (req) => { app.need(req, 'admin'); const o = {}; for (const k of Object.keys(SITE_KEYS)) o[k] = db.setting(k, null); return o; });
  r.post('/api/admin/settings', async (req) => {
    const me = app.need(req, 'admin'); const b = await readJson(req);
    for (const [k, t] of Object.entries(SITE_KEYS)) if (b[k] !== undefined) db.setSetting(k, t === 'b' ? !!b[k] : t === 'n' ? Number(b[k]) || 0 : t === 'a' ? (Array.isArray(b[k]) ? b[k] : String(b[k]).split(',')).map((s) => String(s).trim()).filter(Boolean) : String(b[k]).slice(0, 500));
    db.audit(me.id, 'settings', null, Object.keys(b)); app.bump();
    return { ok: true };
  });
  r.get('/api/admin/audit', (req) => {
    app.need(req, 'mod');
    const before = Number(req.query.get('before')) || 1e15;
    return { items: db.all('SELECT a.*, u.nick FROM audit a LEFT JOIN users u ON u.id = a.actor WHERE a.id < ? ORDER BY a.id DESC LIMIT 100', before) };
  });
  r.post('/api/admin/backup', async (req) => { const me = app.need(req, 'admin'); await app.backup.run(db, 'manual'); db.audit(me.id, 'backup'); return { last: app.backup.last, size: app.backup.lastSize, err: app.backup.lastErr }; });
};
