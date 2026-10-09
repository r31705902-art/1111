// V_N SPA — vanilla, no deps.
(() => {
'use strict';
const S = { me: null, site: {}, meta: null, player: null };
const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => window.vnFmt ? window.vnFmt(s) : String(s);
const dur = (s) => { s = Math.round(s || 0); const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return hh ? `${hh}ч ${m}м` : `${m}м`; };
const DOW = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];
const ddate = (d) => d ? d.replace(/-/g, '.') + ' · ' + DOW[new Date(d + 'T12:00:00').getDay()] : '';
const LS = { get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

async function api(path, { method = 'GET', body, raw, signal, keepalive } = {}) {
  const headers = { 'X-VN': '1' };
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  const r = await fetch(path, { method, headers, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin', signal, keepalive });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Ошибка ' + r.status); e.status = r.status; e.data = j; throw e; }
  return j;
}
function toast(msg, kind = '') { const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('#toasts').append(t); setTimeout(() => t.remove(), 3800); }
function modal(html, onMount) {
  const m = $('#modal'); m.innerHTML = `<div class="dlg ${html.wide ? 'wide' : ''}" role="dialog">${html.html || html}<button class="btn ghost sm x" data-close aria-label="Закрыть">✕</button></div>`;
  const close = () => { m.innerHTML = ''; m.onclose?.(); m.onclose = null; };
  m.onclick = (e) => { if (e.target === m || e.target.closest('[data-close]')) close(); };
  onMount?.(m.firstElementChild, close);
  return close;
}
const confirmDlg = (text, okLabel = 'Подтвердить', danger) => new Promise((res) => { modal(`<h2>Точно?</h2><p class="mu">${text}</p><div class="dlg-f"><button class="btn" data-close>Отмена</button><button class="btn ${danger ? 'dan' : 'pri'}" id="ok">${okLabel}</button></div>`, (d, close) => { $('#modal').onclose = () => res(false); $('#ok', d).onclick = () => { $('#modal').onclose = null; close(); res(true); }; }); });
const coverHtml = (v) => v.cover ? `<img loading="lazy" decoding="async" src="${h(v.cover)}" alt="">` : `<div class="ph" style="background:${grad(v.id)}">${h((v.title || '?').slice(0, 2).toUpperCase())}</div>`;
function grad(id) { let x = 0; for (const c of String(id)) x = (x * 31 + c.charCodeAt(0)) >>> 0; const a = x % 360; return `linear-gradient(135deg,hsl(${a} 30% 16%),hsl(${(a + 60) % 360} 35% 9%))`; }
const progMap = () => LS.get('vn_prog', {});
function card(v, mini) {
  const p = v.pos ?? progMap()[v.id]; const pct = p && v.dur ? Math.min(100, (p / v.dur) * 100) : 0;
  const thumb = `<div class="thumb">${coverHtml(v)}${mini ? '' : '<span class="badge rec">REC</span>'}<span class="badge dur">${fmt(v.dur)}</span>${v.pinned && !mini ? '<span class="badge pin">★</span>' : ''}${pct > 1 ? `<div class="wbar" style="width:${pct}%"></div>` : ''}</div>`;
  if (mini) return `<a class="mini" href="/v/${v.id}">${thumb}<div><h3>${h(v.title)}</h3><div class="cdate">${ddate(v.date)}</div></div></a>`;
  return `<a class="card" href="/v/${v.id}">${thumb}<div class="cmeta"><div class="cdate">${ddate(v.date)} · ${dur(v.dur)}</div><h3>${h(v.title)}</h3><div class="ctags">${v.tags.slice(0, 4).map((t) => '#' + h(t)).join(' ')}</div></div></a>`;
}

// ---------- nav ----------
function renderNav() {
  const n = $('#nav'); const me = S.me;
  n.innerHTML = me ? `${me.role !== 'user' ? '<a class="btn ghost sm" href="/admin">Панель</a>' : ''}<a class="me-btn" href="/me">${avatar(me)}<span>${h(me.nick)}</span></a>` : `<button class="btn tg" id="login">${tgIcon()} Войти</button>`;
  $('#login', n)?.addEventListener('click', login);
  $('#announce').textContent = S.site.announce || '';
}
const avatar = (u, cls = '') => u.avatar ? `<img class="ava ${cls}" src="${h(u.avatar)}" alt="">` : `<span class="ava ${cls}">${h((u.nick || '?')[0].toUpperCase())}</span>`;
const tgIcon = () => '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M21.9 4.3 18.7 19.4c-.2 1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.3-5 9.1-8.2c.4-.4-.1-.6-.6-.2L6.2 13.1 1.4 11.6c-1-.3-1-1 .2-1.5L20.5 2.8c.9-.3 1.6.2 1.4 1.5z"/></svg>';

// ---------- login via Telegram bot ----------
async function login() {
  let alive = true, started = null;
  modal(`<h2>Вход через Telegram</h2><p class="mu">Без паролей: аккаунт создаётся автоматически при первом входе.</p>
    <ol class="tg-steps"><li>Нажми кнопку — откроется наш бот <b>@${h(S.site.bot)}</b></li><li>В боте нажми «Start», затем «✅ Подтвердить вход»</li><li>Вернись сюда — ты уже внутри</li></ol>
    <button class="btn tg" style="width:100%;height:46px" id="go">${tgIcon()} Открыть Telegram</button>
    <div id="st"></div><p class="hint" style="margin-top:14px">Или напиши боту <span class="mono">/login</span> — он пришлёт одноразовую ссылку для входа.</p>`, (d) => {
    $('#modal').onclose = () => { alive = false; };
    $('#go', d).onclick = async () => {
      try {
        if (!started) started = await api('/api/auth/tg/start', { method: 'POST' });
        window.open(started.link, '_blank', 'noopener');
        $('#st', d).innerHTML = `<div class="wait"><span class="rec-dot"></span><span>Ждём подтверждения в боте… код <span class="code">${h(started.code)}</span><br><a class="ac" href="${h(started.link)}" target="_blank" rel="noopener">не открылось? нажми здесь</a></span></div>`;
        if (started.polling) return; started.polling = true;
        while (alive) {
          const r = await api('/api/auth/tg/poll?code=' + encodeURIComponent(started.code)).catch(() => ({ st: 'wait' }));
          if (r.st === 'ok') { S.me = r.me; $('#modal').innerHTML = ''; toast('Привет, ' + r.me.nick + '!', 'o'); renderNav(); route(); return; }
          if (r.st === 'deny') { $('#st', d).innerHTML = '<div class="wait err">Вход отменён в боте.</div>'; started = null; return; }
          if (r.st === 'expired') { $('#st', d).innerHTML = '<div class="wait">Код устарел — нажми кнопку ещё раз.</div>'; started = null; return; }
        }
      } catch (e) { toast(e.message, 'e'); }
    };
  });
}

// ---------- router ----------
const routes = [[/^\/$/, home], [/^\/v\/([\w-]+)$/, watch], [/^\/me$/, profile], [/^\/admin(?:\/([\w-]+))?$/, admin]];
function go(url, replace) { if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url); route(); }
async function route() {
  if (S.player) { S.player.destroy(); S.player = null; }
  document.body.classList.remove('theater');
  const p = location.pathname;
  if (S.me?.banned && p !== '/me') return banned();
  for (const [re, fn] of routes) { const m = re.exec(p); if (m) { try { await fn(...m.slice(1)); } catch (e) { fatal(e); } return; } }
  view.innerHTML = '<div class="full"><div><h1>404</h1><p class="mu">Такой плёнки нет в архиве.</p><a class="btn" href="/">На главную</a></div></div>';
}
function fatal(e) {
  if (e.data?.maintenance) { view.innerHTML = `<div class="full"><div><h1>ТЕХ<span class="ac">_</span>РАБОТЫ</h1><p class="mu">${h(e.message)}</p></div></div>`; return; }
  if (e.data?.banned) return banned();
  view.innerHTML = `<div class="full"><div><h1>ОШИБКА</h1><p class="mu">${h(e.message)}</p><a class="btn" href="/">На главную</a></div></div>`;
}
function banned() {
  const b = S.me.banned;
  view.innerHTML = `<div class="full"><div><h1 class="err">ДОСТУП ЗАКРЫТ</h1><p>Аккаунт <b>${h(S.me.nick)}</b> заблокирован ${b.until === -1 ? 'навсегда' : 'до ' + new Date(b.until).toLocaleString('ru-RU')}.</p>${b.reason ? `<p class="mu">Причина: ${h(b.reason)}</p>` : ''}<button class="btn" id="lo">Выйти</button></div></div>`;
  $('#lo').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; };
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]'); if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
  const u = new URL(a.href, location.href); if (u.origin !== location.origin || u.pathname.startsWith('/auth/')) return;
  e.preventDefault(); if (u.pathname + u.search !== location.pathname + location.search) { go(u.pathname + u.search); scrollTo(0, 0); }
});
addEventListener('popstate', route);

// ---------- search box ----------
const q = $('#q');
let qT;
q.addEventListener('input', () => { clearTimeout(qT); qT = setTimeout(() => { const u = new URLSearchParams(location.pathname === '/' ? location.search : ''); if (q.value.trim()) u.set('q', q.value.trim()); else u.delete('q'); go('/' + (u.toString() ? '?' + u : ''), location.pathname === '/'); }, 280); });
addEventListener('keydown', (e) => { if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); q.select(); } if (e.key === 'Escape' && document.activeElement === q) q.blur(); });

// ---------- home ----------
async function home() {
  const P = new URLSearchParams(location.search);
  q.value = P.get('q') || '';
  if (!S.meta) S.meta = await api('/api/meta');
  const sel = new Set((P.get('tags') || '').split(',').filter(Boolean));
  const filtered = ['q', 'tags', 'from', 'to', 'len', 'sort'].some((k) => P.get(k));
  view.innerHTML = `
    <section class="hero"><div><h1>Архив<br><span>стримов</span></h1><div class="tag">${h(S.site.tagline || '')} <span class="rec-dot" style="margin-left:6px"></span></div></div>
      <div class="counters"><div><b>${S.meta.total}</b><span>записей</span></div><div><b>${S.meta.hours}</b><span>часов эфира</span></div><div><b>${S.meta.tags.length}</b><span>тегов</span></div></div></section>
    ${calendar(S.meta.days, P)}
    <div class="filters">
      <div class="chips">${S.meta.tags.slice(0, 40).map((t) => `<button class="chip ${sel.has(t.tag) ? 'on' : ''}" data-tag="${h(t.tag)}">#${h(t.tag)} <small>${t.n}</small></button>`).join('')}</div>
      <input class="fin" type="date" id="from" value="${h(P.get('from') || '')}" title="С даты"><input class="fin" type="date" id="to" value="${h(P.get('to') || '')}" title="По дату">
      <select class="fsel" id="len"><option value="">Любая длина</option><option value="0-120">до 2 ч</option><option value="120-240">2–4 ч</option><option value="240-">4+ ч</option></select>
      <select class="fsel" id="sort"><option value="">Сначала новые</option><option value="old">Сначала старые</option><option value="views">Популярные</option><option value="long">Самые длинные</option><option value="short">Самые короткие</option><option value="title">По названию</option>${P.get('q') ? '<option value="rel">По релевантности</option>' : ''}</select>
    </div>
    <div id="cont"></div>
    <div class="result-line" id="rl"></div><div class="grid" id="grid"></div><div class="more"><button class="btn" id="more" hidden>Показать ещё</button></div>`;
  $('#len').value = P.get('len') || ''; $('#sort').value = P.get('sort') || '';
  const upd = (k, v) => { const u = new URLSearchParams(location.search); if (v) u.set(k, v); else u.delete(k); go('/' + (u.toString() ? '?' + u : ''), true); };
  view.querySelectorAll('.chip').forEach((c) => (c.onclick = () => { const t = c.dataset.tag; sel.has(t) ? sel.delete(t) : sel.add(t); upd('tags', [...sel].join(',')); }));
  $('#from').onchange = (e) => upd('from', e.target.value); $('#to').onchange = (e) => upd('to', e.target.value);
  $('#len').onchange = (e) => upd('len', e.target.value); $('#sort').onchange = (e) => upd('sort', e.target.value);
  view.querySelectorAll('.cal-g i[data-d]').forEach((i) => (i.onclick = () => { const d = i.dataset.d; const u = new URLSearchParams(location.search); if (u.get('from') === d && u.get('to') === d) { u.delete('from'); u.delete('to'); } else { u.set('from', d); u.set('to', d); } go('/' + (u.toString() ? '?' + u : ''), true); }));
  if (S.me && !filtered) api('/api/me/library').then((l) => { const c = l.history.filter((v) => v.pos > 30 && v.pos < v.dur - 90).slice(0, 12); if (c.length) $('#cont').innerHTML = `<div class="row-h"><h2>Продолжить просмотр</h2></div><div class="strip">${c.map((v) => card(v)).join('')}</div>`; }).catch(() => {});
  let page = 0; const params = new URLSearchParams();
  for (const k of ['q', 'tags', 'from', 'to', 'sort']) if (P.get(k)) params.set(k, P.get(k));
  const [lo, hi] = (P.get('len') || '-').split('-'); if (lo) params.set('dmin', lo); if (hi) params.set('dmax', hi);
  const load = async () => {
    params.set('page', page);
    const r = await api('/api/videos?' + params);
    $('#grid').insertAdjacentHTML('beforeend', r.items.map((v) => card(v)).join(''));
    if (page === 0) {
      $('#rl').innerHTML = filtered ? `<span>Найдено: <b class="ac">${r.total}</b> · ${r.hours} ч</span><a class="btn ghost sm" href="/">сбросить фильтры ✕</a>` : '';
      if (!r.total) $('#grid').outerHTML = `<div class="empty">${filtered ? 'Ничего не нашлось. Попробуй другие теги или даты.' : 'Архив пока пуст — первые записи скоро появятся.'}</div>`;
    }
    const more = $('#more'); if (more) more.hidden = (page + 1) * r.limit >= r.total;
  };
  await load();
  const more = $('#more');
  if (more) { more.onclick = () => { page++; load(); }; new IntersectionObserver((es) => { if (es[0].isIntersecting && !more.hidden) more.click(); }, { rootMargin: '600px' }).observe(more); }
}
function calendar(days, P) {
  if (!days.length) return '';
  const map = new Map(days.map((d) => [d.d, d]));
  const end = new Date(); end.setHours(12, 0, 0, 0);
  const start = new Date(end); start.setDate(start.getDate() - 7 * 52 - ((end.getDay() + 6) % 7));
  const cells = [], months = []; let lastM = -1, col = 0;
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10), x = map.get(iso);
    if ((d.getDay() + 6) % 7 === 0) { if (d.getMonth() !== lastM) { months.push([col, d.toLocaleString('ru-RU', { month: 'short' })]); lastM = d.getMonth(); } col++; }
    const lv = x ? Math.min(4, Math.ceil(x.s / 5400)) : 0;
    cells.push(`<i class="${lv ? 'l' + lv : ''} ${P.get('from') === iso && P.get('to') === iso ? 'sel' : ''}" ${x ? `data-d="${iso}" title="${iso}: ${x.n} зап., ${dur(x.s)}"` : `title="${iso}"`}></i>`);
  }
  const lead = (start.getDay() + 6) % 7;
  return `<div class="cal"><div class="cal-h"><span>Карта эфиров · 12 месяцев</span><span>${days.length} дней в эфире</span></div>
    <div class="cal-m" style="grid-template-columns:repeat(${col},11px)">${months.map(([c, m]) => `<span style="grid-column:${c + 1}">${m}</span>`).join('')}</div>
    <div class="cal-g">${'<i class="x"></i>'.repeat(lead)}${cells.join('')}</div></div>`;
}

// ---------- watch ----------
async function pickNodes(nodes) {
  const probe = (n) => new Promise((res) => {
    const t0 = performance.now(); const ac = new AbortController(); const to = setTimeout(() => { ac.abort(); res({ ...n, rtt: 9e3 }); }, 1800);
    fetch(n.url + '/ping', { signal: ac.signal, cache: 'no-store' }).then((r) => r.json()).then((j) => { clearTimeout(to); res({ ...n, rtt: performance.now() - t0, l: j.l ?? n.l, d: j.d }); }).catch(() => { clearTimeout(to); res({ ...n, rtt: 9e3 }); });
  });
  const r = await Promise.all(nodes.map(probe));
  const ranked = r.filter((n) => !n.d).sort((a, b) => a.rtt * (1 + a.l * 1.5) + (a.rg === 'origin' ? 400 : 0) - (b.rtt * (1 + b.l * 1.5) + (b.rg === 'origin' ? 400 : 0)));
  const best = ranked.find((n) => n.rtt < 9e3 && n.rg !== 'origin'); if (best) LS.set('vn_rg', best.rg);
  return ranked.length ? ranked : nodes;
}
const playReq = (id) => api(`/api/videos/${id}/play`, { method: 'POST', body: { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, off: new Date().getTimezoneOffset(), rg: LS.get('vn_rg', '') } });
async function watch(id) {
  const v = await api('/api/videos/' + id);
  document.title = v.title + ' — V_N';
  if (LS.get('vn_theater', false)) document.body.classList.add('theater');
  const linkTs = (txt) => h(txt).replace(/\b(\d{1,2}:)?\d{1,2}:\d{2}\b/g, (m) => `<span class="ts" data-t="${m.split(':').reduce((a, x) => a * 60 + +x, 0)}">${m}</span>`);
  view.innerHTML = `<div class="stage"><div id="pl">${v.status !== 'ready' ? '<div class="vp"><div class="full" style="min-height:0;height:100%"><div class="mono mu">Видео обрабатывается: ' + h(v.status) + '</div></div></div>' : '<div class="vp"></div>'}</div></div>
    <div class="wgrid"><div class="winfo">
      <div class="wdate"><span><span class="rec-dot"></span> REC ${ddate(v.date)}</span><span>${dur(v.dur)}</span><span>${v.views} просмотров</span>${v.watching ? `<span class="live">● ${v.watching} смотрят сейчас</span>` : ''}${v.visibility === 'hidden' ? '<span class="warn">скрыто</span>' : ''}</div>
      <h1>${h(v.title)}</h1>
      <div class="wact">${S.me ? `<button class="btn ${v.fav ? 'on' : ''}" id="fav">${v.fav ? '★ В избранном' : '☆ В избранное'}</button>` : ''}<button class="btn" id="share">⤴ Поделиться с таймкодом</button>${S.me && S.me.role === 'admin' ? `<a class="btn ghost" href="/admin/videos?edit=${v.id}">✎ Редактировать</a>` : ''}</div>
      <div class="ctags" style="margin-bottom:16px;gap:8px">${v.tags.map((t) => `<a class="chip" href="/?tags=${encodeURIComponent(t)}">#${h(t)}</a>`).join('')}</div>
      ${v.description ? `<div class="desc">${linkTs(v.description)}</div>` : ''}
    </div><aside class="side">
      ${v.chapters.length ? `<h2>Главы · ${v.chapters.length}</h2><div class="chl" id="chl">${v.chapters.map((c, i) => `<button data-t="${c.t}" data-i="${i}"><b>${fmt(c.t)}</b><span>${h(c.title)}</span></button>`).join('')}</div>` : ''}
      ${v.related.length ? `<h2>Похожие записи</h2>${v.related.map((x) => card(x, true)).join('')}` : ''}
    </aside></div>`;
  $('#fav')?.addEventListener('click', async (e) => { const on = !e.target.classList.contains('on'); await api(`/api/videos/${id}/fav`, { method: 'POST', body: { on } }); e.target.classList.toggle('on', on); e.target.textContent = on ? '★ В избранном' : '☆ В избранное'; });
  $('#share').onclick = () => { const t = Math.floor(S.player?.el.v.currentTime || 0); const url = `${location.origin}/v/${id}${t > 5 ? '?t=' + t : ''}`; navigator.clipboard?.writeText(url).then(() => toast('Ссылка скопирована' + (t > 5 ? ' с ' + fmt(t) : ''), 'o'), () => prompt('Ссылка:', url)); };
  view.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { S.player?.seek(+b.dataset.t); scrollTo({ top: 0, behavior: 'smooth' }); }));
  if (v.status !== 'ready') return;
  let pr;
  try { pr = await playReq(id); }
  catch (e) { $('#pl').innerHTML = `<div class="vp"><div class="full" style="min-height:0;height:100%"><div><p>${h(e.message)}</p>${e.status === 401 ? '<button class="btn tg" id="lg">Войти через Telegram</button>' : ''}</div></div></div>`; $('#lg')?.addEventListener('click', login); return; }
  const bases = await pickNodes(pr.nodes);
  const P = new URLSearchParams(location.search);
  const saved = Math.max(v.progress || 0, progMap()[id] || 0);
  const start = P.get('t') ? +P.get('t') : saved > 30 && saved < v.dur - 60 ? saved : 0;
  let lastSent = 0;
  S.player = new window.VNPlayer($('#pl'), { bases, path: `/p/${pr.token}/${id}/`, dur: v.dur, start, chapters: v.chapters, sb: v.sb, title: v.title, cover: v.cover,
    refresh: async () => { const r = await playReq(id); return { path: `/p/${r.token}/${id}/`, bases: await pickNodes(r.nodes) }; },
    onProgress: (t, d, final) => {
      const m = progMap(); m[id] = Math.round(t); const keys = Object.keys(m); if (keys.length > 300) delete m[keys[0]]; LS.set('vn_prog', m);
      if (S.me && (final || Date.now() - lastSent > 30000)) { lastSent = Date.now(); api('/api/progress', { method: 'POST', body: { v: id, p: t, d }, keepalive: final }).catch(() => {}); }
    },
    onChapter: (c) => { const l = $('#chl'); if (!l) return; l.querySelectorAll('button').forEach((b) => b.classList.toggle('on', c && +b.dataset.t === c.t)); },
  });
  S.player.el.vp.focus({ preventScroll: true });
}

// ---------- profile ----------
async function profile() {
  if (!S.me) { view.innerHTML = '<div class="full"><div><h1>ПРОФИЛЬ</h1><p class="mu">Войди через Telegram, чтобы сохранять прогресс и избранное.</p><button class="btn tg" id="lg">Войти</button></div></div>'; $('#lg').onclick = login; return; }
  const me = S.me;
  const cd = S.site.nickCooldownH * 3600e3 - (Date.now() - (me.nickAt || 0));
  view.innerHTML = `<div class="prof"><div>
    <div class="panel prof-card"><label class="ava-wrap">${avatar(me, 'lg')}<input type="file" accept="image/*" id="avf" hidden></label>
      <div style="font-size:22px;font-weight:700">${h(me.nick)}</div><div class="mono mu" style="font-size:13px">${me.tg ? '@' + h(me.tg) + ' · ' : ''}${me.role}</div>
      ${me.avatar ? '<button class="btn ghost sm" id="avd" style="margin-top:8px">убрать аватарку</button>' : ''}</div>
    <div class="panel" style="margin-top:16px"><label class="field"><span>Никнейм</span><input class="inp" id="nick" maxlength="24" value="${h(me.nick)}"></label>
      <div class="hint" style="margin:-6px 0 12px">3–24 символа: буквы, цифры, _ . - ${cd > 0 && me.role === 'user' ? `<br><span class="warn">Можно сменить через ${Math.ceil(cd / 3600e3)} ч</span>` : ''}</div>
      <button class="btn pri" id="nsave">Сохранить</button>
      <hr style="border:0;border-top:1px solid var(--ln);margin:20px 0"><label class="sw"><input type="checkbox" id="ntf" ${me.notify ? 'checked' : ''}> Присылать новые записи в Telegram</label></div>
    <div class="panel" style="margin-top:16px"><div class="field"><span>Устройства</span></div><div id="sess" class="mu">…</div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn sm" id="lo2">Выйти на других</button><button class="btn sm dan" id="lo">Выйти</button></div></div>
  </div><div><div class="tabs"><button class="on" data-tab="history">История</button><button data-tab="favorites">Избранное</button></div><div id="lib" class="grid"></div></div></div>`;
  const lib = await api('/api/me/library');
  const showTab = (t) => { view.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t)); const items = lib[t]; $('#lib').innerHTML = items.length ? items.map((v) => card(v)).join('') : `<div class="empty" style="grid-column:1/-1">${t === 'history' ? 'Ты ещё ничего не смотрел' : 'Пока пусто — жми ☆ на странице записи'}</div>`; };
  view.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab))); showTab('history');
  api('/api/me/sessions').then((r) => { $('#sess').innerHTML = r.items.map((s) => `<div class="sess"><span>${h(uaShort(s.ua))}${s.current ? ' <b class="ac">· это устройство</b>' : ''}</span><span class="mono">${new Date(s.seen_at).toLocaleDateString('ru-RU')}</span></div>`).join(''); });
  $('#nsave').onclick = async () => { try { const r = await api('/api/me', { method: 'PATCH', body: { nick: $('#nick').value } }); S.me = r.me; renderNav(); toast('Ник сохранён', 'o'); profile(); } catch (e) { toast(e.message, 'e'); } };
  $('#ntf').onchange = async (e) => { const r = await api('/api/me', { method: 'PATCH', body: { notify: e.target.checked } }); S.me = r.me; toast(e.target.checked ? 'Уведомления включены' : 'Уведомления выключены'); };
  $('#avf').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { const blob = await resizeImage(f, 256, 256, true); const r = await api('/api/me/avatar', { method: 'POST', body: blob, raw: true }); S.me = r.me; renderNav(); profile(); toast('Аватарка обновлена', 'o'); } catch (er) { toast(er.message, 'e'); } };
  $('#avd')?.addEventListener('click', async () => { await api('/api/me/avatar', { method: 'DELETE' }); S.me.avatar = null; renderNav(); profile(); });
  $('#lo').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); S.me = null; renderNav(); go('/'); };
  $('#lo2').onclick = async () => { await api('/api/me/logout-others', { method: 'POST' }); toast('Другие сессии завершены'); profile(); };
}
const uaShort = (ua = '') => ((/(Edg|OPR|YaBrowser|Firefox|Chrome|Safari)\//.exec(ua) || [, 'Браузер'])[1].replace('Edg', 'Edge').replace('OPR', 'Opera') + ' · ' + ((/(Android|iPhone|iPad|Windows|Mac OS X|Linux)/.exec(ua) || [, '—'])[1]));

// image → cropped/resized WebP blob (done on the client to keep 0.5-CPU servers idle)
async function resizeImage(file, W, H, square) {
  const img = await createImageBitmap(file).catch(() => { throw new Error('Не удалось прочитать картинку'); });
  const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
  const sr = img.width / img.height, dr = W / H; let sw = img.width, sh = img.height, sx = 0, sy = 0;
  if (sr > dr) { sw = img.height * dr; sx = (img.width - sw) / 2; } else { sh = img.width / dr; sy = (img.height - sh) / 2; }
  x.imageSmoothingQuality = 'high'; x.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
  let b = await new Promise((r) => c.toBlob(r, 'image/webp', 0.86));
  if (!b || b.type !== 'image/webp') b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
  return b;
}

// ---------- admin (lazy) ----------
async function admin(tab) {
  if (!S.me || S.me.role === 'user') { view.innerHTML = '<div class="full"><div><h1>403</h1><p class="mu">Только для администрации.</p></div></div>'; return; }
  if (!window.VNAdmin) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/admin.js?v=__V_admin.js__'; s.onload = res; s.onerror = rej; document.head.append(s); });
  return window.VNAdmin.render(view, tab || 'overview', { api, h, toast, modal, confirmDlg, S, fmt, dur, go, resizeImage, coverHtml, ddate });
}

// ---------- boot ----------
(async () => {
  try { const b = await api('/api/boot'); S.site = b.site; S.me = b.me; } catch (e) { S.site = { title: 'V_N' }; }
  renderNav();
  if (new URLSearchParams(location.search).get('login') === 'expired') toast('Ссылка входа устарела — запроси новую в боте', 'e');
  await new Promise((r) => (window.VNPlayer ? r() : addEventListener('load', r, { once: true })));
  route();
})();
})();
