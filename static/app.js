'use strict';
/* Clipper — browser UI. Talks to app.py over a small JSON API. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const dpr = () => window.devicePixelRatio || 1;

const S = {
  app: null, src: null, clip: null, tl: null,
  inPt: null, outPt: null, stopAt: null,
  view: { t0: 0, t1: 1 },
  activeRect: null,
  prog: { on: false, i: 0, outro: false, tOut: 0, mainDur: 0 },
  saveTimer: null, srcPatchTimer: null,
  myJobs: new Set(), jobState: {}, jobs: [],
  wmImg: null, tlDirty: true, yt: null,
};

// ------------------------------------------------------------ utils

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
}

function fmt(t, dec = 1) {
  if (t == null || isNaN(t)) return '–';
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = dec ? s.toFixed(dec).padStart(dec + 3, '0') : String(Math.floor(s)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function parseTime(str) {
  if (str == null) return null;
  str = String(str).trim();
  if (!str) return null;
  const parts = str.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;
const mediaUrl = p => `/media/file?path=${encodeURIComponent(p)}`;

function store(key, val) { try { localStorage.setItem('clipper.' + key, val); } catch (_) { /* private mode */ } }
function recall(key) { try { return localStorage.getItem('clipper.' + key); } catch (_) { return null; } }

let toastTimer = null;
function toast(msg, bad = false, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function setTabs(group, name) {
  $$(`[data-tabs="${group}"] .tab`).forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$(`[data-panes="${group}"] > .pane`).forEach(p => p.classList.toggle('active', p.dataset.pane === name));
}
$$('[data-tabs]').forEach(g => g.addEventListener('click', e => {
  const b = e.target.closest('.tab');
  if (b) setTabs(g.dataset.tabs, b.dataset.tab);
}));

// mouse clicks should not leave buttons focused (Space is the play key)
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b && e.detail > 0) b.blur();
});

// ------------------------------------------------------------ app state

const BRAND = [
  { key: 'watermark', label: 'Watermark' },
  { key: 'banner', label: 'Banner' },
  { key: 'bumper_in', label: 'Bumper in' },
  { key: 'bumper_out', label: 'Bumper out' },
];

async function loadState() {
  S.app = await api('GET', '/api/state');
  renderProjectSel();
  renderAssets();
  renderSources();
  renderExports();
  fillStyleSelects();
  loadAssetsMedia();
  renderNoCampaign();
}

function renderAssets() {
  const a = S.app.assets;
  const chips = BRAND.filter(b => a[b.key].enabled || a[b.key].required).map(b => {
    const el = a[b.key];
    const val = !el.exists ? 'belum ada' : (el.duration && b.key.startsWith('bumper') ? `${el.duration.toFixed(1)} dtk` : 'ada');
    return `<span class="asset ${el.exists ? 'ok' : 'bad'}" title="${esc(el.path || 'file belum dipilih')}">${b.label}: <b>${val}</b></span>`;
  });
  $('#assetStatus').innerHTML = chips.join('') +
    `<span class="asset">Encoder: <b>${S.app.tools.nvenc ? 'GPU (NVENC)' : 'CPU'}</b></span>`;
}

/* images and videos of the campaign's branding, used by the 9:16 preview */
function loadAssetsMedia() {
  const a = S.app.assets;
  const stamp = '&t=' + Date.now();
  S.wmImg = null; S.wmBox = null; S.bannerImg = null;
  if (a.watermark.exists && a.watermark.kind === 'image') {
    const img = new Image();
    img.onload = () => { S.wmImg = img; S.wmBox = alphaBox(img); };
    img.src = mediaUrl(a.watermark.path) + stamp;
  }
  if (a.banner.exists && a.banner.kind === 'image') {
    const img = new Image();
    img.onload = () => { S.bannerImg = img; };
    img.src = mediaUrl(a.banner.path) + stamp;
  }
  S.bumper = {};
  [['bumper_in', '#bumperInVideo'], ['bumper_out', '#outroVideo']].forEach(([k, sel]) => {
    const el = a[k], v = $(sel);
    S.bumper[k] = null;
    if (el.exists && el.kind === 'video') {
      const url = mediaUrl(el.path);
      if (!v.src.endsWith(url)) v.src = url;
      S.bumper[k] = { kind: 'video', el: v, duration: el.duration || 0 };
    } else {
      v.removeAttribute('src');
      if (el.exists && el.kind === 'image') {
        const img = new Image();
        img.src = mediaUrl(el.path) + stamp;
        S.bumper[k] = { kind: 'image', el: img, duration: el.duration || 2 };
      }
    }
  });
}

/* campaign element merged with the clip's own choice (mirror of common.branding_for) */
function brandFor(key) {
  const base = (S.app && S.app.campaign[key]) || {};
  const st = (S.app && S.app.assets[key]) || {};
  let own = S.clip ? S.clip[key] : undefined;
  if (key === 'bumper_out' && own === undefined && S.clip && 'outro' in S.clip) own = S.clip.outro;
  let el = { ...base }, enabled = !!base.enabled;
  if (typeof own === 'boolean') enabled = own;
  else if (own && typeof own === 'object') { el = { ...el, ...own }; if ('enabled' in own) enabled = !!own.enabled; }
  return { ...el, enabled, required: !!base.required, exists: !!st.exists, kind: st.kind, duration: st.duration };
}
const bumperOn = k => { const e = brandFor(k); return e.enabled && e.exists && !!(S.bumper && S.bumper[k]); };
const bumperDur = k => (bumperOn(k) ? (S.bumper[k].duration || 0) : 0);

// --- campaign picker (each campaign is its own folder with campaign.json)
function renderProjectSel() {
  const sel = $('#projectSel');
  const list = S.app.projects || [];
  const cur = S.app.project.root;
  sel.innerHTML = (S.app.project.has_campaign ? '' : '<option value="">(belum ada campaign di folder ini)</option>') +
    list.map(p => `<option value="${esc(p.path)}" title="${esc(p.path)}">${esc(p.name)}</option>`).join('') +
    '<option value="__new">+ Campaign baru…</option><option value="__open">Buka folder campaign lain…</option>';
  sel.value = list.some(p => p.current) ? list.find(p => p.current).path : '';
  $('#campaignBtn').disabled = !S.app.project.has_campaign;
  document.title = S.app.project.has_campaign ? `${S.app.campaign.name} · Clipper` : 'Clipper';
  sel.dataset.cur = cur;
}
$('#projectSel').addEventListener('change', async e => {
  const v = e.target.value;
  const back = () => renderProjectSel();
  try {
    if (v === '__new') {
      const name = prompt('Nama campaign baru (contoh: Clip Podcast X - Agency Y)');
      if (!name || !name.trim()) return back();
      const r = await api('POST', '/api/projects/new', { name: name.trim() });
      toast(`Campaign dibuat di ${r.root}`);
    } else if (v === '__open') {
      const path = prompt('Path folder campaign (yang berisi campaign.json)', S.app.project.root);
      if (!path) return back();
      await api('POST', '/api/projects/switch', { path: path.trim() });
    } else if (v) {
      await api('POST', '/api/projects/switch', { path: v });
    } else return back();
  } catch (err) {
    toast(err.message, true, 6000);
    return back();
  }
  location.reload();
});

function renderNoCampaign() {
  if (S.app.project.has_campaign) return;
  $('#editorEmpty').hidden = false;
  $('#editorMain').hidden = true;
  $('#editorPrepare').hidden = true;
  $('#editorEmpty').innerHTML = `<h3>Belum ada campaign di folder ini</h3>
    <p>${esc(S.app.project.root)} belum punya <code>campaign.json</code>. Buat campaign baru (dibuatkan folder sendiri berisi
    raw/, assets/, clips/, exports/) atau buka folder campaign yang sudah ada lewat pilihan campaign di atas.</p>
    <button class="btn primary" id="newCampaignBtn">Buat campaign baru</button>`;
  $('#newCampaignBtn').addEventListener('click', () => {
    const sel = $('#projectSel');
    sel.value = '__new';
    sel.dispatchEvent(new Event('change'));
  });
}

/* bounding box of visible pixels, as fractions of the image */
function alphaBox(img) {
  const w = 270, h = Math.max(1, Math.round(270 * img.height / img.width));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    if (d[(yy * w + xx) * 4 + 3] > 10) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
  }
  return x1 < 0 ? { x: 0, y: 0, w: 1, h: 1 } : { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h };
}

/* watermark's visible area on the 9:16 frame, as fractions of the frame */
function wmHitBox() {
  const wm = wmCfg();
  const ratio = S.wmImg ? S.wmImg.height / S.wmImg.width : 1 / 3;
  const fw = wm.w, fh = wm.w * ratio * PW / PH;
  const left = wm.x - fw / 2, top = wm.y - fh / 2;
  const b = (S.wmImg && S.wmBox) || { x: 0, y: 0, w: 1, h: 1 };
  return { x: left + b.x * fw, y: top + b.y * fh, w: b.w * fw, h: b.h * fh };
}

function fillStyleSelects() {
  const st = S.app.styles;
  const opts = obj => Object.keys(obj).map(k => `<option value="${k}">${k}</option>`).join('');
  $('#hookStyle').innerHTML = opts(st.hooks);
  $('#capStyle').innerHTML = opts(st.captions);
}

function renderSources() {
  const list = $('#sourceList');
  const sources = S.app.sources;
  if (!sources.length) {
    list.innerHTML = '<li class="muted">Belum ada video. Taruh file di folder raw/ lalu klik Scan.</li>';
    return;
  }
  list.innerHTML = sources.map(s => {
    const status = s.prepared
      ? `<span class="ok">siap</span>${s.transcribed ? ' · <span class="ok">transkrip</span>' : ''}`
      : 'belum disiapkan';
    const dur = s.duration ? fmt(s.duration, 0) + ' · ' : '';
    const clips = s.clips ? ` · ${s.clips} klip` : '';
    return `<li data-id="${esc(s.id)}" class="${S.src && S.src.id === s.id ? 'active' : ''}" title="${esc(s.path)}">
      <span class="name">${s.kind === 'youtube' ? 'YT · ' : ''}${esc(s.title)}</span>
      <span class="meta">${dur}${status}${clips}</span></li>`;
  }).join('');
}
$('#sourceList').addEventListener('click', e => {
  const li = e.target.closest('li[data-id]');
  if (li) { setLibOpen(false); selectSource(li.dataset.id); }
});
$('#rescanBtn').addEventListener('click', async () => { await loadState(); toast('Folder sudah di-scan ulang'); });

// on narrower screens the source list is a drawer
function setLibOpen(open) {
  document.body.classList.toggle('lib-open', open);
  $('#libScrim').hidden = !open;
}
$('#libBtn').addEventListener('click', () => setLibOpen(!document.body.classList.contains('lib-open')));
$('#libScrim').addEventListener('click', () => setLibOpen(false));
document.addEventListener('keydown', e => { if (e.key === 'Escape') setLibOpen(false); });

function renderExports() {
  const ex = S.app.exports;
  $('#exportList').innerHTML = ex.length ? ex.slice(0, 30).map(x => `
    <li><span class="name" title="${esc(x.path)}">${esc(x.name)}</span>
    <span class="muted">${(x.size / 1e6).toFixed(1)} MB · ${esc(x.mtime.replace('T', ' '))}</span>
    <div class="acts">
      <button class="btn small" data-play="${esc(x.path)}">Putar</button>
      <button class="btn small ghost" data-copy="${esc(x.caption)}">Salin caption</button>
      <button class="btn small ghost" data-open="${esc(x.path)}">Folder</button>
    </div></li>`).join('') : '<li class="muted">Belum ada export.</li>';
}

document.addEventListener('click', async e => {
  const play = e.target.closest('[data-play]');
  if (play) return openVideo(play.dataset.play, play.dataset.play.split('/').pop());
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    await navigator.clipboard.writeText(copy.dataset.copy);
    return toast('Caption disalin');
  }
  const open = e.target.closest('[data-open]');
  if (open) api('POST', '/api/open', { path: open.dataset.open }).catch(err => toast(err.message, true));
});

function openVideo(path, title, note = '') {
  const d = $('#videoDialog');
  $('#dlgTitle').textContent = title || 'Preview';
  $('#dlgNote').textContent = note;
  const v = $('#dlgVideo');
  v.src = mediaUrl(path) + '&t=' + Date.now();
  d.showModal();
  v.play().catch(() => {});
}
$('#dlgClose').addEventListener('click', () => $('#videoDialog').close());
$('#videoDialog').addEventListener('close', () => { $('#dlgVideo').pause(); });

// ------------------------------------------------------------ source selection

const video = $('#srcVideo');

async function selectSource(id, keepClip = null) {
  stopProgram();
  let data;
  try {
    data = await api('GET', `/api/sources/${encodeURIComponent(id)}`);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const changed = !S.src || S.src.id !== id;
  S.src = data;
  store('source', id);
  if (changed) { S.inPt = S.outPt = null; S.stopAt = null; }
  renderSources();
  $('#editorEmpty').hidden = true;
  if (!data.prepared) {
    $('#editorMain').hidden = true;
    $('#editorPrepare').hidden = false;
    $('#prepTitle').textContent = data.title;
    setClip(null);
    renderClipSelect();
    return;
  }
  $('#editorPrepare').hidden = true;
  $('#editorMain').hidden = false;
  $('#srcTitle').textContent = data.title;
  const yt = data.youtube && data.youtube.url ? ` · <a href="${esc(data.youtube.url)}" target="_blank" rel="noopener">YouTube</a>` : '';
  $('#srcMeta').innerHTML = `${esc(data.path)} · ${data.width}×${data.height} · ${fmt(data.duration, 0)}${yt}`;
  $('#timeDur').textContent = fmt(data.duration, 0);
  $('#heatLegend').hidden = !(data.youtube && data.youtube.heatmap && data.youtube.heatmap.length);
  if (video.dataset.sid !== data.id) {
    video.src = data.proxy_url;
    video.dataset.sid = data.id;
    S.view = { t0: 0, t1: data.duration || 1 };
  }
  $('#transcribeBtn').textContent = data.transcribed ? 'Transkrip ulang' : 'Transkrip (Whisper)';
  const cp = data.candidate_params || {};
  if (cp.pre) $('#candPre').value = cp.pre;
  if (cp.post) $('#candPost').value = cp.post;
  sizePlayer();
  sizeTimeline();
  renderCandidates();
  renderTranscript();
  renderClipSelect();
  const want = keepClip || (changed ? recall('clip.' + id) : S.clip && S.clip.id);
  const pick = data.clips.find(c => c.id === want) || data.clips[0];
  if (pick && (!S.clip || S.clip.id !== pick.id || keepClip)) await loadClip(pick.id);
  else if (!pick) setClip(null);
  S.tlDirty = true;
}

$('#prepareBtn').addEventListener('click', () => startJob('POST', `/api/sources/${S.src.id}/prepare`));
$('#transcribeBtn').addEventListener('click', () => {
  if (!S.src) return;
  startJob('POST', `/api/sources/${S.src.id}/transcribe`, {});
  toast('Transkripsi berjalan. Pertama kali akan download model Whisper (±1.5 GB).', false, 6000);
});
$('#recalcBtn').addEventListener('click', async () => {
  if (!S.src) return;
  S.src.candidates = await api('POST', `/api/sources/${S.src.id}/candidates`,
    { pre: +$('#candPre').value, post: +$('#candPost').value });
  renderCandidates();
  S.tlDirty = true;
});

// ------------------------------------------------------------ player + layout rectangles

const rectCanvas = $('#rectCanvas');
const rctx = rectCanvas.getContext('2d');

function sizePlayer() {
  if (!S.src || !S.src.width) return;
  const area = $('#playerArea');
  const aspect = S.src.width / S.src.height;
  // leave room for transport, timeline and a few moment rows below the player
  const oneColumn = window.innerWidth <= 820;
  const maxH = clamp(window.innerHeight * (oneColumn ? 0.42 : 0.36), 160, 480);
  const w = Math.min(area.clientWidth, maxH * aspect);
  const h = w / aspect;
  const wrap = $('#playerWrap');
  wrap.style.width = w + 'px';
  wrap.style.height = h + 'px';
  rectCanvas.width = Math.round(w * dpr());
  rectCanvas.height = Math.round(h * dpr());
}

function currentLayout() {
  if (S.clip) return S.clip.layout;
  return S.src && S.src.layout_default;
}

function rectAspect(key, L) {
  const ow = 1080, oh = 1920;
  const r = L.split_ratio || 0.4;
  if (key === 'cam') return ow / (oh * r);
  if (key === 'game') return ow / (oh * (1 - r));
  if (key === 'crop') return ow / oh;
  return null;
}

function rectKeys(mode) {
  if (mode === 'split') return ['game', 'cam'];
  if (mode === 'crop') return ['crop'];
  return ['content'];
}
const RECT_LABEL = { cam: 'CAM', game: 'GAMEPLAY', crop: 'CROP', content: 'AREA VIDEO' };

/* shrink a normalized rect around its centre until its pixel aspect matches */
function fitAspectN(r, aspect) {
  if (!aspect) return r;
  const W = S.src.width, H = S.src.height;
  const pw = r.w * W, ph = r.h * H;
  if (pw / ph > aspect) {
    const nw = ph * aspect;
    return { x: (r.x * W + (pw - nw) / 2) / W, y: r.y, w: nw / W, h: r.h };
  }
  const nh = pw / aspect;
  return { x: r.x, y: (r.y * H + (ph - nh) / 2) / H, w: r.w, h: nh / H };
}

function drawRects() {
  const W = rectCanvas.width, H = rectCanvas.height;
  rctx.clearRect(0, 0, W, H);
  const L = currentLayout();
  if (!L || !$('#showRects').checked) return;
  const keys = rectKeys(L.mode);
  rctx.save();
  // dim everything outside the used areas
  rctx.fillStyle = 'rgba(0,0,0,0.45)';
  rctx.beginPath();
  rctx.rect(0, 0, W, H);
  keys.forEach(k => { const r = L[k]; if (r) rctx.rect(r.x * W, r.y * H, r.w * W, r.h * H); });
  rctx.fill('evenodd');
  keys.forEach(k => {
    const r = L[k];
    if (!r) return;
    const active = S.activeRect === k;
    const x = r.x * W, y = r.y * H, w = r.w * W, h = r.h * H;
    rctx.lineWidth = (active ? 2.5 : 1.5) * dpr();
    rctx.strokeStyle = active ? '#ffd400' : 'rgba(255,255,255,0.85)';
    rctx.setLineDash(active ? [] : [6 * dpr(), 4 * dpr()]);
    rctx.strokeRect(x, y, w, h);
    rctx.setLineDash([]);
    rctx.font = `600 ${11 * dpr()}px Segoe UI, sans-serif`;
    const label = RECT_LABEL[k];
    const tw = rctx.measureText(label).width + 10 * dpr();
    rctx.fillStyle = active ? '#ffd400' : 'rgba(0,0,0,0.7)';
    rctx.fillRect(x, y, tw, 18 * dpr());
    rctx.fillStyle = active ? '#1a1600' : '#fff';
    rctx.fillText(label, x + 5 * dpr(), y + 13 * dpr());
    if (active) {
      const hs = 9 * dpr();
      rctx.fillStyle = '#ffd400';
      [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([cx, cy]) => rctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs));
    }
  });
  rctx.restore();
}

let rectDrag = null;
function normPoint(e) {
  const b = rectCanvas.getBoundingClientRect();
  return { x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height, bw: b.width, bh: b.height };
}
function cornerAt(r, p) {
  const tolX = 10 / p.bw, tolY = 10 / p.bh;
  const corners = { tl: [r.x, r.y], tr: [r.x + r.w, r.y], bl: [r.x, r.y + r.h], br: [r.x + r.w, r.y + r.h] };
  for (const [name, [cx, cy]] of Object.entries(corners)) {
    if (Math.abs(p.x - cx) < tolX && Math.abs(p.y - cy) < tolY) return name;
  }
  return null;
}
const inside = (r, p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

function hitRect(p) {
  const L = currentLayout();
  if (!L || !$('#showRects').checked) return null;
  const keys = rectKeys(L.mode);
  const order = S.activeRect && keys.includes(S.activeRect) ? [S.activeRect, ...keys.filter(k => k !== S.activeRect)] : keys.slice().reverse();
  for (const k of order) {
    const r = L[k];
    if (!r) continue;
    if (k === S.activeRect) { const c = cornerAt(r, p); if (c) return { k, corner: c }; }
    if (inside(r, p)) return { k, corner: null };
  }
  return null;
}

rectCanvas.addEventListener('pointerdown', e => {
  const p = normPoint(e);
  const hit = hitRect(p);
  if (!hit) { togglePlay(); return; }
  S.activeRect = hit.k;
  const L = currentLayout();
  rectDrag = { ...hit, start: p, orig: { ...L[hit.k] } };
  rectCanvas.setPointerCapture(e.pointerId);
});
rectCanvas.addEventListener('pointermove', e => {
  const p = normPoint(e);
  if (!rectDrag) {
    const hit = hitRect(p);
    rectCanvas.style.cursor = !hit ? 'pointer' : hit.corner ? (hit.corner === 'tl' || hit.corner === 'br' ? 'nwse-resize' : 'nesw-resize') : 'move';
    return;
  }
  const L = currentLayout();
  const o = rectDrag.orig;
  const k = rectDrag.k;
  let r;
  if (!rectDrag.corner) {
    r = { ...o, x: clamp(o.x + p.x - rectDrag.start.x, 0, 1 - o.w), y: clamp(o.y + p.y - rectDrag.start.y, 0, 1 - o.h) };
  } else {
    const c = rectDrag.corner;
    const ax = c.includes('l') ? o.x + o.w : o.x;
    const ay = c.includes('t') ? o.y + o.h : o.y;
    let w = Math.abs(p.x - ax), h = Math.abs(p.y - ay);
    const aspect = rectAspect(k, L);
    if (aspect) {
      const an = aspect * S.src.height / S.src.width; // normalized w/h
      w = Math.max(w, h * an);
      h = w / an;
      const maxW = c.includes('l') ? ax : 1 - ax;
      const maxH = c.includes('t') ? ay : 1 - ay;
      const f = Math.min(1, maxW / w, maxH / h);
      w *= f; h *= f;
      if (w < 0.03) { w = 0.03; h = w / an; }
    } else {
      w = clamp(w, 0.05, c.includes('l') ? ax : 1 - ax);
      h = clamp(h, 0.05, c.includes('t') ? ay : 1 - ay);
    }
    r = { x: c.includes('l') ? ax - w : ax, y: c.includes('t') ? ay - h : ay, w, h };
  }
  L[k] = { x: round(r.x, 4), y: round(r.y, 4), w: round(r.w, 4), h: round(r.h, 4) };
});
rectCanvas.addEventListener('pointerup', () => {
  if (!rectDrag) return;
  rectDrag = null;
  layoutChanged();
});
$('#showRects').addEventListener('change', () => { if (!$('#showRects').checked) S.activeRect = null; });

function layoutChanged() {
  if (S.clip) scheduleSave();
  else if (S.src) {
    clearTimeout(S.srcPatchTimer);
    S.srcPatchTimer = setTimeout(() => api('PATCH', `/api/sources/${S.src.id}`, { layout_default: S.src.layout_default }), 400);
  }
}

// ------------------------------------------------------------ transport

function togglePlay() {
  if (!S.src || !S.src.prepared) return;
  if (video.paused) video.play().catch(() => {}); else video.pause();
}
function seekTo(t) {
  if (!S.src) return;
  video.currentTime = clamp(t, 0, S.src.duration || 0);
}
$('#playBtn').addEventListener('click', togglePlay);
video.addEventListener('play', () => { $('#playBtn').textContent = 'Pause'; });
video.addEventListener('pause', () => { $('#playBtn').textContent = 'Play'; });
$$('[data-seek]').forEach(b => b.addEventListener('click', () => { stopProgram(); seekTo(video.currentTime + Number(b.dataset.seek)); }));

function setIn() { S.inPt = round(video.currentTime, 2); if (S.outPt != null && S.outPt <= S.inPt) S.outPt = null; updateInOut(); }
function setOut() { S.outPt = round(video.currentTime, 2); if (S.inPt != null && S.inPt >= S.outPt) S.inPt = null; updateInOut(); }
function updateInOut() {
  $('#inVal').textContent = S.inPt != null ? fmt(S.inPt) : '';
  $('#outVal').textContent = S.outPt != null ? fmt(S.outPt) : '';
  S.tlDirty = true;
}
$('#inBtn').addEventListener('click', setIn);
$('#outBtn').addEventListener('click', setOut);
$('#addSegBtn').addEventListener('click', addSegFromInOut);

async function addSegFromInOut() {
  if (S.inPt == null || S.outPt == null) { toast('Tandai IN dan OUT dulu (tombol I dan O)', true); return; }
  await addSegment(S.inPt, S.outPt);
  S.inPt = S.outPt = null;
  updateInOut();
}

async function addSegment(start, end, newClip = false) {
  const seg = { start: round(start, 2), end: round(end, 2), zoom: 'none', speed: 1 };
  if (!S.clip || newClip) {
    const d = await api('POST', '/api/clips', { source_id: S.src.id, segments: [seg], title: `${S.src.id} ${fmt(start, 0).replace(':', 'm')}` });
    S.src.clips.unshift({ id: d.clip.id, title: d.clip.title });
    renderClipSelect();
    setClip(d.clip, d.timeline);
    toast('Klip baru dibuat');
  } else {
    S.clip.segments.push(seg);
    renderSegs();
    scheduleSave(0);
    toast(`Potongan ${S.clip.segments.length} ditambahkan`);
  }
  setTabs('clip', 'cuts');
  S.tlDirty = true;
}

// ------------------------------------------------------------ timeline

const tl = $('#timeline');
const tctx = tl.getContext('2d');
const tlStatic = document.createElement('canvas');
const TL = { ruler: 14, candY: 16, candH: 9, envTop: 28, envBottom: 64, segY: 67, segH: 14 }; // 84px canvas

function sizeTimeline() {
  const b = tl.getBoundingClientRect();
  tl.width = Math.round(b.width * dpr());
  tl.height = Math.round(b.height * dpr());
  tlStatic.width = tl.width;
  tlStatic.height = tl.height;
  S.tlDirty = true;
}
const tToX = t => (t - S.view.t0) / (S.view.t1 - S.view.t0) * tl.width;
const xToT = x => S.view.t0 + x / tl.width * (S.view.t1 - S.view.t0);

function drawTimelineStatic() {
  const c = tlStatic.getContext('2d');
  const W = tlStatic.width, H = tlStatic.height, k = dpr();
  c.clearRect(0, 0, W, H);
  if (!S.src || !S.src.duration) return;
  const span = S.view.t1 - S.view.t0;
  // ruler
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = steps.find(s => s / span * W >= 70 * k) || 3600;
  c.fillStyle = '#9b9ea6';
  c.font = `${10 * k}px Segoe UI, sans-serif`;
  c.strokeStyle = '#2b2d32';
  c.lineWidth = 1;
  for (let t = Math.ceil(S.view.t0 / step) * step; t <= S.view.t1; t += step) {
    const x = Math.round(tToX(t)) + 0.5;
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
    c.fillText(fmt(t, step < 1 ? 1 : 0), x + 3 * k, 11 * k);
  }
  // candidates
  (S.src.candidates || []).forEach((cd, i) => {
    const x0 = tToX(cd.start), x1 = tToX(cd.end);
    if (x1 < 0 || x0 > W) return;
    c.fillStyle = 'rgba(79,163,255,0.28)';
    c.fillRect(x0, TL.candY * k, x1 - x0, TL.candH * k);
    const px = tToX(cd.peak);
    c.fillStyle = '#4fa3ff';
    c.fillRect(px - 1 * k, TL.candY * k, 2 * k, TL.candH * k);
    c.fillText(String(i + 1), x0 + 2 * k, (TL.candY + 8) * k);
  });
  // loudness envelope
  const env = S.src.envelope;
  if (env) {
    const top = TL.envTop * k, bottom = TL.envBottom * k, hh = bottom - top;
    c.fillStyle = '#5b5f69';
    const n = env.db.length;
    for (let x = 0; x < W; x += 2 * k) {
      const ta = xToT(x), tb = xToT(x + 2 * k);
      let ia = Math.max(0, Math.floor(ta / env.hop)), ib = Math.min(n, Math.ceil(tb / env.hop));
      if (ib <= ia) continue;
      let m = -90;
      for (let i = ia; i < ib; i++) if (env.db[i] > m) m = env.db[i];
      const v = clamp((m + 55) / 50, 0, 1);
      c.fillRect(x, bottom - v * hh, Math.max(1, 1.5 * k), v * hh);
    }
  }
  // YouTube most replayed
  const yt = S.src.youtube;
  if (yt && yt.heatmap && yt.heatmap.length) {
    const off = yt.offset || 0;
    const top = TL.envTop * k, bottom = TL.envBottom * k;
    c.strokeStyle = '#ff6b6b';
    c.lineWidth = 1.5 * k;
    c.beginPath();
    yt.heatmap.forEach((h, i) => {
      const x = tToX((h.start_time + h.end_time) / 2 - off);
      const y = bottom - h.value * (bottom - top);
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    });
    c.stroke();
  }
  // in/out range
  if (S.inPt != null || S.outPt != null) {
    const a = S.inPt ?? S.outPt, b = S.outPt ?? S.inPt;
    c.fillStyle = 'rgba(255,255,255,0.08)';
    c.fillRect(tToX(a), 0, Math.max(2, tToX(b) - tToX(a)), H);
    c.fillStyle = '#ffffff';
    if (S.inPt != null) c.fillRect(tToX(S.inPt), TL.ruler * k, 2 * k, H);
    if (S.outPt != null) c.fillRect(tToX(S.outPt) - 2 * k, TL.ruler * k, 2 * k, H);
  }
  // clip segments
  if (S.clip) {
    S.clip.segments.forEach((sg, i) => {
      const x0 = tToX(sg.start), x1 = tToX(sg.end);
      c.fillStyle = 'rgba(255,212,0,0.85)';
      c.fillRect(x0, TL.segY * k, Math.max(2, x1 - x0), TL.segH * k);
      c.fillStyle = 'rgba(255,212,0,0.10)';
      c.fillRect(x0, TL.envTop * k, Math.max(2, x1 - x0), (TL.envBottom - TL.envTop) * k);
      c.fillStyle = '#1a1600';
      c.font = `700 ${10 * k}px Segoe UI, sans-serif`;
      if (x1 - x0 > 14 * k) c.fillText(String(i + 1), x0 + 4 * k, (TL.segY + 10.5) * k);
      c.font = `${10 * k}px Segoe UI, sans-serif`;
    });
    // sound effects, mapped from output time back onto the source
    (S.clip.sfx || []).forEach(s => {
      const t = outToSrc(s.at);
      if (t == null) return;
      const x = tToX(t), y = TL.segY * k;
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.moveTo(x, y - 1 * k); c.lineTo(x - 4 * k, y - 7 * k); c.lineTo(x + 4 * k, y - 7 * k);
      c.closePath(); c.fill();
    });
  }
}

/* output time -> source time (null when it falls in the outro or nowhere) */
function outToSrc(tOut) {
  const sg = segsLocal().find(s => tOut >= s.out_start && tOut < s.out_end);
  return sg ? sg.start + (tOut - sg.out_start) * sg.speed : null;
}

function drawTimeline() {
  if (S.tlDirty) { drawTimelineStatic(); S.tlDirty = false; }
  tctx.clearRect(0, 0, tl.width, tl.height);
  tctx.drawImage(tlStatic, 0, 0);
  if (!S.src || !S.src.duration) return;
  const x = tToX(video.currentTime);
  tctx.fillStyle = '#ffd400';
  tctx.fillRect(x - 1 * dpr(), 0, 2 * dpr(), tl.height);
}

let tlDrag = null;
function tlPoint(e) {
  const b = tl.getBoundingClientRect();
  return { x: (e.clientX - b.left) * dpr(), y: (e.clientY - b.top) * dpr() };
}
function segEdgeAt(p) {
  if (!S.clip) return null;
  const k = dpr();
  if (p.y < TL.envTop * k) return null;
  for (let i = 0; i < S.clip.segments.length; i++) {
    const sg = S.clip.segments[i];
    if (Math.abs(tToX(sg.start) - p.x) < 6 * k) return { i, edge: 'start' };
    if (Math.abs(tToX(sg.end) - p.x) < 6 * k) return { i, edge: 'end' };
  }
  return null;
}
tl.addEventListener('pointerdown', e => {
  if (!S.src) return;
  const p = tlPoint(e);
  const edge = segEdgeAt(p);
  tl.setPointerCapture(e.pointerId);
  stopProgram();
  if (edge) { tlDrag = { type: 'edge', ...edge }; return; }
  tlDrag = { type: 'scrub' };
  seekTo(xToT(p.x));
});
tl.addEventListener('pointermove', e => {
  const p = tlPoint(e);
  if (!tlDrag) { tl.style.cursor = segEdgeAt(p) ? 'ew-resize' : 'text'; return; }
  const t = clamp(xToT(p.x), 0, S.src.duration);
  if (tlDrag.type === 'scrub') { seekTo(t); return; }
  const sg = S.clip.segments[tlDrag.i];
  if (tlDrag.edge === 'start') sg.start = round(Math.min(t, sg.end - 0.2), 2);
  else sg.end = round(Math.max(t, sg.start + 0.2), 2);
  seekTo(t);
  S.tlDirty = true;
});
tl.addEventListener('pointerup', () => {
  if (tlDrag && tlDrag.type === 'edge') { renderSegs(); scheduleSave(); }
  tlDrag = null;
});
tl.addEventListener('wheel', e => {
  if (!S.src || !S.src.duration) return;
  e.preventDefault();
  const dur = S.src.duration;
  const span = S.view.t1 - S.view.t0;
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    const d = (e.deltaX || e.deltaY) / tl.clientWidth * span;
    const t0 = clamp(S.view.t0 + d, 0, dur - span);
    S.view = { t0, t1: t0 + span };
  } else {
    const p = tlPoint(e);
    const at = xToT(p.x);
    const ns = clamp(span * Math.exp(e.deltaY * 0.0015), Math.min(4, dur), dur);
    let t0 = at - (p.x / tl.width) * ns;
    t0 = clamp(t0, 0, dur - ns);
    S.view = { t0, t1: t0 + ns };
  }
  S.tlDirty = true;
}, { passive: false });

function ensureVisible(t) {
  const span = S.view.t1 - S.view.t0;
  if (t < S.view.t0 || t > S.view.t1) {
    const t0 = clamp(t - span * 0.2, 0, Math.max(0, S.src.duration - span));
    S.view = { t0, t1: t0 + span };
    S.tlDirty = true;
  }
}

// ------------------------------------------------------------ candidates + transcript

function renderCandidates() {
  const list = $('#candList');
  const c = S.src.candidates || [];
  if (!c.length) {
    list.innerHTML = '<li class="muted">Belum ada momen terdeteksi. Coba Hitung ulang, atau pilih manual pakai IN/OUT.</li>';
    return;
  }
  const segs = S.clip ? S.clip.segments : [];
  list.innerHTML = c.map((cd, i) => {
    const used = segs.some(s => s.start < cd.end && s.end > cd.start);
    return `<li class="${used ? 'used' : ''}">
      <div><div class="when"><b>${i + 1}.</b> ${fmt(cd.start, 0)}–${fmt(cd.end, 0)}</div>
        <div class="muted">${(cd.end - cd.start).toFixed(0)} dtk${used ? ' · dipakai' : ''}</div>
        <div class="score" title="skor ${cd.score}"><i style="width:${clamp(cd.score / 2, 0.05, 1) * 100}%"></i></div></div>
      <div><div class="why">${esc(cd.reasons.join(' · ') || 'suara di atas rata-rata')}</div>
        <div class="txt">${cd.text ? '“' + esc(cd.text) + '”' : '<span class="muted">(belum ada transkrip)</span>'}</div></div>
      <div class="acts">
        <button class="btn small" data-cand-play="${i}">Putar</button>
        <button class="btn small" data-cand-add="${i}">+ ke klip</button>
        <button class="btn small ghost" data-cand-new="${i}">Klip baru</button>
      </div></li>`;
  }).join('');
}
$('#candList').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  const cands = S.src.candidates;
  if (b.dataset.candPlay != null) {
    const cd = cands[+b.dataset.candPlay];
    stopProgram();
    ensureVisible(cd.start);
    seekTo(cd.start);
    S.stopAt = cd.end;
    S.inPt = cd.start; S.outPt = cd.end; updateInOut();
    video.play().catch(() => {});
  } else if (b.dataset.candAdd != null) {
    const cd = cands[+b.dataset.candAdd];
    addSegment(cd.start, cd.end).then(renderCandidates);
  } else if (b.dataset.candNew != null) {
    const cd = cands[+b.dataset.candNew];
    addSegment(cd.start, cd.end, true).then(renderCandidates);
  }
});

function renderTranscript() {
  const list = $('#trList');
  const segs = S.src.transcript_segments;
  if (!segs) {
    list.innerHTML = '<li class="muted">Belum ada transkrip. Klik “Transkrip (Whisper)” di tab Momen.</li>';
    return;
  }
  const q = $('#trSearch').value.trim().toLowerCase();
  const rx = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
  list.innerHTML = segs.map((s, i) => {
    if (q && !s.text.toLowerCase().includes(q)) return '';
    const text = rx ? esc(s.text).replace(rx, m => `<mark>${m}</mark>`) : esc(s.text);
    return `<li data-i="${i}"><span class="t">${fmt(s.start, 0)}</span><span>${text}</span>
      <button class="btn small ghost" data-tr-add="${i}" title="Tambah kalimat ini sebagai potongan">+</button></li>`;
  }).join('') || '<li class="muted">Tidak ketemu.</li>';
}
$('#trSearch').addEventListener('input', renderTranscript);
$('#trList').addEventListener('click', e => {
  const add = e.target.closest('[data-tr-add]');
  const segs = S.src.transcript_segments;
  if (add) {
    const s = segs[+add.dataset.trAdd];
    addSegment(Math.max(0, s.start - 0.2), s.end + 0.3);
    return;
  }
  const li = e.target.closest('li[data-i]');
  if (li) { stopProgram(); const t = segs[+li.dataset.i].start; ensureVisible(t); seekTo(t); }
});

// ------------------------------------------------------------ clips

function renderClipSelect() {
  const sel = $('#clipSelect');
  const clips = S.src ? S.src.clips || [] : [];
  sel.innerHTML = clips.length
    ? clips.map(c => `<option value="${esc(c.id)}">${esc(c.title || c.id)}</option>`).join('')
    : '<option value="">(belum ada klip)</option>';
  if (S.clip) sel.value = S.clip.id;
  const has = !!S.src && S.src.prepared;
  $('#newClipBtn').disabled = !has;
  $('#dupClipBtn').disabled = !S.clip;
  $('#delClipBtn').disabled = !S.clip;
}
$('#clipSelect').addEventListener('change', e => { if (e.target.value) loadClip(e.target.value); });
$('#newClipBtn').addEventListener('click', async () => {
  const t = video.currentTime || 0;
  const start = S.inPt ?? t, end = S.outPt ?? Math.min(S.src.duration, start + 15);
  await addSegment(start, end, true);
});
$('#dupClipBtn').addEventListener('click', async () => {
  if (!S.clip) return;
  await flushSave();
  const d = await api('POST', `/api/clips/${S.clip.id}/duplicate`);
  S.src.clips.unshift({ id: d.clip.id, title: d.clip.title });
  setClip(d.clip, d.timeline);
  renderClipSelect();
  toast('Klip diduplikat');
});
$('#delClipBtn').addEventListener('click', async () => {
  if (!S.clip) return;
  if (!confirm(`Hapus klip "${S.clip.title}"? (file dipindah ke clips/.trash)`)) return;
  const id = S.clip.id;
  clearTimeout(S.saveTimer);
  await api('DELETE', `/api/clips/${id}`);
  S.src.clips = S.src.clips.filter(c => c.id !== id);
  setClip(null);
  if (S.src.clips[0]) await loadClip(S.src.clips[0].id);
  renderClipSelect();
});

async function loadClip(id) {
  await flushSave();
  const d = await api('GET', `/api/clips/${encodeURIComponent(id)}`);
  setClip(d.clip, d.timeline);
}

function setClip(clip, timeline = null) {
  stopProgram();
  S.clip = clip;
  S.tl = timeline;
  S.activeRect = null;
  $('#clipEmpty').hidden = !!clip;
  $('#clipBody').hidden = !clip;
  if (S.src && clip) store('clip.' + S.src.id, clip.id);
  renderClipSelect();
  if (clip) renderClip();
  if (S.src && S.src.candidates) renderCandidates();
  S.tlDirty = true;
}

function scheduleSave(delay = 350) {
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveClip, delay);
}
async function flushSave() {
  if (S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = null; await saveClip(); }
}
async function saveClip() {
  S.saveTimer = null;
  if (!S.clip) return;
  const id = S.clip.id;
  try {
    const d = await api('PUT', `/api/clips/${id}`, S.clip);
    if (S.clip && S.clip.id === id) {
      S.tl = d.timeline;
      if (!document.activeElement || !document.activeElement.closest('#wordEditor')) renderWordEditor();
      renderChecklist();
      const sum = S.src.clips.find(c => c.id === id);
      if (sum && sum.title !== S.clip.title) { sum.title = S.clip.title; renderClipSelect(); }
    }
  } catch (err) {
    toast('Gagal simpan: ' + err.message, true);
  }
}

function clipEdited() {
  scheduleSave();
  S.tlDirty = true;
}

/* local copy of the server's segment -> output time mapping */
function segsLocal() {
  const out = [];
  let t = 0;
  for (const sg of (S.clip ? S.clip.segments : [])) {
    if (sg.end - sg.start < 0.1) continue;
    const sp = Number(sg.speed) || 1;
    const d = (sg.end - sg.start) / sp;
    out.push({ start: sg.start, end: sg.end, speed: sp, zoom: sg.zoom || 'none', out_start: t, out_end: t + d });
    t += d;
  }
  return out;
}
const mainDuration = () => { const s = segsLocal(); return s.length ? s[s.length - 1].out_end : 0; };
const outroDuration = () => (S.clip ? bumperDur('bumper_in') + bumperDur('bumper_out') : 0); // all bumpers

function renderClip() {
  const c = S.clip;
  $('#clipTitle').value = c.title || '';
  // layout
  $$('#layoutMode button').forEach(b => b.classList.toggle('on', b.dataset.mode === c.layout.mode));
  $$('[data-show]').forEach(el => { el.hidden = el.dataset.show !== c.layout.mode; });
  $('#splitRatio').value = c.layout.split_ratio ?? 0.4;
  $('#splitVal').textContent = Math.round((c.layout.split_ratio ?? 0.4) * 100) + '%';
  $('#camTop').checked = c.layout.cam_top !== false;
  $('#fitZoom').value = c.layout.fit_zoom ?? 1;
  $('#fitZoomVal').textContent = (+(c.layout.fit_zoom ?? 1)).toFixed(2) + '×';
  $('#fitY').value = c.layout.fit_y ?? 0.5;
  $('#fitBg').value = c.layout.bg || 'blur';
  // text
  const h = c.hook || (c.hook = {});
  $('#hookText').value = h.text || '';
  $('#hookStyle').value = h.style || 'box-white';
  $('#hookDur').value = h.duration || 0;
  $('#hookY').value = h.y ?? 0.4;
  const cap = c.captions || (c.captions = {});
  $('#capOn').checked = cap.enabled !== false;
  $('#capStyle').value = cap.style || 'pop';
  $('#capWords').value = String(cap.words_per_chunk || 3);
  const hl = cap.highlight ?? S.app.styles.captions[cap.style || 'pop'].highlight;
  $('#capHl').value = hl || '#ffffff';
  $('#capHl').disabled = !hl;
  $('#capUpper').checked = cap.uppercase !== false;
  $('#capY').value = cap.y ?? 0.62;
  $('#capNoTranscript').hidden = !!(S.src && S.src.transcribed);
  // export
  const wm = wmCfg();
  $('#wmW').value = wm.w; $('#wmOp').value = wm.opacity; $('#wmX').value = wm.x; $('#wmY').value = wm.y;
  renderBrandToggles();
  $('#loudOn').checked = c.loudnorm !== false;
  $('#fpsSel').value = String(c.fps || 30);
  if (!c.post_caption) c.post_caption = defaultCaption();
  $('#postCaption').value = c.post_caption;
  renderSegs();
  renderOverlays();
  renderWordEditor();
  renderChecklist();
  renderLastExport();
  renderAudio();
}

$('#clipTitle').addEventListener('input', e => { if (S.clip) { S.clip.title = e.target.value; clipEdited(); } });

// --- audio: original volume, backsound, sound effects
const lib = () => (S.app && S.app.audio) || { music: [], sfx: [] };
const audioName = p => (p || '').split('/').pop().replace(/\.[^.]+$/, '');
const MUSIC_DEFAULTS = { volume: 0.15, start: 0, fade_in: 0.5, fade_out: 1.0, duck: true };

let auditionEl = null;
function audition(path) {
  if (auditionEl) {
    const same = auditionEl.dataset.path === path;
    auditionEl.pause();
    auditionEl = null;
    if (same) return;
  }
  const a = new Audio(mediaUrl(path));
  a.dataset.path = path;
  a.volume = 0.9;
  a.play().catch(() => {});
  a.addEventListener('ended', () => { if (auditionEl === a) auditionEl = null; });
  auditionEl = a;
}

function renderAudio() {
  if (!S.clip) return;
  const c = S.clip;
  const vv = c.voice_volume ?? 1;
  $('#voiceVol').value = vv;
  $('#voiceVal').textContent = Math.round(vv * 100) + '%';
  video.volume = clamp(vv, 0, 1);
  const music = lib().music;
  const cur = c.music && c.music.path;
  const known = music.some(m => m.path === cur);
  $('#musicSel').innerHTML = '<option value="">Tanpa backsound</option>' +
    (cur && !known ? `<option value="${esc(cur)}">${esc(audioName(cur))} (file tidak ditemukan)</option>` : '') +
    music.map(m => `<option value="${esc(m.path)}">${esc(m.name)}${m.duration ? ` · ${fmt(m.duration, 0)}` : ''}</option>`).join('');
  $('#musicSel').value = cur || '';
  $('#musicOpts').hidden = !cur;
  if (cur) {
    const m = { ...MUSIC_DEFAULTS, ...c.music };
    $('#musicVol').value = m.volume;
    $('#musicVolVal').textContent = Math.round(m.volume * 100) + '%';
    $('#musicStart').value = m.start;
    $('#musicFadeIn').value = m.fade_in;
    $('#musicFadeOut').value = m.fade_out;
    $('#musicDuck').checked = m.duck !== false;
  }
  $('#sfxLib').innerHTML = lib().sfx.map(s => `
    <span class="sfx-item"><button class="btn small ghost" data-sfx-play="${esc(s.path)}" title="Dengar">${esc(s.name)}</button><button class="btn small ghost" data-sfx-add="${esc(s.path)}" title="Taruh di detik preview sekarang">+</button></span>`).join('')
    || '<span class="muted">Belum ada file di assets/sfx.</span>';
  renderSfxList();
}

function renderSfxList() {
  const items = S.clip.sfx || [];
  const options = path => {
    const all = lib().sfx.some(s => s.path === path) ? lib().sfx : [{ path, name: audioName(path) + ' (tidak ditemukan)' }, ...lib().sfx];
    return all.map(s => `<option value="${esc(s.path)}" ${s.path === path ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  };
  $('#sfxList').innerHTML = items.map((s, i) => `
    <li data-i="${i}">
      <div class="r1"><select data-f="path">${options(s.path)}</select>
        <button class="btn small ghost" data-a="play">Dengar</button>
        <button class="btn small ghost" data-a="go">Lompat</button>
        <button class="btn small ghost danger" data-a="del">Hapus</button></div>
      <div class="r2">di detik <input type="number" min="0" step="0.1" data-f="at" value="${s.at}">
        volume <input type="range" min="0" max="2" step="0.05" data-f="volume" value="${s.volume ?? 1}">
        <span>${Math.round((s.volume ?? 1) * 100)}%</span></div></li>`).join('');
}

$('#voiceVol').addEventListener('input', e => {
  if (!S.clip) return;
  S.clip.voice_volume = Number(e.target.value);
  $('#voiceVal').textContent = Math.round(S.clip.voice_volume * 100) + '%';
  video.volume = clamp(S.clip.voice_volume, 0, 1);
  clipEdited();
});
$('#musicSel').addEventListener('change', e => {
  if (!S.clip) return;
  const path = e.target.value;
  S.clip.music = path ? { ...MUSIC_DEFAULTS, ...(S.clip.music || {}), path } : null;
  renderAudio();
  clipEdited();
});
$('#musicPrev').addEventListener('click', () => {
  const p = $('#musicSel').value;
  if (!p) { toast('Pilih file backsound dulu', true); return; }
  audition(p);
});
[['#musicVol', 'volume'], ['#musicStart', 'start'], ['#musicFadeIn', 'fade_in'], ['#musicFadeOut', 'fade_out']].forEach(([sel, f]) => {
  $(sel).addEventListener('input', e => {
    if (!S.clip || !S.clip.music) return;
    S.clip.music[f] = Math.max(0, Number(e.target.value) || 0);
    if (f === 'volume') $('#musicVolVal').textContent = Math.round(S.clip.music.volume * 100) + '%';
    clipEdited();
  });
});
$('#musicDuck').addEventListener('change', e => { if (S.clip && S.clip.music) { S.clip.music.duck = e.target.checked; clipEdited(); } });

$('#sfxLib').addEventListener('click', e => {
  const play = e.target.closest('[data-sfx-play]');
  if (play) { audition(play.dataset.sfxPlay); return; }
  const add = e.target.closest('[data-sfx-add]');
  if (!add || !S.clip) return;
  if (!S.clip.segments.length) { toast('Tambah potongan dulu', true); return; }
  const t = currentOutTime();
  if (t == null) toast('Posisi video di luar potongan, SFX ditaruh di detik 0. Ubah detiknya di daftar.', true, 5000);
  const sfx = S.clip.sfx || (S.clip.sfx = []);
  sfx.push({ path: add.dataset.sfxAdd, at: round(t ?? 0, 2), volume: 1 });
  sfx.sort((a, b) => a.at - b.at);
  renderSfxList();
  clipEdited();
  toast(`${audioName(add.dataset.sfxAdd)} ditaruh di detik ${fmt(t ?? 0)}`);
});
$('#sfxList').addEventListener('input', e => {
  const li = e.target.closest('li[data-i]');
  const f = e.target.dataset.f;
  if (!li || !f) return;
  const s = S.clip.sfx[+li.dataset.i];
  if (f === 'path') s.path = e.target.value;
  else if (f === 'at') s.at = Math.max(0, Number(e.target.value) || 0);
  else if (f === 'volume') { s.volume = Number(e.target.value); e.target.nextElementSibling.textContent = Math.round(s.volume * 100) + '%'; }
  clipEdited();
});
$('#sfxList').addEventListener('change', e => {
  if (e.target.dataset.f === 'at') { S.clip.sfx.sort((a, b) => a.at - b.at); renderSfxList(); }
});
$('#sfxList').addEventListener('click', e => {
  const b = e.target.closest('button[data-a]');
  const li = e.target.closest('li[data-i]');
  if (!b || !li) return;
  const i = +li.dataset.i, s = S.clip.sfx[i];
  if (b.dataset.a === 'play') audition(s.path);
  if (b.dataset.a === 'go') {
    const t = outToSrc(s.at);
    if (t == null) { toast('Detik ini di luar potongan klip', true); return; }
    stopProgram(); ensureVisible(t); seekTo(t);
  }
  if (b.dataset.a === 'del') { S.clip.sfx.splice(i, 1); renderSfxList(); clipEdited(); }
});
$('#audioReload').addEventListener('click', async () => {
  S.app.audio = await api('GET', '/api/audio');
  renderAudio();
  toast(`${lib().music.length} backsound, ${lib().sfx.length} sound effect`);
});

// --- segments
function renderSegs() {
  if (!S.clip) return;
  const segs = S.clip.segments;
  $('#segList').innerHTML = segs.length ? segs.map((s, i) => `
    <li data-i="${i}">
      <div class="top"><span class="num">${i + 1}</span>
        <input type="number" step="0.1" min="0" data-f="start" value="${s.start}" title="mulai (detik)">
        <span class="muted">→</span>
        <input type="number" step="0.1" min="0" data-f="end" value="${s.end}" title="selesai (detik)">
        <span class="dur">${((s.end - s.start) / (s.speed || 1)).toFixed(1)} dtk</span></div>
      <div class="bottom">
        <select data-f="zoom" title="efek zoom">
          ${['none', 'punch', 'push', 'punch-out'].map(z => `<option value="${z}" ${s.zoom === z ? 'selected' : ''}>zoom: ${z}</option>`).join('')}
        </select>
        <select data-f="speed" title="kecepatan">
          ${[0.5, 0.75, 1, 1.25, 1.5, 2].map(v => `<option value="${v}" ${Number(s.speed || 1) === v ? 'selected' : ''}>${v}×</option>`).join('')}
        </select>
        <button class="btn small ghost" data-a="go" title="Lompat ke awal potongan">Lompat</button>
        <button class="btn small ghost" data-a="inout" title="Ganti dengan IN/OUT yang ditandai">Pakai IN/OUT</button>
        <button class="btn small ghost" data-a="up" title="Naikkan urutan">↑</button>
        <button class="btn small ghost" data-a="down" title="Turunkan urutan">↓</button>
        <button class="btn small ghost danger" data-a="del">Hapus</button>
      </div></li>`).join('') : '<li class="muted">Belum ada potongan. Tandai IN/OUT lalu klik + Potongan.</li>';
  updateSegTotal();
}
function updateSegTotal() {
  const m = mainDuration(), bi = bumperDur('bumper_in'), bo = bumperDur('bumper_out');
  const extra = [bi ? `bumper in ${bi.toFixed(1)}` : '', bo ? `bumper out ${bo.toFixed(1)}` : ''].filter(Boolean);
  $('#segTotal').textContent = S.clip && S.clip.segments.length
    ? `Klip ${m.toFixed(1)} dtk${extra.length ? ` + ${extra.join(' + ')} = ${(m + bi + bo).toFixed(1)} dtk` : ''}`
    : '';
}
$('#segList').addEventListener('change', e => {
  const li = e.target.closest('li[data-i]');
  if (!li || !S.clip) return;
  const sg = S.clip.segments[+li.dataset.i];
  const f = e.target.dataset.f;
  if (f === 'start' || f === 'end') {
    let v = clamp(Number(e.target.value), 0, S.src.duration);
    if (f === 'start') sg.start = round(Math.min(v, sg.end - 0.1), 2); else sg.end = round(Math.max(v, sg.start + 0.1), 2);
  } else if (f === 'zoom') sg.zoom = e.target.value;
  else if (f === 'speed') sg.speed = Number(e.target.value);
  renderSegs();
  clipEdited();
});
$('#segList').addEventListener('click', e => {
  const b = e.target.closest('button[data-a]');
  const li = e.target.closest('li[data-i]');
  if (!b || !li) return;
  const i = +li.dataset.i, segs = S.clip.segments;
  const a = b.dataset.a;
  if (a === 'go') { stopProgram(); ensureVisible(segs[i].start); seekTo(segs[i].start); return; }
  if (a === 'inout') {
    if (S.inPt == null || S.outPt == null) { toast('Tandai IN dan OUT dulu', true); return; }
    segs[i].start = S.inPt; segs[i].end = S.outPt;
  }
  if (a === 'up' && i > 0) [segs[i - 1], segs[i]] = [segs[i], segs[i - 1]];
  if (a === 'down' && i < segs.length - 1) [segs[i + 1], segs[i]] = [segs[i], segs[i + 1]];
  if (a === 'del') segs.splice(i, 1);
  renderSegs();
  renderCandidates();
  clipEdited();
});

// --- layout
$('#layoutMode').addEventListener('click', e => {
  const b = e.target.closest('button[data-mode]');
  if (!b || !S.clip) return;
  S.clip.layout.mode = b.dataset.mode;
  const L = S.clip.layout;
  applyTextDefaults();
  // make sure the rect for this mode exists
  if (L.mode === 'crop' && !L.crop) L.crop = fitAspectN(L.content || { x: 0, y: 0, w: 1, h: 1 }, 1080 / 1920);
  S.activeRect = null;
  renderClip();
  clipEdited();
});
$('#splitRatio').addEventListener('input', e => {
  const L = S.clip.layout;
  L.split_ratio = Number(e.target.value);
  $('#splitVal').textContent = Math.round(L.split_ratio * 100) + '%';
  // keep the boxes at the right shape for the new split
  const grow = r => ({ x: r.x - r.w * 0.5, y: r.y - r.h * 0.5, w: r.w * 2, h: r.h * 2 });
  const inBounds = r => ({ x: clamp(r.x, 0, 1), y: clamp(r.y, 0, 1), w: Math.min(r.w, 1 - clamp(r.x, 0, 1)), h: Math.min(r.h, 1 - clamp(r.y, 0, 1)) });
  ['cam', 'game'].forEach(k => {
    const r = L[k];
    const target = rectAspect(k, L);
    const cur = (r.w * S.src.width) / (r.h * S.src.height);
    // shrink if possible; if the shape gets taller/wider than the box allows, grow the box first
    let base = cur > target ? r : inBounds(grow(r));
    L[k] = fitAspectN(base, target);
    if (k === 'game') {
      const nr = L[k];
      const keepH = Math.min(1, r.h);
      if (nr.h < keepH * 0.98) L[k] = fitAspectN(inBounds({ x: nr.x + nr.w / 2 - 0.5, y: r.y, w: 1, h: keepH }), target);
    }
    ['x', 'y', 'w', 'h'].forEach(f => { L[k][f] = round(L[k][f], 4); });
  });
  applyTextDefaults();
  $('#hookY').value = S.clip.hook.y;
  clipEdited();
});
$('#camTop').addEventListener('change', e => { S.clip.layout.cam_top = e.target.checked; applyTextDefaults(); renderClip(); clipEdited(); });

/* hook/caption heights follow the layout (off the facecam) until the user moves them by hand */
function textDefaults(L) {
  if (L.mode === 'split') {
    const r = L.split_ratio || 0.4, top = L.cam_top !== false;
    return { hook: round(top ? r : 1 - r, 3), captions: top ? 0.63 : 0.3 };
  }
  // captions stay above the campaign watermark banner (73-83% of the height)
  if (L.mode === 'fit') return { hook: 0.2, captions: 0.62 };
  return { hook: 0.12, captions: 0.63 };
}
function applyTextDefaults() {
  const d = textDefaults(S.clip.layout);
  if (!S.clip.hook.y_custom) S.clip.hook.y = d.hook;
  if (!S.clip.captions.y_custom) S.clip.captions.y = d.captions;
}
$('#fitZoom').addEventListener('input', e => {
  S.clip.layout.fit_zoom = Number(e.target.value);
  $('#fitZoomVal').textContent = Number(e.target.value).toFixed(2) + '×';
  clipEdited();
});
$('#fitY').addEventListener('input', e => { S.clip.layout.fit_y = Number(e.target.value); clipEdited(); });
$('#fitBg').addEventListener('change', e => { S.clip.layout.bg = e.target.value; clipEdited(); });
$('#saveDefaultLayout').addEventListener('click', async () => {
  S.src.layout_default = JSON.parse(JSON.stringify(S.clip.layout));
  await api('PATCH', `/api/sources/${S.src.id}`, { layout_default: S.src.layout_default });
  toast('Layout ini jadi default untuk klip baru dari video ini');
});

// --- text
function bindClip(sel, apply, evt = 'input') {
  $(sel).addEventListener(evt, e => {
    if (!S.clip) return;
    const el = e.target;
    apply(el.type === 'checkbox' ? el.checked : el.value, S.clip);
    clipEdited();
  });
}
bindClip('#hookText', (v, c) => { c.hook.text = v; if (!c.post_caption_edited) { c.post_caption = defaultCaption(); $('#postCaption').value = c.post_caption; } });
bindClip('#hookStyle', (v, c) => { c.hook.style = v; }, 'change');
bindClip('#hookDur', (v, c) => { c.hook.duration = Math.max(0, Number(v) || 0); });
bindClip('#hookY', (v, c) => { c.hook.y = Number(v); c.hook.y_custom = true; });
bindClip('#capOn', (v, c) => { c.captions.enabled = v; }, 'change');
bindClip('#capStyle', (v, c) => {
  c.captions.style = v;
  c.captions.highlight = S.app.styles.captions[v].highlight;
  $('#capHl').value = c.captions.highlight || '#ffffff';
  $('#capHl').disabled = !c.captions.highlight;
}, 'change');
bindClip('#capWords', (v, c) => { c.captions.words_per_chunk = Number(v); }, 'change');
bindClip('#capHl', (v, c) => { c.captions.highlight = v; });
bindClip('#capUpper', (v, c) => { c.captions.uppercase = v; }, 'change');
bindClip('#capY', (v, c) => { c.captions.y = Number(v); c.captions.y_custom = true; });

function renderWordEditor() {
  const box = $('#wordEditor');
  const words = (S.tl && S.tl.words) || [];
  $('#wordCount').textContent = words.length;
  box.innerHTML = words.map(w => {
    const edited = w.w !== w.orig;
    return `<span class="w"><small data-t="${w.s}">${fmt(w.s)}</small>
      <input data-key="${esc(w.key)}" data-orig="${esc(w.orig)}" value="${esc(w.w)}" size="${Math.max(2, w.w.length || w.orig.length)}"
        class="${edited ? 'edited' : ''} ${w.w.trim() ? '' : 'hidden-w'}" title="asli: ${esc(w.orig)}"></span>`;
  }).join('') || '<span class="muted">Tidak ada kata di dalam potongan klip (atau belum ada transkrip).</span>';
}
$('#wordEditor').addEventListener('input', e => {
  const inp = e.target.closest('input[data-key]');
  if (!inp || !S.clip) return;
  const ov = S.clip.captions.overrides || (S.clip.captions.overrides = {});
  if (inp.value === inp.dataset.orig) delete ov[inp.dataset.key]; else ov[inp.dataset.key] = inp.value;
  inp.classList.toggle('edited', inp.value !== inp.dataset.orig);
  inp.classList.toggle('hidden-w', !inp.value.trim());
  inp.size = Math.max(2, inp.value.length);
  clipEdited();
});
$('#wordEditor').addEventListener('click', e => {
  const t = e.target.closest('small[data-t]');
  if (t) { stopProgram(); seekTo(Number(t.dataset.t)); }
});

function renderOverlays() {
  const ovs = S.clip.overlays || (S.clip.overlays = []);
  const styles = Object.keys(S.app.styles.overlays);
  $('#ovList').innerHTML = ovs.map((o, i) => `
    <li data-i="${i}">
      <div class="r1"><input data-f="text" value="${esc(o.text)}" placeholder="teks">
        <select data-f="style">${styles.map(s => `<option ${o.style === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div class="r2">dari <input type="number" step="0.1" min="0" data-f="start" value="${o.start}">
        s/d <input type="number" step="0.1" min="0" data-f="end" value="${o.end}"> dtk
        <label class="inline">Y <input type="range" min="0.05" max="0.95" step="0.01" data-f="y" value="${o.y ?? 0.3}" style="width:80px"></label>
        <button class="btn small ghost danger" data-a="del">Hapus</button></div></li>`).join('');
}
$('#ovList').addEventListener('input', e => {
  const li = e.target.closest('li[data-i]');
  const f = e.target.dataset.f;
  if (!li || !f) return;
  const o = S.clip.overlays[+li.dataset.i];
  o[f] = ['start', 'end', 'y'].includes(f) ? Number(e.target.value) : e.target.value;
  clipEdited();
});
$('#ovList').addEventListener('click', e => {
  const b = e.target.closest('button[data-a="del"]');
  const li = e.target.closest('li[data-i]');
  if (!b || !li) return;
  S.clip.overlays.splice(+li.dataset.i, 1);
  renderOverlays();
  clipEdited();
});
$('#addOvBtn').addEventListener('click', () => {
  if (!S.clip) return;
  const t = currentOutTime() ?? 0;
  S.clip.overlays.push({ text: 'NGAKAK', style: 'pop', start: round(t, 1), end: round(t + 2, 1), x: 0.5, y: 0.3, anim: 'pop' });
  renderOverlays();
  clipEdited();
});

// --- export
function wmCfg() {
  return { x: 0.5, y: 0.5, w: 1, opacity: 1, ...brandFor('watermark') };
}
function setWm(field, value) {
  if (!S.clip) return;
  S.clip.watermark = { ...(S.clip.watermark || {}), [field]: value };
  clipEdited();
}
['wmW:w', 'wmOp:opacity', 'wmX:x', 'wmY:y'].forEach(pair => {
  const [id, f] = pair.split(':');
  $('#' + id).addEventListener('input', e => setWm(f, Number(e.target.value)));
});
$('#wmReset').addEventListener('click', () => {
  if (!S.clip) return;
  const on = S.clip.watermark && 'enabled' in S.clip.watermark ? { enabled: S.clip.watermark.enabled } : {};
  S.clip.watermark = on;
  renderClip();
  clipEdited();
});

/* per-clip on/off for each branding element the campaign has set up */
function renderBrandToggles() {
  const rows = BRAND.filter(b => { const c = S.app.campaign[b.key] || {}; return c.path || c.enabled || c.required; }).map(b => {
    const e = brandFor(b.key);
    const note = !e.exists ? '<span class="bad">file belum ada</span>'
      : (b.key.startsWith('bumper') && e.duration ? `<span class="muted">${e.duration.toFixed(1)} dtk</span>` : '');
    return `<label class="check"><input type="checkbox" data-brand="${b.key}" ${e.enabled ? 'checked' : ''}>
      ${b.label}${e.required ? ' <span class="muted">(wajib)</span>' : ''} ${note}</label>`;
  });
  $('#brandToggles').innerHTML = rows.join('') ||
    '<p class="hint">Campaign ini belum punya watermark, banner, atau bumper.</p>';
  const wm = S.app.campaign.watermark || {};
  $('#wmAdjust').hidden = !(wm.path || wm.enabled);
}
$('#brandToggles').addEventListener('change', e => {
  const k = e.target.dataset.brand;
  if (!k || !S.clip) return;
  const v = e.target.checked;
  if (k === 'watermark' || k === 'banner') S.clip[k] = { ...(S.clip[k] || {}), enabled: v };
  else S.clip[k] = v;
  if (k === 'bumper_out') delete S.clip.outro;
  updateSegTotal();
  renderChecklist();
  clipEdited();
});
bindClip('#loudOn', (v, c) => { c.loudnorm = v; }, 'change');
bindClip('#fpsSel', (v, c) => { c.fps = Number(v); }, 'change');
bindClip('#postCaption', (v, c) => { c.post_caption = v; c.post_caption_edited = true; renderChecklist(); });

function defaultCaption() {
  const hook = ((S.clip && S.clip.hook && S.clip.hook.text) || '').replace(/\*/g, '').replace(/\s*\n\s*/g, ' ').trim();
  const tags = (S.app.campaign.hashtags || []).join(' ');
  return [hook, tags].filter(Boolean).join('\n\n');
}
function hashtagsOk(text) {
  const tags = S.app.campaign.hashtags || [];
  const lower = (text || '').toLowerCase();
  let pos = -1;
  for (const t of tags) {
    const re = new RegExp(t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])', 'g');
    let m, found = -1;
    while ((m = re.exec(lower))) { if (m.index > pos) { found = m.index; break; } }
    if (found < 0) return false;
    pos = found;
  }
  return true;
}
$('#copyCaption').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#postCaption').value);
  toast('Caption + hashtag disalin');
});
$('#fixHashtags').addEventListener('click', () => {
  const tags = S.app.campaign.hashtags || [];
  let text = $('#postCaption').value;
  tags.forEach(t => { text = text.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])', 'gi'), ''); });
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  text = (text ? text + '\n\n' : '') + tags.join(' ');
  $('#postCaption').value = text;
  S.clip.post_caption = text;
  S.clip.post_caption_edited = true;
  clipEdited();
  renderChecklist();
});

function renderChecklist() {
  if (!S.clip) return;
  const auto = [];
  BRAND.forEach(b => {
    const e = brandFor(b.key);
    if (!e.required) return;
    const ok = e.enabled && e.exists;
    const label = !e.exists ? `${b.label} wajib, tapi filenya belum ada (atur di Pengaturan campaign)`
      : !e.enabled ? `${b.label} wajib, tapi dimatikan di klip ini` : `${b.label} terpasang`;
    auto.push([ok, label]);
  });
  if ((S.app.campaign.hashtags || []).length) auto.push([hashtagsOk(S.clip.post_caption), 'Hashtag lengkap dan urutannya benar']);
  auto.push([mainDuration() > 0, `Durasi klip ${mainDuration().toFixed(1)} dtk`]);
  const manual = S.app.campaign.checklist || [];
  const checks = S.clip.checks || {};
  $('#checklist').innerHTML =
    auto.map(([ok, label]) => `<li><span class="st ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</span><span>${esc(label)}</span></li>`).join('') +
    manual.map((label, i) => `<li><label><input type="checkbox" data-check="${i}" ${checks[i] ? 'checked' : ''}><span>${esc(label)}</span></label></li>`).join('');
}
$('#checklist').addEventListener('change', e => {
  const cb = e.target.closest('[data-check]');
  if (!cb || !S.clip) return;
  S.clip.checks = { ...(S.clip.checks || {}), [cb.dataset.check]: cb.checked };
  clipEdited();
});

function renderLastExport() {
  const p = S.clip && S.clip.exported;
  $('#lastExport').innerHTML = p
    ? `Export terakhir: <code>${esc(p)}</code> <button class="btn small" data-play="${esc(p)}">Putar</button>
       <button class="btn small ghost" data-open="${esc(p)}">Folder</button>`
    : '';
}

$('#draftBtn').addEventListener('click', () => renderClip_('draft'));
$('#exportBtn').addEventListener('click', () => renderClip_('final'));
async function renderClip_(quality) {
  if (!S.clip) return;
  if (!S.clip.segments.length) { toast('Belum ada potongan', true); return; }
  await flushSave();
  const missing = BRAND.filter(b => { const e = brandFor(b.key); return e.required && !(e.enabled && e.exists); });
  if (quality === 'final' && missing.length) {
    const names = missing.map(b => b.label.toLowerCase()).join(', ');
    if (!confirm(`Campaign mewajibkan ${names}, tapi belum aktif atau filenya belum ada. Tetap export?`)) return;
  }
  startJob('POST', `/api/clips/${S.clip.id}/render`, { quality });
  toast(quality === 'draft' ? 'Render draft dimulai…' : 'Export final dimulai…');
}

// ------------------------------------------------------------ 9:16 preview

const pc = $('#preview');
const pctx = pc.getContext('2d');
const PW = pc.width, PH = pc.height, K = PW / 1080;

function currentOutTime() {
  if (S.prog.on) return S.prog.tOut;
  const t = video.currentTime;
  const seg = segsLocal().find(s => t >= s.start && t < s.end);
  return seg ? seg.out_start + (t - seg.start) / seg.speed : null;
}
function zoomAt(seg, tLocal, dur) {
  if (!seg) return 1;
  if (seg.zoom === 'push') return 1 + 0.12 * tLocal / Math.max(dur, 0.1);
  if (seg.zoom === 'punch') return 1 + 0.22 * Math.min(tLocal / 0.12, 1);
  if (seg.zoom === 'punch-out') return 1.25 - 0.25 * Math.min(tLocal / 0.35, 1);
  return 1;
}

function srcRect(r, vw, vh) { return [r.x * vw, r.y * vh, r.w * vw, r.h * vh]; }
function zoomRect([x, y, w, h], z) {
  if (z === 1) return [x, y, w, h];
  const nw = w / z, nh = h / z;
  return [x + (w - nw) / 2, y + (h - nh) / 2, nw, nh];
}

function drawLayout(ctx, v, L, z) {
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw) return;
  if (L.mode === 'split') {
    const ht = Math.round(PH * (L.split_ratio || 0.4));
    const hb = PH - ht;
    const camTop = L.cam_top !== false;
    const cam = srcRect(fitAspectN(L.cam, rectAspect('cam', L)), vw, vh);
    const game = zoomRect(srcRect(fitAspectN(L.game, rectAspect('game', L)), vw, vh), z);
    ctx.drawImage(v, ...cam, 0, camTop ? 0 : hb, PW, ht);
    ctx.drawImage(v, ...game, 0, camTop ? ht : 0, PW, hb);
  } else if (L.mode === 'crop') {
    ctx.drawImage(v, ...zoomRect(srcRect(fitAspectN(L.crop, 1080 / 1920), vw, vh), z), 0, 0, PW, PH);
  } else {
    const C = L.content || { x: 0, y: 0, w: 1, h: 1 };
    const [cx, cy, cw, ch] = srcRect(C, vw, vh);
    ctx.save();
    if (z !== 1) { ctx.translate(PW / 2, PH / 2); ctx.scale(z, z); ctx.translate(-PW / 2, -PH / 2); }
    if ((L.bg || 'blur') === 'blur') {
      const sc = Math.max(PW / cw, PH / ch);
      ctx.filter = 'blur(12px) brightness(0.9) saturate(1.15)';
      ctx.drawImage(v, cx, cy, cw, ch, (PW - cw * sc) / 2, (PH - ch * sc) / 2, cw * sc, ch * sc);
      ctx.filter = 'none';
    }
    const fz = Math.max(1, L.fit_zoom || 1);
    const fw = PW * fz, fh = fw * ch / cw;
    const w = Math.min(fw, PW), h = Math.min(fh, PH);
    const sw = cw * w / fw, sh = ch * h / fh;
    ctx.drawImage(v, cx + (cw - sw) / 2, cy + (ch - sh) / 2, sw, sh, (PW - w) / 2, (PH - h) * (L.fit_y ?? 0.5), w, h);
    ctx.restore();
  }
}

function canvasFont(name, px) {
  if (/black/i.test(name)) return `900 ${px}px Poppins, "Arial Black", sans-serif`;
  if (/extrabold/i.test(name)) return `800 ${px}px Poppins, "Segoe UI", sans-serif`;
  if (/impact/i.test(name)) return `${px}px Impact, "Arial Black", sans-serif`;
  return `700 ${px}px "${name}", sans-serif`;
}

/* split "*accent*" markup into [{text, accent}] */
function accentRuns(line) {
  return line.split(/(\*[^*]+\*)/).filter(Boolean).map(p =>
    p.length > 2 && p.startsWith('*') && p.endsWith('*') ? { text: p.slice(1, -1), accent: true } : { text: p, accent: false });
}

/* libass-style smart wrap: lines that overflow are split into evenly sized lines */
function wrapLines(ctx, text, maxW) {
  const out = [];
  text.split('\n').forEach(line => {
    const plain = line.replace(/\*/g, '');
    const full = ctx.measureText(plain).width;
    if (full <= maxW) { out.push(line); return; }
    const words = line.split(/\s+/).filter(Boolean);
    const width = ws => ctx.measureText(ws.join(' ').replace(/\*/g, '')).width;
    // two lines if possible: the most even split, top line not narrower than the bottom one
    let best = null;
    for (let i = 1; i < words.length; i++) {
      const a = width(words.slice(0, i)), b = width(words.slice(i));
      if (a > maxW || b > maxW) continue;
      const score = Math.max(a, b) + (a < b ? 1 : 0);
      if (!best || score < best.score) best = { i, score };
    }
    if (best) { out.push(words.slice(0, best.i).join(' '), words.slice(best.i).join(' ')); return; }
    let cur = [];
    words.forEach(w => {
      if (cur.length && width([...cur, w]) > maxW) { out.push(cur.join(' ')); cur = [w]; } else cur.push(w);
    });
    if (cur.length) out.push(cur.join(' '));
  });
  // keep *accent* runs balanced when a wrap split one
  return out.map(l => ((l.match(/\*/g) || []).length % 2 ? l.replace(/\*/g, '') : l));
}

function drawTextBlock(ctx, text, cfg) {
  // cfg: font, size, color, accent, outline, bord, box, x, y
  const size = cfg.size * K;
  ctx.font = canvasFont(cfg.font, size);
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const lines = wrapLines(ctx, text, PW - 2 * (cfg.box ? 40 : 60) * K);
  const lh = size * 1.18;
  const pad = cfg.box ? Math.max(10, cfg.size / 4) * K : 0;
  const blockH = lines.length * lh + (cfg.box ? (lines.length - 1) * pad * 0.6 : 0);
  let y = cfg.y - blockH / 2 + lh / 2;
  lines.forEach(line => {
    const runs = accentRuns(line);
    const widths = runs.map(r => ctx.measureText(r.text).width);
    const total = widths.reduce((a, b) => a + b, 0);
    let x = cfg.x - total / 2;
    if (cfg.box && total > 0) {
      ctx.fillStyle = cfg.box;
      ctx.fillRect(x - pad, y - lh / 2 - pad * 0.35, total + pad * 2, lh + pad * 0.7);
    }
    runs.forEach((r, i) => {
      if (!cfg.box && cfg.bord) {
        ctx.lineWidth = cfg.bord * 2 * K;
        ctx.strokeStyle = cfg.outline || '#000';
        ctx.strokeText(r.text, x, y);
      }
      ctx.fillStyle = r.accent ? cfg.accent : cfg.color;
      ctx.fillText(r.text, x, y);
      x += widths[i];
    });
    y += lh + (cfg.box ? pad * 0.6 : 0);
  });
}

function drawCaption(ctx, tOut) {
  const cap = S.clip.captions || {};
  if (cap.enabled === false || !S.tl || tOut == null) return;
  const ch = S.tl.captions.find(c => tOut >= c.s && tOut < c.e);
  if (!ch) return;
  const st = S.app.styles.captions[cap.style || 'pop'] || S.app.styles.captions.pop;
  const size = (cap.size || st.size) * K;
  const hl = cap.highlight ?? st.highlight;
  let active = 0;
  ch.words.forEach((w, i) => { if (tOut >= w.s) active = i; });
  const pop = clamp((tOut - ch.s) / 0.09, 0, 1);
  const scale = 0.88 + 0.12 * pop;
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const cx = PW / 2, cy = (cap.y ?? 0.62) * PH;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  const words = ch.words.map((w, i) => ({ text: w.w, big: hl && i === active }));
  const space = size * 0.28;
  const measure = w => { ctx.font = canvasFont(st.font, w.big ? size * 1.12 : size); return ctx.measureText(w.text).width; };
  const widths = words.map(measure);
  // wrap into lines that fit inside the 60px side margins
  const maxW = PW - 120 * K;
  const lines = [[]];
  let lw = 0;
  words.forEach((w, i) => {
    const add = widths[i] + (lines[lines.length - 1].length ? space : 0);
    if (lw + add > maxW && lines[lines.length - 1].length) { lines.push([]); lw = 0; }
    lines[lines.length - 1].push(i);
    lw += widths[i] + (lines[lines.length - 1].length > 1 ? space : 0);
  });
  const lh = size * 1.15;
  lines.forEach((ids, li) => {
    const total = ids.reduce((a, i, j) => a + widths[i] + (j ? space : 0), 0);
    let x = -total / 2;
    const y = (li - (lines.length - 1) / 2) * lh;
    ids.forEach(i => {
      const w = words[i];
      ctx.font = canvasFont(st.font, w.big ? size * 1.12 : size);
      ctx.lineWidth = st.bord * 2 * K;
      ctx.strokeStyle = st.outline;
      ctx.strokeText(w.text, x, y);
      ctx.fillStyle = w.big ? hl : st.color;
      ctx.fillText(w.text, x, y);
      x += widths[i] + space;
    });
  });
  ctx.restore();
}

/* bumper video/image letterboxed into the 9:16 frame */
function drawBumper(k) {
  const b = S.bumper && S.bumper[k];
  if (!b) return;
  const w0 = b.kind === 'video' ? b.el.videoWidth : b.el.naturalWidth;
  const h0 = b.kind === 'video' ? b.el.videoHeight : b.el.naturalHeight;
  if (!w0) return;
  const sc = Math.min(PW / w0, PH / h0);
  pctx.drawImage(b.el, (PW - w0 * sc) / 2, (PH - h0 * sc) / 2, w0 * sc, h0 * sc);
}

function drawImageOverlay(ctx, img, cfg, W, H, alpha = 1, dy = 0) {
  const ww = (cfg.w ?? 1) * W, wh = ww * img.height / img.width;
  ctx.globalAlpha = (cfg.opacity ?? 1) * alpha;
  ctx.drawImage(img, (cfg.x ?? 0.5) * W - ww / 2, (cfg.y ?? 0.5) * H - wh / 2 + dy, ww, wh);
  ctx.globalAlpha = 1;
}

const ANIM_IN = 0.35; // same as render.py
function drawBanner(tOut) {
  const b = brandFor('banner');
  if (!b.enabled || !S.bannerImg) return;
  const total = mainDuration();
  const start = Math.max(0, Number(b.start) || 0);
  const end = Math.min(total, start + (Number(b.duration) || Math.max(0, total - start)));
  let alpha = 1, dy = 0;
  if (tOut != null) {
    if (tOut < start || tOut > end) return;
    const pin = clamp((tOut - start) / ANIM_IN, 0, 1);
    if (b.anim === 'fade') {
      alpha = pin;
      if (end < total - 0.05) alpha = Math.min(alpha, clamp((end - tOut) / ANIM_IN, 0, 1));
    } else if (b.anim === 'slide') {
      const wh = (b.w ?? 0.9) * PW * S.bannerImg.height / S.bannerImg.width;
      const cy = (b.y ?? 0.12) * PH;
      dy = (cy < PH / 2 ? -(wh / 2 + cy) : (PH - cy + wh / 2)) * (1 - pin) * (1 - pin);
    }
  }
  drawImageOverlay(pctx, S.bannerImg, b, PW, PH, alpha, dy);
}

function drawWatermark() {
  const wm = wmCfg();
  if (!wm.enabled) return;
  if (S.wmImg) { drawImageOverlay(pctx, S.wmImg, wm, PW, PH); return; }
  const ww = wm.w * PW, wh = Math.min(ww / 3, PH / 6);
  pctx.setLineDash([6, 4]);
  pctx.strokeStyle = 'rgba(255,255,255,0.8)';
  pctx.lineWidth = 2;
  pctx.strokeRect(wm.x * PW - ww / 2, wm.y * PH - wh / 2, ww, wh);
  pctx.setLineDash([]);
  pctx.fillStyle = 'rgba(255,255,255,0.85)';
  pctx.font = '600 18px Segoe UI, sans-serif';
  pctx.textAlign = 'center';
  pctx.textBaseline = 'middle';
  pctx.fillText('watermark (file belum ada)', wm.x * PW, wm.y * PH);
  pctx.textAlign = 'left';
}

function drawPreview() {
  pctx.fillStyle = '#000';
  pctx.fillRect(0, 0, PW, PH);
  if (!S.clip || !S.src) return;
  if (S.prog.on && S.prog.phase !== 'main') {
    drawBumper(S.prog.phase === 'in' ? 'bumper_in' : 'bumper_out');
    return;
  }
  const L = S.clip.layout;
  const t = video.currentTime;
  const segs = segsLocal();
  const seg = segs.find(s => t >= s.start && t < s.end);
  const z = seg ? zoomAt(seg, (t - seg.start) / seg.speed, seg.out_end - seg.out_start) : 1;
  if (video.readyState >= 2) drawLayout(pctx, video, L, z);
  const tOut = currentOutTime();

  // hook title
  const hook = S.clip.hook || {};
  const hd = Number(hook.duration) || 0;
  if (hook.text && hook.text.trim() && (tOut == null || !hd || tOut < hd)) {
    const st = S.app.styles.hooks[hook.style || 'box-white'] || S.app.styles.hooks['box-white'];
    drawTextBlock(pctx, hook.text.trim(), { font: st.font, size: hook.size || st.size, color: st.color, accent: st.accent,
      outline: st.outline, bord: st.box ? 0 : 6, box: st.box, x: PW / 2, y: (hook.y ?? 0.4) * PH });
  }

  drawCaption(pctx, tOut);

  // overlays
  if (tOut != null) {
    const total = mainDuration();
    (S.clip.overlays || []).forEach(o => {
      if (!o.text || tOut < o.start || tOut >= (o.end || total)) return;
      const st = S.app.styles.overlays[o.style] || S.app.styles.overlays.meme;
      drawTextBlock(pctx, o.text, { font: st.font, size: o.size || st.size, color: st.color,
        accent: o.style === 'pop' ? '#FFFFFF' : '#FFE600', outline: st.outline, bord: st.bord || 0, box: st.box,
        x: (o.x ?? 0.5) * PW, y: (o.y ?? 0.3) * PH });
    });
  }

  // same stacking as the export: text, then banner, then watermark on top
  drawBanner(tOut);
  drawWatermark();

  if (tOut == null && S.clip.segments.length) {
    pctx.fillStyle = 'rgba(0,0,0,0.6)';
    pctx.fillRect(0, PH - 34, PW, 34);
    pctx.fillStyle = '#c9cbd1';
    pctx.font = '16px Segoe UI, sans-serif';
    pctx.textAlign = 'center';
    pctx.textBaseline = 'middle';
    pctx.fillText('di luar potongan: caption tidak tampil', PW / 2, PH - 17);
    pctx.textAlign = 'left';
  }
}

// drag the watermark on the preview
let wmDrag = null;
pc.addEventListener('pointerdown', e => {
  if (!S.clip) return;
  const b = pc.getBoundingClientRect();
  const p = { x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height };
  const wm = wmCfg();
  const hb = wmHitBox();
  if (p.x >= hb.x && p.x <= hb.x + hb.w && p.y >= hb.y && p.y <= hb.y + hb.h) {
    wmDrag = { dx: p.x - wm.x, dy: p.y - wm.y };
    pc.setPointerCapture(e.pointerId);
  }
});
pc.addEventListener('pointermove', e => {
  const b = pc.getBoundingClientRect();
  const p = { x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height };
  if (!wmDrag) {
    if (!S.clip) return;
    const hb = wmHitBox();
    const over = p.x >= hb.x && p.x <= hb.x + hb.w && p.y >= hb.y && p.y <= hb.y + hb.h;
    pc.style.cursor = over ? 'move' : 'default';
    return;
  }
  const x = round(clamp(p.x - wmDrag.dx, 0, 1), 3), y = round(clamp(p.y - wmDrag.dy, 0, 1), 3);
  S.clip.watermark = { ...(S.clip.watermark || {}), x, y };
  $('#wmX').value = x; $('#wmY').value = y;
});
pc.addEventListener('pointerup', () => { if (wmDrag) { wmDrag = null; clipEdited(); } });

// --- program playback (plays the cut as the viewer will see it)
function startProgram() {
  const segs = segsLocal();
  if (!segs.length) { toast('Belum ada potongan', true); return; }
  S.stopAt = null;
  S.prog = { on: true, i: 0, phase: 'main', tOut: 0, disp: 0, lastT: -0.001, t0: 0,
             mainDur: segs[segs.length - 1].out_end };
  $('#progBtn').textContent = 'Stop';
  if (bumperOn('bumper_in')) startBumper('bumper_in'); else startMain();
}
function startMain() {
  const segs = segsLocal();
  S.prog.phase = 'main';
  S.prog.i = 0;
  video.currentTime = segs[0].start;
  video.playbackRate = segs[0].speed;
  video.volume = clamp(S.clip.voice_volume ?? 1, 0, 1);
  video.play().catch(() => {});
  startProgramMusic();
}
function startBumper(k) {
  const b = S.bumper[k];
  S.prog.phase = k === 'bumper_in' ? 'in' : 'out';
  S.prog.t0 = performance.now();
  if (b.kind === 'video') { b.el.currentTime = 0; b.el.play().catch(() => {}); }
}
function stopProgram() {
  if (!S.prog.on) return;
  S.prog.on = false;
  S.prog.phase = 'main';
  video.pause();
  video.playbackRate = 1;
  $('#outroVideo').pause();
  $('#bumperInVideo').pause();
  stopProgramMusic();
  $('#progBtn').textContent = 'Putar klip';
}

/* backsound + sound effects while the cut plays (ducking is only applied in the export) */
let progMusic = null;
function startProgramMusic() {
  stopProgramMusic();
  const m = S.clip.music;
  if (!m || !m.path) return;
  progMusic = new Audio(mediaUrl(m.path));
  progMusic.loop = true;
  progMusic.volume = clamp((m.volume ?? 0.15) * (m.duck !== false ? 0.7 : 1), 0, 1);
  progMusic.addEventListener('loadedmetadata', () => {
    progMusic.currentTime = Math.min(m.start || 0, Math.max(0, progMusic.duration - 0.1));
  }, { once: true });
  progMusic.play().catch(() => {});
}
function stopProgramMusic() {
  if (progMusic) { progMusic.pause(); progMusic = null; }
}
function fireSfx(from, to) {
  (S.clip.sfx || []).forEach(s => {
    if (s.at > from && s.at <= to) {
      const a = new Audio(mediaUrl(s.path));
      a.volume = clamp(s.volume ?? 1, 0, 1);
      a.play().catch(() => {});
    }
  });
}
$('#progBtn').addEventListener('click', () => (S.prog.on ? stopProgram() : startProgram()));

function tickProgram() {
  if (!S.prog.on) return;
  const segs = segsLocal();
  const inDur = bumperDur('bumper_in');
  if (S.prog.phase !== 'main') {
    const k = S.prog.phase === 'in' ? 'bumper_in' : 'bumper_out';
    const b = S.bumper[k];
    const t = b.kind === 'video' ? b.el.currentTime : (performance.now() - S.prog.t0) / 1000;
    S.prog.disp = S.prog.phase === 'in' ? t : inDur + S.prog.mainDur + t;
    const done = b.kind === 'video' ? b.el.ended : t >= b.duration;
    if (done) { if (S.prog.phase === 'in') startMain(); else stopProgram(); }
    return;
  }
  let seg = segs[S.prog.i];
  if (!seg) { stopProgram(); return; }
  if (video.currentTime >= seg.end - 0.02 || video.ended) {
    S.prog.i += 1;
    const nx = segs[S.prog.i];
    if (nx) {
      video.currentTime = nx.start;
      video.playbackRate = nx.speed;
      seg = nx;
    } else if (bumperOn('bumper_out')) {
      video.pause();
      stopProgramMusic();
      startBumper('bumper_out');
      return;
    } else {
      stopProgram();
      return;
    }
  }
  S.prog.tOut = seg.out_start + Math.max(0, video.currentTime - seg.start) / seg.speed;
  S.prog.disp = inDur + S.prog.tOut;
  if (S.prog.tOut > S.prog.lastT) fireSfx(S.prog.lastT, S.prog.tOut);
  S.prog.lastT = S.prog.tOut;
}

// ------------------------------------------------------------ jobs

async function startJob(method, url, body) {
  try {
    const job = await api(method, url, body);
    S.myJobs.add(job.id);
    S.jobState[job.id] = job.status;
    pollJobs(true);
    return job;
  } catch (err) {
    toast(err.message, true);
  }
}

let pollTimer = null;
async function pollJobs(now = false) {
  clearTimeout(pollTimer);
  if (!now) { /* scheduled */ }
  try {
    S.jobs = await api('GET', '/api/jobs');
    renderJobs();
    for (const j of S.jobs) {
      const prev = S.jobState[j.id];
      if (S.myJobs.has(j.id) && prev !== j.status && ['done', 'error', 'cancelled'].includes(j.status)) onJobFinished(j);
      S.jobState[j.id] = j.status;
    }
  } catch (_) { /* server restarting */ }
  const busy = S.jobs.some(j => j.status === 'running' || j.status === 'queued');
  pollTimer = setTimeout(pollJobs, busy ? 700 : 3000);
}

function renderJobs() {
  const active = S.jobs.filter(j => j.status === 'running' || j.status === 'queued');
  $('#jobsCount').textContent = active.length ? String(active.length) : '';
  $('#jobList').innerHTML = S.jobs.length ? S.jobs.map(j => {
    const pct = Math.round((j.progress || 0) * 100);
    const live = j.status === 'running' || j.status === 'queued';
    const status = { queued: 'antri', running: `${pct}%`, done: 'selesai', error: 'gagal', cancelled: 'dibatalkan' }[j.status];
    return `<li><div class="jt"><b>${esc(j.title)}</b><span class="${j.status === 'done' ? 'done' : ''}">${status}</span></div>
      ${live ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
      ${j.message ? `<div class="muted">${esc(j.message)}</div>` : ''}
      ${j.error ? `<div class="err">${esc(j.error)}</div>` : ''}
      ${live ? `<button class="btn small ghost" data-cancel="${j.id}">Batalkan</button>` : ''}</li>`;
  }).join('') : '<li class="muted">Tidak ada proses.</li>';
}
$('#jobList').addEventListener('click', e => {
  const b = e.target.closest('[data-cancel]');
  if (b) api('POST', `/api/jobs/${b.dataset.cancel}/cancel`).then(() => pollJobs(true));
});
$('#jobsBtn').addEventListener('click', () => { $('#jobsPanel').hidden = !$('#jobsPanel').hidden; });
$('#jobsClose').addEventListener('click', () => { $('#jobsPanel').hidden = true; });

async function onJobFinished(j) {
  if (j.status === 'error') {
    toast(`${j.title} gagal. Detail ada di panel Proses.`, true, 7000);
    $('#jobsPanel').hidden = false;
    return;
  }
  if (j.status !== 'done') return;
  if (j.kind === 'prepare' || j.kind === 'transcribe') {
    await loadState();
    if (S.src && S.src.id === j.target) await selectSource(j.target, S.clip && S.clip.id);
    if (S.clip) { const d = await api('GET', `/api/clips/${S.clip.id}`); S.tl = d.timeline; renderWordEditor(); }
    toast(j.kind === 'prepare' ? 'Video siap. Momen seru sudah dideteksi.' : 'Transkrip selesai. Caption otomatis aktif.');
  } else if (j.kind === 'render') {
    const r = j.result || {};
    (r.warnings || []).forEach(w => toast(w, true, 7000));
    if (j.title.startsWith('Draft')) {
      openVideo(r.path, 'Draft: ' + j.title.slice(6), 'Draft beresolusi rendah untuk cek cepat. Export final = 1080×1920.');
    } else {
      await loadState();
      if (S.clip && S.clip.id === j.target) { S.clip.exported = r.path; renderLastExport(); }
      toast(`Export selesai: ${r.path}`, false, 6000);
    }
  } else if (j.kind === 'ytscan') {
    const vid = j.result && j.result.video_id;
    if (S.yt && S.yt.id === vid) {
      S.yt.scan = await api('GET', `/api/youtube/scan/${encodeURIComponent(vid)}`);
      renderYt();
    }
    toast('Scan selesai. Pilih momen lalu klik “Download momen ini”.', false, 6000);
  } else if (j.kind === 'download') {
    await loadState();
    const r = j.result || {};
    if (r.source_id) await selectSource(r.source_id);
    toast('Download selesai. Klik “Siapkan video” untuk mulai memotong.', false, 6000);
  }
}

// ------------------------------------------------------------ YouTube

$('#ytForm').addEventListener('submit', async e => {
  e.preventDefault();
  const url = $('#ytUrl').value.trim();
  const box = $('#ytInfo');
  box.hidden = false;
  box.innerHTML = '<p class="muted">Mengambil info video…</p>';
  try {
    S.yt = await api('POST', '/api/youtube/info', { url });
    renderYt();
  } catch (err) {
    box.innerHTML = `<p class="warn">${esc(err.message)}</p>`;
  }
});

function renderYt() {
  const y = S.yt;
  const box = $('#ytInfo');
  const date = y.upload_date ? `${y.upload_date.slice(6, 8)}/${y.upload_date.slice(4, 6)}/${y.upload_date.slice(0, 4)}` : '';
  const peaks = y.peaks || [];
  box.innerHTML = `
    <div class="title">${esc(y.title)}</div>
    <div class="muted">${esc(y.channel)} ${esc(y.channel_handle || '')} · ${fmt(y.duration || 0, 0)}${date ? ' · ' + date : ''}</div>
    ${y.channel_ok ? '' : '<div class="warn">Channel ini bukan sumber yang diizinkan campaign.</div>'}
    ${y.heatmap && y.heatmap.length ? '<canvas id="ytHeat"></canvas><div class="muted">Grafik “most replayed”. Puncak = bagian yang paling sering ditonton ulang.</div>' : '<div class="muted">Grafik most replayed tidak tersedia untuk video ini.</div>'}
    ${peaks.length ? `<ul class="peaks">${peaks.map(p => `
      <li><span class="time">${p.label}</span><span class="bar" style="width:${Math.round(p.value * 60)}px"></span>
        <span class="grow"></span>
        <a class="btn small ghost" href="https://youtu.be/${esc(y.id)}?t=${Math.floor(p.time)}" target="_blank" rel="noopener">Tonton</a>
        <button class="btn small" data-peak="${p.time}">Ambil ±30 dtk</button></li>`).join('')}</ul>` : ''}
    <div class="scan">
      ${y.scan ? scanList(y) : `<p class="muted">Scan stream untuk cari momen seru: download audionya saja (±${Math.max(1, Math.round((y.duration || 0) * 0.006))} MB), lalu analisis suara dan transkrip.</p>`}
      <label class="check"><input type="checkbox" id="ytScanTr" checked> + transkrip (lebih akurat, lebih lama)</label>
      <button class="btn small" id="ytScanBtn" type="button">${y.scan ? 'Scan ulang' : 'Scan momen dari audio'}</button>
    </div>
    <div class="yt-range">
      <label class="field">Mulai (j:mm:dd)<input id="ytStart" placeholder="1:02:30"></label>
      <label class="field">Selesai<input id="ytEnd" placeholder="1:04:00"></label>
      <label class="field">Kualitas<select id="ytQ"><option value="1080">1080p</option><option value="720">720p</option></select></label>
      <label class="field">&nbsp;<button class="btn" id="ytRangeBtn" type="button">Download potongan</button></label>
    </div>
    <button class="btn ghost small" id="ytFullBtn" type="button">Download video penuh</button>`;
  const cv = $('#ytHeat');
  if (cv) {
    const r = cv.getBoundingClientRect();
    cv.width = r.width * dpr(); cv.height = r.height * dpr();
    const c = cv.getContext('2d');
    const d = y.duration || 1;
    c.strokeStyle = '#ff6b6b'; c.lineWidth = 1.5 * dpr();
    c.beginPath();
    y.heatmap.forEach((h, i) => {
      const x = ((h.start_time + h.end_time) / 2) / d * cv.width;
      const yy = cv.height - h.value * (cv.height - 4 * dpr()) - 2 * dpr();
      if (i === 0) c.moveTo(x, yy); else c.lineTo(x, yy);
    });
    c.stroke();
  }
}
function scanList(y) {
  const sc = y.scan;
  const when = sc.scanned ? sc.scanned.replace('T', ' ') : '';
  return `<div class="muted">Hasil scan ${esc(when)}${sc.transcribed ? ' (dengan transkrip)' : ''}: ${sc.candidates.length} momen</div>
    <ol class="scan-list">${sc.candidates.map(c => `
      <li><div><b>${fmt(c.start, 0)}–${fmt(c.end, 0)}</b> <span class="muted">${esc(c.reasons.join(' · '))}</span></div>
        ${c.text ? `<div class="txt">“${esc(c.text.slice(0, 140))}${c.text.length > 140 ? '…' : ''}”</div>` : ''}
        <div class="acts">
          <a class="btn small ghost" href="https://youtu.be/${esc(y.id)}?t=${Math.floor(c.start)}" target="_blank" rel="noopener">Tonton</a>
          <button class="btn small" data-range="${Math.max(0, c.start - 5)},${c.end + 5}">Download momen ini</button>
        </div></li>`).join('')}</ol>`;
}

$('#ytInfo').addEventListener('click', e => {
  const peak = e.target.closest('[data-peak]');
  const range = e.target.closest('[data-range]');
  const y = S.yt;
  if (!y) return;
  const q = Number(($('#ytQ') || {}).value || 1080);
  if (range) {
    const [start, end] = range.dataset.range.split(',').map(Number);
    startJob('POST', '/api/youtube/download', { url: y.url, start, end: Math.min(end, y.duration || end), height: q });
    toast(`Download ${fmt(start, 0)}–${fmt(end, 0)} dimulai`);
    return;
  }
  if (e.target.id === 'ytScanBtn') {
    startJob('POST', '/api/youtube/scan', { url: y.url, transcribe: $('#ytScanTr').checked });
    toast('Scan dimulai. Lihat progres di panel Proses.');
    return;
  }
  if (peak) {
    const t = Number(peak.dataset.peak);
    const start = Math.max(0, t - 30), end = Math.min(y.duration || t + 30, t + 30);
    startJob('POST', '/api/youtube/download', { url: y.url, start, end, height: q });
    toast(`Download ${fmt(start, 0)}–${fmt(end, 0)} dimulai`);
  } else if (e.target.id === 'ytRangeBtn') {
    const start = parseTime($('#ytStart').value), end = parseTime($('#ytEnd').value);
    if (start == null || end == null || end <= start) { toast('Isi waktu mulai & selesai, contoh 1:02:30 dan 1:04:00', true); return; }
    startJob('POST', '/api/youtube/download', { url: y.url, start, end, height: q });
    toast('Download potongan dimulai');
  } else if (e.target.id === 'ytFullBtn') {
    if ((y.duration || 0) > 1800 && !confirm(`Video ini ${fmt(y.duration, 0)}. Download penuh bisa besar dan lama. Lanjut?`)) return;
    startJob('POST', '/api/youtube/download', { url: y.url, height: q });
    toast('Download dimulai');
  }
});

// ------------------------------------------------------------ campaign settings

const BRAND_INFO = {
  watermark: { accept: 'image/*', overlay: true,
    hint: 'Gambar PNG transparan yang tampil sepanjang klip, paling atas. Template full-frame 9:16: lebar 100%, posisi tengah.' },
  banner: { accept: 'image/*', overlay: true, timed: true,
    hint: 'Gambar promo/sponsor/CTA yang muncul di detik tertentu, di bawah watermark. Lama 0 = sampai klip selesai.' },
  bumper_in: { accept: 'video/*,image/*', bumper: true, hint: 'Video atau gambar yang diputar sebelum klip (intro).' },
  bumper_out: { accept: 'video/*,image/*', bumper: true,
    hint: 'Video atau gambar setelah klip (outro/CTA). Ditempel utuh, hanya disesuaikan ke 9:16.' },
};
let CAMP = null;
const campImgs = {};
function campImg(path) {
  if (!path) return null;
  if (!campImgs[path]) {
    const img = new Image();
    img.onload = drawCampCanvas;
    img.src = mediaUrl(path) + '&t=' + Date.now();
    campImgs[path] = img;
  }
  const img = campImgs[path];
  return img.complete && img.naturalWidth ? img : null;
}

async function openCampaign() {
  if (!S.app.project.has_campaign) return;
  const d = await api('GET', '/api/campaign');
  CAMP = JSON.parse(JSON.stringify(d.campaign));
  S.brandAssets = d.brand_assets;
  $('#campFolder').textContent = S.app.project.root;
  $('#cName').value = CAMP.name || '';
  $('#cTags').value = (CAMP.hashtags || []).join(' ');
  $('#cFps').value = String((CAMP.output || {}).fps || 30);
  $('#cLang').value = CAMP.language ?? 'id';
  $('#cChecklist').value = (CAMP.checklist || []).join('\n');
  $('#cKeywords').value = (CAMP.keywords || []).join(', ');
  $('#cPrompt').value = CAMP.whisper_prompt || '';
  $('#cChannels').value = (CAMP.allowed_channels || []).join(' ');
  renderBrandForms();
  $('#campaignDialog').showModal();
  drawCampCanvas();
}
$('#campaignBtn').addEventListener('click', openCampaign);
document.addEventListener('click', e => { if (e.target.closest('[data-campaign-open]')) openCampaign(); });
$('#campClose').addEventListener('click', () => $('#campaignDialog').close());

function renderBrandForms() {
  const animName = { fade: 'Fade', slide: 'Slide', none: 'Tanpa animasi' };
  $('#brandForms').innerHTML = BRAND.map(b => {
    const el = CAMP[b.key] || {};
    const info = BRAND_INFO[b.key];
    const kinds = info.bumper ? ['image', 'video'] : ['image'];
    const opts = (S.brandAssets || []).filter(a => kinds.includes(a.kind));
    const missing = el.path && !opts.some(a => a.path === el.path);
    const range = (f, label, min, max, step, def) =>
      `<label class="field">${label} <span class="muted" data-v="${f}"></span>
        <input type="range" data-f="${f}" min="${min}" max="${max}" step="${step}" value="${el[f] ?? def}"></label>`;
    let extra = '';
    if (info.overlay) {
      extra += `<div class="grid2">${range('x', 'Posisi X', 0, 1, 0.005, 0.5)}${range('y', 'Posisi Y', 0, 1, 0.005, 0.5)}
        ${range('w', 'Lebar', 0.05, 1, 0.01, 1)}${range('opacity', 'Opasitas', 0.1, 1, 0.05, 1)}</div>`;
    }
    if (info.timed) {
      extra += `<div class="grid2">
        <label class="field">Muncul di detik <input type="number" data-f="start" min="0" step="0.5" value="${el.start ?? 0}"></label>
        <label class="field">Lama (dtk, 0 = sampai akhir) <input type="number" data-f="duration" min="0" step="0.5" value="${el.duration ?? 0}"></label>
        <label class="field">Animasi masuk <select data-f="anim">${['fade', 'slide', 'none'].map(a =>
          `<option value="${a}" ${(el.anim || 'fade') === a ? 'selected' : ''}>${animName[a]}</option>`).join('')}</select></label></div>`;
    }
    if (info.bumper) {
      extra += `<label class="field">Lama tampil kalau berupa gambar (dtk)
        <input type="number" data-f="image_duration" min="0.5" step="0.5" value="${el.image_duration ?? 2}"></label>`;
    }
    return `<section class="brand-card" data-key="${b.key}">
      <div class="bc-head"><b>${b.label}</b>
        <label class="check"><input type="checkbox" data-f="enabled" ${el.enabled ? 'checked' : ''}> Aktif</label>
        <label class="check" title="Klip tidak lolos checklist kalau elemen ini tidak ada"><input type="checkbox" data-f="required" ${el.required ? 'checked' : ''}> Wajib</label></div>
      <div class="row gap"><select data-f="path" class="grow"><option value="">(belum dipilih)</option>
        ${missing ? `<option value="${esc(el.path)}">${esc(el.path)} (tidak ditemukan)</option>` : ''}
        ${opts.map(a => `<option value="${esc(a.path)}">${esc(a.name)}</option>`).join('')}</select>
        <label class="btn small">Upload<input type="file" accept="${info.accept}" data-upload hidden></label></div>
      ${extra}
      <p class="hint">${esc(el.note || info.hint)}</p>
    </section>`;
  }).join('');
  $$('#brandForms select[data-f="path"]').forEach(s => { s.value = (CAMP[s.closest('[data-key]').dataset.key] || {}).path || ''; });
  updateRangeLabels();
}
function updateRangeLabels() {
  $$('#brandForms [data-v]').forEach(sp => {
    const v = (CAMP[sp.closest('[data-key]').dataset.key] || {})[sp.dataset.v];
    sp.textContent = v == null ? '' : Math.round(v * 100) + '%';
  });
}
$('#brandForms').addEventListener('input', e => {
  const card = e.target.closest('[data-key]');
  const f = e.target.dataset.f;
  if (!card || !f) return;
  const el = CAMP[card.dataset.key] || (CAMP[card.dataset.key] = {});
  if (e.target.type === 'checkbox') el[f] = e.target.checked;
  else if (e.target.type === 'range' || e.target.type === 'number') el[f] = Number(e.target.value);
  else el[f] = e.target.value;
  if (f === 'path' && e.target.value && !el.enabled) {
    el.enabled = true;
    card.querySelector('[data-f="enabled"]').checked = true;
  }
  updateRangeLabels();
  drawCampCanvas();
});
$('#brandForms').addEventListener('change', async e => {
  const up = e.target.closest('[data-upload]');
  if (!up || !up.files[0]) return;
  const key = up.closest('[data-key]').dataset.key;
  const fd = new FormData();
  fd.append('file', up.files[0]);
  toast('Mengupload…', false, 60000);
  try {
    const res = await fetch('/api/assets/upload', { method: 'POST', body: fd });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || res.statusText);
    S.brandAssets = (await api('GET', '/api/campaign')).brand_assets;
    CAMP[key] = { ...(CAMP[key] || {}), path: r.path, enabled: true };
    renderBrandForms();
    drawCampCanvas();
    toast(`${r.name} tersimpan di assets/. Klik Simpan untuk memakainya.`);
  } catch (err) {
    toast('Upload gagal: ' + err.message, true);
  }
});

function drawCampCanvas() {
  const cv = $('#campCanvas');
  const c = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  // stand-in for a split layout so positions read against something familiar
  c.fillStyle = '#34363c'; c.fillRect(0, 0, W, H * 0.4);
  c.fillStyle = '#26282d'; c.fillRect(0, H * 0.4, W, H * 0.6);
  c.fillStyle = '#7d808a'; c.font = '600 15px Segoe UI, sans-serif'; c.textAlign = 'center';
  c.fillText('facecam', W / 2, H * 0.2); c.fillText('gameplay', W / 2, H * 0.7); c.textAlign = 'left';
  if (!CAMP) return;
  ['banner', 'watermark'].forEach(k => {
    const el = CAMP[k];
    if (!el || !el.enabled || !el.path) return;
    const img = campImg(el.path);
    if (img) drawImageOverlay(c, img, el, W, H);
  });
}

$('#campSave').addEventListener('click', async () => {
  const lines = s => s.split('\n').map(x => x.trim()).filter(Boolean);
  const body = {
    name: $('#cName').value.trim() || 'Campaign',
    hashtags: $('#cTags').value.split(/\s+/).filter(Boolean).map(t => (t.startsWith('#') ? t : '#' + t)),
    output: { ...(CAMP.output || {}), fps: Number($('#cFps').value) },
    language: $('#cLang').value,
    checklist: lines($('#cChecklist').value),
    keywords: $('#cKeywords').value.split(',').map(x => x.trim()).filter(Boolean),
    whisper_prompt: $('#cPrompt').value.trim(),
    allowed_channels: $('#cChannels').value.split(/\s+/).filter(Boolean),
  };
  BRAND.forEach(b => { body[b.key] = CAMP[b.key] || {}; });
  try {
    await api('PUT', '/api/campaign', body);
  } catch (err) {
    toast('Gagal simpan: ' + err.message, true);
    return;
  }
  await loadState();
  if (S.clip) renderClip();
  $('#campaignDialog').close();
  toast('Pengaturan campaign disimpan');
});

// ------------------------------------------------------------ keyboard + loop

document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if ($('#videoDialog').open) return;
  if (!S.src || !S.src.prepared) return;
  const k = e.key;
  const handled = {
    ' ': togglePlay,
    k: () => video.pause(),
    i: setIn, I: setIn,
    o: setOut, O: setOut,
    Enter: addSegFromInOut,
    ArrowLeft: () => { stopProgram(); seekTo(video.currentTime - (e.shiftKey ? 0.1 : 1)); },
    ArrowRight: () => { stopProgram(); seekTo(video.currentTime + (e.shiftKey ? 0.1 : 1)); },
    j: () => { stopProgram(); seekTo(video.currentTime - 5); },
    l: () => { stopProgram(); seekTo(video.currentTime + 5); },
    p: () => (S.prog.on ? stopProgram() : startProgram()),
  }[k];
  if (handled) { e.preventDefault(); handled(); }
});

let lastTimeText = '';
function frame() {
  if (S.src && S.src.prepared) {
    tickProgram();
    if (S.stopAt != null && video.currentTime >= S.stopAt) { video.pause(); S.stopAt = null; }
    const tt = fmt(video.currentTime);
    if (tt !== lastTimeText) { $('#timeNow').textContent = tt; lastTimeText = tt; }
    if (!video.paused && !S.prog.on) ensureVisible(video.currentTime);
    drawRects();
    drawTimeline();
    drawPreview();
    if (S.clip) {
      const total = mainDuration() + outroDuration();
      const t = S.prog.on ? S.prog.disp : bumperDur('bumper_in') + (currentOutTime() ?? 0);
      const txt = `${fmt(t, 1)} / ${fmt(total, 1)}`;
      if ($('#progTime').textContent !== txt) $('#progTime').textContent = txt;
    }
  }
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => { sizePlayer(); sizeTimeline(); });

(async function init() {
  try {
    await loadState();
  } catch (err) {
    toast('Server tidak merespons: ' + err.message, true, 10000);
    return;
  }
  sizeTimeline();
  const last = recall('source');
  if (last && S.app.sources.some(s => s.id === last)) await selectSource(last);
  pollJobs();
  requestAnimationFrame(frame);
})();
