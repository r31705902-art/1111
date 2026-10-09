#!/usr/bin/env node
'use strict';
// V_N encoder: raw stream → multi-quality HLS (fMP4, AV1 + H.264 fallback, shared AAC track) + storyboard → Blomp.
// Runs anywhere with ffmpeg (your PC, a VPS, GitHub Actions). Never on the 0.5 CPU nodes.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { env, envInt, log } = require('../../shared/lib');
const { Swift } = require('../../shared/swift');

const MAIN = env('MAIN_URL', 'http://localhost:8080').replace(/\/$/, '');
const TOKEN = env('ENCODER_TOKEN', 'dev-encoder-token');
const NAME = env('ENCODER_NAME', os.hostname().slice(0, 30));
const WORK = env('WORK_DIR', path.join(os.tmpdir(), 'vn-enc'));
const FFMPEG = env('FFMPEG', 'ffmpeg'), FFPROBE = env('FFPROBE', 'ffprobe');
const SEG = 6, SB_INT = 10;

const api = async (p, body, method = 'POST') => {
  const r = await fetch(MAIN + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status} ${j.error || ''}`);
  return j;
};

// ---------- capabilities ----------
let ENCODERS = '';
function caps() {
  if (!ENCODERS) { try { ENCODERS = execFileSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' }); } catch { throw new Error('ffmpeg не найден'); } }
  const has = (n) => new RegExp('\\s' + n + '\\s').test(ENCODERS);
  const hw = env('ENC_HW', 'none');
  return { svt: has('libsvtav1'), aom: has('libaom-av1'), x264: has('libx264'), webp: has('libwebp'), nvAv1: hw === 'nvenc' && has('av1_nvenc'), nvH264: hw === 'nvenc' && has('h264_nvenc') };
}

// ---------- ladder ----------
const PROFILES = {
  av1: [['av1', 1080], ['av1', 720], ['av1', 480], ['h264', 480]],
  av1compat: [['av1', 1080], ['av1', 720], ['av1', 480], ['h264', 720], ['h264', 360]],
  h264: [['h264', 1080], ['h264', 720], ['h264', 480], ['h264', 360]],
  lite: [['av1', 720], ['av1', 480], ['h264', 360]],
};
const AV1 = { 1440: [33, 4200, 5500], 1080: [34, 2200, 3000], 720: [35, 1300, 1800], 480: [37, 700, 900], 360: [38, 450, 550] }; // crf, maxrate30, maxrate60 (kbps)
const H264 = { 1440: [23, 7000, 9000], 1080: [23, 4000, 5500], 720: [23, 2500, 3200], 480: [24, 1100, 1300], 360: [25, 600, 700] };

function ladder(profile, src) {
  const c = caps();
  const want = PROFILES[profile] || PROFILES.av1;
  let list = want.filter(([, h]) => h <= src.h + 8);
  if (!list.length) list = [[want[0][0], src.h - (src.h % 2)]];
  if (!list.some(([k]) => k === 'h264')) list.push(['h264', Math.min(360, src.h - (src.h % 2))]);
  const seen = new Set();
  return list.map(([codec, h]) => {
    if (codec === 'av1' && !c.svt && !c.aom && !c.nvAv1) codec = 'h264';
    const name = (codec === 'av1' ? 'v' : 'h') + h;
    if (seen.has(name)) return null; seen.add(name);
    const fps = h <= 480 && src.fps > 31 ? src.fps / 2 : src.fps;
    const t = (codec === 'av1' ? AV1 : H264)[h] || (codec === 'av1' ? AV1[480] : H264[480]);
    return { name, codec, h, fps, crf: Number(env('ENC_CRF_' + name.toUpperCase(), t[0])), maxrate: fps > 31 ? t[2] : t[1] };
  }).filter(Boolean);
}

function videoArgs(r, i, src) {
  const c = caps(), g = Math.max(1, Math.round(r.fps * SEG));
  const a = [];
  const kf = ['-force_key_frames:v:' + i, `expr:gte(t,n_forced*${SEG})`];
  if (r.codec === 'av1') {
    if (c.nvAv1) a.push('-c:v:' + i, 'av1_nvenc', '-preset:v:' + i, 'p6', '-cq:v:' + i, String(r.crf), '-b:v:' + i, '0', '-g:v:' + i, String(g), ...kf);
    else if (c.svt) a.push('-c:v:' + i, 'libsvtav1', '-preset:v:' + i, env('ENC_SVT_PRESET', '8'), '-crf:v:' + i, String(r.crf), '-g:v:' + i, String(g), ...kf,
      '-svtav1-params:v:' + i, `tune=0:scd=0:enable-overlays=1:keyint=${g}`);
    else a.push('-c:v:' + i, 'libaom-av1', '-cpu-used:v:' + i, '8', '-row-mt:v:' + i, '1', '-usage:v:' + i, 'realtime', '-crf:v:' + i, String(r.crf), '-b:v:' + i, '0', '-g:v:' + i, String(g), ...kf);
  } else {
    if (c.nvH264) a.push('-c:v:' + i, 'h264_nvenc', '-preset:v:' + i, 'p6', '-cq:v:' + i, String(r.crf + 2), '-b:v:' + i, '0', '-profile:v:' + i, 'high', '-g:v:' + i, String(g), ...kf);
    else a.push('-c:v:' + i, 'libx264', '-preset:v:' + i, env('ENC_X264_PRESET', 'medium'), '-crf:v:' + i, String(r.crf), '-profile:v:' + i, 'high', '-g:v:' + i, String(g), '-keyint_min:v:' + i, String(g), '-sc_threshold:v:' + i, '0', ...kf);
  }
  const aom = r.codec === 'av1' && !c.nvAv1 && !c.svt;
  if (!aom) a.push('-maxrate:v:' + i, r.maxrate + 'k', '-bufsize:v:' + i, r.maxrate * 2 + 'k'); // libaom: pure CRF
  return a;
}

async function probe(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8', maxBuffer: 32 << 20 });
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new Error('В файле нет видеодорожки');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const [fn, fd] = String(v.avg_frame_rate || v.r_frame_rate || '30/1').split('/').map(Number);
  let fps = fd ? fn / fd : 30; if (!(fps > 1 && fps < 241)) fps = 30;
  let w = v.width, h = v.height;
  const rot = Number(v.tags?.rotate || v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation || 0);
  if (Math.abs(rot) === 90) [w, h] = [h, w];
  return { w, h, fps: Math.round(fps * 1000) / 1000, dur: Number(j.format.duration || v.duration || 0), audio: !!a, size: Number(j.format.size || 0) };
}

// ---------- codec strings from init segments ----------
function codecString(buf, kind) {
  const find = (t) => buf.indexOf(Buffer.from(t));
  if (kind === 'audio') return 'mp4a.40.2';
  let i = find('avcC');
  if (i > 0) { const b = buf.subarray(i + 4, i + 8); return 'avc1.' + [b[1], b[2], b[3]].map((x) => x.toString(16).padStart(2, '0')).join(''); }
  i = find('av1C');
  if (i > 0) {
    const b1 = buf[i + 5], b2 = buf[i + 6];
    const prof = b1 >> 5, lvl = b1 & 31, tier = (b2 >> 7) & 1, hbd = (b2 >> 6) & 1, tw = (b2 >> 5) & 1;
    const bd = hbd ? (tw ? 12 : 10) : 8;
    return `av01.${prof}.${String(lvl).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(bd).padStart(2, '0')}`;
  }
  return 'avc1.640028';
}

// ---------- upload pool ----------
function pool(n) {
  const q = []; let active = 0, err = null; const idle = [];
  const next = () => {
    while (active < n && q.length) {
      const [fn, res, rej] = q.shift(); active++;
      fn().then(res, (e) => { err = err || e; rej(e); }).finally(() => { active--; next(); if (!active && !q.length) idle.splice(0).forEach((f) => f()); });
    }
  };
  return { add: (fn) => new Promise((res, rej) => { q.push([fn, res, rej]); next(); }).catch(() => {}), drain: () => new Promise((r) => (!active && !q.length ? r() : idle.push(r))), get err() { return err; }, get pending() { return q.length + active; } };
}

// ---------- main encode ----------
async function encode({ job, source, swift, report }) {
  const vid = job.videoId, dir = path.join(WORK, vid), out = path.join(dir, 'out');
  await fsp.mkdir(out, { recursive: true });
  const src = await probe(source);
  log(`source ${src.w}x${src.h} @${src.fps}fps, ${(src.dur / 3600).toFixed(2)}h, audio=${src.audio}`);
  const profile = job.opts?.profile || env('ENC_PROFILE', 'av1');
  const L = ladder(profile, src);
  log('ladder:', L.map((r) => `${r.name}(${r.codec} crf${r.crf} ≤${r.maxrate}k)`).join(' '));
  const c = caps();
  const sbExt = c.webp ? 'webp' : 'jpg';
  for (const r of L) await fsp.mkdir(path.join(out, r.name), { recursive: true });
  if (src.audio) await fsp.mkdir(path.join(out, 'a'), { recursive: true });
  await fsp.mkdir(path.join(out, 'sb'), { recursive: true });

  let fg = `[0:v]format=yuv420p,split=${L.length}` + L.map((_, i) => `[b${i}]`).join('') + ';';
  fg += L.map((r, i) => `[b${i}]${r.fps !== src.fps ? `fps=${r.fps},` : ''}scale=-2:${r.h}:flags=bicubic[o${i}]`).join(';');
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-i', source, '-filter_complex', fg];
  L.forEach((r, i) => args.push('-map', `[o${i}]`));
  L.forEach((r, i) => args.push(...videoArgs(r, i, src)));
  if (src.audio) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', env('ENC_AUDIO_KBPS', '128') + 'k', '-ac', '2', '-ar', '48000');
  const vsm = L.map((r, i) => `v:${i},name:${r.name}`).concat(src.audio ? ['a:0,name:a'] : []).join(' ');
  args.push('-f', 'hls', '-hls_time', String(SEG), '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_flags', 'independent_segments',
    '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(out, '%v', 'seg_%05d.m4s'), '-var_stream_map', vsm, path.join(out, '%v', 'index.m3u8'));

  const rends = [...L.map((r) => r.name), ...(src.audio ? ['a'] : [])];
  const uploaded = new Map(); // name/file -> size
  job._uploaded = uploaded;
  const up = pool(envInt('ENC_UPLOADS', 6));
  let bytesUp = 0;
  const uploadFile = (rel) => {
    if (uploaded.has(rel)) return; uploaded.set(rel, -1);
    return up.add(async () => {
      const f = path.join(out, rel); const buf = await fsp.readFile(f);
      await swift.putRetry(`v/${vid}/${rel}`, buf, rel.endsWith('.m4s') ? 'video/iso.segment' : 'application/octet-stream', 5);
      uploaded.set(rel, buf.length); bytesUp += buf.length;
      if (rel.endsWith('.m4s')) await fsp.unlink(f).catch(() => {});
    });
  };
  const scan = async (final) => {
    for (const r of rends) {
      const files = (await fsp.readdir(path.join(out, r)).catch(() => [])).filter((f) => /^seg_\d+\.m4s$/.test(f)).sort();
      const ready = final ? files : files.slice(0, -1);
      for (const f of ready) uploadFile(`${r}/${f}`);
    }
  };

  const t0 = Date.now();
  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let errTxt = '', prog = {}, canceled = false;
  ff.stderr.on('data', (d) => { errTxt = (errTxt + d).slice(-4000); });
  ff.stdout.on('data', (d) => { for (const line of String(d).split('\n')) { const [k, v] = line.split('='); if (k && v !== undefined) prog[k.trim()] = v.trim(); } });
  const tick = setInterval(async () => {
    await scan(false).catch(() => {});
    const t = Number(prog.out_time_us || prog.out_time_ms || 0) / 1e6, sp = parseFloat(prog.speed) || 0;
    const frac = src.dur ? Math.min(1, t / src.dur) : 0;
    const r = await report(0.05 + frac * 0.9, { stage: 'encode', t: Math.round(t), fps: Number(prog.fps) || 0, speed: sp, eta: sp > 0 ? Math.round((src.dur - t) / sp) : null, uploadedMB: Math.round(bytesUp / 1048576), queue: up.pending, ladder: L.map((x) => x.name) }).catch(() => ({}));
    if (r && r.cancel && !canceled) { canceled = true; ff.kill('SIGKILL'); }
  }, 5000);
  const code = await new Promise((res) => ff.on('close', (c, sig) => res(c ?? sig)));
  clearInterval(tick);
  if (canceled) throw new Error('canceled');
  if (code !== 0) throw new Error('ffmpeg exit ' + code + ': ' + errTxt.slice(-1500));
  log(`encoded in ${((Date.now() - t0) / 60000).toFixed(1)} min, finishing uploads…`);
  await scan(true); await up.drain(); if (up.err) throw up.err;

  // finalize playlists, compute real bitrates
  const media = { v: 1, segDur: SEG, renditions: [], audio: null, sb: null, profile };
  let total = 0;
  for (const r of rends) {
    const rd = path.join(out, r);
    const files = await fsp.readdir(rd);
    const initF = files.find((f) => f.endsWith('.mp4'));
    if (!initF) throw new Error('нет init для ' + r);
    if (initF !== 'init.mp4') await fsp.rename(path.join(rd, initF), path.join(rd, 'init.mp4'));
    const init = await fsp.readFile(path.join(rd, 'init.mp4'));
    let pl = await fsp.readFile(path.join(rd, 'index.m3u8'), 'utf8');
    pl = pl.replace(/#EXT-X-MAP:URI="[^"]*"/, '#EXT-X-MAP:URI="init.mp4"').split('\n').map((l) => (l && !l.startsWith('#') ? path.basename(l.trim()) : l)).join('\n');
    await fsp.writeFile(path.join(rd, 'index.m3u8'), pl);
    const durs = [...pl.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
    const segs = pl.split('\n').filter((l) => l && !l.startsWith('#'));
    let bytes = 0, peak = 0;
    segs.forEach((s, i) => { const sz = uploaded.get(`${r}/${s}`) || 0; bytes += sz; peak = Math.max(peak, (sz * 8) / Math.max(0.5, durs[i] || SEG)); });
    const dur = durs.reduce((a, b) => a + b, 0) || src.dur;
    await swift.putRetry(`v/${vid}/${r}/init.mp4`, init, 'video/mp4');
    await swift.putRetry(`v/${vid}/${r}/index.m3u8`, Buffer.from(pl), 'application/vnd.apple.mpegurl');
    total += bytes + init.length;
    const info = { name: r, codec: codecString(init, r === 'a' ? 'audio' : 'video'), segs: segs.length, bytes, bw: Math.round(peak), abw: Math.round((bytes * 8) / dur) };
    if (r === 'a') media.audio = info;
    else { const l = L.find((x) => x.name === r); media.renditions.push({ ...info, h: l.h, w: Math.round((src.w * l.h) / src.h / 2) * 2, fps: l.fps, kind: l.codec }); }
  }
  media.renditions.sort((a, b) => b.h - a.h || (a.kind === 'av1' ? -1 : 1));
  // master playlist
  const ab = media.audio ? media.audio.bw : 0;
  let m3u = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n';
  if (media.audio) m3u += '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="a/index.m3u8"\n';
  for (const r of media.renditions) m3u += `#EXT-X-STREAM-INF:BANDWIDTH=${r.bw + ab},AVERAGE-BANDWIDTH=${r.abw + (media.audio?.abw || 0)},CODECS="${r.codec}${media.audio ? ',' + media.audio.codec : ''}",RESOLUTION=${r.w}x${r.h},FRAME-RATE=${r.fps.toFixed(3)}${media.audio ? ',AUDIO="aud"' : ''}\n${r.name}/index.m3u8\n`;
  await swift.putRetry(`v/${vid}/master.m3u8`, Buffer.from(m3u), 'application/vnd.apple.mpegurl');
  // storyboard: separate keyframe-only pass (decodes ~1 frame/2s → very cheap, no RAM pile-up)
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-skip_frame', 'nokey', '-i', source, '-an', '-vf', `fps=1/${SB_INT},scale=160:90:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=160:90:-1:-1:color=black,tile=10x10`,
      '-fps_mode', 'passthrough', ...(c.webp ? ['-c:v', 'libwebp', '-quality', '55'] : ['-c:v', 'mjpeg', '-q:v', '6']), '-f', 'image2', path.join(out, 'sb', 'sb_%03d.' + sbExt)], { stdio: 'ignore' });
  } catch (e) { log('storyboard failed', e.message); }
  const sheets = (await fsp.readdir(path.join(out, 'sb'))).filter((f) => f.startsWith('sb_')).sort();
  for (const f of sheets) { const b = await fsp.readFile(path.join(out, 'sb', f)); total += b.length; await swift.putRetry(`v/${vid}/sb/${f}`, b, sbExt === 'webp' ? 'image/webp' : 'image/jpeg'); }
  if (sheets.length) media.sb = { i: SB_INT, w: 160, h: 90, c: 10, r: 10, sheets: sheets.length, ext: sbExt, n: Math.ceil(src.dur / SB_INT) };
  // poster
  let cover = null;
  if (!job.hasCover) {
    const pf = path.join(dir, 'poster.' + (c.webp ? 'webp' : 'jpg'));
    try {
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.floor(src.dur * 0.2)), '-i', source, '-frames:v', '1', '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:-1:-1', ...(c.webp ? ['-c:v', 'libwebp', '-quality', '78'] : ['-q:v', '3']), pf]);
      cover = (await api(`/api/encoder/cover/${vid}`, await fsp.readFile(pf))).key;
    } catch (e) { log('poster failed', e.message); }
  }
  media.totalBytes = total;
  return { media, duration: src.dur, size: total, cover };
}

async function downloadRaw(job, swift, report) {
  const dir = path.join(WORK, job.videoId); await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'source' + (path.extname(job.rawName || '') || '.bin'));
  const ws = fs.createWriteStream(file);
  let got = 0;
  for (let i = 1; i <= job.rawParts; i++) {
    for (let a = 0; ; a++) {
      try {
        const res = await swift.get(`raw/${job.videoId}/p_${String(i).padStart(5, '0')}`);
        if (res.statusCode !== 200) { res.resume(); throw new Error('raw part ' + i + ': ' + res.statusCode); }
        const chunks = []; for await (const c of res) chunks.push(c);
        const b = Buffer.concat(chunks); got += b.length;
        if (!ws.write(b)) await new Promise((r) => ws.once('drain', r));
        break;
      } catch (e) { if (a >= 4) throw e; await new Promise((r) => setTimeout(r, 2000 * (a + 1))); }
    }
    if (i % 4 === 0) report(0.05 * (got / job.rawSize), { stage: 'download', mb: Math.round(got / 1048576) }).catch(() => {});
  }
  await new Promise((r) => ws.end(r));
  return file;
}

function makeSwift(creds) {
  const s = new Swift({ provider: () => api('/api/encoder/storage', undefined, 'GET') });
  s.setCreds(creds); return s;
}

async function runJob(job, storage, localFile) {
  const swift = makeSwift(storage);
  const report = (progress, info) => api(`/api/encoder/jobs/${job.id}/progress`, { progress, info });
  log(`job #${job.id} video ${job.videoId} «${job.title}»`);
  try {
    const source = localFile || await downloadRaw(job, swift, report);
    const res = await encode({ job, source, swift, report });
    await api(`/api/encoder/jobs/${job.id}/done`, res);
    log(`job #${job.id} done: ${(res.size / 1073741824).toFixed(2)} GB for ${(res.duration / 3600).toFixed(2)} h`);
  } catch (e) {
    log(`job #${job.id} failed:`, e.message);
    if (job._uploaded?.size) await swift.bulkDelete([...job._uploaded.keys()].map((k) => `v/${job.videoId}/${k}`)).catch(() => {});
    await api(`/api/encoder/jobs/${job.id}/fail`, { error: e.message }).catch(() => {});
    if (localFile) process.exitCode = 1;
  } finally {
    await fsp.rm(path.join(WORK, job.videoId), { recursive: true, force: true }).catch(() => {});
  }
}

async function worker(once) {
  log(`V_N encoder «${NAME}» → ${MAIN}; caps:`, JSON.stringify(caps()));
  for (;;) {
    try {
      const r = await api('/api/encoder/claim', { name: NAME, caps: caps(), ver: '1.0.0' });
      if (r.job) { await runJob(r.job, r.storage); continue; }
      if (once) { log('нет задач — выходим'); return; }
    } catch (e) { log('claim error:', e.message); if (once) return; }
    await new Promise((r) => setTimeout(r, envInt('POLL_SEC', 20) * 1000));
  }
}

async function ingest(argv) {
  const file = argv[0]; if (!file || !fs.existsSync(file)) { console.error('Файл не найден: ' + file); process.exit(2); }
  const opt = {}; for (let i = 1; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); opt[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  const r = await api('/api/encoder/ingest', { title: opt.title || path.basename(file).replace(/\.[^.]+$/, ''), description: opt.desc || '', tags: opt.tags || '', stream_date: opt.date, profile: opt.profile, visibility: opt.hidden ? 'hidden' : 'public', file: path.basename(file), encoder: NAME });
  await runJob(r.job, r.storage, path.resolve(file));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'ingest') ingest(rest).catch((e) => { console.error(e.message); process.exit(1); });
else if (cmd === 'caps') console.log(caps(), '\nladder for 1080p60 av1:', ladder('av1', { h: 1080, w: 1920, fps: 60 }));
else worker(rest.includes('--once') || env('ONCE') === '1');
