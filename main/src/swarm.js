'use strict';
// Swarm coordinator: registry, health, geo-aware bounded-load rendezvous routing, warm-pool sleep/wake, traffic budgets.
const crypto = require('node:crypto');
const { log } = require('../../shared/lib');

const KNOWN = { oregon: -122.7, ohio: -83, virginia: -77.5, frankfurt: 8.7, singapore: 103.8 };
const EU_ASIA = /^Asia\/(Almaty|Qyzylorda|Qostanay|Aqtobe|Aqtau|Atyrau|Oral|Tashkent|Samarkand|Bishkek|Dushanbe|Ashgabat|Baku|Tbilisi|Yerevan|Tehran|Dubai|Muscat|Qatar|Riyadh|Kuwait|Bahrain|Baghdad|Beirut|Damascus|Amman|Jerusalem|Tel_Aviv|Nicosia|Famagusta|Yekaterinburg|Omsk|Novosibirsk|Barnaul|Tomsk|Novokuznetsk|Krasnoyarsk|Karachi|Kabul|Gaza|Hebron)$/;
function regionOrder(tz = '', offMin = 0, hint, present) {
  let base;
  if (/^(Europe|Africa|Atlantic)\//.test(tz) || EU_ASIA.test(tz)) base = ['frankfurt', 'virginia', 'singapore', 'ohio', 'oregon'];
  else if (/^(Asia|Australia|Indian|Pacific\/(Auckland|Fiji|Guam))\//.test(tz)) base = ['singapore', 'frankfurt', 'oregon', 'virginia', 'ohio'];
  else if (/^America\/(Los_Angeles|Vancouver|Tijuana|Phoenix|Denver|Edmonton|Boise|Anchorage|Juneau|Sitka|Whitehorse|Dawson|Hermosillo|Mazatlan)|^Pacific\/Honolulu/.test(tz)) base = ['oregon', 'ohio', 'virginia', 'frankfurt', 'singapore'];
  else if (/^America\/(Chicago|Winnipeg|Mexico_City|Monterrey|Matamoros|Regina|Indiana|Kentucky|Detroit)/.test(tz)) base = ['ohio', 'virginia', 'oregon', 'frankfurt', 'singapore'];
  else if (/^America\//.test(tz)) base = ['virginia', 'ohio', 'oregon', 'frankfurt', 'singapore'];
  else { const lon = -offMin / 60 * 15; base = Object.keys(KNOWN).sort((a, b) => dlon(lon, KNOWN[a]) - dlon(lon, KNOWN[b])); }
  const out = [];
  if (hint && present.has(hint)) out.push(hint);
  for (const r of base) if (!out.includes(r)) out.push(r);
  for (const r of present) if (!out.includes(r)) out.push(r);
  return out;
}
const dlon = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const hrw = (a, b) => crypto.createHash('md5').update(a + '|' + b).digest().readUInt32BE(0) / 4294967296;
const month = () => new Date().toISOString().slice(0, 7);

class Swarm {
  constructor(db, swift, cfg) {
    this.db = db; this.swift = swift; this.cfg = cfg; // cfg: {publicUrl, botUrl, secret}
    this.nodes = new Map();
    this.revoked = new Map(); // userId -> until
    this.hist = []; // swarm-wide history
    for (const r of db.all('SELECT * FROM nodes')) this.nodes.set(r.id, this.mk(r));
    this.timer = setInterval(() => this.tick().catch((e) => log('swarm tick', e.message)), 15000);
    this.lastSample = 0; this.botPingAt = 0;
  }
  mk(r) { return { ...r, enabled: !!r.enabled, seen: 0, st: null, errs: [], cmds: [], hist: [], pend: 0, sleepWanted: false, wakeAt: 0, pingAt: 0, pingRtt: 0, lastTotal: 0, boot: '', ver: '', cap: 0, persistAt: 0, overBudget: false }; }
  S(k, d) { return this.db.setting('swarm.' + k, d); }
  settings() {
    return { warmMin: this.S('warmMin', 2), keepAllWarm: this.S('keepAllWarm', false), idleSleepMin: this.S('idleSleepMin', 30), defaultCap: this.S('defaultCap', 40),
      nodeMbps: this.S('nodeMbps', 300), budgetGB: this.S('budgetGB', 90), edgeCacheMB: this.S('edgeCacheMB', 160), autoApprove: this.S('autoApprove', true), mainFallback: this.S('mainFallback', true), scaleAt: this.S('scaleAt', 0.6) };
  }

  revoke(uid) { this.revoked.set(uid, Date.now() + 8 * 3600e3); }

  heartbeat(b) {
    if (!b || typeof b.id !== 'string' || !/^[\w.-]{1,60}$/.test(b.id) || !/^https?:\/\//.test(b.url || '')) return { error: 'bad' };
    const S = this.settings();
    let n = this.nodes.get(b.id);
    const region = String(b.region || 'unknown').toLowerCase().slice(0, 30);
    if (!n) {
      const row = { id: b.id, url: b.url, region, enabled: S.autoApprove ? 1 : 0, capacity: 0, render_key: null, render_service: null, note: null, month: month(), month_bytes: 0, created_at: Date.now() };
      this.db.run('INSERT INTO nodes(id,url,region,enabled,capacity,month,month_bytes,created_at) VALUES(?,?,?,?,?,?,?,?)', row.id, row.url, row.region, row.enabled, 0, row.month, 0, row.created_at);
      n = this.mk(row); this.nodes.set(n.id, n); log('swarm: new node', n.id, region, n.url);
    }
    if (n.url !== b.url || n.region !== region) { n.url = b.url; n.region = region; this.db.run('UPDATE nodes SET url=?, region=? WHERE id=?', b.url, region, n.id); }
    const st = b.st || {};
    // monthly traffic accounting
    const m = month();
    if (n.month !== m) { n.month = m; n.month_bytes = 0; if (n.overBudget) { n.overBudget = false; n.cmds.push({ t: 'undrain' }); } }
    const total = Number(st.totalBytes) || 0;
    const delta = !n.boot ? 0 : b.boot === n.boot ? Math.max(0, total - n.lastTotal) : total; // first hb after main restart: baseline only (no double count)
    n.lastTotal = total; n.boot = b.boot; n.month_bytes += delta;
    if (Date.now() - n.persistAt > 120000 || delta > 2e8) { n.persistAt = Date.now(); this.db.run('UPDATE nodes SET month=?, month_bytes=? WHERE id=?', n.month, n.month_bytes, n.id); }
    if (!n.overBudget && S.budgetGB > 0 && n.month_bytes > S.budgetGB * 1e9) { n.overBudget = true; n.cmds.push({ t: 'drain' }); log('swarm: node over traffic budget', n.id); }
    n.st = st; n.seen = Date.now(); n.pend = 0; n.errs = b.errs || []; n.ver = b.ver; n.cap = b.cap; n.wakeAt = 0;
    if (st.viewers > 0) n.sleepWanted = false;
    if (!n.enabled && !n.st.draining) n.cmds.push({ t: 'drain' });
    if (n.enabled && n.st.draining && !n.overBudget && !n.manualDrain) n.cmds.push({ t: 'undrain' });
    const now = Date.now(), revoked = [];
    for (const [u, t] of this.revoked) { if (t < now) this.revoked.delete(u); else revoked.push(u); }
    return { storage: this.swift.creds(), revoked, cap: n.capacity || S.defaultCap, cacheMB: S.edgeCacheMB, cmds: n.cmds.splice(0) };
  }

  state(n) {
    if (!n.enabled) return 'disabled';
    const age = Date.now() - n.seen, mode = n.st?.mode;
    const alive = n.seen && age < (mode === 'active' ? 50e3 : mode === 'idle' ? 140e3 : 300e3);
    if (alive) {
      if (n.overBudget) return 'budget';
      if (n.st.draining) return 'draining';
      return mode === 'sleep' ? 'dozing' : mode === 'idle' ? 'idle' : 'online';
    }
    if (n.wakeAt && Date.now() - n.wakeAt < 120e3) return 'waking';
    if (n.sleepWanted) return 'sleeping';
    return n.seen ? 'offline' : 'unknown';
  }
  usable(n) { const s = this.state(n); return s === 'online' || s === 'idle' || s === 'dozing'; }
  load(n) {
    const S = this.settings(), st = n.st || {};
    const cap = n.capacity || S.defaultCap;
    return Math.max(((st.viewers || 0) + n.pend) / cap, st.cpu || 0, (st.bps || 0) / (S.nodeMbps * 1e6));
  }

  /** candidates for a viewer: affinity (cache locality) + least loaded + cross-region fallback */
  pick(vid, { tz, off, hint } = {}) {
    const S = this.settings();
    const groups = new Map();
    for (const n of this.nodes.values()) if (this.usable(n)) { if (!groups.has(n.region)) groups.set(n.region, []); groups.get(n.region).push(n); }
    const order = regionOrder(tz, off, hint, new Set(groups.keys()));
    const out = []; let regionsUsed = 0;
    for (const rg of order) {
      const list = groups.get(rg); if (!list) continue;
      const sc = list.map((n) => ({ n, l: this.load(n) + (n.st?.mode === 'sleep' ? 0.15 : 0), b: S.budgetGB ? n.month_bytes / (S.budgetGB * 1e9) : 0 }));
      const avg = sc.reduce((a, x) => a + x.l, 0) / sc.length;
      const bound = Math.min(0.95, Math.max(0.2, avg * 1.25 + 0.05));
      const ranked = sc.map((x) => ({ ...x, w: hrw(vid, x.n.id) * (1 - 0.5 * x.b) })).sort((a, b) => b.w - a.w);
      const take = regionsUsed === 0 ? 3 : 1;
      const picked = [];
      for (const x of ranked) { if (picked.length >= Math.min(2, take)) break; if (x.l < bound) picked.push(x); }
      const least = [...sc].sort((a, b) => a.l + a.b * 0.3 - (b.l + b.b * 0.3))[0];
      if (picked.length < take && least && !picked.some((x) => x.n.id === least.n.id) && least.l < 1) picked.push(least);
      if (!picked.length) continue;
      for (const x of picked) out.push(x);
      if (++regionsUsed >= 2) break;
    }
    // wake a sleeping region nearest to the viewer if it has no live node
    if (order[0] && !groups.has(order[0])) this.wakeRegion(order[0], 1);
    if (out[0]) out[0].n.pend++;
    const res = out.map((x) => ({ id: x.n.id, url: x.n.url, rg: x.n.region, l: +x.l.toFixed(3) }));
    if (S.mainFallback || !res.length) res.push({ id: 'origin', url: this.cfg.publicUrl, rg: 'origin', l: 0.9 });
    return res;
  }

  ping(n) {
    n.pingAt = Date.now(); const t0 = Date.now();
    return fetch(n.url + '/ping', { signal: AbortSignal.timeout(65000) }).then((r) => { n.pingRtt = Date.now() - t0; return r.json(); }).catch(() => null);
  }
  wake(n) { if (!n.enabled || n.overBudget) return; n.sleepWanted = false; n.wakeAt = Date.now(); n.cmds.push({ t: 'wake' }); this.ping(n); }
  wakeRegion(rg, count) {
    const c = [...this.nodes.values()].filter((n) => n.region === rg && n.enabled && !n.overBudget && !this.usable(n) && this.state(n) !== 'waking');
    c.sort((a, b) => a.month_bytes - b.month_bytes).slice(0, count).forEach((n) => this.wake(n));
  }

  async tick() {
    const S = this.settings(), now = Date.now();
    const regions = new Map();
    for (const n of this.nodes.values()) { if (!regions.has(n.region)) regions.set(n.region, []); regions.get(n.region).push(n); }
    for (const [, list] of regions) {
      const live = list.filter((n) => this.usable(n));
      const viewers = live.reduce((a, n) => a + (n.st?.viewers || 0), 0);
      const avgLoad = live.length ? live.reduce((a, n) => a + this.load(n), 0) / live.length : 0;
      const avgCap = S.defaultCap;
      const enabled = list.filter((n) => n.enabled && !n.overBudget);
      let need = S.keepAllWarm ? enabled.length : Math.max(S.warmMin, Math.ceil((viewers * 1.4) / avgCap) + (viewers > 0 ? 1 : 0));
      if (avgLoad > S.scaleAt) need = Math.max(need, live.length + 1);
      need = Math.min(need, enabled.length);
      const waking = list.filter((n) => this.state(n) === 'waking').length;
      if (live.length + waking < need) {
        const sleepers = enabled.filter((n) => !this.usable(n) && this.state(n) !== 'waking').sort((a, b) => a.month_bytes - b.month_bytes);
        sleepers.slice(0, need - live.length - waking).forEach((n) => { log('swarm: wake', n.id); this.wake(n); });
      } else if (live.length > need) {
        const idle = live.filter((n) => (n.st?.viewers || 0) === 0 && (n.st?.idleFor || 0) > S.idleSleepMin * 60 && !n.sleepWanted).sort((a, b) => b.month_bytes - a.month_bytes);
        if (idle[0]) { idle[0].sleepWanted = true; idle[0].cmds.push({ t: 'sleep' }); log('swarm: sleep', idle[0].id); }
      }
      // dozing nodes that must stay warm get woken
      for (const n of live) if (n.st?.mode === 'sleep' && !n.sleepWanted && need > 0) n.cmds.push({ t: 'wake' });
    }
    // keep-alive pings: Render free sleeps after 15 min without inbound traffic
    for (const n of this.nodes.values()) {
      if (!n.enabled || n.sleepWanted || n.overBudget) continue;
      const st = this.state(n);
      const interval = st === 'offline' || st === 'unknown' ? 180e3 : 540e3;
      if (now - n.pingAt > interval) this.ping(n);
    }
    if (this.cfg.botUrl && now - this.botPingAt > 540e3) { this.botPingAt = now; fetch(this.cfg.botUrl + '/health', { signal: AbortSignal.timeout(60000) }).catch(() => {}); }
    if (now - this.lastSample >= 30000) {
      this.lastSample = now;
      let v = 0, b = 0;
      for (const n of this.nodes.values()) {
        const live = this.usable(n) || this.state(n) === 'draining';
        const p = { t: now, v: live ? n.st?.viewers || 0 : 0, c: live ? n.st?.cpu || 0 : 0, b: live ? n.st?.bps || 0 : 0, m: live ? n.st?.rss || 0 : 0 };
        n.hist.push(p); if (n.hist.length > 120) n.hist.shift();
        v += p.v; b += p.b;
      }
      this.hist.push({ t: now, v, b }); if (this.hist.length > 240) this.hist.shift();
    }
  }

  async renderApi(n, action) {
    if (!n.render_key || !n.render_service) throw new Error('Для узла не задан Render API key / service id');
    const r = await fetch(`https://api.render.com/v1/services/${encodeURIComponent(n.render_service)}/${action}`, { method: 'POST', headers: { Authorization: 'Bearer ' + n.render_key, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('Render API: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return true;
  }

  snapshot() {
    const S = this.settings();
    const list = [...this.nodes.values()].map((n) => ({
      id: n.id, url: n.url, region: n.region, enabled: n.enabled, state: this.state(n), capacity: n.capacity || S.defaultCap, note: n.note,
      hasRender: !!(n.render_key && n.render_service), render_service: n.render_service, seen: n.seen, ver: n.ver, st: n.st, errs: n.errs,
      load: +this.load(n).toFixed(3), monthBytes: n.month_bytes, budget: S.budgetGB * 1e9, pingRtt: n.pingRtt, sleepWanted: n.sleepWanted, manualDrain: !!n.manualDrain, hist: n.hist,
    })).sort((a, b) => a.region.localeCompare(b.region) || a.id.localeCompare(b.id));
    return { settings: S, nodes: list, hist: this.hist, regions: KNOWN };
  }
  liveViewers() {
    let v = 0; const per = {};
    for (const n of this.nodes.values()) if (n.st && Date.now() - n.seen < 150e3) { v += n.st.viewers || 0; for (const [k, c] of Object.entries(n.st.perVideo || {})) per[k] = (per[k] || 0) + c; }
    return { v, per };
  }
}
module.exports = { Swarm, regionOrder };
