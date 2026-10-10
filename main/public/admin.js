// V_N sys.admin dashboard (loaded only for staff)
(() => {
'use strict';
let C, timer;
const $ = (s, r = document) => r.querySelector(s);
const B = (n) => { n = Number(n) || 0; const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return (i ? n.toFixed(n < 10 ? 2 : 1) : n) + ' ' + u[i]; };
const bps = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + ' Гбит/с' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + ' Мбит/с' : Math.round(n / 1e3) + ' кбит/с');
const ago = (t) => { if (!t) return '—'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + ' с' : s < 3600 ? Math.round(s / 60) + ' мин' : s < 86400 ? Math.round(s / 3600) + ' ч' : Math.round(s / 86400) + ' д'; };
const upt = (s) => (s > 86400 ? Math.floor(s / 86400) + 'д ' : '') + Math.floor((s % 86400) / 3600) + 'ч ' + Math.floor((s % 3600) / 60) + 'м';
const pct = (x) => Math.round((x || 0) * 100) + '%';
const bar = (x, w = 80) => `<div class="bar ${x > 0.85 ? 'e' : x > 0.6 ? 'w' : ''}" style="width:${w}px"><i style="width:${Math.min(100, (x || 0) * 100)}%"></i></div>`;
function spark(pts, w = 110, hgt = 28) {
  if (!pts || pts.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${hgt}"></svg>`;
  const mx = Math.max(1e-9, ...pts); const step = w / (pts.length - 1);
  const p = pts.map((v, i) => `${(i * step).toFixed(1)},${(hgt - 2 - (v / mx) * (hgt - 4)).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none"><path class="a" d="M0,${hgt} L${p.join(' L')} L${w},${hgt}Z"/><path d="M${p.join(' L')}"/></svg>`;
}
const TABS = [['overview', 'Обзор', '◎'], ['videos', 'Видео', '▶'], ['upload', 'Загрузка', '↑'], ['autocut', 'Авто-нарезка', '✂'], ['users', 'Пользователи', '◉'], ['servers', 'Серверы · рой', '◆'], ['jobs', 'Кодировщик', '⚙'], ['settings', 'Настройки', '≡'], ['audit', 'Журнал', '≡']];
const STATE_RU = { online: 'в сети', idle: 'простой', dozing: 'дремлет', sleeping: 'спит', waking: 'просыпается', draining: 'слив', budget: 'лимит трафика', offline: 'нет связи', disabled: 'выключен', unknown: 'неизвестно' };

function render(view, tab, ctx) {
  C = ctx; clearInterval(timer);
  const staffOnly = C.S.me.role !== 'admin';
  view.innerHTML = `<div class="adm"><nav class="adm-nav"><div class="lbl">sys.admin</div>${TABS.filter(([k]) => !(staffOnly && ['upload', 'autocut', 'settings'].includes(k))).map(([k, l, i]) => `<a href="/admin/${k}" class="${k === tab ? 'on' : ''}"><span class="mono">${i}</span>${l}</a>`).join('')}</nav><div id="ac"></div></div>`;
  const el = $('#ac');
  const fn = { overview, videos, upload, autocut, users, servers, jobs, settings, audit }[tab] || overview;
  return fn(el).catch((e) => { el.innerHTML = `<div class="empty err">${C.h(e.message)}</div>`; });
}
const live = (el, fn, ms) => { timer = setInterval(() => { if (!el.isConnected) return clearInterval(timer); fn().catch(() => {}); }, ms); };
function popMenu(btn, items) {
  document.querySelectorAll('.menu-pop').forEach((m) => m.remove());
  const m = document.createElement('div'); m.className = 'menu-pop';
  m.innerHTML = items.map((it) => (it === '-' ? '<hr>' : `<button class="${it.d ? 'd' : ''}">${it.l}</button>`)).join('');
  document.body.append(m);
  const r = btn.getBoundingClientRect(); m.style.top = scrollY + r.bottom + 6 + 'px'; m.style.left = Math.max(8, Math.min(innerWidth - 220, r.right - 210)) + 'px';
  const real = items.filter((x) => x !== '-');
  m.querySelectorAll('button').forEach((b, i) => (b.onclick = () => { m.remove(); real[i].f(); }));
  setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', off); } }), 0);
}
const run = async (p, body, msg) => { try { const r = await C.api(p, { method: 'POST', body: body || {} }); if (msg) C.toast(msg, 'o'); return r; } catch (e) { C.toast(e.message, 'e'); throw e; } };

// ---------- overview ----------
async function overview(el) {
  const draw = async () => {
    const o = await C.api('/api/admin/overview');
    const vs = Object.fromEntries(o.videos.map((x) => [x.status, x]));
    const ready = vs.ready || { n: 0, dur: 0, size: 0 };
    const jobs = Object.fromEntries(o.jobs.map((x) => [x.status, x.n]));
    const hist = o.swarm.hist;
    el.innerHTML = `<h1>Обзор <span class="sp"></span><span class="mono mu" style="font-size:13px">обновляется каждые 5 с</span></h1>
      <div class="kpis">
        <div class="kpi"><span>Смотрят сейчас</span><b class="ac">${o.live.viewers}</b><small>${bps(o.live.bps)} отдаётся</small></div>
        <div class="kpi"><span>Узлы роя</span><b>${(o.swarm.states.online || 0) + (o.swarm.states.idle || 0) + (o.swarm.states.dozing || 0)}<small> / ${o.swarm.total}</small></b><small>${Object.entries(o.swarm.states).map(([k, n]) => (STATE_RU[k] || k) + ' ' + n).join(' · ') || 'нет узлов'}</small></div>
        <div class="kpi"><span>Записи</span><b>${ready.n}</b><small>${Math.round(ready.dur / 3600)} ч · ${B(ready.size)}</small></div>
        <div class="kpi"><span>Пользователи</span><b>${o.users.n}</b><small>${o.users.active24 || 0} за 24 ч · ${o.users.banned || 0} в бане</small></div>
        <div class="kpi"><span>Просмотры</span><b>${o.views}</b><small>всего</small></div>
        <div class="kpi"><span>Хранилище Blomp</span><b>${o.storage ? B(o.storage.bytes) : '…'}</b><small>${o.storage ? 'из ' + B(o.storage.quota) + ' · ' + o.storage.objects + ' объектов' : 'считаю…'}</small>${o.storage ? bar(o.storage.bytes / o.storage.quota, 150) : ''}</div>
        <div class="kpi"><span>Кодировщик</span><b>${jobs.encoding || 0}<small> в работе</small></b><small>${jobs.queued || 0} в очереди · ${jobs.error || 0} ошибок · ${o.encoders.filter((e) => e.online).length} онлайн</small></div>
        <div class="kpi"><span>Главный сервер</span><b>${pct(o.main.cpu)}<small> CPU</small></b><small>RAM ${B(o.main.rss)} · lag ${o.main.lag} мс · up ${upt(o.main.up)}</small></div>
      </div>
      <div class="cols2"><div class="panel"><div class="field"><span>Зрители · последние 2 часа</span></div>${spark(hist.map((x) => x.v), 600, 120).replace('class="spark"', 'class="spark" style="width:100%;height:120px"')}</div>
        <div class="panel"><div class="field"><span>Трафик роя · последние 2 часа</span></div>${spark(hist.map((x) => x.b), 600, 120).replace('class="spark"', 'class="spark" style="width:100%;height:120px"')}</div></div>
      <div class="cols2" style="margin-top:18px"><div class="panel"><div class="field"><span>Резервная копия БД → Blomp</span></div>
          <p style="margin:0 0 12px">Последняя: <b>${o.backup.last ? ago(o.backup.last) + ' назад' : 'не было'}</b> · ${B(o.backup.size)} ${o.backup.dirty ? '<span class="warn">· есть несохранённые изменения</span>' : ''}${o.backup.err ? `<br><span class="err">${C.h(o.backup.err)}</span>` : ''}</p>
          <p class="hint">Токен Blomp до ${new Date(o.blompTokenExp).toLocaleTimeString('ru-RU')} (обновляется сам)</p>${C.S.me.role === 'admin' ? '<button class="btn sm" id="bk">Сделать копию сейчас</button>' : ''}</div>
        <div class="panel"><div class="field"><span>Топ записей</span></div>${o.top.map((v) => `<div class="sess"><a href="/v/${v.id}">${C.h(v.title)}</a><span class="mono">${v.views}</span></div>`).join('') || '<span class="mu">пусто</span>'}</div></div>`;
    $('#bk', el)?.addEventListener('click', () => run('/api/admin/backup', {}, 'Копия сохранена').then(draw));
  };
  await draw(); live(el, draw, 5000);
}

// ---------- videos ----------
async function videos(el) {
  const P = new URLSearchParams(location.search);
  el.innerHTML = `<h1>Видео <span class="sp"></span><a class="btn pri" href="/admin/upload">↑ Загрузить</a></h1>
    <div class="toolbar"><input class="inp" id="vq" placeholder="Поиск по названию, тегу, id"><select class="fsel" id="vs"><option value="">Все статусы</option><option value="ready">Готово</option><option value="encoding">Кодируется</option><option value="queued">В очереди</option><option value="uploading">Загружается</option><option value="error">Ошибка</option></select></div>
    <div class="tw"><table class="tbl"><thead><tr><th></th><th>Название</th><th>Статус</th><th>Дата</th><th class="num">Длина</th><th class="num">Просм.</th><th class="num">Размер</th><th></th></tr></thead><tbody id="vt"></tbody></table></div>`;
  let items = [];
  const load = async () => {
    const r = await C.api(`/api/admin/videos?q=${encodeURIComponent($('#vq').value)}&status=${$('#vs').value}`);
    items = r.items;
    $('#vt').innerHTML = items.map((v) => `<tr data-id="${v.id}"><td>${v.cover ? `<img class="vthumb" src="${C.h(v.cover)}" loading="lazy">` : '<div class="vthumb"></div>'}</td>
      <td><a href="/v/${v.id}"><b>${C.h(v.title)}</b></a><div class="mono mu" style="font-size:12px">${v.id} · ${v.tags.map((t) => '#' + C.h(t)).join(' ')}${v.visibility === 'hidden' ? ' · <span class="warn">скрыто</span>' : ''}${v.pinned ? ' · <span class="ac">закреплено</span>' : ''}</div></td>
      <td><span class="pill ${v.status}">${v.status}${v.job && v.status === 'encoding' ? ' ' + pct(v.job.progress) : ''}</span>${v.job?.error ? `<div class="err" style="font-size:12px;max-width:220px">${C.h(v.job.error.slice(0, 120))}</div>` : ''}</td>
      <td class="mono">${v.stream_date || ''}</td><td class="num">${C.fmt(v.duration)}</td><td class="num">${v.views}</td><td class="num">${B(v.size_bytes)}</td>
      <td><button class="btn sm" data-m>⋯</button></td></tr>`).join('') || '<tr><td colspan="8" class="mu" style="text-align:center;padding:40px">Пусто</td></tr>';
    $('#vt').querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => { const v = items.find((x) => x.id === b.closest('tr').dataset.id); vmenu(b, v); }));
  };
  const vmenu = (b, v) => popMenu(b, [
    { l: '✎ Редактировать', f: () => editVideo(v, load) },
    { l: '🖼 Сменить обложку', f: () => pickCover(v, load) },
    { l: v.visibility === 'hidden' ? '👁 Показать в каталоге' : '🙈 Скрыть из каталога', f: () => C.api('/api/admin/videos/' + v.id, { method: 'PATCH', body: { visibility: v.visibility === 'hidden' ? 'public' : 'hidden' } }).then(load) },
    { l: v.pinned ? '☆ Открепить' : '★ Закрепить наверху', f: () => C.api('/api/admin/videos/' + v.id, { method: 'PATCH', body: { pinned: !v.pinned } }).then(load) },
    { l: '📣 Разослать в Telegram', f: () => run(`/api/admin/videos/${v.id}/announce`, {}, 'Рассылка запущена') },
    '-',
    { l: '🗑 Удалить навсегда', d: true, f: async () => { if (await C.confirmDlg(`Удалить «${C.h(v.title)}» и все файлы в Blomp? Это необратимо.`, 'Удалить', true)) { await C.api('/api/admin/videos/' + v.id, { method: 'DELETE' }); C.toast('Удалено'); load(); } } },
  ]);
  let t; $('#vq').oninput = () => { clearTimeout(t); t = setTimeout(load, 250); }; $('#vs').onchange = load;
  await load();
  if (P.get('edit')) { const v = items.find((x) => x.id === P.get('edit')); if (v) editVideo(v, load); }
  live(el, () => (items.some((v) => ['encoding', 'queued'].includes(v.status)) && !$('#modal').innerHTML ? load() : Promise.resolve()), 6000);
}
const chapToText = (ch) => ch.map((c) => `${C.fmt(c.t)} ${c.title}`).join('\n');
const textToChap = (s) => s.split('\n').map((l) => /^\s*((?:\d+:)?\d{1,2}:\d{2})\s+[-–—]?\s*(.+)$/.exec(l)).filter(Boolean).map((m) => ({ t: m[1].split(':').reduce((a, x) => a * 60 + +x, 0), title: m[2].trim() }));
function editVideo(v, done) {
  C.modal({ wide: true, html: `<h2>Редактирование</h2><p class="mono mu" style="font-size:12px">${v.id}</p>
    <label class="field"><span>Название</span><input class="inp" id="et" value="${C.h(v.title)}" maxlength="200"></label>
    <div class="cols3"><label class="field"><span>Дата стрима</span><input class="inp" type="date" id="ed" value="${v.stream_date || ''}"></label>
      <label class="field"><span>Видимость</span><select class="inp" id="evis"><option value="public">В каталоге</option><option value="hidden">Только по ссылке</option></select></label>
      <label class="field"><span>Закрепить</span><select class="inp" id="epin"><option value="0">Нет</option><option value="1">Да</option></select></label></div>
    <label class="field"><span>Теги (через запятую)</span><input class="inp" id="etg" value="${C.h(v.tags.join(', '))}"></label>
    <label class="field"><span>Описание</span><textarea class="inp" id="eds" maxlength="5000">${C.h(v.description)}</textarea></label>
    <label class="field"><span>Главы — по строке: «1:02:03 Название»</span><textarea class="inp mono" id="ech" style="min-height:140px;font-size:13px" placeholder="0:00 Начало&#10;12:30 Катка 1&#10;1:45:00 Босс">${C.h(chapToText(v.chapters))}</textarea></label>
    <div class="dlg-f"><button class="btn" data-close>Отмена</button><button class="btn pri" id="es">Сохранить</button></div>` }, (d, close) => {
    $('#evis', d).value = v.visibility; $('#epin', d).value = v.pinned ? '1' : '0';
    $('#es', d).onclick = async () => {
      try { await C.api('/api/admin/videos/' + v.id, { method: 'PATCH', body: { title: $('#et', d).value, stream_date: $('#ed', d).value, visibility: $('#evis', d).value, pinned: $('#epin', d).value === '1', tags: $('#etg', d).value, description: $('#eds', d).value, chapters: textToChap($('#ech', d).value) } }); close(); C.toast('Сохранено', 'o'); done(); }
      catch (e) { C.toast(e.message, 'e'); }
    };
  });
}
function pickCover(v, done) {
  const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*';
  i.onchange = async () => { try { const blob = await C.resizeImage(i.files[0], 1280, 720); await C.api(`/api/admin/videos/${v.id}/cover`, { method: 'POST', body: blob, raw: true }); C.toast('Обложка обновлена', 'o'); done(); } catch (e) { C.toast(e.message, 'e'); } };
  i.click();
}

// ---------- upload (chunked, resumable, parallel) ----------
const LSu = { get: () => { try { return JSON.parse(localStorage.getItem('vn_up') || '{}'); } catch { return {}; } }, set: (o) => localStorage.setItem('vn_up', JSON.stringify(o)) };
async function upload(el) {
  el.innerHTML = `<h1>Загрузка записи</h1>
    <div class="cols2"><div><div class="drop" id="drop"><b>Перетащи файл стрима сюда</b><span class="mu">или нажми, чтобы выбрать · MP4, MKV, FLV, MOV, TS · хоть 10 часов</span><input type="file" id="fi" accept="video/*,.mkv,.flv,.ts" hidden></div>
      <div id="fileinfo" class="hint" style="margin-top:10px"></div></div>
      <div class="panel"><label class="field"><span>Название</span><input class="inp" id="ut" maxlength="200" placeholder="Стрим: …"></label>
        <div class="cols2"><label class="field"><span>Дата стрима</span><input class="inp" type="date" id="ud" value="${new Date().toISOString().slice(0, 10)}"></label>
          <label class="field"><span>Профиль сжатия</span><select class="inp" id="up"><option value="av1">AV1 + H.264 480p (мин. размер)</option><option value="av1compat">AV1 + H.264 720p (совместимость)</option><option value="h264">Только H.264 (быстро)</option><option value="lite">Лайт: до 720p</option></select></label></div>
        <label class="field"><span>Теги</span><input class="inp" id="utg" placeholder="minecraft, ивент, коллаб"></label>
        <label class="field"><span>Описание</span><textarea class="inp" id="uds"></textarea></label>
        <label class="sw"><input type="checkbox" id="uh"> Скрыть из каталога (только по ссылке)</label>
        <button class="btn pri" id="ugo" style="width:100%;margin-top:16px;height:44px" disabled>Загрузить и поставить в очередь</button></div></div>
    <div id="uq" style="margin-top:24px"></div>
    <div class="panel" style="margin-top:24px"><div class="field"><span>Совет: большие файлы быстрее через CLI</span></div><p class="hint" style="margin:0 0 8px">Кодировщик на твоём ПК может взять файл с диска напрямую — без загрузки исходника в облако:</p>
      <div class="code-box">docker run --rm -v "$PWD:/in" -e MAIN_URL=${location.origin} -e ENCODER_TOKEN=… vn-encoder ingest /in/stream.mkv --title "Название" --date 2026-10-09 --tags a,b</div></div>`;
  let file = null;
  const fi = $('#fi', el), drop = $('#drop', el);
  const setFile = (f) => { file = f; $('#fileinfo').innerHTML = f ? `📼 <b>${C.h(f.name)}</b> · ${B(f.size)}${LSu.get()[fp(f)] ? ' · <span class="ac">найдена незавершённая загрузка — продолжу с места остановки</span>' : ''}` : ''; $('#ugo').disabled = !f; if (f && !$('#ut').value) $('#ut').value = f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' '); };
  drop.onclick = () => fi.click(); fi.onchange = () => setFile(fi.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); }; drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); setFile(e.dataTransfer.files[0]); };
  $('#ugo').onclick = () => { const meta = { title: $('#ut').value, stream_date: $('#ud').value, tags: $('#utg').value, description: $('#uds').value, visibility: $('#uh').checked ? 'hidden' : 'public' }; const prof = $('#up').value; const f = file; setFile(null); $('#ut').value = ''; doUpload(f, meta, prof, $('#uq')); };
}
const fp = (f) => `${f.name}|${f.size}|${f.lastModified}`;
async function doUpload(file, meta, profile, host) {
  const box = document.createElement('div'); box.className = 'panel'; box.style.marginBottom = '12px';
  box.innerHTML = `<div style="display:flex;justify-content:space-between;gap:12px"><b>${C.h(meta.title || file.name)}</b><span class="mono mu" data-s>подготовка…</span></div><div class="prog"><i style="width:0"></i></div><div class="mono mu" style="font-size:12px" data-d></div>`;
  host.prepend(box);
  const S = (t) => (box.querySelector('[data-s]').textContent = t);
  try {
    const saved = LSu.get(); let up = null;
    if (saved[fp(file)]) up = await C.api('/api/admin/uploads/' + saved[fp(file)]).catch(() => null);
    if (!up || up.done) { up = await C.api('/api/admin/uploads', { method: 'POST', body: { name: file.name, size: file.size, ...meta } }); saved[fp(file)] = up.id; LSu.set(saved); }
    const got = new Set(up.got); const todo = []; for (let n = 1; n <= up.parts; n++) if (!got.has(n)) todo.push(n);
    let done = got.size * up.partSize, t0 = Date.now(), base = done; const inflight = new Map();
    const paint = () => { const cur = done + [...inflight.values()].reduce((a, b) => a + b, 0); const sp = (cur - base) / Math.max(1, (Date.now() - t0) / 1000); box.querySelector('.prog i').style.width = (cur / file.size) * 100 + '%'; S(`${((cur / file.size) * 100).toFixed(1)}%`); box.querySelector('[data-d]').textContent = `${B(cur)} / ${B(file.size)} · ${B(sp)}/с · осталось ~${sp > 0 ? C.fmt((file.size - cur) / sp) : '…'} · части ${got.size}/${up.parts}`; };
    const put = (n) => new Promise((res, rej) => {
      const blob = file.slice((n - 1) * up.partSize, Math.min(n * up.partSize, file.size));
      const x = new XMLHttpRequest(); x.open('PUT', `/api/admin/uploads/${up.id}/${n}`); x.setRequestHeader('X-VN', '1');
      x.upload.onprogress = (e) => { inflight.set(n, e.loaded); paint(); };
      x.onload = () => { inflight.delete(n); if (x.status < 300) { done += blob.size; got.add(n); paint(); res(); } else rej(new Error(JSON.parse(x.responseText || '{}').error || 'HTTP ' + x.status)); };
      x.onerror = () => { inflight.delete(n); rej(new Error('сеть')); }; x.send(blob);
    });
    const worker = async () => { while (todo.length) { const n = todo.shift(); for (let a = 0; ; a++) { try { await put(n); break; } catch (e) { if (a >= 5) throw e; S('повтор части ' + n + '…'); await new Promise((r) => setTimeout(r, 1500 * (a + 1))); } } } };
    await Promise.all([worker(), worker(), worker()]);
    S('завершаю…');
    await C.api(`/api/admin/uploads/${up.id}/complete`, { method: 'POST', body: { profile } });
    const s2 = LSu.get(); delete s2[fp(file)]; LSu.set(s2);
    S('✓ в очереди кодировщика'); box.querySelector('.prog i').style.width = '100%';
    box.querySelector('[data-d]').innerHTML = `Готово. Видео <a class="ac" href="/admin/jobs">ждёт кодировщик</a> — он сожмёт его в AV1/H.264 и выложит в рой.`;
  } catch (e) { S('ошибка'); box.querySelector('[data-d]').innerHTML = `<span class="err">${C.h(e.message)}</span> — выбери тот же файл снова, загрузка продолжится.`; }
}

// ---------- авто-нарезка ----------
const STAGE_RU = { download: 'скачивание', encode: 'кодирование + расшифровка', asr: 'расшифровка', llm: 'нейросеть режет', parts: 'сборка частей', finish: 'публикация' };
async function autocut(el) {
  let r = await C.api('/api/admin/autocut');
  const c = r.cfg;
  el.innerHTML = `<h1>Авто-нарезка стрима</h1>
    <div class="cols2"><div class="panel">
      <label class="field"><span>Ссылка на стрим / VOD (Twitch, YouTube, VK, Kick… всё, что умеет yt-dlp)</span><input class="inp" id="acu" placeholder="https://www.twitch.tv/videos/…"></label>
      <div class="cols2"><label class="field"><span>Стример (как писать в названиях)</span><input class="inp" id="acs" value="${C.h(c.streamer || '')}"></label>
        <label class="field"><span>Язык речи</span><select class="inp" id="acl"><option value="ru">русский</option><option value="auto">определить сам</option><option value="uk">украинский</option><option value="en">английский</option></select></label></div>
      <div class="cols2"><label class="field"><span>Название полного стрима (пусто = придумает нейросеть)</span><input class="inp" id="act" maxlength="200"></label>
        <label class="field"><span>Дата (пусто = из источника)</span><input class="inp" type="date" id="acd"></label></div>
      <div class="cols2"><label class="field"><span>Теги для всех частей</span><input class="inp" id="actg" placeholder="нарезка, t2x2"></label>
        <label class="field"><span>Профиль сжатия</span><select class="inp" id="acp"><option value="av1">AV1 + H.264 480p</option><option value="av1compat">AV1 + H.264 720p</option><option value="h264">Только H.264</option><option value="lite">Лайт: до 720p</option></select></label></div>
      <label class="field"><span>Части короче, мин — склеивать с соседними</span><input class="inp" type="number" id="acm" value="${c.minPart || 8}" min="1" max="120"></label>
      <label class="sw"><input type="checkbox" id="aci" ${c.intro ? 'checked' : 'disabled'}> Вступление в начале каждой части ${c.intro ? '' : '<span class="mu">(сначала загрузи его справа)</span>'}</label>
      <label class="sw" style="margin-top:10px"><input type="checkbox" id="ack" checked> Оставить полный стрим на сайте (с главами и субтитрами)</label>
      <label class="sw" style="margin-top:10px"><input type="checkbox" id="acc" checked> Нарезать на части (выкл = только полный стрим + субтитры)</label>
      <label class="sw" style="margin-top:10px"><input type="checkbox" id="ach"> Скрыть из каталога (только по ссылке)</label>
      <button class="btn pri" id="acgo" style="width:100%;margin-top:16px;height:44px">✂ Скачать и нарезать</button></div>
    <div><div class="panel"><div class="field"><span>Вступление</span></div><div id="acin"></div>
        <input type="file" id="acif" accept="video/*" hidden><div style="display:flex;gap:8px;margin-top:10px"><button class="btn sm" id="acib">Загрузить файл…</button><button class="btn sm dan" id="acid" ${c.intro ? '' : 'disabled'}>Убрать</button></div>
        <p class="hint" style="margin:10px 0 0">MP4 (H.264/AAC), 16:9, 1920×1080 или 1280×720, 3–15 секунд, со звуком (если звука нет — подставлю тишину). Загружается один раз — под каждый стрим ферма сама перекодирует его в те же качества и fps.</p></div>
      <div class="panel" style="margin-top:18px"><div class="field"><span>Стиль названий — примеры для нейросети (по одному в строке)</span></div><textarea class="inp" id="acst" style="min-height:220px;font-size:12px">${C.h(c.style || '')}</textarea><button class="btn sm" id="acss" style="margin-top:10px">Сохранить стиль и стримера</button></div></div></div>
    <h2 style="margin-top:28px">Задачи</h2><div id="acj"></div>`;
  $('#acl', el).value = c.lang || 'ru';
  const intro = () => { $('#acin', el).innerHTML = c.intro ? `🎬 <b>${C.h(c.intro.name)}</b> · ${B(c.intro.size)} · ${new Date(c.intro.at).toLocaleDateString('ru-RU')}` : '<span class="mu">не загружено</span>'; };
  intro();
  $('#acib', el).onclick = () => $('#acif', el).click();
  $('#acif', el).onchange = () => {
    const f = $('#acif', el).files[0]; if (!f) return;
    const x = new XMLHttpRequest(); x.open('PUT', '/api/admin/autocut/intro?name=' + encodeURIComponent(f.name)); x.setRequestHeader('X-VN', '1');
    x.upload.onprogress = (e) => { $('#acin', el).textContent = 'загрузка ' + Math.round((e.loaded / e.total) * 100) + '%'; };
    x.onload = () => { if (x.status < 300) { Object.assign(c, JSON.parse(x.responseText)); C.toast('Вступление загружено', 'o'); autocut(el); } else C.toast(JSON.parse(x.responseText || '{}').error || 'Ошибка ' + x.status, 'e'); };
    x.onerror = () => C.toast('сеть', 'e'); x.send(f);
  };
  $('#acid', el).onclick = async () => { await C.api('/api/admin/autocut/intro', { method: 'DELETE' }); autocut(el); };
  $('#acss', el).onclick = () => run('/api/admin/autocut/config', { style: $('#acst', el).value, streamer: $('#acs', el).value, lang: $('#acl', el).value, minPart: +$('#acm', el).value }, 'Сохранено');
  $('#acgo', el).onclick = async () => {
    const b = { url: $('#acu', el).value, streamer: $('#acs', el).value, lang: $('#acl', el).value, title: $('#act', el).value, stream_date: $('#acd', el).value || undefined, tags: $('#actg', el).value, profile: $('#acp', el).value, minPart: +$('#acm', el).value,
      intro: $('#aci', el).checked, keepFull: $('#ack', el).checked, cut: $('#acc', el).checked, visibility: $('#ach', el).checked ? 'hidden' : 'public' };
    if (!b.cut && !b.keepFull) return C.toast('Нечего публиковать: включи нарезку или полный стрим', 'e');
    await run('/api/admin/autocut', b, 'В очереди — ферма скоро возьмёт'); $('#acu', el).value = ''; $('#act', el).value = ''; draw();
  };
  const draw = async () => {
    r = await C.api('/api/admin/autocut');
    $('#acj', el).innerHTML = r.items.map((j) => { const i = j.info || {}; return `<div class="panel" style="margin-bottom:12px"><div style="display:flex;gap:12px;justify-content:space-between;align-items:center">
        <div><a href="/admin/videos?edit=${j.video_id}"><b>${C.h(j.title || j.video_id)}</b></a><div class="mono mu" style="font-size:11px;word-break:break-all">${C.h(j.url || '')}</div></div>
        <div style="text-align:right"><span class="pill ${j.status}">${j.status}</span><div class="mono mu" style="font-size:11px">#${j.id} · ${ago(j.created_at)} назад</div></div></div>
      <div class="prog"><i style="width:${(j.progress || 0) * 100}%"></i></div>
      <div class="mono" style="font-size:12px">${j.status === 'encoding' ? `${STAGE_RU[i.stage] || C.h(i.stage || '')} ${i.detail ? '· ' + C.h(i.detail) : ''}` : j.error ? `<span class="${j.status === 'done' ? 'warn' : 'err'}">${C.h(j.error.slice(0, 300))}</span>` : ''}</div>
      ${j.parts.length ? `<div style="margin-top:8px">${j.parts.map((p) => `<div class="sess"><a href="/v/${p.id}">${C.h(p.title)}</a><span class="mono">${p.status === 'ready' ? C.fmt(p.duration) : p.status}</span></div>`).join('')}</div>` : ''}</div>`; }).join('') || '<div class="empty mu">Пока пусто</div>';
  };
  await draw(); live(el, draw, 8000);
}

// ---------- users ----------
async function users(el) {
  el.innerHTML = `<h1>Пользователи</h1><div class="toolbar"><input class="inp" id="uq" placeholder="Ник, @username, Telegram ID, IP"><select class="fsel" id="uf"><option value="">Все</option><option value="banned">Забаненные</option><option value="staff">Админы и модеры</option><option value="notify">С уведомлениями</option></select><span class="mono mu" id="ucount"></span></div>
    <div class="tw"><table class="tbl"><thead><tr><th>Пользователь</th><th>Роль</th><th>Статус</th><th>Был</th><th class="num">Смотрел</th><th class="num">Сессий</th><th>Создан</th><th></th></tr></thead><tbody id="ut"></tbody></table></div>`;
  let items = [];
  const load = async () => {
    const r = await C.api(`/api/admin/users?q=${encodeURIComponent($('#uq').value)}&filter=${$('#uf').value}`);
    items = r.items; $('#ucount').textContent = 'всего ' + r.total;
    $('#ut').innerHTML = items.map((u) => `<tr data-id="${u.id}"><td style="display:flex;gap:10px;align-items:center">${u.avatar ? `<img class="ava" src="${C.h(u.avatar)}">` : `<span class="ava">${C.h(u.nick[0].toUpperCase())}</span>`}<div><b>${C.h(u.nick)}</b><div class="mono mu" style="font-size:12px">${u.tg ? '@' + C.h(u.tg) : ''} · id ${u.tg_id || '—'}</div></div></td>
      <td><span class="mono">${u.role}</span></td><td>${u.banned ? `<span class="pill banned">бан ${u.banned.until === -1 ? '∞' : 'до ' + new Date(u.banned.until).toLocaleDateString('ru-RU')}</span>` : '<span class="pill online">ок</span>'}</td>
      <td class="mono">${ago(u.last_seen)}</td><td class="num">${u.watched}</td><td class="num">${u.sessions}</td><td class="mono">${new Date(u.created).toLocaleDateString('ru-RU')}</td><td><button class="btn sm" data-m>⋯</button></td></tr>`).join('') || '<tr><td colspan="8" class="mu" style="text-align:center;padding:40px">Никого</td></tr>';
    $('#ut').querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => umenu(b, items.find((x) => x.id === +b.closest('tr').dataset.id))));
  };
  const act = (u, a, body, msg) => run(`/api/admin/users/${u.id}/${a}`, body, msg).then(load);
  const umenu = (b, u) => popMenu(b, [
    { l: '🔎 Подробнее', f: () => udetail(u) },
    u.banned ? { l: '✅ Разбанить', f: () => act(u, 'unban', {}, 'Разбанен') } : { l: '⛔ Забанить…', f: () => banDlg(u, act) },
    { l: '✉️ Написать в Telegram', f: () => C.modal(`<h2>Сообщение для ${C.h(u.nick)}</h2><textarea class="inp" id="mt" placeholder="Текст"></textarea><div class="dlg-f"><button class="btn" data-close>Отмена</button><button class="btn pri" id="ms">Отправить</button></div>`, (d, close) => ($('#ms', d).onclick = () => act(u, 'message', { text: $('#mt', d).value }, 'Отправлено').then(close))) },
    { l: '✎ Задать ник…', f: () => { const n = prompt('Новый ник', u.nick); if (n) act(u, 'set-nick', { nick: n }, 'Ник изменён'); } },
    { l: '↺ Сбросить ник', f: () => act(u, 'reset-nick', {}, 'Сброшен') },
    { l: '🖼 Убрать аватарку', f: () => act(u, 'reset-avatar', {}, 'Аватарка удалена') },
    { l: '🚪 Выкинуть со всех устройств', f: () => act(u, 'kick', {}, 'Сессии завершены') },
    ...(C.S.me.role === 'admin' ? ['-', { l: 'Роль: user', f: () => act(u, 'role', { role: 'user' }) }, { l: 'Роль: mod', f: () => act(u, 'role', { role: 'mod' }) }, { l: 'Роль: admin', f: () => act(u, 'role', { role: 'admin' }) }, '-',
      { l: '🗑 Удалить аккаунт', d: true, f: async () => { if (await C.confirmDlg(`Удалить ${C.h(u.nick)} с историей и избранным?`, 'Удалить', true)) act(u, 'delete', {}, 'Удалён'); } }] : []),
  ]);
  let t; $('#uq').oninput = () => { clearTimeout(t); t = setTimeout(load, 250); }; $('#uf').onchange = load;
  await load();
}
function banDlg(u, act) {
  const D = [['60', '1 час'], ['1440', '1 день'], ['10080', '7 дней'], ['43200', '30 дней'], ['0', 'Навсегда']];
  C.modal(`<h2>Бан: ${C.h(u.nick)}</h2><div class="field"><span>Срок</span><div style="display:flex;gap:6px;flex-wrap:wrap" id="bd">${D.map(([v, l], i) => `<button class="chip ${i === 1 ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div></div>
    <label class="field"><span>Причина (увидит пользователь)</span><input class="inp" id="br" maxlength="300"></label><label class="sw"><input type="checkbox" id="bn" checked> Уведомить в Telegram</label>
    <div class="dlg-f"><button class="btn" data-close>Отмена</button><button class="btn dan" id="bgo">Забанить</button></div>`, (d, close) => {
    let mins = '1440'; d.querySelectorAll('#bd .chip').forEach((c) => (c.onclick = () => { d.querySelectorAll('#bd .chip').forEach((x) => x.classList.remove('on')); c.classList.add('on'); mins = c.dataset.v; }));
    $('#bgo', d).onclick = () => act(u, 'ban', { minutes: +mins, reason: $('#br', d).value, notify: $('#bn', d).checked }, 'Забанен').then(close);
  });
}
async function udetail(u) {
  const r = await C.api('/api/admin/users/' + u.id);
  C.modal({ wide: true, html: `<h2>${C.h(r.user.nick)}</h2><p class="mono mu" style="font-size:13px">uid ${r.user.id} · tg ${r.user.tg_id} ${r.user.tg ? '@' + C.h(r.user.tg) : ''} · ${C.h(r.user.tg_name || '')} · IP ${C.h(r.user.last_ip || '—')}</p>
    <div class="cols2"><div><div class="field"><span>Сессии</span></div>${r.sessions.map((s) => `<div class="sess"><span>${C.h(s.ua)} · ${C.h(s.ip || '')}</span><span class="mono">${ago(s.seen_at)}</span></div>`).join('') || '<span class="mu">нет</span>'}</div>
    <div><div class="field"><span>Последние просмотры</span></div>${r.history.map((x) => `<div class="sess"><a href="/v/${x.video_id}">${C.h(x.title || x.video_id)}</a><span class="mono">${C.fmt(x.pos)}</span></div>`).join('') || '<span class="mu">нет</span>'}</div></div>
    <div class="field" style="margin-top:16px"><span>История модерации</span></div>${r.audit.map((a) => `<div class="sess"><span class="mono">${a.action}</span><span class="mono mu">${new Date(a.at).toLocaleString('ru-RU')}</span></div>`).join('') || '<span class="mu">чисто</span>'}` });
}

// ---------- servers / swarm ----------
async function servers(el) {
  let snap;
  const draw = async () => {
    snap = await C.api('/api/admin/swarm');
    const S = snap.settings, nodes = snap.nodes;
    const regions = [...new Set(nodes.map((n) => n.region))];
    const liveN = nodes.filter((n) => ['online', 'idle', 'dozing'].includes(n.state));
    const totV = liveN.reduce((a, n) => a + (n.st?.viewers || 0), 0), totB = liveN.reduce((a, n) => a + (n.st?.bps || 0), 0);
    const monthT = nodes.reduce((a, n) => a + n.monthBytes, 0);
    const o = snap.origin;
    $('#sw-k', el).innerHTML = `<div class="kpi"><span>Узлов в сети</span><b class="ac">${liveN.length}<small> / ${nodes.length}</small></b><small>${regions.length} регион(ов)</small></div>
      <div class="kpi"><span>Зрителей</span><b>${totV}</b><small>+${o?.viewers || 0} через главный</small></div><div class="kpi"><span>Отдача</span><b>${bps(totB)}</b><small>сейчас</small></div>
      <div class="kpi"><span>Трафик за месяц</span><b>${B(monthT)}</b><small>лимит ${S.budgetGB} ГБ/узел</small></div><div class="kpi"><span>Тёплый резерв</span><b>${S.keepAllWarm ? 'все' : S.warmMin}</b><small>на регион · сон через ${S.idleSleepMin} мин</small></div>`;
    $('#sw-r', el).innerHTML = regions.map((rg) => {
      const list = nodes.filter((n) => n.region === rg);
      const lv = list.filter((n) => ['online', 'idle', 'dozing'].includes(n.state));
      return `<div class="region"><div class="region-h">◆ ${C.h(rg)} <small>${lv.length}/${list.length} в сети · ${lv.reduce((a, n) => a + (n.st?.viewers || 0), 0)} зрителей · средняя нагрузка ${pct(lv.reduce((a, n) => a + n.load, 0) / Math.max(1, lv.length))}</small></div>
      <div class="tw"><table class="tbl"><thead><tr><th>Узел</th><th>Состояние</th><th class="num">Зрит.</th><th>Нагрузка</th><th class="num">CPU</th><th class="num">RAM</th><th class="num">Отдача</th><th>Кэш</th><th>Трафик/мес</th><th class="num">Up</th><th>Зрители · 1ч</th><th></th></tr></thead><tbody>
      ${list.map((n) => { const st = n.st || {}; const live = ['online', 'idle', 'dozing', 'draining', 'budget'].includes(n.state); const hr = st.hits + st.miss ? st.hits / (st.hits + st.miss) : 0; return `<tr data-id="${C.h(n.id)}">
        <td><b class="mono">${C.h(n.id)}</b><div class="mono mu" style="font-size:11.5px">${C.h(n.url.replace(/^https?:\/\//, ''))}${n.note ? ' · ' + C.h(n.note) : ''}</div></td>
        <td><span class="pill ${n.state}">${STATE_RU[n.state] || n.state}</span><div class="mono mu" style="font-size:11px">${n.seen ? 'hb ' + ago(n.seen) : ''}${n.manualDrain ? ' · ручной слив' : ''}</div></td>
        <td class="num">${live ? st.viewers ?? 0 : '—'}<div class="mu" style="font-size:11px">/${n.capacity}</div></td><td>${live ? bar(n.load) : ''}</td>
        <td class="num">${live ? pct(st.cpu) : '—'}<div class="mu" style="font-size:11px">${live ? 'lag ' + st.lag + 'мс' : ''}</div></td><td class="num">${live ? B(st.rss) : '—'}</td>
        <td class="num">${live ? bps(st.bps || 0) : '—'}<div class="mu" style="font-size:11px">${live ? (st.rps || 0) + ' req/s' : ''}</div></td>
        <td>${live ? `${bar((st.cacheBytes || 0) / (st.cacheMax || 1), 60)}<div class="mono mu" style="font-size:11px">${B(st.cacheBytes)} · hit ${pct(hr)} · ↓${st.upMs}мс</div>` : ''}</td>
        <td>${bar(n.budget ? n.monthBytes / n.budget : 0, 70)}<div class="mono mu" style="font-size:11px">${B(n.monthBytes)}</div></td>
        <td class="num">${live ? upt(st.up || 0) : '—'}</td><td>${spark(n.hist.map((x) => x.v))}</td><td><button class="btn sm" data-m>⋯</button></td></tr>`; }).join('')}</tbody></table></div></div>`;
    }).join('') || `<div class="empty">Узлов пока нет. Задеплой образ <b>vn-edge</b> на Render с переменными MAIN_URL и SWARM_SECRET — он сам появится здесь.</div>`;
    $('#sw-r', el).querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => nmenu(b, nodes.find((x) => x.id === b.closest('tr').dataset.id))));
  };
  const nact = (n, a, msg) => run(`/api/admin/swarm/nodes/${encodeURIComponent(n.id)}/${a}`, {}, msg).then((r) => { draw(); return r; });
  const nmenu = (b, n) => popMenu(b, [
    { l: '🩺 Диагностика', f: () => diag(n) },
    { l: '📡 Пинг с главного', f: async () => { const r = await nact(n, 'ping'); C.toast(r.ok ? `Ответил за ${r.rtt} мс · нагрузка ${pct(r.reply?.l)}` : 'Не отвечает (' + r.rtt + ' мс)', r.ok ? 'o' : 'e'); } },
    n.enabled ? { l: '⏻ Выключить (слить + усыпить)', f: () => nact(n, 'disable', 'Узел выключен') } : { l: '⏻ Включить', f: () => nact(n, 'enable', 'Узел включён') },
    n.manualDrain ? { l: '▶ Вернуть в ротацию', f: () => nact(n, 'undrain', 'Вернули') } : { l: '⏸ Слить (новых зрителей не давать)', f: () => nact(n, 'drain', 'Сливаем') },
    { l: '☀ Разбудить', f: () => nact(n, 'wake', 'Будим…') }, { l: '☾ Усыпить', f: () => nact(n, 'sleep', 'Усыпляем') },
    { l: '🧹 Очистить кэш', f: () => nact(n, 'flush', 'Кэш очищен') }, { l: '↻ Перезапустить процесс', f: () => nact(n, 'restart', 'Перезапуск') },
    '-', { l: '✎ Настройки узла…', f: () => nodeEdit(n, draw) },
    ...(n.hasRender ? [{ l: 'Render: приостановить сервис', f: () => nact(n, 'suspend', 'Сервис приостановлен') }, { l: 'Render: возобновить', f: () => nact(n, 'resume', 'Сервис возобновлён') }, { l: 'Render: рестарт инстанса', f: () => nact(n, 'render-restart', 'Рестарт запрошен') }] : []),
    '-', { l: '🗑 Удалить из роя', d: true, f: async () => { if (await C.confirmDlg('Удалить узел из реестра? Если он жив, он зарегистрируется снова при следующем heartbeat.', 'Удалить', true)) nact(n, 'remove'); } },
  ]);
  el.innerHTML = `<h1>Серверы · рой <span class="sp"></span><button class="btn sm" id="sw-set">⚙ Политика роя</button><button class="btn sm" id="sw-add">+ Узел вручную</button></h1>
    <div class="kpis" id="sw-k"></div><div id="sw-r"></div>
    <p class="hint">Узлы регистрируются сами по heartbeat. Зритель получает 3–4 кандидата (ближний регион, привязка видео к узлу для кэша, наименее загруженный, резерв в соседнем регионе), меряет пинг и выбирает лучший; при сбое плеер сам переключается.</p>`;
  $('#sw-set', el).onclick = () => swarmSettings(snap.settings, draw);
  $('#sw-add', el).onclick = () => C.modal(`<h2>Добавить узел</h2><label class="field"><span>URL</span><input class="inp" id="na" placeholder="https://vn-edge-07.onrender.com"></label><label class="field"><span>Регион</span><select class="inp" id="nr">${Object.keys(snap.regions).map((r) => `<option>${r}</option>`).join('')}</select></label><div class="dlg-f"><button class="btn" data-close>Отмена</button><button class="btn pri" id="ns">Добавить</button></div>`, (d, close) => ($('#ns', d).onclick = () => run('/api/admin/swarm/nodes', { url: $('#na', d).value, region: $('#nr', d).value }, 'Добавлен').then(() => { close(); draw(); })));
  await draw(); live(el, () => ($('.menu-pop') || $('#modal').innerHTML ? Promise.resolve() : draw()), 5000);
}
async function diag(n) {
  C.modal({ wide: true, html: `<h2>Диагностика ${C.h(n.id)}</h2><div id="dg" class="code-box">запрашиваю узел…</div>` });
  const r = await C.api(`/api/admin/swarm/nodes/${encodeURIComponent(n.id)}/diag`, { method: 'POST', body: {} }).catch((e) => ({ error: e.message }));
  const box = $('#dg'); if (!box) return;
  if (!r.ok) { box.textContent = 'Узел недоступен: ' + (r.error || JSON.stringify(r.diag)) + '\nRTT ' + r.rtt + ' мс'; return; }
  const d = r.diag;
  box.textContent = [`RTT main→node: ${r.rtt} мс`, `версия: ${d.ver} · ${d.node} · uptime ${upt(d.uptime)}`, `Blomp: ${d.blomp} (${d.blompMs} мс)`, `CPU квота: ${d.cpuQuota} ядра · loadavg ${d.loadavg.map((x) => x.toFixed(2)).join(' ')}`,
    `память: rss ${B(d.mem.rss)} · heap ${B(d.mem.heap)} · buffers ${B(d.mem.buf)}`, `кэш: ${B(d.cache.bytes)} / ${B(d.cache.max)} · ${d.cache.items} объектов · в полёте ${d.inflight}`,
    `режим: ${d.state.mode}${d.state.draining ? ' (слив)' : ''} · heartbeat ok ${d.state.hbOk} / fail ${d.state.hbFail} · rtt до main ${d.state.mainRtt} мс`, '', 'последние ошибки:', ...(d.errors.length ? d.errors.map((e) => new Date(e.t).toLocaleTimeString('ru-RU') + '  ' + e.m) : ['— нет —'])].join('\n');
}
function nodeEdit(n, done) {
  C.modal(`<h2>Узел ${C.h(n.id)}</h2><div class="cols2"><label class="field"><span>Регион</span><input class="inp" id="er" value="${C.h(n.region)}"></label><label class="field"><span>Ёмкость (зрителей, 0 = по умолч.)</span><input class="inp" type="number" id="ec" value="${n.capacity}"></label></div>
    <label class="field"><span>Заметка</span><input class="inp" id="en" value="${C.h(n.note || '')}" placeholder="аккаунт #7, почта …"></label>
    <div class="field"><span>Render API (необязательно — для настоящего выключения сервиса)</span></div>
    <div class="cols2"><input class="inp" id="es" placeholder="srv-xxxxxxxx (Service ID)" value="${C.h(n.render_service || '')}"><input class="inp" id="ek" type="password" placeholder="${n.hasRender ? '•••••• (сохранён)' : 'rnd_… API key'}"></div>
    <label class="sw" style="margin-top:14px"><input type="checkbox" id="et"> Сбросить счётчик трафика за месяц</label>
    <div class="dlg-f"><button class="btn" data-close>Отмена</button><button class="btn pri" id="ego">Сохранить</button></div>`, (d, close) => {
    $('#ego', d).onclick = async () => { const b = { region: $('#er', d).value, capacity: +$('#ec', d).value, note: $('#en', d).value, render_service: $('#es', d).value, resetTraffic: $('#et', d).checked }; if ($('#ek', d).value) b.render_key = $('#ek', d).value; await C.api('/api/admin/swarm/nodes/' + encodeURIComponent(n.id), { method: 'PATCH', body: b }); close(); done(); };
  });
}
function swarmSettings(S, done) {
  const F = [['warmMin', 'Тёплых узлов на регион (минимум)', 'Столько узлов всегда держим проснувшимися — зритель не ждёт 30–50 с холодного старта Render'], ['idleSleepMin', 'Усыплять лишний узел после простоя, мин', ''], ['scaleAt', 'Будить ещё узел при средней нагрузке', '0.6 = 60%'], ['defaultCap', 'Ёмкость узла по умолчанию, зрителей', ''], ['nodeMbps', 'Пропускная способность узла, Мбит/с', ''], ['budgetGB', 'Лимит трафика узла в месяц, ГБ', 'Render Free ≈ 100 ГБ/мес; узел уходит в слив при превышении (0 = без лимита)'], ['edgeCacheMB', 'RAM-кэш на узле, МБ', 'из 512 МБ; 160 — безопасно']];
  C.modal({ wide: true, html: `<h2>Политика роя</h2><div class="cols2">${F.map(([k, l, hnt]) => `<label class="field"><span>${l}</span><input class="inp" type="number" step="any" id="s_${k}" value="${S[k]}">${hnt ? `<small class="hint">${hnt}</small>` : ''}</label>`).join('')}</div>
    <label class="sw"><input type="checkbox" id="s_keepAllWarm" ${S.keepAllWarm ? 'checked' : ''}> Держать тёплыми ВСЕ узлы (у каждого аккаунта Render 750 ч/мес — хватает на 24/7)</label>
    <label class="sw" style="margin-top:10px"><input type="checkbox" id="s_autoApprove" ${S.autoApprove ? 'checked' : ''}> Автоматически принимать новые узлы с верным SWARM_SECRET</label>
    <label class="sw" style="margin-top:10px"><input type="checkbox" id="s_mainFallback" ${S.mainFallback ? 'checked' : ''}> Главный сервер как последний резерв раздачи</label>
    <div class="dlg-f"><button class="btn" data-close>Отмена</button><button class="btn pri" id="sgo">Применить</button></div>` }, (d, close) => {
    $('#sgo', d).onclick = async () => { const b = {}; for (const [k] of F) b[k] = +$('#s_' + k, d).value; for (const k of ['keepAllWarm', 'autoApprove', 'mainFallback']) b[k] = $('#s_' + k, d).checked; await run('/api/admin/swarm/settings', b, 'Политика применена'); close(); done(); };
  });
}

// ---------- jobs ----------
async function jobs(el) {
  const draw = async () => {
    const r = await C.api('/api/admin/jobs');
    el.innerHTML = `<h1>Кодировщик</h1><div class="kpis">${r.encoders.map((e) => `<div class="kpi"><span>${C.h(e.name)}</span><b class="${e.online ? 'ok' : 'err'}">${e.online ? (e.busy ? 'работает' : 'ждёт') : 'офлайн'}</b><small>${e.caps ? Object.entries(e.caps).filter(([, v]) => v).map(([k]) => k).join(' · ') : ''} · ${ago(e.t)} назад</small></div>`).join('') || '<div class="kpi"><span>Кодировщики</span><b class="err">0</b><small>запусти vn-encoder на ПК/VPS</small></div>'}</div>
      <div class="tw"><table class="tbl"><thead><tr><th>#</th><th>Видео</th><th>Статус</th><th>Прогресс</th><th>Детали</th><th>Кодировщик</th><th>Создано</th><th></th></tr></thead><tbody>
      ${r.items.map((j) => { const i = j.info || {}; return `<tr data-id="${j.id}"><td class="mono">${j.id}</td><td><a href="/admin/videos?edit=${j.video_id}">${C.h(j.title || j.video_id)}</a><div class="mono mu" style="font-size:11px">${j.local ? 'локальный ingest' : B(j.raw_size) + ' исходник'}</div></td>
        <td><span class="pill ${j.status}">${j.status}</span></td><td style="min-width:140px"><div class="prog" style="margin:0"><i style="width:${(j.progress || 0) * 100}%"></i></div><span class="mono mu" style="font-size:11px">${pct(j.progress)}</span></td>
        <td class="mono" style="font-size:12px">${j.status === 'encoding' ? `${i.stage || ''} ${i.speed ? i.speed.toFixed(2) + '×' : ''} ${i.fps ? i.fps + 'fps' : ''} ${i.eta != null ? '· ETA ' + C.fmt(i.eta) : ''} ${i.uploadedMB ? '· ↑' + i.uploadedMB + 'МБ' : ''}` : j.error ? `<span class="err">${C.h(j.error.slice(0, 160))}</span>` : (i.ladder || []).join(' ')}</td>
        <td class="mono">${C.h(j.encoder || '—')}</td><td class="mono">${ago(j.created_at)}</td><td>${['error', 'canceled'].includes(j.status) ? '<button class="btn sm" data-a="retry">повторить</button>' : ''}${['queued', 'encoding'].includes(j.status) ? '<button class="btn sm dan" data-a="cancel">отменить</button>' : ''}</td></tr>`; }).join('') || '<tr><td colspan="8" class="mu" style="text-align:center;padding:40px">Задач не было</td></tr>'}</tbody></table></div>`;
    el.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => run(`/api/admin/jobs/${b.closest('tr').dataset.id}/${b.dataset.a}`, {}, 'Готово').then(draw)));
  };
  await draw(); live(el, draw, 5000);
}

// ---------- settings ----------
async function settings(el) {
  const s = await C.api('/api/admin/settings');
  const v = (k, d) => (s[k] ?? d);
  el.innerHTML = `<h1>Настройки</h1><div class="cols2"><div class="panel">
      <label class="field"><span>Название сайта</span><input class="inp" id="st" value="${C.h(v('site.title', 'V_N'))}"></label>
      <label class="field"><span>Подзаголовок</span><input class="inp" id="stg" value="${C.h(v('site.tagline', 'все эфиры в одном месте'))}"></label>
      <label class="field"><span>Баннер-объявление (пусто = нет)</span><input class="inp" id="san" value="${C.h(v('site.announce', ''))}"></label>
      <label class="field"><span>Техработы: текст (не пусто = сайт закрыт для всех, кроме админов)</span><input class="inp" id="smt" value="${C.h(v('site.maintenance', ''))}"></label>
      <label class="field"><span>Смена ника не чаще, часов</span><input class="inp" type="number" id="snc" value="${v('site.nickCooldownH', 24)}"></label>
      <label class="field"><span>Запрещённые слова в никах (через запятую)</span><input class="inp" id="sbw" value="${C.h((v('site.bannedWords', []) || []).join(', '))}"></label>
      <label class="field"><span>Профиль сжатия по умолчанию</span><select class="inp" id="sep"><option value="av1">AV1 + H.264 480p</option><option value="av1compat">AV1 + H.264 720p</option><option value="h264">H.264</option><option value="lite">Лайт</option></select></label>
      <label class="sw"><input type="checkbox" id="sgw" ${v('site.guestWatch', true) ? 'checked' : ''}> Гости могут смотреть без входа</label>
      <label class="sw" style="margin-top:10px"><input type="checkbox" id="srg" ${v('site.registration', true) ? 'checked' : ''}> Открыта регистрация новых пользователей</label>
      <label class="sw" style="margin-top:10px"><input type="checkbox" id="snn" ${v('site.notifyNew', true) ? 'checked' : ''}> Рассылать подписчикам новые записи</label>
      <label class="sw" style="margin-top:10px"><input type="checkbox" id="skr" ${v('site.keepRaw', false) ? 'checked' : ''}> Хранить исходники после кодирования (занимает место!)</label>
      <button class="btn pri" id="ssave" style="margin-top:18px">Сохранить</button></div>
    <div><div class="panel"><div class="field"><span>Рассылка через бота</span></div><textarea class="inp" id="bt" placeholder="Сегодня в 20:00 большой стрим!"></textarea>
      <input class="inp" id="bu" placeholder="Ссылка для кнопки (необязательно)" style="margin-top:10px"><label class="sw" style="margin-top:12px"><input type="checkbox" id="ba"> Всем (а не только подписанным на уведомления)</label>
      <button class="btn" id="bgo" style="margin-top:14px">Отправить</button></div></div></div>`;
  $('#sep', el).value = v('enc.profile', 'av1');
  $('#ssave', el).onclick = () => run('/api/admin/settings', { 'site.title': $('#st').value, 'site.tagline': $('#stg').value, 'site.announce': $('#san').value, 'site.maintenance': $('#smt').value, 'site.nickCooldownH': +$('#snc').value, 'site.bannedWords': $('#sbw').value, 'enc.profile': $('#sep').value, 'site.guestWatch': $('#sgw').checked, 'site.registration': $('#srg').checked, 'site.notifyNew': $('#snn').checked, 'site.keepRaw': $('#skr').checked }, 'Сохранено');
  $('#bgo', el).onclick = async () => { if (!$('#bt').value.trim()) return; if (await C.confirmDlg('Отправить рассылку?', 'Отправить')) { const r = await run('/api/admin/broadcast', { text: $('#bt').value, url: $('#bu').value || undefined, all: $('#ba').checked }); C.toast('Отправлено: ' + r.sent, 'o'); } };
}

// ---------- audit ----------
async function audit(el) {
  const r = await C.api('/api/admin/audit');
  el.innerHTML = `<h1>Журнал действий</h1><div class="tw"><table class="tbl"><thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Объект</th><th>Детали</th></tr></thead><tbody>
    ${r.items.map((a) => `<tr><td class="mono">${new Date(a.at).toLocaleString('ru-RU')}</td><td>${C.h(a.nick || (a.actor ? '#' + a.actor : 'система'))}</td><td class="mono">${C.h(a.action)}</td><td class="mono">${C.h(a.target || '')}</td><td class="mono mu" style="font-size:12px;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${C.h(a.meta || '')}</td></tr>`).join('')}</tbody></table></div>`;
}

window.VNAdmin = { render };
})();
