'use strict';
// Minimal OpenStack Swift client for Blomp (keystone v2). Streams, keep-alive, auto re-auth.
const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 48, maxFreeSockets: 8, keepAliveMsecs: 15000 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 48, maxFreeSockets: 8, keepAliveMsecs: 15000 }),
};

class Swift {
  /**
   * opts: { authUrl, user, key, tenant, container }   — full credentials (main server)
   *   or: { provider: async () => ({ url, token, container, exp }) } — borrowed token (edges/encoders)
   */
  constructor(opts = {}) {
    this.o = opts;
    this.container = opts.container || opts.user || '';
    this.storageUrl = opts.storageUrl || ''; this.token = opts.token || ''; this.exp = opts.exp || 0;
    this._authing = null;
  }
  get ready() { return !!(this.token && this.storageUrl && Date.now() < this.exp); }
  setCreds(c) { if (!c) return; this.storageUrl = c.url; this.token = c.token; this.exp = c.exp; if (c.container) this.container = c.container; }
  creds() { return { url: this.storageUrl, token: this.token, exp: this.exp, container: this.container }; }

  async auth(force) {
    if (!force && this.token && Date.now() < this.exp - 5 * 60e3) return;
    if (this._authing) return this._authing;
    this._authing = (async () => {
      if (this.o.provider) { this.setCreds(await this.o.provider()); return; }
      const r = await fetch(this.o.authUrl.replace(/\/$/, '') + '/v2.0/tokens', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth: { passwordCredentials: { username: this.o.user, password: this.o.key }, tenantName: this.o.tenant || 'storage' } }),
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error('Blomp auth failed: HTTP ' + r.status);
      const j = await r.json();
      const os = (j.access.serviceCatalog || []).find((s) => s.type === 'object-store');
      if (!os) throw new Error('Blomp: no object-store endpoint');
      this.storageUrl = os.endpoints[0].publicURL;
      this.token = j.access.token.id;
      this.exp = Date.parse(j.access.token.expires) || Date.now() + 50 * 60e3;
    })().finally(() => { this._authing = null; });
    return this._authing;
  }

  objUrl(name) {
    return this.storageUrl + '/' + encodeURIComponent(this.container) + (name ? '/' + name.split('/').map(encodeURIComponent).join('/') : '');
  }

  /** raw request → IncomingMessage. body: Buffer | Readable | undefined */
  async req(method, name, { headers = {}, body, query = '', timeout = 60000, account = false } = {}, retry = true) {
    await this.auth();
    const u = new URL((account ? this.storageUrl : this.objUrl(name)) + query);
    const res = await new Promise((resolve, reject) => {
      const lib = u.protocol === 'https:' ? https : http;
      const rq = lib.request(u, { method, agent: agents[u.protocol], headers: { 'X-Auth-Token': this.token, ...headers } }, resolve);
      rq.setTimeout(timeout, () => rq.destroy(new Error('Blomp timeout')));
      rq.on('error', reject);
      if (body instanceof Readable) body.pipe(rq);
      else rq.end(body);
    });
    if (res.statusCode === 401 && retry && !(body instanceof Readable)) {
      res.resume(); await this.auth(true);
      return this.req(method, name, { headers, body, query, timeout, account }, false);
    }
    return res;
  }

  async get(name, range) {
    const res = await this.req('GET', name, { headers: range ? { Range: range } : {} });
    return res;
  }
  async getBuffer(name, limit = 64 << 20) {
    const res = await this.get(name);
    if (res.statusCode === 404) { res.resume(); return null; }
    if (res.statusCode >= 300) { res.resume(); throw new Error(`Blomp GET ${name}: ${res.statusCode}`); }
    const chunks = []; let n = 0;
    for await (const c of res) { n += c.length; if (n > limit) { res.destroy(); throw new Error('object too large'); } chunks.push(c); }
    return { buf: Buffer.concat(chunks), type: res.headers['content-type'], etag: res.headers.etag };
  }
  async put(name, body, type = 'application/octet-stream', extra = {}) {
    const headers = { 'Content-Type': type, ...extra };
    if (Buffer.isBuffer(body)) headers['Content-Length'] = body.length; else headers['Transfer-Encoding'] = 'chunked';
    const res = await this.req('PUT', name, { headers, body, timeout: 600000 });
    res.resume();
    if (res.statusCode >= 300) throw new Error(`Blomp PUT ${name}: ${res.statusCode}`);
    return res.headers.etag;
  }
  async putRetry(name, buf, type, tries = 4) {
    for (let i = 0; ; i++) {
      try { return await this.put(name, buf, type); }
      catch (e) { if (i >= tries - 1) throw e; await new Promise((r) => setTimeout(r, 800 * 2 ** i)); }
    }
  }
  async del(name) {
    const res = await this.req('DELETE', name); res.resume();
    return res.statusCode < 300 || res.statusCode === 404;
  }
  /** bulk delete — up to 10k per call */
  async bulkDelete(names) {
    let deleted = 0;
    for (let i = 0; i < names.length; i += 9000) {
      const body = Buffer.from(names.slice(i, i + 9000).map((n) => '/' + encodeURIComponent(this.container) + '/' + n.split('/').map(encodeURIComponent).join('/')).join('\n'));
      const res = await this.req('POST', '', { account: true, query: '?bulk-delete', headers: { 'Content-Type': 'text/plain', Accept: 'application/json', 'Content-Length': body.length }, body, timeout: 300000 });
      let txt = ''; for await (const c of res) txt += c;
      try { const j = JSON.parse(txt); deleted += (j['Number Deleted'] || 0); } catch {}
    }
    return deleted;
  }
  async list(prefix, limit = 10000) {
    const out = []; let marker = '';
    while (out.length < limit) {
      const res = await this.req('GET', '', { query: `?format=json&limit=1000&prefix=${encodeURIComponent(prefix)}${marker ? '&marker=' + encodeURIComponent(marker) : ''}` });
      let txt = ''; for await (const c of res) txt += c;
      if (res.statusCode >= 300) break;
      const arr = JSON.parse(txt || '[]'); if (!arr.length) break;
      for (const o of arr) out.push(o);
      marker = arr[arr.length - 1].name; if (arr.length < 1000) break;
    }
    return out;
  }
  async stat() {
    const res = await this.req('HEAD', ''); res.resume();
    return { bytes: Number(res.headers['x-container-bytes-used'] || 0), objects: Number(res.headers['x-container-object-count'] || 0), quota: Number(res.headers['x-container-meta-quota-bytes'] || 0) };
  }
}
module.exports = { Swift };
