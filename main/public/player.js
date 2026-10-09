// V_N player — tiny MSE engine for fMP4 HLS (AV1/H.264 + shared AAC), ABR, node failover, storyboard previews.
(() => {
'use strict';
const MS = window.ManagedMediaSource || window.MediaSource;
const attrs = (l) => { const o = {}; l.replace(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g, (_, k, v) => { o[k] = v.replace(/^"|"$/g, ''); }); return o; };
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const LS = { get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

class Engine {
  constructor(video, o) {
    this.v = video; this.o = o; this.bases = o.bases.slice(); this.bi = 0; this.path = o.path;
    this.bw = LS.get('vn_bw', 4e6); this.manual = null; this.maxAhead = 40; this.backKeep = 25;
    this.tracks = []; this.pl = new Map(); this.fails = 0; this.ac = new Set(); this.dead = false;
    this.stat = { node: this.bases[0]?.id, bytes: 0, segs: 0, switches: 0, errors: 0 };
  }
  url(u) { return this.bases[this.bi].url + this.path + u; }
  emit(t, d) { this.o.on?.(t, d); }
  async fetchBuf(u, kind) {
    let lastErr;
    for (let attempt = 0; attempt < Math.max(3, this.bases.length * 2); attempt++) {
      if (this.dead) throw new Error('dead');
      const ac = new AbortController(); this.ac.add(ac);
      const to = setTimeout(() => ac.abort(), kind === 'seg' ? 20000 : 10000);
      const t0 = performance.now();
      try {
        const r = await fetch(this.url(u), { signal: ac.signal, cache: 'force-cache' });
        if (r.status === 403) { const e = new Error('token'); e.token = true; throw e; }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const b = await r.arrayBuffer();
        const ms = performance.now() - t0;
        if (kind === 'seg' && b.byteLength > 60000 && ms > 30) { const s = (b.byteLength * 8) / (ms / 1000); this.bw = this.bw * 0.7 + s * 0.3; LS.set('vn_bw', Math.round(this.bw)); }
        this.stat.bytes += b.byteLength; this.fails = 0;
        return b;
      } catch (e) {
        lastErr = e;
        if (ac.signal.aborted && this.seekAbort) { this.seekAbort = false; throw e; }
        if (e.token && this.o.refresh && attempt < 2) { await this.o.refresh(); continue; }
        this.stat.errors++;
        if (this.bases.length > 1) { this.bi = (this.bi + 1) % this.bases.length; this.stat.node = this.bases[this.bi].id; this.emit('node', this.bases[this.bi]); }
        await new Promise((r) => setTimeout(r, 300 * attempt));
      } finally { clearTimeout(to); this.ac.delete(ac); }
    }
    throw lastErr;
  }
  async text(u) { return new TextDecoder().decode(await this.fetchBuf(u, 'pl')); }
  async media(r) {
    if (this.pl.has(r.uri)) return this.pl.get(r.uri);
    const dir = r.uri.replace(/[^/]*$/, '');
    const txt = await this.text(r.uri); const segs = []; let init = null, d = 0, start = 0;
    for (const l of txt.split('\n')) {
      if (l.startsWith('#EXT-X-MAP:')) init = dir + attrs(l.slice(11)).URI;
      else if (l.startsWith('#EXTINF:')) d = parseFloat(l.slice(8));
      else if (l && !l.startsWith('#')) { segs.push({ uri: dir + l.trim(), s: start, d }); start += d; }
    }
    const m = { init, segs, dur: start }; this.pl.set(r.uri, m); return m;
  }
  async load(startAt = 0) {
    const txt = await this.text('master.m3u8');
    const lines = txt.split('\n'); let audio = null; const vars = [];
    lines.forEach((l, i) => {
      if (l.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(l)) audio = { uri: attrs(l).URI };
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = attrs(l.slice(18)); const cs = (a.CODECS || '').split(',');
        const [w, h] = (a.RESOLUTION || '0x0').split('x').map(Number);
        vars.push({ bw: +a.BANDWIDTH, abw: +(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH), vc: cs.find((c) => !c.startsWith('mp4a')) || cs[0], ac: cs.find((c) => c.startsWith('mp4a')), w, h, fps: +(a['FRAME-RATE'] || 30), uri: lines[i + 1].trim() });
      }
    });
    if (!MS) return this.native(startAt);
    let ok = vars.filter((v) => MS.isTypeSupported(`video/mp4; codecs="${v.vc}"`));
    const av1 = ok.filter((v) => v.vc.startsWith('av01')), avc = ok.filter((v) => !v.vc.startsWith('av01'));
    let fam = av1.length ? av1 : avc;
    if (av1.length && avc.length && navigator.mediaCapabilities) {
      try {
        const top = av1.reduce((a, b) => (b.h > a.h ? b : a));
        const info = await navigator.mediaCapabilities.decodingInfo({ type: 'media-source', video: { contentType: `video/mp4; codecs="${top.vc}"`, width: top.w, height: top.h, bitrate: top.bw, framerate: top.fps } });
        const mobile = navigator.userAgentData?.mobile || /Mobi|Android/i.test(navigator.userAgent);
        if (!info.smooth || (mobile && !info.powerEfficient)) fam = avc;
      } catch {}
    }
    if (!fam.length) { if (this.v.canPlayType('application/vnd.apple.mpegurl')) return this.native(startAt); throw new Error('Браузер не поддерживает эти кодеки'); }
    this.vars = fam.sort((a, b) => a.bw - b.bw);
    this.audio = audio && vars[0]?.ac ? { uri: audio.uri, codec: vars[0].ac } : null;
    this.cur = this.pickAuto(true);
    this.ms = new MS();
    if (window.ManagedMediaSource) this.v.disableRemotePlayback = true;
    this.v.src = URL.createObjectURL(this.ms);
    await new Promise((r) => this.ms.addEventListener('sourceopen', r, { once: true }));
    const vm = await this.media(this.cur);
    this.ms.duration = vm.dur;
    this.tracks = [{ kind: 'video', sb: this.ms.addSourceBuffer(`video/mp4; codecs="${this.cur.vc}"`), init: null, last: -1, busy: false, ended: false }];
    if (this.audio) this.tracks.push({ kind: 'audio', sb: this.ms.addSourceBuffer(`audio/mp4; codecs="${this.audio.codec}"`), init: null, last: -1, busy: false, ended: false });
    if (startAt > 0) this.v.currentTime = startAt;
    const kick = () => this.pumpAll();
    for (const e of ['timeupdate', 'playing', 'play']) this.v.addEventListener(e, kick);
    this.v.addEventListener('seeking', () => { this.seekAbort = true; for (const a of this.ac) a.abort(); this.tracks.forEach((t) => { t.last = -1; t.ended = false; }); setTimeout(kick, 0); });
    this.iv = setInterval(() => { this.watch(); kick(); }, 700);
    this.emit('levels', this.vars);
    kick();
  }
  native(startAt) { this.isNative = true; this.v.src = this.url('master.m3u8'); if (startAt) this.v.addEventListener('loadedmetadata', () => (this.v.currentTime = startAt), { once: true }); this.emit('levels', []); }
  pickAuto(initial) {
    const box = this.o.box?.() || { h: 720 }; const dpr = Math.min(2, devicePixelRatio || 1);
    const capH = this.capH || 1e9; const sizeH = box.h * dpr * 1.15;
    const fits = this.vars.filter((v) => v.h <= capH);
    let pool = fits.length ? fits : [this.vars[0]];
    const rung = pool.find((v) => v.h >= sizeH) || pool[pool.length - 1];
    pool = pool.filter((v) => v.h <= rung.h);
    const ahead = initial ? 0 : this.ahead();
    const budget = this.bw * (ahead > 20 ? 0.85 : ahead > 8 ? 0.7 : 0.5);
    let best = pool[0];
    for (const v of pool) if (v.bw <= budget) best = v;
    if (!initial && this.cur && best.bw > this.cur.bw && ahead < 12) best = this.cur; // hysteresis: go up only with buffer
    return best;
  }
  level() { return this.manual ?? this.cur; }
  setLevel(h) {
    this.manual = h === 'auto' ? null : this.vars.find((v) => v.h === h) || null;
    const nv = this.manual || this.pickAuto();
    if (nv !== this.cur) { this.cur = nv; this.stat.switches++; this.flushAhead(); }
    this.emit('level', this.cur);
  }
  async flushAhead() {
    const t = this.tracks[0]; if (!t) return; const at = this.v.currentTime + 1.5;
    for (let i = 0; i < 50 && t.busy; i++) await new Promise((r) => setTimeout(r, 50));
    try { if (t.sb.buffered.length && t.sb.buffered.end(t.sb.buffered.length - 1) > at) await this.sbOp(t.sb, () => t.sb.remove(at, Infinity)); } catch {}
    t.last = -1; t.ended = false; this.pumpAll();
  }
  ahead(t = this.tracks[0]) { if (!t) return 0; const b = t.sb.buffered, c = this.v.currentTime; for (let i = 0; i < b.length; i++) if (b.start(i) <= c + 0.3 && b.end(i) >= c) return b.end(i) - c; return 0; }
  bufEnd(t) { const b = t.sb.buffered, c = this.v.currentTime; for (let i = 0; i < b.length; i++) if (b.start(i) <= c + 0.3 && b.end(i) >= c) return b.end(i); return c; }
  sbOp(sb, fn) { return new Promise((res, rej) => { const done = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', er); res(); }; const er = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', er); rej(new Error('sb error')); }; sb.addEventListener('updateend', done); sb.addEventListener('error', er); try { fn(); } catch (e) { sb.removeEventListener('updateend', done); sb.removeEventListener('error', er); rej(e); } }); }
  async append(t, buf) {
    try { await this.sbOp(t.sb, () => t.sb.appendBuffer(buf)); }
    catch (e) {
      if (e.name !== 'QuotaExceededError') throw e;
      this.maxAhead = Math.max(12, this.maxAhead * 0.7); this.backKeep = 8;
      await this.evict(t, true); await this.sbOp(t.sb, () => t.sb.appendBuffer(buf));
    }
  }
  async evict(t, hard) {
    const c = this.v.currentTime, b = t.sb.buffered; if (!b.length || t.sb.updating) return;
    const keep = hard ? 4 : this.backKeep;
    if (b.start(0) < c - keep - 5) await this.sbOp(t.sb, () => t.sb.remove(0, c - keep)).catch(() => {});
    const far = c + this.maxAhead + 30;
    if (t.sb.buffered.length && t.sb.buffered.end(t.sb.buffered.length - 1) > far + 10) await this.sbOp(t.sb, () => t.sb.remove(far, Infinity)).catch(() => {});
  }
  pumpAll() { if (this.dead || !this.ms || this.ms.readyState !== 'open') return; for (const t of this.tracks) this.pump(t); }
  async pump(t) {
    if (t.busy || t.sb.updating) return;
    const target = this.v.paused ? Math.min(20, this.maxAhead) : this.maxAhead;
    if (this.ahead(t) >= target) { if (Math.random() < 0.1) this.evict(t); return; }
    t.busy = true;
    try {
      let rend;
      if (t.kind === 'video') { if (!this.manual) { const n = this.pickAuto(); if (n !== this.cur) { this.cur = n; this.stat.switches++; this.emit('level', n); } } rend = this.level(); }
      else rend = this.audio;
      const m = await this.media(rend);
      let idx = segAt(m.segs, this.bufEnd(t) + 0.08);
      if (t.last >= 0 && idx <= t.last && t.lastRend === rend.uri) idx = t.last + 1;
      if (idx >= m.segs.length) { t.ended = true; this.maybeEnd(); return; }
      if (t.init !== rend.uri) { const ib = await this.fetchBuf(m.init, 'init'); await this.append(t, ib); t.init = rend.uri; }
      const seg = m.segs[idx];
      const buf = await this.fetchBuf(seg.uri, 'seg');
      if (this.dead) return;
      await this.append(t, buf);
      t.last = idx; t.lastRend = rend.uri; this.stat.segs++;
    } catch (e) {
      if (!this.dead && e.name !== 'AbortError' && e.message !== 'dead') { this.emit('error', e); }
    } finally { t.busy = false; if (!this.dead) setTimeout(() => this.pump(t), 0); }
  }
  maybeEnd() { if (this.tracks.every((t) => t.ended && !t.sb.updating) && this.ms.readyState === 'open') { try { this.ms.endOfStream(); } catch {} } }
  watch() {
    const v = this.v;
    // jump small gaps
    if (this.tracks[0] && !v.paused && v.readyState < 3) {
      const b = this.tracks[0].sb.buffered;
      for (let i = 0; i < b.length; i++) if (b.start(i) > v.currentTime && b.start(i) - v.currentTime < 1.2) { v.currentTime = b.start(i) + 0.05; break; }
      this.stall = (this.stall || 0) + 1;
      if (this.stall > 12 && this.bases.length > 1) { this.stall = 0; this.bi = (this.bi + 1) % this.bases.length; this.stat.node = this.bases[this.bi].id; this.emit('node', this.bases[this.bi]); for (const a of this.ac) a.abort(); }
    } else this.stall = 0;
    // dropped frames → cap resolution
    const q = v.getVideoPlaybackQuality?.();
    if (q && this.cur) {
      const df = q.droppedVideoFrames - (this.lq?.d || 0), tf = q.totalVideoFrames - (this.lq?.t || 0);
      if (tf > 120) { if (df / tf > 0.15 && this.cur.h > this.vars[0].h) { this.capH = this.cur.h - 1; this.emit('toast', 'Устройство не тянет ' + this.cur.h + 'p — снижаю качество'); } this.lq = { d: q.droppedVideoFrames, t: q.totalVideoFrames }; }
    }
  }
  setPath(p, bases) { this.path = p; if (bases?.length) { this.bases = bases; this.bi = 0; } }
  destroy() { this.dead = true; clearInterval(this.iv); for (const a of this.ac) a.abort(); try { if (this.ms?.readyState === 'open') this.ms.endOfStream(); } catch {} this.v.removeAttribute('src'); this.v.load(); }
}
function segAt(segs, t) { let lo = 0, hi = segs.length - 1; if (t >= segs[hi].s + segs[hi].d) return segs.length; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].s <= t) lo = m; else hi = m - 1; } return lo; }

const I = {
  play: '<path d="M8 5.5v13l11-6.5z"/>', pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>',
  back: '<path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/><text x="12" y="16.5" font-size="6.5" text-anchor="middle" fill="currentColor" font-family="monospace">10</text>',
  fwd: '<path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="16.5" font-size="6.5" text-anchor="middle" fill="currentColor" font-family="monospace">10</text>',
  vol: '<path d="M4 9v6h4l5 4V5L8 9zM16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 9v6h4l5 4V5L8 9z"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="1.8"/>',
  fs: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2"/>',
  fsx: '<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" fill="none" stroke="currentColor" stroke-width="2"/>',
  pip: '<rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="12" y="11" width="7" height="6" rx="1"/>',
  th: '<rect x="2" y="7" width="20" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  gear: '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm8.4 4.6.1-1.1-.1-1.1 2-1.6-2-3.4-2.4 1a8 8 0 0 0-1.9-1.1L15.8 3h-3.9l-.4 2.7a8 8 0 0 0-1.9 1.1l-2.4-1-2 3.4 2 1.6-.1 1.1.1 1.1-2 1.6 2 3.4 2.4-1c.6.5 1.2.8 1.9 1.1l.4 2.7h3.9l.4-2.7c.7-.3 1.3-.6 1.9-1.1l2.4 1 2-3.4z" transform="scale(.92) translate(1 1)"/>',
  info: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M11 10.5h2V17h-2zM11 7h2v2h-2z"/>',
};
const svg = (n) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${I[n]}</svg>`;

class VNPlayer {
  constructor(root, o) {
    this.o = o; this.root = root; this.chapters = o.chapters || []; this.dur = o.dur || 0;
    root.innerHTML = `<div class="vp" tabindex="0">
      <video playsinline preload="auto"></video>
      <div class="vp-scan"></div><div class="vp-big">${svg('play')}</div><div class="vp-spin"></div><div class="vp-toast"></div><div class="vp-flash"></div>
      <pre class="vp-stats" hidden></pre>
      <div class="vp-ui">
        <div class="vp-tl"><div class="vp-tl-in"><div class="vp-buf"></div><div class="vp-cur"></div><div class="vp-hov"></div>${''}</div><div class="vp-chs"></div><div class="vp-knob"></div>
          <div class="vp-prev" hidden><div class="vp-prev-img"></div><b class="vp-prev-ch"></b><span class="vp-prev-t"></span></div></div>
        <div class="vp-row">
          <button class="vp-b" data-a="play" title="Пуск/пауза (K)">${svg('play')}</button>
          <button class="vp-b" data-a="back" title="−10 с (J)">${svg('back')}</button>
          <button class="vp-b" data-a="fwd" title="+10 с (L)">${svg('fwd')}</button>
          <div class="vp-vol"><button class="vp-b" data-a="mute" title="Звук (M)">${svg('vol')}</button><input type="range" min="0" max="1" step="0.02" class="vp-vr" aria-label="Громкость"><span class="vp-vn"></span></div>
          <span class="vp-time"><b class="vp-tc">0:00</b> / <span class="vp-td">0:00</span></span>
          <span class="vp-chn"></span>
          <span class="vp-sp"></span>
          <button class="vp-b vp-txt" data-a="speed" title="Скорость">1×</button>
          <button class="vp-b vp-txt vp-q" data-a="quality" title="Качество">АВТО</button>
          <button class="vp-b" data-a="stats" title="Статистика">${svg('info')}</button>
          <button class="vp-b" data-a="pip" title="Картинка в картинке">${svg('pip')}</button>
          <button class="vp-b" data-a="theater" title="Театр (T)">${svg('th')}</button>
          <button class="vp-b" data-a="fs" title="Полный экран (F)">${svg('fs')}</button>
        </div>
      </div>
      <div class="vp-menu" hidden></div>
    </div>`;
    const $ = (s) => root.querySelector(s);
    this.el = { vp: $('.vp'), v: $('video'), big: $('.vp-big'), spin: $('.vp-spin'), toast: $('.vp-toast'), flash: $('.vp-flash'), stats: $('.vp-stats'), tl: $('.vp-tl'), buf: $('.vp-buf'), cur: $('.vp-cur'), hov: $('.vp-hov'), knob: $('.vp-knob'), chs: $('.vp-chs'),
      prev: $('.vp-prev'), prevImg: $('.vp-prev-img'), prevT: $('.vp-prev-t'), prevCh: $('.vp-prev-ch'), tc: $('.vp-tc'), td: $('.vp-td'), chn: $('.vp-chn'), vr: $('.vp-vr'), vn: $('.vp-vn'), menu: $('.vp-menu'), q: $('.vp-q'), speed: $('[data-a=speed]'), play: $('[data-a=play]'), mute: $('[data-a=mute]'), fs: $('[data-a=fs]') };
    const v = this.el.v;
    v.volume = LS.get('vn_vol', 0.8); v.muted = LS.get('vn_muted', false); v.playbackRate = LS.get('vn_speed', 1);
    this.bind(); this.renderChapters(); this.syncVol(); this.el.speed.textContent = v.playbackRate + '×';
    this.start(o.start || 0);
  }
  async start(at) {
    const o = this.o;
    try {
      this.engine = new Engine(this.el.v, { bases: o.bases, path: o.path, box: () => ({ h: this.el.vp.clientHeight }), refresh: o.refresh ? async () => { const r = await o.refresh(); this.engine.setPath(r.path, r.bases); } : null,
        on: (t, d) => {
          if (t === 'node') this.toast('Переключаюсь на узел ' + d.id + ' (' + d.rg + ')');
          if (t === 'toast') this.toast(d);
          if (t === 'levels' || t === 'level') this.syncQ();
          if (t === 'error') { if (++this.errs > 6) this.toast('Проблемы с сетью…'); }
        } });
      this.errs = 0;
      await this.engine.load(at);
      const q = LS.get('vn_q', 'auto'); if (q !== 'auto' && this.engine.vars?.some((x) => x.h === q)) this.engine.setLevel(q);
      if (o.autoplay !== false) this.el.v.play().catch(() => this.el.vp.classList.add('vp-paused'));
    } catch (e) { this.toast('Ошибка: ' + e.message, 8000); }
  }
  bind() {
    const { vp, v, tl, vr, menu } = this.el;
    const on = (el, ev, fn, o) => el.addEventListener(ev, fn, o);
    on(v, 'play', () => this.syncPlay()); on(v, 'pause', () => this.syncPlay());
    on(v, 'waiting', () => vp.classList.add('vp-wait')); on(v, 'playing', () => vp.classList.remove('vp-wait')); on(v, 'canplay', () => vp.classList.remove('vp-wait'));
    on(v, 'timeupdate', () => this.syncTime()); on(v, 'progress', () => this.syncBuf()); on(v, 'durationchange', () => this.syncTime());
    on(v, 'volumechange', () => this.syncVol()); on(v, 'ratechange', () => { this.el.speed.textContent = v.playbackRate + '×'; LS.set('vn_speed', v.playbackRate); });
    on(v, 'ended', () => this.o.onEnded?.());
    on(v, 'click', () => this.toggle()); on(this.el.big, 'click', () => this.toggle());
    on(v, 'dblclick', () => this.fs());
    vp.querySelectorAll('[data-a]').forEach((b) => on(b, 'click', (e) => { e.stopPropagation(); this.act(b.dataset.a, b); }));
    on(vr, 'input', () => { v.volume = +vr.value; v.muted = v.volume === 0; });
    on(vp.querySelector('.vp-vol'), 'wheel', (e) => { e.preventDefault(); v.volume = Math.min(1, Math.max(0, v.volume + (e.deltaY < 0 ? 0.05 : -0.05))); v.muted = false; }, { passive: false });
    // timeline
    let drag = false;
    const pos = (e) => { const r = tl.getBoundingClientRect(); return Math.min(1, Math.max(0, ((e.touches?.[0] || e).clientX - r.left) / r.width)); };
    on(tl, 'pointerdown', (e) => { drag = true; tl.setPointerCapture(e.pointerId); this.scrub(pos(e)); });
    on(tl, 'pointermove', (e) => { this.preview(pos(e)); if (drag) this.scrub(pos(e)); });
    on(tl, 'pointerup', (e) => { if (drag) { drag = false; v.currentTime = pos(e) * this.D(); } });
    on(tl, 'pointerleave', () => { if (!drag) this.el.prev.hidden = true; this.el.hov.style.width = 0; });
    // auto-hide
    let hideT; const wake = () => { vp.classList.add('vp-act'); clearTimeout(hideT); hideT = setTimeout(() => { if (!v.paused && menu.hidden) vp.classList.remove('vp-act'); }, 2600); };
    on(vp, 'pointermove', wake); on(vp, 'pointerdown', wake); on(vp, 'keydown', wake);
    on(vp, 'keydown', (e) => this.key(e));
    on(document, 'fullscreenchange', () => { this.el.fs.innerHTML = svg(document.fullscreenElement ? 'fsx' : 'fs'); });
    on(document, 'pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
    // touch double-tap seek
    let lastTap = 0;
    on(v, 'touchend', (e) => { const now = Date.now(); const x = e.changedTouches[0].clientX / vp.clientWidth; if (now - lastTap < 300) { e.preventDefault(); this.seekBy(x < 0.4 ? -10 : x > 0.6 ? 10 : 0); } lastTap = now; });
    // progress reporting
    this.pi = setInterval(() => { if (!v.paused && v.currentTime > 5) this.o.onProgress?.(v.currentTime, this.D()); if (!this.el.stats.hidden) this.renderStats(); }, 10000);
    on(window, 'pagehide', () => this.o.onProgress?.(v.currentTime, this.D(), true));
    if ('mediaSession' in navigator && this.o.title) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: this.o.title, artist: 'V_N', artwork: this.o.cover ? [{ src: this.o.cover, sizes: '1280x720', type: 'image/webp' }] : [] });
      for (const [a, f] of [['play', () => v.play()], ['pause', () => v.pause()], ['seekbackward', () => this.seekBy(-10)], ['seekforward', () => this.seekBy(10)], ['seekto', (d) => (v.currentTime = d.seekTime)]]) { try { navigator.mediaSession.setActionHandler(a, f); } catch {} }
    }
  }
  D() { return isFinite(this.el.v.duration) && this.el.v.duration > 0 ? this.el.v.duration : this.dur || 1; }
  key(e) {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    const v = this.el.v, k = e.key;
    const map = { ' ': () => this.toggle(), k: () => this.toggle(), 'л': () => this.toggle(), j: () => this.seekBy(-10), 'о': () => this.seekBy(-10), l: () => this.seekBy(10), 'д': () => this.seekBy(10), ArrowLeft: () => this.seekBy(-5), ArrowRight: () => this.seekBy(5),
      ArrowUp: () => { v.volume = Math.min(1, v.volume + 0.05); v.muted = false; this.flash(Math.round(v.volume * 100) + '%'); }, ArrowDown: () => { v.volume = Math.max(0, v.volume - 0.05); this.flash(Math.round(v.volume * 100) + '%'); },
      m: () => this.act('mute'), 'ь': () => this.act('mute'), f: () => this.fs(), 'а': () => this.fs(), t: () => this.act('theater'), 'е': () => this.act('theater'),
      '>': () => this.rate(0.25), '<': () => this.rate(-0.25), Home: () => (v.currentTime = 0), End: () => (v.currentTime = this.D() - 1),
      PageDown: () => this.chapterJump(1), PageUp: () => this.chapterJump(-1) };
    if (/^[0-9]$/.test(k) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); v.currentTime = (this.D() * Number(k)) / 10; return; }
    const f = map[k] || map[k.toLowerCase?.()];
    if (f && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); f(); }
  }
  toggle() { const v = this.el.v; if (v.paused) v.play().catch(() => {}); else v.pause(); }
  seekBy(s) { if (!s) return; const v = this.el.v; v.currentTime = Math.min(this.D() - 0.5, Math.max(0, v.currentTime + s)); this.flash((s > 0 ? '+' : '−') + Math.abs(s) + ' с'); }
  rate(d) { const v = this.el.v; v.playbackRate = Math.min(3, Math.max(0.25, Math.round((v.playbackRate + d) * 100) / 100)); this.flash(v.playbackRate + '×'); }
  seek(t) { this.el.v.currentTime = t; this.el.v.play().catch(() => {}); }
  chapterJump(dir) { const t = this.el.v.currentTime; const ch = this.chapters; if (!ch.length) return; if (dir > 0) { const n = ch.find((c) => c.t > t + 1); if (n) this.el.v.currentTime = n.t; } else { const p = [...ch].reverse().find((c) => c.t < t - 3); this.el.v.currentTime = p ? p.t : 0; } }
  scrub(f) { this.el.cur.style.width = f * 100 + '%'; this.el.knob.style.left = f * 100 + '%'; this.el.tc.textContent = fmt(f * this.D()); this.preview(f); }
  preview(f) {
    const t = f * this.D(), { prev, prevImg, prevT, prevCh, tl } = this.el;
    this.el.hov.style.width = f * 100 + '%';
    prev.hidden = false; prevT.textContent = fmt(t);
    const ch = this.chapterAt(t); prevCh.textContent = ch ? ch.title : '';
    const sb = this.o.sb;
    if (sb && this.engine && !this.engine.isNative) {
      const i = Math.min(sb.n - 1, Math.floor(t / sb.i)), per = sb.c * sb.r, sheet = Math.floor(i / per), k = i % per;
      prevImg.style.backgroundImage = `url("${this.engine.url(`sb/sb_${String(sheet + 1).padStart(3, '0')}.${sb.ext}`)}")`;
      prevImg.style.backgroundPosition = `-${(k % sb.c) * sb.w}px -${Math.floor(k / sb.c) * sb.h}px`;
      prevImg.style.display = '';
    } else prevImg.style.display = 'none';
    const w = tl.clientWidth, pw = prev.offsetWidth || 170;
    prev.style.left = Math.min(w - pw / 2, Math.max(pw / 2, f * w)) + 'px';
  }
  chapterAt(t) { let c = null; for (const x of this.chapters) if (x.t <= t) c = x; return c; }
  renderChapters() {
    const d = this.dur; if (!d || !this.chapters.length) { this.el.chs.innerHTML = ''; return; }
    this.el.chs.innerHTML = this.chapters.filter((c) => c.t > 0).map((c) => `<i style="left:${(c.t / d) * 100}%"></i>`).join('');
  }
  setChapters(ch) { this.chapters = ch || []; this.renderChapters(); }
  syncPlay() { const p = this.el.v.paused; this.el.play.innerHTML = svg(p ? 'play' : 'pause'); this.el.vp.classList.toggle('vp-paused', p); this.el.big.innerHTML = svg(p ? 'play' : 'pause'); if (navigator.mediaSession) navigator.mediaSession.playbackState = p ? 'paused' : 'playing'; }
  syncTime() {
    const v = this.el.v, D = this.D(), f = v.currentTime / D;
    this.el.cur.style.width = f * 100 + '%'; this.el.knob.style.left = f * 100 + '%';
    this.el.tc.textContent = fmt(v.currentTime); this.el.td.textContent = fmt(D);
    const ch = this.chapterAt(v.currentTime); this.el.chn.textContent = ch ? '· ' + ch.title : '';
    if (ch !== this.lastCh) { this.lastCh = ch; this.o.onChapter?.(ch); }
  }
  syncBuf() { const v = this.el.v, b = v.buffered; let e = 0; for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5) e = Math.max(e, b.end(i)); this.el.buf.style.width = (e / this.D()) * 100 + '%'; }
  syncVol() { const v = this.el.v; this.el.vr.value = v.muted ? 0 : v.volume; this.el.vr.style.setProperty('--p', (v.muted ? 0 : v.volume) * 100 + '%'); this.el.mute.innerHTML = svg(v.muted || v.volume === 0 ? 'mute' : 'vol'); this.el.vn.textContent = v.muted ? '0' : Math.round(v.volume * 100); LS.set('vn_vol', v.volume); LS.set('vn_muted', v.muted); }
  syncQ() { const e = this.engine; if (!e) return; const c = e.cur; this.el.q.textContent = (e.manual ? '' : 'АВТО ') + (c ? c.h + 'p' + (c.fps > 31 ? c.fps.toFixed(0) : '') : ''); this.el.q.classList.toggle('vp-hd', !!c && c.h >= 1080); }
  flash(t) { const f = this.el.flash; f.textContent = t; f.classList.remove('on'); void f.offsetWidth; f.classList.add('on'); }
  toast(t, ms = 3000) { const el = this.el.toast; el.textContent = t; el.classList.add('on'); clearTimeout(this.tt); this.tt = setTimeout(() => el.classList.remove('on'), ms); }
  fs() { const vp = this.el.vp; if (document.fullscreenElement) document.exitFullscreen(); else if (vp.requestFullscreen) vp.requestFullscreen().catch(() => {}); else this.el.v.webkitEnterFullscreen?.(); }
  menu(btn, items, cur, pick, title) {
    const m = this.el.menu;
    m.innerHTML = `<div class="vp-mt">${title}</div>` + items.map((it) => `<button data-v="${it.v}" class="${String(it.v) === String(cur) ? 'on' : ''}">${it.l}${it.s ? `<small>${it.s}</small>` : ''}</button>`).join('');
    m.hidden = false;
    const r = btn.getBoundingClientRect(), pr = this.el.vp.getBoundingClientRect();
    m.style.right = Math.max(8, pr.right - r.right - 20) + 'px';
    m.querySelectorAll('button').forEach((b) => (b.onclick = () => { pick(b.dataset.v); m.hidden = true; }));
  }
  act(a, btn) {
    const v = this.el.v;
    switch (a) {
      case 'play': return this.toggle();
      case 'back': return this.seekBy(-10);
      case 'fwd': return this.seekBy(10);
      case 'mute': v.muted = !v.muted; if (!v.muted && v.volume === 0) v.volume = 0.5; return;
      case 'fs': return this.fs();
      case 'pip': if (document.pictureInPictureElement) document.exitPictureInPicture(); else v.requestPictureInPicture?.().catch(() => this.toast('PiP недоступен')); return;
      case 'theater': document.body.classList.toggle('theater'); LS.set('vn_theater', document.body.classList.contains('theater')); return;
      case 'stats': this.el.stats.hidden = !this.el.stats.hidden; this.renderStats(); return;
      case 'speed': return this.menu(btn, [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((x) => ({ v: x, l: x + '×' })), v.playbackRate, (x) => (v.playbackRate = +x), 'Скорость');
      case 'quality': {
        const e = this.engine; if (!e?.vars) return this.toast('Качество выбирает браузер');
        const items = [{ v: 'auto', l: 'Авто', s: e.cur && !e.manual ? e.cur.h + 'p' : '' }, ...[...e.vars].reverse().map((x) => ({ v: x.h, l: x.h + 'p' + (x.fps > 31 ? Math.round(x.fps) : '') + (x.h >= 1080 ? ' <em>HD</em>' : ''), s: (x.abw / 1e6).toFixed(1) + ' Мбит/с · ' + (x.vc.startsWith('av01') ? 'AV1' : 'H.264') }))];
        return this.menu(btn, items, e.manual ? e.manual.h : 'auto', (x) => { const val = x === 'auto' ? 'auto' : +x; e.setLevel(val); LS.set('vn_q', val); this.syncQ(); }, 'Качество');
      }
    }
  }
  renderStats() {
    const e = this.engine, v = this.el.v; if (!e) return;
    const q = v.getVideoPlaybackQuality?.() || {};
    this.el.stats.textContent = [`узел      ${e.stat.node} (${e.bases[e.bi]?.rg || '?'})`, `качество  ${e.cur ? e.cur.w + '×' + e.cur.h + '@' + Math.round(e.cur.fps) + ' ' + e.cur.vc : 'native'}`, `канал     ${(e.bw / 1e6).toFixed(2)} Мбит/с`,
      `буфер     ${e.ahead().toFixed(1)} с (цель ${Math.round(e.maxAhead)})`, `сегментов ${e.stat.segs} · ${(e.stat.bytes / 1048576).toFixed(1)} МБ`, `кадры     ${q.droppedVideoFrames || 0} потеряно / ${q.totalVideoFrames || 0}`, `ошибки    ${e.stat.errors} · смен качества ${e.stat.switches}`].join('\n');
  }
  destroy() { clearInterval(this.pi); this.o.onProgress?.(this.el.v.currentTime, this.D(), true); this.engine?.destroy(); this.root.innerHTML = ''; }
}
window.VNPlayer = VNPlayer; window.vnFmt = fmt;
})();
