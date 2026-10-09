'use strict';
// V_N Telegram bot: registration/login confirmation, magic links, notifications. Long polling, no deps.
const http = require('node:http');
const { env, envInt, safeEq, readJson, log } = require('../../shared/lib');

const TOKEN = env('BOT_TOKEN', '');
const MAIN = env('MAIN_URL', 'http://localhost:8080').replace(/\/$/, '');
const SECRET = env('BOT_SECRET', 'dev-bot-secret');
const SITE = env('SITE_URL', MAIN).replace(/\/$/, '');
const MODE = env('BOT_MODE', 'poll');
const PUBLIC_URL = env('PUBLIC_URL', env('RENDER_EXTERNAL_URL', '')).replace(/\/$/, '');
const HOOK_PATH = '/tg/' + require('node:crypto').createHash('sha256').update(TOKEN + SECRET).digest('hex').slice(0, 24);
if (!TOKEN) log('WARNING: BOT_TOKEN not set — bot will only serve /health');

const tg = async (method, body, timeout = 15000) => {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(timeout) });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok) { const e = new Error(j.description || 'tg ' + r.status); e.code = j.error_code; e.retry = j.parameters?.retry_after; throw e; }
  return j.result;
};
const main = async (p, body, extra = {}) => {
  const r = await fetch(MAIN + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Bot-Secret': SECRET, 'Content-Type': extra.type || 'application/json' }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), signal: AbortSignal.timeout(65000) });
  return r.json().catch(() => ({ ok: false, error: 'Сайт не отвечает, попробуй через минуту' }));
};
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const tgUser = (f) => ({ id: f.id, username: f.username, first_name: f.first_name, last_name: f.last_name });
const kb = (rows) => ({ inline_keyboard: rows });
const urlBtn = (text, url) => (/^https:\/\//.test(url) ? { text, url } : { text: text + ' (' + url + ')', callback_data: 'noop' });
const say = (chat, text, markup) => tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup });

async function importAvatar(from) {
  try {
    const ph = await tg('getUserProfilePhotos', { user_id: from.id, limit: 1 });
    const sizes = ph.photos?.[0]; if (!sizes) return;
    const pick = sizes.find((s) => s.width >= 300) || sizes[sizes.length - 1];
    const f = await tg('getFile', { file_id: pick.file_id });
    const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return;
    await main('/api/bot/avatar?tg=' + from.id, Buffer.from(await r.arrayBuffer()), { type: 'application/octet-stream' });
  } catch (e) { log('avatar import', e.message); }
}

const HELP = (name) => `👋 Привет${name ? ', ' + esc(name) : ''}! Это бот архива стримов <b>V_N</b>.\n\n` +
  '• /login — войти на сайт по ссылке\n• /me — мой профиль\n• /latest — свежие записи\n• /notify — уведомления о новых записях\n• /logout — выйти на всех устройствах';

async function onMessage(m) {
  if (!m.text || m.chat.type !== 'private') return;
  const [cmd0, arg] = m.text.trim().split(/\s+/, 2); const cmd = cmd0.split('@')[0].toLowerCase();
  const chat = m.chat.id, from = tgUser(m.from);
  if (cmd === '/start' && arg && /^[A-Za-z0-9]{6,20}$/.test(arg)) {
    return say(chat, '🔐 <b>Вход на сайт V_N</b>\n\nКто-то (надеемся, ты) входит на сайт через этого бота. Подтвердить вход в аккаунт Telegram <b>' + esc(m.from.first_name) + '</b>?\n\n<i>Если это не ты — нажми «Отмена».</i>',
      kb([[{ text: '✅ Подтвердить вход', callback_data: 'ok:' + arg }], [{ text: '✖ Отмена', callback_data: 'no:' + arg }]]));
  }
  if (cmd === '/start' || cmd === '/help') return say(chat, HELP(m.from.first_name), kb([[urlBtn('🌐 Открыть архив', SITE)], [{ text: '🔑 Войти на сайт', callback_data: 'magic' }]]));
  if (cmd === '/login') return magic(chat, from);
  if (cmd === '/me') {
    const r = await main('/api/bot/me', { tg: from.id });
    if (!r.ok) return say(chat, 'Ты ещё не зарегистрирован. Нажми /login — аккаунт создастся автоматически.');
    const u = r.me;
    return say(chat, `👤 <b>${esc(u.nick)}</b>\nРоль: ${u.role}\nПросмотрено записей: ${r.watched}\nУведомления: ${u.notify ? 'вкл' : 'выкл'}${u.banned ? '\n⛔ Заблокирован' + (u.banned.reason ? ': ' + esc(u.banned.reason) : '') : ''}`, kb([[urlBtn('Открыть профиль', SITE + '/me')]]));
  }
  if (cmd === '/latest') {
    const r = await main('/api/bot/latest');
    if (!r.items?.length) return say(chat, 'Пока пусто 📭');
    return say(chat, '📼 <b>Свежие записи</b>\n\n' + r.items.map((v) => `• <a href="${SITE}/v/${v.id}">${esc(v.title)}</a> — ${v.stream_date}, ${Math.floor(v.duration / 3600)}ч ${Math.floor((v.duration % 3600) / 60)}м`).join('\n'));
  }
  if (cmd === '/notify') {
    const me = await main('/api/bot/me', { tg: from.id });
    if (!me.ok) return say(chat, 'Сначала войди: /login');
    const on = arg ? arg === 'on' : !me.me.notify;
    await main('/api/bot/notify', { tg: from.id, on });
    return say(chat, on ? '🔔 Буду присылать новые записи.' : '🔕 Уведомления выключены.');
  }
  if (cmd === '/logout') { const r = await main('/api/bot/logout', { tg: from.id }); return say(chat, r.ok ? '🚪 Вышел на всех устройствах.' : 'Аккаунт не найден.'); }
  return say(chat, HELP(m.from.first_name));
}

async function magic(chat, from) {
  const r = await main('/api/bot/magic', { tg: from });
  if (!r.ok) return say(chat, '⚠️ ' + esc(r.error || 'Не получилось'));
  if (r.needAvatar) importAvatar(from);
  return say(chat, `${r.created ? '🎉 Аккаунт создан! Твой ник: <b>' + esc(r.nick) + '</b> (можно сменить на сайте)\n\n' : ''}Ссылка для входа действует 5 минут и срабатывает один раз:`, kb([[urlBtn('🔑 Войти на сайт', r.url)]]));
}

async function onCallback(q) {
  const data = q.data || '', chat = q.message?.chat.id, mid = q.message?.message_id;
  const ans = (text) => tg('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {});
  const edit = (text, markup) => tg('editMessageText', { chat_id: chat, message_id: mid, text, parse_mode: 'HTML', reply_markup: markup }).catch(() => {});
  if (data === 'noop') return ans();
  if (data === 'magic') { ans(); return magic(chat, tgUser(q.from)); }
  const [act, code] = data.split(':');
  if (act === 'ok' || act === 'no') {
    const r = await main('/api/bot/confirm', { code, tg: tgUser(q.from), deny: act === 'no' });
    if (act === 'no') { ans('Отменено'); return edit('✖ Вход отменён.'); }
    if (!r.ok) { ans('Ошибка'); return edit('⚠️ ' + esc(r.error || 'Не удалось')); }
    ans('Готово!');
    if (r.needAvatar) importAvatar(q.from);
    return edit(`✅ <b>Вход подтверждён!</b>\nВозвращайся на сайт — всё уже готово.${r.created ? '\n\n🎉 Добро пожаловать! Твой ник: <b>' + esc(r.nick) + '</b>\nСменить ник и аватарку можно в профиле.' : ''}`);
  }
}

async function onUpdate(u) {
  try { if (u.message) await onMessage(u.message); else if (u.callback_query) await onCallback(u.callback_query); }
  catch (e) { log('update error', e.message); }
}

// ---------- outgoing notification queue (respects Telegram limits) ----------
const queue = []; let sending = false; const stats = { sent: 0, failed: 0, blocked: 0, updates: 0, started: Date.now() };
async function pump() {
  if (sending) return; sending = true;
  while (queue.length) {
    const m = queue.shift();
    try { await say(m.chat, m.text, m.url ? kb([[urlBtn(m.button || 'Открыть', m.url)]]) : undefined); stats.sent++; }
    catch (e) {
      if (e.code === 429) { queue.unshift(m); await new Promise((r) => setTimeout(r, (e.retry || 3) * 1000)); continue; }
      if (e.code === 403) stats.blocked++; else stats.failed++;
    }
    await new Promise((r) => setTimeout(r, 40)); // ~25 msg/s
  }
  sending = false;
}

const server = http.createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  try {
    if (p === '/health' || p === '/') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, mode: MODE, queue: queue.length, ...stats, rss: process.memoryUsage().rss })); }
    if (p === '/notify' && req.method === 'POST') {
      if (!safeEq(req.headers['x-bot-secret'], SECRET)) { res.writeHead(401); return res.end(); }
      const b = await readJson(req, 4 << 20);
      for (const chat of b.chats || []) queue.push({ chat, text: String(b.text || ''), url: b.url, button: b.button });
      pump();
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ queued: (b.chats || []).length }));
    }
    if (MODE === 'webhook' && p === HOOK_PATH && req.method === 'POST') {
      if (!safeEq(req.headers['x-telegram-bot-api-secret-token'], SECRET.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 200))) { res.writeHead(401); return res.end(); }
      const u = await readJson(req, 1 << 20); stats.updates++; res.writeHead(200); res.end(); return onUpdate(u);
    }
    res.writeHead(404); res.end();
  } catch (e) { res.writeHead(500); res.end(); }
});

async function poll() {
  let offset = 0;
  try { await tg('deleteWebhook', {}); } catch {}
  for (;;) {
    try {
      const ups = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 65000);
      for (const u of ups) { offset = u.update_id + 1; stats.updates++; onUpdate(u); }
    } catch (e) { log('poll error', e.message); await new Promise((r) => setTimeout(r, e.code === 409 ? 10000 : 3000)); }
  }
}

server.listen(envInt('PORT', 10001), async () => {
  log(`V_N bot on :${server.address().port}, mode=${MODE}, main=${MAIN}`);
  if (!TOKEN) return;
  tg('setMyCommands', { commands: [{ command: 'login', description: 'Войти на сайт' }, { command: 'me', description: 'Мой профиль' }, { command: 'latest', description: 'Свежие записи' }, { command: 'notify', description: 'Уведомления вкл/выкл' }, { command: 'logout', description: 'Выйти везде' }] }).catch(() => {});
  if (MODE === 'webhook' && PUBLIC_URL) await tg('setWebhook', { url: PUBLIC_URL + HOOK_PATH, secret_token: SECRET.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 200), allowed_updates: ['message', 'callback_query'], max_connections: 10 }).then(() => log('webhook set')).catch((e) => log('webhook', e.message));
  else poll();
  // keep main awake as well (mutual keep-alive)
  setInterval(() => fetch(MAIN + '/health').catch(() => {}), 9 * 60e3).unref();
});
process.on('unhandledRejection', (e) => log('unhandled', e?.message || e));
