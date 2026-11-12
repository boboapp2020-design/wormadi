// WORMADI (วอมาดิ) — แอปหน้าเดียว 16 หน้าตามต้นแบบ
// ใช้ได้ 3 แบบ: Cloudflare (บัญชีพนักงาน, ครบทุกฟีเจอร์), เซิร์ฟเวอร์ LAN เดิม (พูด/ฟังอย่างเดียว), แอป Android (service ถือ WebSocket)
'use strict';

// ================================================================ utils
const $ = id => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
const lsJson = (k, d) => { try { return JSON.parse(lsGet(k)) ?? d; } catch { return d; } };
const vibrate = p => navigator.vibrate && navigator.vibrate(p);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const icon = (id, cls = 'i') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const TH = 'th-TH-u-ca-gregory';
const fmtTime = ts => new Date(ts).toLocaleTimeString(TH, { hour: '2-digit', minute: '2-digit' });
const fmtDate = ts => new Date(ts).toLocaleDateString(TH, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDur = ms => { const s = Math.max(1, Math.round((ms || 0) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const ago = ts => { if (!ts) return ''; const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'เมื่อสักครู่' : m < 60 ? `${m} นาที` : m < 1440 ? `${Math.round(m / 60)} ชม.` : `${Math.round(m / 1440)} วัน`; };
const TARGET_RATE = 16000;
const ROLE_NAME = { user: 'ผู้ใช้งานทั่วไป', lead: 'หัวหน้างาน', admin: 'ผู้ดูแลระบบ' };
const CH_ICON = { star: 'star', gear: 'gear', bolt: 'bolt', box: 'box', tools: 'tools', flask: 'flask', shield: 'shield', factory: 'factory', truck: 'truck', building: 'building', radio: 'radio', users: 'users', pin: 'pin', drop: 'drop', fire: 'fire' };
const SOS = { general: ['เหตุฉุกเฉิน', 'siren', '#d81e1e'], fire: ['เพลิงไหม้', 'fire', '#d81e1e'], injury: ['อุบัติเหตุ / เจ็บป่วย', 'medic', '#d81e1e'], chemical: ['สารเคมีรั่วไหล', 'drop', '#1d63d6'], other: ['ความเสี่ยงอื่นๆ', 'warn', '#c27c00'] };

// Android app (Capacitor): the native service owns the WebSocket and audio
const CAP = window.Capacitor;
const NATIVE = !!(CAP && typeof CAP.isNativePlatform === 'function' && CAP.isNativePlatform() && CAP.Plugins && CAP.Plugins.WalkieNative);
const WN = NATIVE ? CAP.Plugins.WalkieNative : null;
document.documentElement.classList.toggle('native', NATIVE);

// ================================================================ state
const S = {
  config: { features: [], accounts: false, app: 'WORMADI', org: '', emojis: ['👍', '✅', '❤️', '🙏', '😂'] },
  token: lsGet('walkie_token'), user: lsJson('walkie_user', null), unread: 0, openTasks: 0,
  profile: lsJson('walkie_profile', {}),             // LAN mode: {name, dept}
  uid: lsGet('walkie_uid') || (() => { const u = 'u' + Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join(''); lsSet('walkie_uid', u); return u; })(),
  channels: [], counts: {}, me: null, state: { users: [], talker: null }, roster: null,
  chat: { channel: null, msgs: [], reactions: {}, more: false, loadedFor: null },
  msgAlerts: lsJson('walkie_alerts', []), favs: lsJson('walkie_favs', []),
  prefs: Object.assign({ beep: true, nc: true, volume: 80, mode: 'hold', speaker: true }, lsJson('walkie_prefs', {})),
  conn: 'offline', route: null, params: {}, sos: null,
};
const has = f => S.config.features.includes(f);
const ACC = () => !!S.config.accounts;
let serverBase = NATIVE ? (lsGet('walkie_server_base') || '') : '';
// wormadi.pages.dev: some networks block one of its two Cloudflare addresses, so a connection can hang.
// When that happens, quietly continue through the Worker's own address (same server, same accounts).
const BACKUP_BASE = !NATIVE && /\.pages\.dev$/.test(location.hostname) ? 'https://walkie.boboapp2020.workers.dev' : '';
async function netFetch(path, opts = {}) {
  if (!BACKUP_BASE || serverBase) return fetch((serverBase || '') + path, opts);
  try { return await fetch(path, { ...opts, signal: AbortSignal.timeout(7000) }); }
  catch (e) { serverBase = BACKUP_BASE; return fetch(serverBase + path, opts); }
}
let ws, talking = false, wantTalk = false, pressed = false, attempt = 0, reconnectTimer = null, pingTimer = null, stopped = true;
let audioCtx, outGain, micStream, micSource, processor, rxRate = TARGET_RATE, playHead = 0;

// ================================================================ theme
const THEME_META = { light: '#0a2a62', dark: '#081a3a' };
function applyTheme(t, save) {
  document.documentElement.setAttribute('data-theme', t);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', THEME_META[t]);
  if (save) lsSet('walkie_theme', t);
}
const curTheme = () => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
applyTheme(curTheme());

// ================================================================ artwork
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function sceneSvg() {   // factory + sugarcane field (splash)
  const r = rng(11), W = 400, H = 520, g = 300;
  let s = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><defs>
    <linearGradient id="sh" x1="0" x2="1"><stop offset="0" stop-color="var(--bld-2)"/><stop offset=".5" stop-color="var(--bld-1)"/><stop offset="1" stop-color="var(--bld-2)"/></linearGradient></defs>`;
  for (const [x, y, k] of [[70, 60, 1], [300, 40, 1.3]]) s += `<g fill="#fff" opacity=".85"><ellipse cx="${x}" cy="${y}" rx="${40 * k}" ry="${12 * k}"/><ellipse cx="${x + 20 * k}" cy="${y - 9 * k}" rx="${24 * k}" ry="${14 * k}"/></g>`;
  s += `<g fill="var(--bld-2)" opacity=".7">`;
  for (let x = -10; x < W; x += 24 + r() * 26) { const h = 24 + r() * 40; s += `<rect x="${x | 0}" y="${(g - h) | 0}" width="${(18 + r() * 24) | 0}" height="${h | 0}"/>`; }
  s += `</g><g>
    <rect x="236" y="96" width="14" height="${g - 96}" fill="#e8eef5"/><rect x="236" y="96" width="14" height="10" fill="#d23b2f"/><rect x="236" y="122" width="14" height="8" fill="#d23b2f"/>
    <rect x="30" y="200" width="40" height="${g - 200}" fill="url(#sh)"/><ellipse cx="50" cy="200" rx="20" ry="7" fill="var(--bld-1)"/>
    <rect x="74" y="190" width="40" height="${g - 190}" fill="url(#sh)"/><ellipse cx="94" cy="190" rx="20" ry="7" fill="var(--bld-1)"/>
    <rect x="120" y="226" width="110" height="${g - 226}" fill="var(--bld-1)"/><path d="M116 226l57-24 61 24z" fill="#2c5d9c"/>
    <rect x="270" y="150" width="52" height="${g - 150}" fill="url(#sh)"/><rect x="266" y="142" width="60" height="10" fill="var(--bld-3)"/>
    <rect x="330" y="236" width="60" height="${g - 236}" rx="4" fill="url(#sh)"/><ellipse cx="360" cy="236" rx="30" ry="8" fill="var(--bld-1)"/>
    <path d="M120 250h110M270 190h52M270 226h52" stroke="var(--bld-3)" stroke-width="2" opacity=".5"/></g><g fill="var(--bld-win)">`;
  for (let y = 236; y < g - 10; y += 16) for (let x = 128; x < 224; x += 14) s += `<rect x="${x}" y="${y}" width="7" height="8" rx="1"/>`;
  for (let y = 160; y < g - 10; y += 18) for (let x = 276; x < 318; x += 12) s += `<rect x="${x}" y="${y}" width="6" height="9" rx="1"/>`;
  s += `</g><path d="M0 ${g + 6} Q120 ${g - 8} 240 ${g + 4} T400 ${g} V${H} H0z" fill="var(--field-1)"/><path d="M0 ${g + 40} Q140 ${g + 24} 260 ${g + 38} T400 ${g + 30} V${H} H0z" fill="var(--field-2)"/>`;
  const bl = [];
  for (let i = 0; i < 220; i++) bl.push([g + 4 + Math.pow(r(), .8) * (H - g), r() * 440 - 20, r(), r(), r()]);
  bl.sort((a, b) => a[0] - b[0]);
  for (const [b, x, a, l, c] of bl) {
    const d = (b - g) / (H - g), h = 14 + d * 110 * (.6 + a * .6), lean = (l - .5) * h;
    const col = d < .3 ? 'var(--field-1)' : c < .4 ? 'var(--field-1)' : c < .75 ? 'var(--field-2)' : 'var(--field-3)';
    s += `<path d="M${x.toFixed(1)} ${b.toFixed(1)} Q${(x + lean * .3).toFixed(1)} ${(b - h * .6).toFixed(1)} ${(x + lean).toFixed(1)} ${(b - h).toFixed(1)}" stroke="${col}" stroke-width="${(1.2 + d * 4).toFixed(1)}" fill="none" stroke-linecap="round"/>`;
  }
  return s + '</svg>';
}
function mapSvg() {     // default illustrated factory map (until admin uploads a real one)
  const B = (x, y, w, h, c = '#e9eef3', roof = '#c3ccd6') => `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${roof}"/><rect x="${x + 4}" y="${y + 4}" width="${w - 8}" height="${h - 10}" rx="3" fill="${c}"/><rect x="${x}" y="${y + h - 8}" width="${w}" height="8" rx="3" fill="#9aa8b6"/></g>`;
  const T = (x, y) => `<circle cx="${x}" cy="${y}" r="9" fill="#4f9a3a"/><circle cx="${x - 3}" cy="${y - 3}" r="5" fill="#69b84d"/>`;
  let s = `<svg viewBox="0 0 400 560" aria-label="แผนที่โรงงาน"><rect width="400" height="560" fill="#bfd9a8"/>
    <path d="M0 270h400M190 0v560M0 120h190M190 420h210" stroke="#8e9aa6" stroke-width="22"/><path d="M0 270h400M190 0v560M0 120h190M190 420h210" stroke="#f2f2ee" stroke-width="2" stroke-dasharray="10 10"/>`;
  s += B(40, 40, 110, 60) + B(30, 150, 70, 90, '#dfe8f0') + B(110, 160, 60, 80) + B(220, 60, 150, 110, '#e3ebf3') + B(230, 190, 70, 60) + B(320, 190, 60, 60);
  s += B(30, 300, 130, 90, '#e6ecf2') + B(30, 420, 120, 100) + B(220, 300, 90, 90) + B(330, 300, 50, 90) + B(230, 450, 150, 80, '#eef2f6');
  s += `<circle cx="360" cy="110" r="22" fill="#cfd8e0" stroke="#9aa8b6" stroke-width="4"/><circle cx="60" cy="200" r="14" fill="#cfd8e0" stroke="#9aa8b6" stroke-width="3"/>`;
  for (const [x, y] of [[20, 20], [175, 30], [175, 220], [210, 25], [390, 30], [170, 400], [210, 420], [390, 400], [20, 540], [175, 540], [390, 540], [100, 270]]) s += T(x, y);
  return s + '</svg>';
}
const HATS = ['#ffffff', '#ffc61a', '#ff8a1a', '#2f7df6', '#22a447'], SKIN = ['#f3cba5', '#e7b48a', '#d9a077', '#c68a5e'], SHIRT = ['#1f4f9a', '#264a7d', '#2d5fb3', '#3b4f6b'];
function hashStr(s) { let h = 7; for (const ch of String(s)) h = (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0; return h; }
function cartoon(name) {
  const h = hashStr(name || '?'), hat = HATS[h % 5], skin = SKIN[(h >>> 3) % 4], shirt = SHIRT[(h >>> 6) % 4];
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" fill="#d7e6f8"/><path d="M8 66c2-13 11-19 24-19s22 6 24 19z" fill="${shirt}"/><path d="M26 47l6 7 6-7z" fill="#fff"/><rect x="28" y="40" width="8" height="8" fill="${skin}"/><circle cx="32" cy="33" r="12.5" fill="${skin}"/><circle cx="27.2" cy="33.5" r="1.6" fill="#22262e"/><circle cx="36.8" cy="33.5" r="1.6" fill="#22262e"/><path d="M27.5 38.6q4.5 3.6 9 0" stroke="#8a3b2a" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M18 27.5a14 13 0 0 1 28 0z" fill="${hat}" stroke="rgba(0,0,0,.2)"/><rect x="14.5" y="26.2" width="35" height="4.2" rx="2.1" fill="${hat}" stroke="rgba(0,0,0,.2)"/><path d="M32 15.5v10.5" stroke="rgba(0,0,0,.14)" stroke-width="3.2" stroke-linecap="round"/></svg>`;
}
const avCache = new Map();
function avatar(u, cls = 'av') {
  const id = u && (u.user_id || u.id), name = u && u.name;
  if (ACC() && u && (u.has_avatar || (u === S.user && S.user?.has_avatar)) && id) {
    const src = avCache.get(id);
    return `<div class="${cls}">${src ? `<img src="${src}" alt="">` : `<img data-av="${id}" alt="" hidden>${cartoon(name)}`}</div>`;
  }
  return `<div class="${cls}">${cartoon(name)}</div>`;
}
async function loadAvatars(root = document) {
  for (const img of $$('img[data-av]', root)) {
    const id = Number(img.dataset.av);
    try {
      if (!avCache.has(id)) { const r = await api(`/api/avatar/${id}`, { raw: true }); avCache.set(id, URL.createObjectURL(await r.blob())); }
      img.src = avCache.get(id); img.hidden = false; img.removeAttribute('data-av'); img.nextElementSibling?.remove();
    } catch {}
  }
}
function orgLogo(cls = 'orglogo') {
  return `<img class="${cls}" src="brand/logo.png" alt="" onerror="this.remove()">`;
}

// ================================================================ API
async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = {};
  if (S.token) headers.Authorization = 'Bearer ' + S.token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await netFetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store' });
  if (r.status === 401 && S.token && path !== '/api/login') { signOut('ออกจากระบบแล้ว: บัญชีนี้เข้าสู่ระบบจากเครื่องอื่น หรือหมดเวลา กรุณาเข้าสู่ระบบใหม่'); throw new Error('unauthorized'); }
  if (raw) { if (!r.ok) throw new Error('HTTP ' + r.status); return r; }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  return data;
}
async function loadConfig() {
  try { const r = await netFetch('/api/config', { cache: 'no-store' }); if (r.ok) Object.assign(S.config, await r.json()); } catch {}
  document.title = S.config.app || 'WORMADI';
}
async function loadChannels() {
  try {
    const list = await (await netFetch('/api/channels', { cache: 'no-store', headers: S.token ? { Authorization: 'Bearer ' + S.token } : {} })).json();
    S.channels = list.map((c, i) => typeof c === 'string' ? { name: c } : { icon: 'radio', color: ['gold', 'green', 'yellow', 'purple', 'orange', 'blue', 'red'][i % 7], ...c });
    for (const c of S.channels) if (c.users != null) S.counts[c.name] = c.users;
  } catch {}
}
async function refreshMe() {
  if (!ACC() || !S.token) return;
  try {
    const d = await api('/api/me');
    S.user = d.user; S.unread = d.unread; S.openTasks = d.openTasks;
    lsSet('walkie_user', JSON.stringify(S.user));
    renderBadges();
  } catch {}
}
const isDm = name => /^dm:\d+:\d+$/.test(String(name || ''));
const chanInfo = name => isDm(name) ? { name: 'ส่วนตัว: ' + (S.call?.peer?.name || 'คุยส่วนตัว'), icon: 'users', color: 'purple', dm: true }
  : S.channels.find(c => c.name === name) || { name, icon: 'radio', color: 'blue' };
const chanIcon = (c, cls = 'ic') => `<span class="${cls} c-${esc(c.color || 'blue')}">${icon(CH_ICON[c.icon] || 'radio')}</span>`;

// ================================================================ router
const ROUTES = {};
const NAV_ROUTES = { home: 'home', channels: 'channels', convos: 'convos', settings: 'settings' };
function go(route, params = {}, replace) {
  const h = '#/' + route + (Object.keys(params).length ? '?' + new URLSearchParams(params) : '');
  if (location.hash === h) return render();
  replace ? history.replaceState(null, '', h) : history.pushState(null, '', h);
  render();
}
function back(fallback = 'home') { if (history.length > 1 && S.route !== fallback) history.back(); else go(fallback, {}, true); }
window.addEventListener('popstate', () => render());
function render() {
  const [r, q] = location.hash.replace(/^#\//, '').split('?');
  const route = ROUTES[r] ? r : (S.token || S.profile.name ? 'home' : 'splash');
  const signedIn = ACC() ? !!S.token : !!S.profile.name;
  if (!signedIn && route === 'join') { try { sessionStorage.setItem('walkie_join', new URLSearchParams(q || '').get('room') || ''); } catch {} return go('login', {}, true); }
  if (!signedIn && !['splash', 'login'].includes(route)) return go('splash', {}, true);
  if (signedIn && ACC() && S.user && S.user.must_change && route !== 'setpw') return go('setpw', {}, true);
  S.route = route; S.params = Object.fromEntries(new URLSearchParams(q || ''));
  closeSheet();
  $('view').innerHTML = '';
  ROUTES[route](S.params);
  $('nav').classList.toggle('hidden', !NAV_ROUTES[route]);
  for (const b of $$('#nav button')) b.classList.toggle('on', b.dataset.go === route);
  loadAvatars($('view'));
  $('view').scrollTop = 0;
}
for (const b of $$('#nav button')) b.onclick = () => go(b.dataset.go);
function mount(html, bind) { $('view').innerHTML = html; bind && bind($('view')); loadAvatars($('view')); }
const header = (title, sub = '', right = '') => `<header class="hd safe-top"><button class="ib" data-back aria-label="กลับ">${icon('back')}</button><h1>${title}${sub ? `<small>${sub}</small>` : ''}</h1>${right || '<span style="width:46px"></span>'}</header>`;
function bindBack(root, fallback) { for (const b of $$('[data-back]', root)) b.onclick = () => back(fallback); }

// ================================================================ toast / sheet
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'alert'); t.textContent = msg;
  $('app').appendChild(t); setTimeout(() => t.remove(), 3400);
}
function sheet(html, bind) {
  closeSheet();
  const bg = document.createElement('div'); bg.className = 'sheet-bg'; bg.id = 'sheet';
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  bg.addEventListener('click', e => { if (e.target === bg) closeSheet(); });
  $('app').appendChild(bg);
  bind && bind(bg);
  loadAvatars(bg);
  const f = bg.querySelector('input, select, textarea, button'); f && f.focus({ preventScroll: true });
  return bg;
}
function closeSheet() { $('sheet')?.remove(); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

// ================================================================ connection (web)
function startConnection() { stopped = false; attempt = 0; if (NATIVE) return nativeJoin(); connect(); }
function connect() {
  if (NATIVE || stopped) return;
  clearTimeout(reconnectTimer);
  if (ws && ws.readyState <= 1) return;
  setConn('connecting');
  const host = serverBase ? new URL(serverBase).host : location.host;
  const sock = ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + host);
  ws.binaryType = 'arraybuffer';
  // voice connection that never opens on pages.dev -> switch to the backup address
  let opened = false;
  const openTimer = BACKUP_BASE && !serverBase ? setTimeout(() => { if (!opened) { serverBase = BACKUP_BASE; attempt = 0; try { sock.close(); } catch {} } }, 6000) : null;
  sock.addEventListener('open', () => { opened = true; clearTimeout(openTimer); });
  sock.addEventListener('close', () => { if (!opened && BACKUP_BASE && !serverBase) { serverBase = BACKUP_BASE; attempt = 0; } });
  ws.onopen = () => { joinNow(); clearInterval(pingTimer); pingTimer = setInterval(() => send({ type: 'ping' }), 20000); };
  ws.onclose = () => {
    clearInterval(pingTimer); stopTalking(true);
    S.state = { users: [], talker: null }; renderTalk();
    if (stopped) { setConn('offline'); return; }
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) * (0.8 + Math.random() * 0.4);
    setConn('reconnecting', { nextMs: delay });
    reconnectTimer = setTimeout(connect, delay);
  };
  ws.onmessage = e => typeof e.data === 'string' ? onMessage(JSON.parse(e.data)) : playChunk(e.data);
}
function stopConnection() {
  stopped = true; clearTimeout(reconnectTimer); clearInterval(pingTimer);
  if (NATIVE) { WN.leave(); return; }
  if (ws) { try { send({ type: 'leave' }); ws.close(); } catch {} }
  ws = null; setConn('offline');
}
const send = m => ws && ws.readyState === 1 && ws.send(JSON.stringify(m));
function sendMsg(m) { if (NATIVE) WN.send({ msg: m }); else send(m); }
function joinNow(channel) {
  const ch = channel || (S.call && S.call.status === 'active' ? S.call.channel : '') || lsGet('walkie_channel') || (S.user && S.user.main_channel_name) || S.channels[0]?.name;
  if (NATIVE) return WN.switchChannel({ channel: ch });
  sendMsg({ type: 'join', token: S.token || undefined, name: S.profile.name, dept: S.profile.dept, uid: S.uid, channel: ch });
}
window.addEventListener('online', () => { if (!stopped && !NATIVE && (!ws || ws.readyState > 1)) { attempt = 0; connect(); } });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !keepOn() && S.me && !S.call) {
    // the user turned background listening off: leave the room while the app is not on screen
    S.pausedBg = true; stopTalking(true); stopConnection();
    return;
  }
  if (!document.hidden && S.pausedBg) { S.pausedBg = false; if (ACC() ? S.token : S.profile.name) startConnection(); }
  if (document.hidden) {
    // app minimised / screen off: keep the connection and speaker running
    if (!NATIVE && S.me && keepOn()) { if (!keepAudio) setKeepAlive(true, true); else keepAudio.play().catch(() => {}); if (audioCtx && audioCtx.state !== 'running') audioCtx.resume().catch(() => {}); }
    return;
  }
  if (!NATIVE && !stopped && (!ws || ws.readyState > 1)) { attempt = 0; connect(); }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().finally(renderUnlock);
  if (wakeOn()) setWake(true);
  refreshMe();
});
function setConn(s, info) {
  S.conn = s;
  for (const el of $$('[data-conn]')) {
    const on = s === 'online';
    el.innerHTML = `<span class="dot ${on ? 'on' : s === 'reconnecting' ? 'warn' : ''}"></span>${on ? 'ออนไลน์' : s === 'connecting' ? 'กำลังเชื่อมต่อ…' : s === 'reconnecting' ? `เชื่อมใหม่ใน ${Math.ceil((info?.nextMs || 0) / 1000)} วิ` : 'ออฟไลน์'}`;
  }
  renderTalk();
}

// ================================================================ server messages
function onMessage(m) {
  switch (m.type) {
    case 'joined': {
      const changed = !S.me || S.me.channel !== m.channel;
      S.me = m; attempt = 0; setConn('online');
      if (m.channels && !S.channels.length) S.channels = m.channels.map(name => ({ name }));
      if (m.channel && !isDm(m.channel)) lsSet('walkie_channel', m.channel);
      if (changed) { S.chat.loadedFor = null; if (S.route === 'chat') renderChat(); }
      if (m.channel) markChannelRead(m.channel);
      if (S.route === 'ptt' || S.route === 'home') render();
      if (keepOn() && !keepAudio && !NATIVE) setKeepAlive(true, true);
      if (!NATIVE && wakeOn()) setWake(true);
      renderUnlock();
      break;
    }
    case 'channels': loadChannels().then(() => ['channels', 'home', 'ptt', 'convos'].includes(S.route) && !$('sheet') && render()); break;
    case 'state':
      S.state = m;
      if (!S.roster) S.counts[m.channel] = m.users.length;
      renderTalk();
      break;
    case 'roster':
      S.roster = m.users;
      for (const c of m.channels || []) S.counts[c.name] = c.users;
      renderTalk();
      if (S.route === 'home') $('onlineN') && ($('onlineN').textContent = m.users.length);
      break;
    case 'talk_granted':
      if (NATIVE) break;
      if (!wantTalk) { send({ type: 'ptt_end' }); break; }
      talking = true; beep(880, 0.08); vibrate(40); renderTalk(); break;
    case 'busy':
      if (!NATIVE) { beep(220, 0.25); vibrate([60, 40, 60]); }
      toast(`${m.by} กำลังพูดอยู่ รอสักครู่`); break;
    case 'talk_start':
      if (!NATIVE) { rxRate = m.rate || TARGET_RATE; playHead = 0; beep(660, 0.06); }
      break;
    case 'talk_end':
      if (!S.me) break;
      if (!NATIVE && m.name !== S.me.name) beep(520, 0.1);
      if (m.reason === 'timeout' && m.name === S.me.name) toast('พูดได้สูงสุด 60 วินาทีต่อครั้ง');
      if (!NATIVE && m.name === S.me.name) { talking = false; renderTalk(); }
      if (!has('chat')) addChatMsg({ id: 'l' + Date.now(), ts: Date.now(), channel: S.me.channel, kind: 'talk', name: m.name, ms: m.ms, uid: m.name === S.me.name ? S.uid : '' });
      break;
    case 'chat': addChatMsg(m.msg); break;
    case 'notify': addMsgAlert(m.msg); break;
    case 'react': S.chat.reactions[m.id] = m.by; const el = $('r-' + m.id); if (el) el.innerHTML = reactsHtml(m.id); break;
    case 'notification':
      S.unread++; renderBadges();
      toast(m.notification.title);
      if (m.notification.kind === 'task') { S.openTasks++; if (S.route === 'tasks') render(); }
      if (document.hidden) systemNotify(m.notification.title, m.notification.body, 'n');
      break;
    case 'sos': showSos(m.sos); break;
    case 'call': incomingCall(m); break;
    case 'call_ringing': toast(`กำลังเรียก ${S.call?.peer?.name || ''}…`); break;
    case 'call_fail': toast(m.message || 'เรียกไม่สำเร็จ'); endCall(); break;
    case 'call_reply':
      if (!S.call || S.call.peer.id !== m.from.id) break;
      if (m.accept) { S.call.status = 'active'; toast(`${m.from.name} รับสายแล้ว พูดได้เลย`); if (S.route === 'ptt') render(); }
      else { toast(`${m.from.name} ไม่รับสาย`); endCall(); }
      break;
    case 'call_end': if (S.call && m.channel === S.call.channel) { toast(`${m.by} วางสายแล้ว`); endCall(); } break;
    case 'call_handled': stopRing(); if ($('callIn')) closeSheet(); break;
    case 'sos_ack': if (S.sos && S.sos.id === m.id) { const a = $('sosAcks'); if (a) a.textContent = `รับทราบแล้ว ${m.acks} คน`; } if (S.route === 'sos') renderSosList(); break;
    case 'sos_closed': if (S.sos && S.sos.id === m.id) { hideSos(); toast(`เหตุฉุกเฉินถูกปิดโดย ${m.by}`); } if (S.route === 'sos') renderSosList(); break;
    case 'error':
      if (m.code === 'auth') { stopConnection(); signOut('ออกจากระบบแล้ว: บัญชีนี้เข้าสู่ระบบจากเครื่องอื่น หรือหมดเวลา กรุณาเข้าสู่ระบบใหม่'); }
      if (m.code === 'replaced') { stopConnection(); signOut(m.message); }
      if (m.code === 'must_change') { stopConnection(); if (S.user) S.user.must_change = 1; go('setpw', {}, true); }
      if (m.code === 'locked') { toast(m.message); loadChannels().then(() => { const c = S.channels.find(x => x.name === m.channel); if (c) askRoomPass(c, S.route); }); }
      if (m.code === 'room_deleted') {
        toast(m.message);
        if (lsGet('walkie_channel') === m.channel) lsSet('walkie_channel', '');
        if (S.me) S.me.channel = null;
        loadChannels().then(() => { joinNow(); if (['ptt', 'chat', 'home', 'channels'].includes(S.route)) render(); });
      }
      break;
  }
}

// ================================================================ audio (web)
function ensureCtx() {
  if (NATIVE) return;
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    outGain = audioCtx.createGain(); outGain.connect(audioCtx.destination);
    applyVolume();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().finally(renderUnlock);
  renderUnlock();
}
function applyVolume() { if (outGain) outGain.gain.value = S.prefs.speaker ? (S.prefs.volume / 100) * 1.4 : 0; }
function renderUnlock() { const b = $('unlockBtn'); if (b) b.classList.toggle('hidden', NATIVE || !audioCtx || audioCtx.state !== 'suspended'); }
document.addEventListener('pointerdown', () => { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().finally(renderUnlock); }, true);
async function ensureMic() {
  ensureCtx();
  if (processor) return;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: !!S.prefs.nc, autoGainControl: true } });
  micSource = audioCtx.createMediaStreamSource(micStream);
  processor = audioCtx.createScriptProcessor(2048, 1, 1);
  const ratio = audioCtx.sampleRate / TARGET_RATE;
  processor.onaudioprocess = e => {
    if (!talking) return;
    const input = e.inputBuffer.getChannelData(0);
    const outLen = Math.floor(input.length / ratio), pcm = new Int16Array(outLen);
    let peak = 0;
    for (let i = 0; i < outLen; i++) {
      let sum = 0; const a = Math.floor(i * ratio), b = Math.floor((i + 1) * ratio);
      for (let j = a; j < b; j++) sum += input[j];
      const s = Math.max(-1, Math.min(1, sum / (b - a)));
      peak = Math.max(peak, Math.abs(s)); pcm[i] = s * 0x7fff;
    }
    setMeter(peak);
    if (ws && ws.readyState === 1) ws.send(pcm.buffer);
  };
  const mute = audioCtx.createGain(); mute.gain.value = 0;
  micSource.connect(processor); processor.connect(mute); mute.connect(audioCtx.destination);
}
function playChunk(buf) {
  if (!audioCtx || !buf.byteLength) return;
  const pcm = new Int16Array(buf), f = new Float32Array(pcm.length);
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) { f[i] = pcm[i] / 0x7fff; peak = Math.max(peak, Math.abs(f[i])); }
  const ab = audioCtx.createBuffer(1, f.length, rxRate); ab.copyToChannel(f, 0);
  const src = audioCtx.createBufferSource(); src.buffer = ab; src.connect(outGain);
  const now = audioCtx.currentTime;
  if (playHead < now) playHead = now + 0.08;
  src.start(playHead); playHead += ab.duration;
  setMeter(peak);
}
function beep(freq, dur) {
  if (!audioCtx || !S.prefs.beep) return;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime;
  o.frequency.value = freq; g.gain.setValueAtTime(0.15, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(outGain || audioCtx.destination); o.start(t); o.stop(t + dur);
}

// ================================================================ push-to-talk
function bindPtt(el) {
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); el.setPointerCapture(e.pointerId);
    if (S.prefs.mode === 'toggle') { wantTalk ? (pressed = false, stopTalking()) : (pressed = true, startTalking()); return; }
    pressed = true; startTalking();
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => el.addEventListener(ev, () => { if (S.prefs.mode === 'toggle') return; pressed = false; stopTalking(); }));
  el.addEventListener('contextmenu', e => e.preventDefault());
}
document.addEventListener('keydown', e => { if (e.code === 'Space' && !e.repeat && S.me && S.route === 'ptt') { e.preventDefault(); pressed = true; startTalking(); } });
document.addEventListener('keyup', e => { if (e.code === 'Space' && S.route === 'ptt') { pressed = false; stopTalking(); } });
async function startTalking() {
  if (S.me && !S.me.channel) { pressed = false; toast('ยังไม่ได้เข้าห้อง เลือกหรือสร้างห้องก่อน'); go('channels', { then: 'ptt' }); return; }
  if (wantTalk || !S.me) { if (!S.me) toast('ยังไม่ได้เชื่อมต่อ'); return; }
  if (NATIVE) { wantTalk = true; WN.pttDown(); renderTalk(); return; }
  ensureCtx();
  if (!processor) {
    try { await ensureMic(); } catch (e) { toast('เปิดไมโครโฟนไม่ได้: ' + (e.message || e)); return; }
    if (!pressed) return;
  }
  wantTalk = true; send({ type: 'ptt_start', rate: TARGET_RATE }); renderTalk();
}
function stopTalking(silent) {
  if (!wantTalk) return;
  wantTalk = false;
  if (NATIVE) { WN.pttUp(); setMeter(0); renderTalk(); return; }
  if (talking && !silent) { send({ type: 'ptt_end' }); beep(440, 0.06); }
  talking = false; setMeter(0); renderTalk();
}
function renderTalk() {
  const t = S.state.talker, mine = talking && S.me && t === S.me.name, other = !!t && !mine;
  for (const b of $$('[data-ptt]')) { b.classList.toggle('talking', mine); b.classList.toggle('listening', other); }
  const big = $('pttBig');
  if (big) big.innerHTML = `${icon('mic')}<b>${mine ? 'กำลังพูด' : other ? 'กำลังรับฟัง' : wantTalk ? 'รอสักครู่…' : 'กดค้างเพื่อพูด'}</b><small>${mine ? 'ปล่อยเพื่อจบ' : other ? esc(t) : S.prefs.mode === 'toggle' ? 'แตะเพื่อเริ่ม / แตะอีกครั้งเพื่อจบ' : ''}</small>`;
  const st = $('pttStatus');
  if (st) {
    const on = S.conn === 'online';
    st.innerHTML = mine ? `<span class="dot" style="background:#ff6b6b;color:#ff6b6b"></span>กำลังส่งเสียง...`
      : other ? `<span class="dot on" style="color:var(--online)"></span>กำลังรับฟัง: ${esc(t)}`
      : on ? `<span class="dot on" style="background:var(--online);color:var(--online)"></span>พร้อมรับการสื่อสาร` : `<span class="dot warn" style="color:#f59e0b"></span>กำลังเชื่อมต่อ…`;
  }
  const cnt = S.me && S.me.channel ? (S.counts[S.me.channel] ?? S.state.users.length) : 0;
  for (const el of $$('[data-chcount]')) el.textContent = `${cnt} คนออนไลน์`;
  updateMediaSession();
}
const levels = new Array(48).fill(0);
let lastLevel = 0;
function setMeter(p) { lastLevel = Math.min(1, p * 1.8); }
(function wave() {
  let phase = 0;
  const tick = () => {
    const c = $('wave');
    if (c && !document.hidden) {
      const g = c.getContext('2d');
      levels.push(lastLevel); levels.shift(); lastLevel *= 0.55; phase += 0.35;
      const active = talking || !!S.state.talker;
      g.clearRect(0, 0, c.width, c.height);
      const grad = g.createLinearGradient(0, 0, c.width, 0);
      const mid = talking ? '#ff6b6b' : S.state.talker ? '#4ade80' : '#3d8bff', edge = talking ? '#ffb3b3' : S.state.talker ? '#a7f3c0' : '#9cc6ff';
      grad.addColorStop(0, edge); grad.addColorStop(.5, mid); grad.addColorStop(1, edge); g.fillStyle = grad;
      const N = 90, w = c.width / N, my = c.height / 2, cur = Math.max(...levels.slice(-5));
      for (let i = 0; i < N; i++) {
        const d = Math.abs(i - (N - 1) / 2) / (N / 2), env = Math.pow(Math.cos(d * Math.PI / 2), 1.3);
        const jit = 0.55 + 0.45 * Math.abs(Math.sin(i * 1.7 + phase));
        const idle = active ? 0 : 0.16 * env * (0.6 + 0.4 * Math.sin(i * .5 + phase * .3));
        const h = Math.max(4, Math.max(cur * env * jit, idle) * c.height * .95);
        g.beginPath(); g.roundRect ? g.roundRect(i * w + w * .28, my - h / 2, Math.max(2, w * .44), h, 2) : g.rect(i * w, my - h / 2, w * .44, h); g.fill();
      }
    }
    setTimeout(() => requestAnimationFrame(tick), 50);
  };
  tick();
})();

// ================================================================ chat data
async function loadHistory(older) {
  const ch = S.me && S.me.channel;
  if (!ch) return;
  if (!older && S.chat.channel !== ch) S.chat = { channel: ch, msgs: [], reactions: {}, more: false, loadedFor: null };
  if (!has('history')) { S.chat.loadedFor = ch; renderChat(); return; }
  const before = older && S.chat.msgs.length ? `&before=${S.chat.msgs[0].id}` : '';
  try {
    const d = await api(`/api/messages?channel=${encodeURIComponent(ch)}&limit=50${before}`);
    if (S.chat.channel !== ch) return;
    const known = new Set(S.chat.msgs.map(m => m.id));
    S.chat.msgs = [...d.msgs.filter(m => !known.has(m.id)), ...S.chat.msgs].sort((a, b) => a.id - b.id);
    Object.assign(S.chat.reactions, d.reactions);
    S.chat.more = d.more; S.chat.loadedFor = ch;
    if (S.route === 'chat') renderChat(!older);
  } catch { toast('โหลดข้อความย้อนหลังไม่ได้'); }
}
function addChatMsg(msg) {
  if (!msg) return;
  if (S.me && msg.channel === S.me.channel) {
    if (S.chat.channel !== msg.channel) S.chat = { channel: msg.channel, msgs: [], reactions: {}, more: false, loadedFor: null };
    if (!S.chat.msgs.some(x => x.id === msg.id)) {
      S.chat.msgs.push(msg);
      if (S.route === 'chat') { const list = $('msgs'); if (list) { list.insertAdjacentHTML('beforeend', msgHtml(msg)); loadAvatars(list); list.scrollTop = list.scrollHeight; } }
    }
    if (msg.kind === 'text' && !isMine(msg) && (S.route !== 'chat' || document.hidden)) addMsgAlert(msg);
  } else addMsgAlert(msg);
}
function addMsgAlert(msg) {
  if (!msg || isMine(msg) || S.msgAlerts.some(a => a.id === msg.id)) return;
  S.msgAlerts.unshift({ id: msg.id, ts: msg.ts, channel: msg.channel, name: msg.name, kind: msg.kind, text: msg.text, ms: msg.ms, read: false });
  S.msgAlerts = S.msgAlerts.slice(0, 60);
  lsSet('walkie_alerts', JSON.stringify(S.msgAlerts));
  renderBadges();
  if (document.hidden) systemNotify(`${msg.name} · ${msg.channel}`, msg.kind === 'talk' ? `พูด ${fmtDur(msg.ms)}` : msg.text, 'ch:' + msg.channel);
}
function markChannelRead(ch) {
  let c = false;
  for (const a of S.msgAlerts) if (a.channel === ch && !a.read) { a.read = true; c = true; }
  if (c) { lsSet('walkie_alerts', JSON.stringify(S.msgAlerts)); renderBadges(); }
}
function renderBadges() {
  const msgs = S.msgAlerts.filter(a => !a.read).length, n = S.unread + msgs;
  const set = (id, v) => { const b = $(id); if (b) { b.textContent = v > 9 ? '9+' : v; b.classList.toggle('hidden', !v); } };
  set('navMsgBadge', msgs); set('bellBadge', n); set('taskBadge', S.openTasks); set('msgTileBadge', msgs);
}
const isMine = m => (m.user_id && S.user && m.user_id === S.user.id) || (m.uid && m.uid === S.uid) || (!m.uid && !m.user_id && S.me && m.name === S.me.name);
function reactsHtml(id) {
  const by = S.chat.reactions[id] || {};
  return Object.entries(by).filter(([, u]) => u.length).map(([e, u]) => `<button type="button" class="react ${u.includes(S.uid) ? 'me' : ''}" data-rid="${id}" data-e="${e}">${e} ${u.length}</button>`).join('');
}
const BARS = n => Array.from({ length: 22 }, (_, i) => `<i style="height:${30 + 60 * Math.abs(Math.sin(i * 1.3 + n))}%"></i>`).join('');
function voiceHtml(m, cls = 'voice') {
  const can = m.audio && S.config.recording;
  return `<button type="button" class="${cls} ${can ? '' : 'noaudio'}" data-play="${can ? m.id : ''}" data-ms="${m.ms || 0}" aria-label="${can ? 'ฟังเสียง' : 'ไม่มีไฟล์เสียง'} ${esc(m.name)} ${fmtDur(m.ms)}">
    <span class="play">${icon(can ? 'play' : 'mic')}</span><span class="bars">${BARS(m.id % 7)}</span><span class="dur">${fmtDur(m.ms)}</span></button>`;
}
function msgHtml(m) {
  const mine = isMine(m);
  const body = m.kind === 'talk' ? voiceHtml(m) : `<button type="button" class="bubble" data-id="${m.id}">${esc(m.text)}</button>`;
  const who = `<div class="who"><span>${mine ? '' : esc(m.name) + (m.dept ? ` (${esc(m.dept)})` : '')}</span><time>${fmtTime(m.ts)}</time></div>`;
  return `<div class="msg ${mine ? 'mine' : ''}" id="m-${m.id}">${mine ? '' : avatar(m)}<div class="body">${who}${body}<div class="reacts" id="r-${m.id}">${reactsHtml(m.id)}</div></div></div>`;
}

// ---------------------------------------------------------------- recorded audio playback
let player = null;
async function playRecording(btn) {
  const id = btn.dataset.play;
  if (!id) return toast(S.config.recording ? 'ไม่มีไฟล์เสียงของรายการนี้ (อาจหมดอายุการเก็บ)' : 'ยังไม่ได้เปิดระบบบันทึกเสียง');
  if (player && player.btn === btn) { player.audio.pause(); player.done(); return; }
  if (player) { player.audio.pause(); player.done(); }
  const playIcon = btn.querySelector('.play, .playbtn') || btn;
  try {
    playIcon.innerHTML = icon('pause');
    const r = await api(`/api/audio/${id}`, { raw: true });
    const url = URL.createObjectURL(await r.blob());
    const audio = new Audio(url);
    audio.volume = Math.min(1, S.prefs.volume / 100 + 0.2);
    const bars = $$('.bars i', btn);
    const done = () => { playIcon.innerHTML = icon('play'); bars.forEach(b => b.classList.remove('done')); URL.revokeObjectURL(url); if (player && player.btn === btn) player = null; };
    audio.ontimeupdate = () => { const p = audio.currentTime / (audio.duration || 1); bars.forEach((b, i) => b.classList.toggle('done', i / bars.length < p)); const d = btn.querySelector('.dur'); if (d) d.textContent = fmtDur(audio.currentTime * 1000 || 1); };
    audio.onended = done;
    player = { audio, btn, done };
    await audio.play();
  } catch (e) { playIcon.innerHTML = icon('play'); toast('เล่นเสียงไม่ได้: ' + e.message); }
}
document.addEventListener('click', e => { const b = e.target.closest('[data-play]'); if (b) playRecording(b); });

// ================================================================ SOS (receive)
let sirenTimer = null;
function showSos(s) {
  S.sos = s;
  if (S.user && s.user_id === S.user.id) return;          // reporter doesn't need the alarm
  hideSos(true);
  const k = SOS[s.kind] || SOS.other;
  const el = document.createElement('div'); el.className = 'sos-alert'; el.id = 'sosAlert'; el.setAttribute('role', 'alertdialog');
  el.innerHTML = `<svg class="i" style="width:110px;height:110px"><use href="#i-siren"/></svg>
    <h2>🚨 เหตุฉุกเฉิน${s.kind && s.kind !== 'general' ? ': ' + esc(s.kind_name || k[0]) : ''}</h2>
    <p style="font-size:15px;opacity:.9;margin-bottom:2px">แจ้งโดย</p>
    <p style="font-size:26px;font-weight:700;margin-top:0">${esc(s.reporter)}${s.reporter_dept ? `<br><span style="font-size:18px;font-weight:500">${esc(s.reporter_dept)}</span>` : ''}</p>
    ${s.place ? `<p>${icon('pin')} ${esc(s.place)}</p>` : ''}${s.note ? `<p>${esc(s.note)}</p>` : ''}
    <p class="small">${fmtTime(s.ts)} น.${s.lat ? ` · พิกัด ${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}` : ''}</p>
    <p class="small">เสียงเตือนดังทุกเครื่องที่เข้าสู่ระบบ</p>
    <p class="small" id="sosAcks"></p>
    <button class="btn ack" id="sosAck" type="button">${icon('check')}รับทราบ</button>
    <button class="btn ghost" id="sosMap" type="button">${icon('map')}ดูจุดเกิดเหตุบนแผนที่</button>
    ${s.lat ? `<button class="btn ghost" id="sosNav" type="button">${icon('pin')}นำทางไปจุดเกิดเหตุ</button>` : ''}`;
  $('app').appendChild(el);
  $('sosAck').onclick = async () => { stopSiren(); try { await api(`/api/sos/${s.id}/ack`, { method: 'POST' }); } catch {} hideSos(); };
  $('sosMap').onclick = () => { stopSiren(); hideSos(true); go('map', s.lat ? { sos: s.id } : {}); };
  if ($('sosNav')) $('sosNav').onclick = () => window.open(`https://www.google.com/maps?q=${s.lat},${s.lng}`, '_blank');
  startSiren();
  if (document.hidden) systemNotify('🚨 เหตุฉุกเฉิน', `แจ้งโดย ${s.reporter}${s.reporter_dept ? ' (' + s.reporter_dept + ')' : ''}${s.place ? ' · ' + s.place : ''}`, 'sos', true);
}
function hideSos(keepState) { $('sosAlert')?.remove(); stopSiren(); if (!keepState) S.sos = null; }
function startSiren() {
  vibrate([600, 300, 600, 300, 600]);
  if (NATIVE) return;
  ensureCtx();
  if (!audioCtx) return;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = 'sawtooth'; g.gain.value = 0.18; o.connect(g); g.connect(audioCtx.destination); o.start();
  let up = true;
  const wail = () => { const t = audioCtx.currentTime; o.frequency.cancelScheduledValues(t); o.frequency.setValueAtTime(up ? 650 : 1250, t); o.frequency.linearRampToValueAtTime(up ? 1250 : 650, t + 0.9); up = !up; vibrate([500, 400]); };
  wail(); sirenTimer = { o, i: setInterval(wail, 900), stopAt: setTimeout(stopSiren, 45000) };
}
function stopSiren() { if (!sirenTimer) return; clearInterval(sirenTimer.i); clearTimeout(sirenTimer.stopAt); try { sirenTimer.o.stop(); } catch {} sirenTimer = null; vibrate(0); }
async function systemNotify(title, body, tag, urgent) {
  if (NATIVE || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const opt = { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', renotify: true, requireInteraction: !!urgent, vibrate: urgent ? [600, 300, 600] : undefined };
    reg ? reg.showNotification(title, opt) : new Notification(title, opt);
  } catch {}
}

// ================================================================ screens
// ---------------------------------------------------------------- 01 splash
ROUTES.splash = () => {
  mount(`<div class="splash">
    <div class="scene">${sceneSvg()}</div>
    <img class="appicon-img" src="brand/app-icon.png" alt="">
    <div class="wordmark">WORMA<span class="t">DI</span></div>
    <div class="tag">วอมาดิ คุยปุ๊บ งานเดินต่อ<br><small>เชื่อมโยงทุกทีมงานโรงงาน</small></div>
    <div class="swoosh"></div>
    <div class="foot">${orgLogo('orglogo light')}<span>${esc(S.config.org || 'Mitr Lao Sugar Co., Ltd.')}</span></div>
  </div>`, root => {
    const next = () => { if (S.route === 'splash') go((ACC() ? S.token : S.profile.name) ? 'home' : 'login', {}, true); };
    root.querySelector('.splash').onclick = next;
    setTimeout(next, 1800);
  });
};

// ---------------------------------------------------------------- 02 login
ROUTES.login = () => {
  const acc = ACC();
  mount(`<div class="login">
    <img class="appicon-img" src="brand/app-icon.png" alt="">
    <img class="wordmark-img" src="brand/wordmark.png" alt="WORMADI วอมาดิ คุยปุ๊บ งานเดินต่อ">
    <h2>เข้าสู่ระบบ</h2>
    <form id="lf" novalidate>
      <div class="native-only">
        <div class="field">${icon('globe', 'i lead')}<input id="server" placeholder="ที่อยู่เซิร์ฟเวอร์ เช่น wormadi.pages.dev" autocapitalize="off" spellcheck="false" inputmode="url"></div>
        <div class="err" id="serverInfo" style="color:var(--muted)"></div>
      </div>
      ${acc || NATIVE ? `
      <div class="field">${icon('user', 'i lead')}<input id="emp" placeholder="รหัสพนักงาน" autocomplete="username" autocapitalize="off" spellcheck="false"></div>
      <div class="field">${icon('lock', 'i lead')}<input id="pw" type="password" placeholder="รหัสผ่าน" autocomplete="current-password">
        <button type="button" class="ib trail" id="eye" aria-label="แสดงรหัสผ่าน">${icon('eyeoff')}</button></div>
      <label class="check"><input type="checkbox" id="remember" checked> จดจำการเข้าสู่ระบบ</label>
      <p class="small muted" style="margin:2px 4px 0">1 บัญชีใช้ได้ทีละ 1 เครื่อง เข้าเครื่องใหม่ เครื่องเดิมจะออกจากระบบอัตโนมัติ</p>`
      : `<div class="field">${icon('user', 'i lead')}<input id="lname" placeholder="ชื่อของคุณ" maxlength="24"></div>
      <div class="field">${icon('brief', 'i lead')}<input id="ldept" placeholder="ฝ่าย / แผนก" maxlength="32"></div>`}
      <div class="err" id="lerr" role="alert"></div>
      <button class="btn primary" type="submit" id="lbtn">เข้าสู่ระบบ</button>
    </form>
    <div style="width:100%;max-width:420px;margin-top:14px">${installBar()}</div>
    <div class="orgline">${orgLogo()}<span>${esc(S.config.org)}</span></div>
    <div class="skyline"><svg viewBox="0 0 400 90" preserveAspectRatio="xMidYMax slice"><path fill="currentColor" d="M0 90V60h30V40h14v20h20V30h10v-8h6v8h10v60zM100 90V50h40v-8h8V20h6v22h8v48zM170 90V44h20v-6h10v6h10v46zM220 90V56h18V30h12v26h30V40l12-6 12 6v50zM310 90V48h22V24h8v24h20v-8h10v8h30v42z"/></svg></div>
  </div>`, root => {
    bindInstallBar(root);
    if (NATIVE) {
      $('server').value = lsGet('walkie_server') || 'wormadi.pages.dev';
      if (!serverBase) probeServer();
      $('server').onchange = () => probeServer();
    }
    if ($('emp')) $('emp').value = lsGet('walkie_emp') || '';
    if ($('lname')) { $('lname').value = S.profile.name || ''; $('ldept').value = S.profile.dept || ''; }
    if ($('eye')) $('eye').onclick = () => { const p = $('pw'); p.type = p.type === 'password' ? 'text' : 'password'; $('eye').innerHTML = icon(p.type === 'password' ? 'eyeoff' : 'eye'); };
    $('lf').onsubmit = async e => {
      e.preventDefault();
      const err = $('lerr'); err.textContent = '';
      if (NATIVE && !serverBase) { await probeServer(); if (!serverBase) { err.textContent = 'ตรวจสอบที่อยู่เซิร์ฟเวอร์ก่อน'; return; } }
      if (ACC()) {
        const emp = $('emp').value.trim(), pw = $('pw').value;
        if (!emp || !pw) { err.textContent = 'กรุณาใส่รหัสพนักงานและรหัสผ่าน'; return; }
        $('lbtn').disabled = true; $('lbtn').textContent = 'กำลังเข้าสู่ระบบ…';
        try {
          const d = await api('/api/login', { method: 'POST', body: { emp, password: pw, remember: $('remember').checked } });
          S.token = d.token; S.user = d.user;
          lsSet('walkie_token', d.token); lsSet('walkie_user', JSON.stringify(d.user)); lsSet('walkie_emp', emp);
          ensureCtx();
          if (d.user.must_change) { S.lastPw = pw; return go('setpw', {}, true); }
          await afterSignIn();
          if (pendingJoin()) return go('join', { room: pendingJoin(true) }, true);
          go('home', {}, true);
        } catch (e2) { err.textContent = e2.message; }
        finally { if ($('lbtn')) { $('lbtn').disabled = false; $('lbtn').textContent = 'เข้าสู่ระบบ'; } }
      } else {
        const name = $('lname').value.trim();
        if (!name) { err.textContent = 'กรุณาใส่ชื่อ'; return; }
        S.profile = { name, dept: $('ldept').value.trim() }; lsSet('walkie_profile', JSON.stringify(S.profile));
        ensureCtx(); startConnection(); go('home', {}, true);
      }
    };
  });
};
async function afterSignIn() {
  await Promise.all([loadChannels(), refreshMe()]);
  startConnection();
}
function signOut(msg) {
  const t = S.token;
  if (t && ACC()) netFetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }).catch(() => {});
  stopConnection();
  S.token = null; S.user = null; S.me = null; S.roster = null; S.unread = 0;
  lsSet('walkie_token', null); lsSet('walkie_user', null);
  if (!ACC()) { S.profile = {}; lsSet('walkie_profile', null); }
  setWake(false); setKeepAlive(false); hideSos();
  go('login', {}, true);
  if (msg) toast(msg);
}

// ---------------------------------------------------------------- set new password (first login / after reset)
ROUTES.setpw = () => {
  const known = !!S.lastPw;
  mount(`<div class="login">
    <img class="appicon-img" src="brand/app-icon.png" alt="">
    <h2 style="margin-top:16px">ตั้งรหัสผ่านใหม่</h2>
    <p class="muted" style="text-align:center;margin:0 0 6px;max-width:340px">สวัสดี <b>${esc(S.user?.name || '')}</b><br>ครั้งแรกที่เข้าใช้งาน กรุณาตั้งรหัสผ่านของคุณเอง อย่างน้อย 6 ตัว และอย่าบอกรหัสนี้กับผู้อื่น</p>
    <form id="pf" novalidate>
      <div class="field ${known ? 'hidden' : ''}">${icon('lock', 'i lead')}<input id="op" type="password" placeholder="รหัสผ่านปัจจุบัน" autocomplete="current-password"></div>
      <div class="field">${icon('lock', 'i lead')}<input id="np" type="password" placeholder="รหัสผ่านใหม่ (อย่างน้อย 6 ตัว)" autocomplete="new-password" minlength="6"></div>
      <div class="field">${icon('lock', 'i lead')}<input id="np2" type="password" placeholder="ยืนยันรหัสผ่านใหม่" autocomplete="new-password"></div>
      <div class="err" id="perr" role="alert"></div>
      <button class="btn primary" type="submit" id="pbtn">บันทึกและเข้าใช้งาน</button>
      <button class="btn" type="button" id="pout" style="margin-top:12px">ออกจากระบบ</button>
    </form>
  </div>`, () => {
    $('pout').onclick = () => signOut();
    $('pf').onsubmit = async e => {
      e.preventDefault();
      const err = $('perr'), np = $('np').value, old = known ? S.lastPw : $('op').value;
      err.textContent = '';
      if (np.length < 6) return (err.textContent = 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 6 ตัว');
      if (np !== $('np2').value) return (err.textContent = 'ยืนยันรหัสผ่านไม่ตรงกัน');
      if (np === old) return (err.textContent = 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม');
      $('pbtn').disabled = true;
      try {
        await api('/api/me/password', { method: 'POST', body: { old, new: np } });
        S.lastPw = null; S.user.must_change = 0; lsSet('walkie_user', JSON.stringify(S.user));
        toast('ตั้งรหัสผ่านใหม่แล้ว');
        await afterSignIn();
        if (pendingJoin()) return go('join', { room: pendingJoin(true) }, true);
        go('home', {}, true);
      } catch (e2) { err.textContent = e2.message; $('pbtn').disabled = false; }
    };
  });
};

// ---------------------------------------------------------------- 03 home dashboard
ROUTES.home = () => {
  const u = S.user || { name: S.profile.name, dept: S.profile.dept };
  const online = S.roster ? S.roster.length : Object.values(S.counts).reduce((a, b) => a + (b || 0), 0);
  mount(`<div class="page"><div class="scroll">
    <div class="home-top"><button type="button" id="homeAv" aria-label="เปลี่ยนรูปโปรไฟล์" style="background:none;border:0;padding:0;cursor:pointer">${avatar(S.user || u)}</button>
      <div class="grow"><div class="hi">สวัสดี</div><div class="nm ell">${esc(u.name)}</div><div class="dp ell">${esc(u.dept || '')}</div></div>
      <button class="ib" id="bell" aria-label="การแจ้งเตือน">${icon('bell')}<span class="badge hidden" id="bellBadge"></span></button>
    </div>
    ${installBar()}
    <div class="tiles6">
      <button class="tile wt" data-to="ptt">${icon('mic')}Walkie Talkie<small>(พูดคุยทันที)</small></button>
      <button class="tile grp" data-to="channels">${icon('team')}กลุ่มสื่อสาร</button>
      <button class="tile tmsg" data-to="convos">${icon('chat')}ข้อความ<span class="badge hidden" id="msgTileBadge"></span></button>
      <button class="tile sos" data-to="sos">${icon('siren')}แจ้งเหตุฉุกเฉิน<small>(SOS)</small></button>
      <button class="tile ttask" data-to="tasks">${icon('task')}งานของฉัน<span class="badge hidden" id="taskBadge"></span></button>
      <button class="tile map" data-to="map">${icon('map')}แผนที่โรงงาน</button>
    </div>
    <button class="card online-card" style="width:calc(100% - 28px);text-align:left" data-to="members">
      <span class="ic">${icon('team')}</span>
      <span class="grow"><b>พนักงานออนไลน์ <span id="onlineN">${online}</span> คน</b><br><span class="muted small">ห้องสื่อสารทั้งหมด ${S.channels.length} ห้อง</span></span>
      <span class="dot on" style="width:14px;height:14px"></span>
    </button>
    <div class="row" style="padding:2px 18px 14px" data-conn-wrap><span class="small muted" data-conn></span>${S.me ? `<span class="small muted">· ${S.me.channel ? 'ห้อง ' + esc(S.me.channel) : 'ยังไม่ได้เข้าห้อง'}</span>` : ''}</div>
  </div></div>`, root => {
    for (const b of $$('[data-to]', root)) b.onclick = () => {
      const to = b.dataset.to;
      if (!ACC() && ['sos', 'tasks', 'map', 'members'].includes(to)) return toast('ใช้ได้เมื่อใช้เซิร์ฟเวอร์ Cloudflare (บัญชีพนักงาน)');
      go(to);
    };
    $('bell').onclick = () => go('notifications');
    $('homeAv').onclick = () => (S.user ? changeAvatar() : go('profile'));
    bindInstallBar(root);
    setConn(S.conn); renderBadges();
  });
};

// ---------------------------------------------------------------- 04 push to talk
ROUTES.ptt = () => {
  const ch = S.me && S.me.channel ? chanInfo(S.me.channel) : null;
  mount(`<div class="pttpage">
    <header class="hd safe-top"><button class="ib" data-back aria-label="กลับ">${icon('back')}</button><h1>Walkie Talkie</h1>
      <button class="ib" id="spk" aria-label="${S.prefs.speaker ? 'ปิดเสียงลำโพง' : 'เปิดเสียงลำโพง'}">${icon(S.prefs.speaker ? 'volume' : 'mute')}</button></header>
    <div class="lbl2">ห้องสื่อสารปัจจุบัน</div>
    <button class="chcard" id="chPick">${ch ? chanIcon(ch) : `<span class="ic">${icon('radio')}</span>`}
      <span class="grow"><b class="ell">${esc(ch ? ch.name : S.me ? 'ยังไม่ได้เข้าห้อง – แตะเพื่อเลือก/สร้างห้อง' : 'กำลังเชื่อมต่อ…')}</b><small>${icon('user')}<span data-chcount></span></small></span>${icon('down')}</button>
    <button class="btn primary unlock hidden" id="unlockBtn" type="button" style="width:auto;margin-top:10px">${icon('volume')}แตะเพื่อเปิดเสียง</button>
    <div class="pttstage">
      <button class="ptt" id="pttBig" data-ptt type="button" aria-describedby="pttStatus"></button>
      <canvas class="wave" id="wave" width="720" height="140" aria-hidden="true"></canvas>
    </div>
    <div class="pttstatus" id="pttStatus" aria-live="polite"></div>
    <div style="display:flex;justify-content:center;gap:10px;margin:0 0 10px">
      ${ch && ch.dm ? `<button class="btn sm" id="hangUp" type="button" style="background:#cf2020;color:#fff;border-color:#cf2020">${icon('x')}วางสาย</button>` : ''}
      <button class="btn sm" id="toChat" type="button">${icon('chat')}พิมพ์ / ฟังย้อนหลัง</button>
      ${ch && ch.id ? `<button class="btn sm" id="shareRoom" type="button">${icon('send')}แชร์ห้อง</button>` : ''}</div>
    <p class="small web-only" style="text-align:center;color:var(--ptt-page-muted);margin:0 0 14px">บนคอมพิวเตอร์ กด Spacebar ค้างไว้เพื่อพูดได้</p>
  </div>`, root => {
    bindBack(root);
    bindPtt($('pttBig'));
    $('chPick').onclick = () => go('channels', { then: 'ptt' });
    $('toChat').onclick = () => go('chat');
    if ($('hangUp')) $('hangUp').onclick = () => { endCall(); toast('วางสายแล้ว'); };
    if ($('shareRoom')) $('shareRoom').onclick = () => shareRoom(ch);
    $('spk').onclick = () => { S.prefs.speaker = !S.prefs.speaker; savePrefs(); applyVolume(); render(); };
    renderTalk(); renderUnlock();
  });
};

// ---------------------------------------------------------------- 05 channels (กลุ่มสื่อสาร)
ROUTES.channels = p => {
  const tab = p.tab || 'all';
  mount(`<div class="page">${header('ห้องสื่อสาร', '', `<button class="ib" id="newRoom" aria-label="สร้างห้องใหม่">${icon('plus')}</button>`)}
    <div class="tabs"><button data-tab="all" class="${tab === 'all' ? 'on' : ''}">ทั้งหมด ${S.channels.length}</button><button data-tab="fav" class="${tab === 'fav' ? 'on' : ''}">รายการโปรด ★</button></div>
    <div class="search">${icon('search')}<input id="q" placeholder="ค้นหาห้อง..." aria-label="ค้นหาห้อง"></div>
    <div class="scroll">
      <div style="padding:4px 14px 0"><button class="btn primary" id="newRoom2" type="button">${icon('plus')}สร้างห้องใหม่</button></div>
      <div class="list" id="chList"></div></div></div>`, root => {
    bindBack(root);
    $('newRoom').onclick = $('newRoom2').onclick = () => createRoomSheet(p.then || 'ptt');
    for (const b of $$('[data-tab]', root)) b.onclick = () => go('channels', { ...p, tab: b.dataset.tab }, true);
    const draw = () => {
      if (!$('chList')) return;
      const q = $('q').value.trim().toLowerCase();
      const list = S.channels.filter(c => (tab !== 'fav' || S.favs.includes(c.name)) && (!q || c.name.toLowerCase().includes(q) || (c.sub || '').toLowerCase().includes(q)));
      $('chList').innerHTML = list.length ? list.map(c => {
        const cur = S.me && S.me.channel === c.name, fav = S.favs.includes(c.name);
        const lock = c.locked ? `<span title="มีรหัส" style="color:${c.access ? 'var(--muted)' : 'var(--err-fg)'}">${icon('lock')}</span>` : '';
        return `<div class="li" role="button" tabindex="0" data-ch="${esc(c.name)}">${chanIcon(c)}
          <div class="grow"><div class="t1 ell">${esc(c.name)} ${lock}</div><div class="t2 ell">${icon('user')}${S.counts[c.name] || 0} คน${c.locked ? (c.access ? ' · มีรหัส (เข้าได้แล้ว)' : ' · มีรหัส') : ' · ห้องเปิด'}${c.creator_name ? ' · โดย ' + esc(c.creator_name) : ''}</div></div>
          <button class="ib" data-share="${c.id}" aria-label="แชร์ห้อง ${esc(c.name)}" style="color:var(--primary-fg)">${icon('send')}</button>
          ${c.can_delete ? `<button class="ib" data-del="${c.id}" aria-label="ลบห้อง ${esc(c.name)}" style="color:var(--err-fg)">${icon('trash')}</button>` : ''}
          <button class="ib" data-fav="${esc(c.name)}" aria-label="${fav ? 'เอาออกจากรายการโปรด' : 'เพิ่มในรายการโปรด'}" style="color:${fav ? '#e0a100' : 'var(--nav-muted)'}">${icon(fav ? 'starf' : 'star')}</button>
          ${cur ? `<span style="color:var(--primary)">${icon('checkc')}</span>` : `<span class="chev">${icon('chev')}</span>`}</div>`;
      }).join('') : `<div class="empty">${tab === 'fav' ? 'ยังไม่มีรายการโปรด แตะ ☆ ที่ห้องเพื่อเพิ่ม' : q ? 'ไม่พบห้อง' : 'ยังไม่มีห้อง กด “สร้างห้องใหม่” เพื่อเริ่มคุยกับทีม'}</div>`;
      for (const r of $$('[data-ch]', root)) r.onclick = e => {
        if (e.target.closest('[data-fav],[data-del],[data-share]')) return;
        enterRoom(r.dataset.ch, p.then || 'ptt');
      };
      for (const f of $$('[data-fav]', root)) f.onclick = () => {
        const n = f.dataset.fav;
        S.favs = S.favs.includes(n) ? S.favs.filter(x => x !== n) : [...S.favs, n];
        lsSet('walkie_favs', JSON.stringify(S.favs)); draw();
      };
      for (const b of $$('[data-share]', root)) b.onclick = () => { const c = S.channels.find(x => String(x.id) === b.dataset.share); if (c) shareRoom(c); };
      for (const d of $$('[data-del]', root)) d.onclick = async () => {
        const c = S.channels.find(x => String(x.id) === d.dataset.del);
        if (!c || !confirm(`ลบห้อง "${c.name}"?\nทุกคนที่อยู่ในห้องจะถูกย้ายออก`)) return;
        try { await api(`/api/channels/${c.id}`, { method: 'DELETE' }); toast('ลบห้องแล้ว'); await loadChannels(); draw(); } catch (e) { toast(e.message); }
      };
    };
    S.redrawRooms = draw;
    $('q').oninput = draw; draw();
    loadChannels().then(() => { if (S.route === 'channels') draw(); });
  });
};
function pendingJoin(take) {
  let v = ''; try { v = sessionStorage.getItem('walkie_join') || ''; if (take) sessionStorage.removeItem('walkie_join'); } catch {}
  return v;
}
/** link that opens a room directly (asks to log in first, and for the room password if it has one) */
function roomLink(c) { return inviteUrl() + '#/join?room=' + c.id; }
function shareRoom(c) {
  const url = roomLink(c);
  const text = `เข้าห้อง "${c.name}" ใน WORMADI${c.locked ? ' (ห้องมีรหัส ขอรหัสจากผู้สร้างห้อง)' : ''}`;
  let svg = '';
  try { const q = qrcode(0, 'M'); q.addData(url); q.make(); svg = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); } catch {}
  sheet(`<h3 class="row" style="gap:8px">${icon('send')}แชร์ห้อง “${esc(c.name)}”</h3>
    <p class="small muted" style="margin-top:0">ให้เพื่อนสแกน QR หรือเปิดลิงก์ จะเข้าห้องนี้ทันทีหลังเข้าสู่ระบบ${c.locked ? '<br><b>ห้องนี้มีรหัส</b> บอกรหัสห้องให้เพื่อนแยกต่างหาก (ลิงก์ไม่มีรหัสติดไปด้วย)' : ''}</p>
    <div class="qr">${svg}</div><div style="text-align:center;font-size:14px;word-break:break-all;margin:6px 0 12px">${esc(url)}</div>
    ${navigator.share ? `<button class="btn primary" id="shNative" type="button">${icon('send')}แชร์ไปยัง LINE / แอปอื่น</button>` : ''}
    <button class="btn" id="shCopy" type="button" style="margin-top:10px">คัดลอกลิงก์</button>`, bg => {
    const n = bg.querySelector('#shNative');
    if (n) n.onclick = async () => { try { await navigator.share({ title: 'WORMADI', text, url }); } catch {} };
    bg.querySelector('#shCopy').onclick = async () => { try { await navigator.clipboard.writeText(text + '\n' + url); toast('คัดลอกลิงก์แล้ว'); } catch { prompt('คัดลอกลิงก์นี้', url); } };
  });
}
ROUTES.join = async p => {
  mount(`<div class="page">${header('กำลังเข้าห้อง…')}<div class="empty">กำลังเปิดห้องที่แชร์มา…</div></div>`, r => bindBack(r));
  await loadChannels();
  if (S.route !== 'join') return;
  const c = S.channels.find(x => String(x.id) === String(p.room));
  if (!c) { toast('ไม่พบห้องนี้ (อาจถูกลบแล้ว)'); return go('channels', {}, true); }
  go('channels', {}, true);                // the room list stays underneath (back button / password sheet)
  enterRoom(c.name, 'ptt');
};

// ---------------------------------------------------------------- private walkie call (both people online)
let ringTimer = null, ringStop = null;
function startCall(u) {
  if (!S.me || S.conn !== 'online') return toast('ยังไม่ได้เชื่อมต่อ');
  if (S.call) endCall();
  const a = Math.min(S.user.id, u.id), b = Math.max(S.user.id, u.id);
  S.call = { peer: { id: u.id, name: u.name }, channel: `dm:${a}:${b}`, prev: isDm(S.me.channel) ? null : S.me.channel, status: 'ringing' };
  stopTalking(true);
  sendMsg({ type: 'call', to: u.id });
  joinNow(S.call.channel);
  go('ptt');
}
function endCall() {
  const c = S.call; S.call = null; stopRing();
  if (S.me && isDm(S.me.channel)) { stopTalking(true); joinNow((c && c.prev) || lsGet('walkie_channel') || undefined); }
  if (['ptt', 'chat', 'home'].includes(S.route)) render();
}
function stopRing() { clearInterval(ringTimer); clearTimeout(ringStop); ringTimer = ringStop = null; }
function incomingCall(m) {
  if (S.call && S.call.status === 'active') { sendMsg({ type: 'call_reply', to: m.from.id, accept: false, channel: m.channel }); return toast(`${m.from.name} เรียกวอส่วนตัว (คุณสายไม่ว่าง)`); }
  stopRing();
  const reply = accept => {
    stopRing(); closeSheet();
    sendMsg({ type: 'call_reply', to: m.from.id, accept, channel: m.channel });
    if (!accept) return;
    S.call = { peer: m.from, channel: m.channel, prev: S.me && !isDm(S.me.channel) ? S.me.channel : null, status: 'active' };
    stopTalking(true); joinNow(m.channel); go('ptt');
  };
  sheet(`<div id="callIn" style="text-align:center">
      <div style="display:flex;justify-content:center;margin:6px 0 10px">${avatar({ id: m.from.id, name: m.from.name, has_avatar: 1 }, 'av')}</div>
      <h2 style="margin:4px 0">${esc(m.from.name)}</h2>${m.from.dept ? `<div class="muted">${esc(m.from.dept)}</div>` : ''}
      <p style="font-size:18px;font-weight:600;margin:12px 0 18px">${icon('walkie')} เรียกวอส่วนตัวหาคุณ</p>
      <div style="display:flex;gap:12px"><button class="btn" id="callNo" type="button" style="background:#cf2020;color:#fff;border-color:#cf2020">ไม่รับ</button>
      <button class="btn" id="callYes" type="button" style="background:#17803d;color:#fff;border-color:#17803d">${icon('mic')}รับสาย</button></div></div>`, () => {
    $('callYes').onclick = () => reply(true);
    $('callNo').onclick = () => reply(false);
  });
  ensureCtx();
  const ring = () => { if (!NATIVE) { beep(880, 0.15); setTimeout(() => beep(660, 0.15), 220); } vibrate([300, 150, 300]); };
  ring(); ringTimer = setInterval(ring, 1600);
  ringStop = setTimeout(() => { if ($('callIn')) { reply(false); toast(`ไม่ได้รับสายจาก ${m.from.name}`); } }, 30000);
  if (document.hidden) systemNotify(`📞 ${m.from.name} เรียกวอส่วนตัว`, 'แตะเพื่อเปิดแอปแล้วรับสาย', 'call', true);
}

/** join a room; a locked room asks for its password once */
function enterRoom(name, then) {
  const c = S.channels.find(x => x.name === name);
  if (c && c.locked && !c.access) return askRoomPass(c, then);
  if (!S.me || S.me.channel !== name) { stopTalking(true); joinNow(name); }
  if (then) go(then, {}, true);
}
function askRoomPass(c, then) {
  sheet(`<h3 class="row" style="gap:8px">${icon('lock')}${esc(c.name)}</h3>
    <p class="muted" style="margin-top:0">ห้องนี้มีรหัส ขอรหัสจากผู้สร้างห้อง${c.creator_name ? ` (${esc(c.creator_name)})` : ''} ใส่ครั้งเดียว ครั้งต่อไปเข้าได้เลย</p>
    <form id="rpf" novalidate><div class="field">${icon('lock', 'i lead')}<input id="rp" type="password" placeholder="รหัสห้อง" autocomplete="off" maxlength="32"></div>
    <div class="err" id="rperr" role="alert"></div><button class="btn primary" id="rpb">เข้าห้อง</button></form>`, () => {
    $('rpf').onsubmit = async e => {
      e.preventDefault();
      $('rpb').disabled = true;
      try {
        await api(`/api/channels/${c.id}/unlock`, { method: 'POST', body: { password: $('rp').value } });
        c.access = true; closeSheet(); toast('เข้าห้องแล้ว');
        enterRoom(c.name, then);
      } catch (er) { $('rperr').textContent = er.message; $('rpb').disabled = false; }
    };
  });
}
function createRoomSheet(then) {
  const colors = ['blue', 'green', 'orange', 'purple', 'red', 'teal', 'gold'];
  let color = colors[0];
  sheet(`<h3>สร้างห้องใหม่</h3><form id="crf" novalidate>
    <label class="lbl" for="crn">ชื่อห้อง</label><div class="field plain"><input id="crn" maxlength="40" placeholder="เช่น ทีมหม้อต้ม กะ A" autocomplete="off"></div>
    <label class="lbl" for="crs">คำอธิบาย (ไม่ใส่ก็ได้)</label><div class="field plain"><input id="crs" maxlength="60" placeholder="เช่น คุยงานซ่อมหม้อไอน้ำ" autocomplete="off"></div>
    <label class="lbl">สีห้อง</label><div class="row" id="crc" style="gap:10px;flex-wrap:wrap;margin:14px 2px 4px">${colors.map((c, i) => `<button type="button" class="ic c-${c}" data-c="${c}" aria-label="สี ${c}" aria-pressed="${i === 0}" style="border:0;outline-offset:2px;${i === 0 ? 'outline:3px solid var(--primary)' : ''}">${icon('radio')}</button>`).join('')}</div>
    <label class="setrow" style="padding:14px 2px;border:0">${icon('lock', 'i lead')}<div class="grow"><b>ตั้งรหัสห้อง</b><small>ไม่ตั้ง = ทุกคนเข้าได้ · ตั้ง = ต้องใส่รหัสก่อนเข้า (ครั้งเดียว)</small></div><input type="checkbox" class="sw" id="crl"></label>
    <div class="field hidden" id="crpw">${icon('lock', 'i lead')}<input id="crp" type="text" placeholder="รหัสห้อง 4–32 ตัว" autocomplete="off" maxlength="32"></div>
    <div class="err" id="crerr" role="alert"></div>
    <button class="btn primary" id="crb">สร้างห้องและเข้าห้อง</button></form>`, bg => {
    for (const b of $$('[data-c]', bg)) b.onclick = () => {
      color = b.dataset.c;
      for (const x of $$('[data-c]', bg)) { x.style.outline = x === b ? '3px solid var(--primary)' : 'none'; x.setAttribute('aria-pressed', x === b); }
    };
    $('crl').onchange = () => { $('crpw').classList.toggle('hidden', !$('crl').checked); if ($('crl').checked) $('crp').focus(); };
    $('crf').onsubmit = async e => {
      e.preventDefault();
      const name = $('crn').value.trim(), pw = $('crl').checked ? $('crp').value : '';
      const err = $('crerr'); err.textContent = '';
      if (!name) return (err.textContent = 'กรุณาตั้งชื่อห้อง');
      if ($('crl').checked && (pw.length < 4 || pw.length > 32)) return (err.textContent = 'รหัสห้องต้องยาว 4–32 ตัว');
      $('crb').disabled = true;
      try {
        await api('/api/channels', { method: 'POST', body: { name, sub: $('crs').value.trim(), color, password: pw || undefined } });
        await loadChannels(); closeSheet();
        toast(pw ? `สร้างห้องแล้ว บอกรหัสห้องให้เพื่อนในทีม` : 'สร้างห้องแล้ว');
        enterRoom(name, then);
      } catch (er) { err.textContent = er.message; $('crb').disabled = false; }
    };
  });
}

// ---------------------------------------------------------------- ข้อความ (conversations) -> 06 chat
ROUTES.convos = async () => {
  mount(`<div class="page">${header('ข้อความ')}<div class="search">${icon('search')}<input id="q" placeholder="ค้นหาช่องสื่อสาร..."></div>
    <div class="scroll"><div class="list" id="cv"><div class="empty">กำลังโหลด…</div></div></div></div>`, root => bindBack(root));
  let last = {};
  if (has('history')) { try { for (const c of await api('/api/conversations')) last[c.channel] = c; } catch {} }
  const draw = () => {
    const q = ($('q')?.value || '').trim().toLowerCase();
    const unread = ch => S.msgAlerts.filter(a => a.channel === ch && !a.read).length;
    const list = [...S.channels].filter(c => !q || c.name.toLowerCase().includes(q)).sort((a, b) => (last[b.name]?.ts || 0) - (last[a.name]?.ts || 0));
    if (!$('cv')) return;
    $('cv').innerHTML = list.map(c => {
      const l = last[c.name], n = unread(c.name);
      const prev = c.locked && !c.access ? '🔒 ห้องมีรหัส แตะเพื่อใส่รหัส' : l ? `${esc(l.name)}: ${l.kind === 'talk' ? '🎙 ' + fmtDur(l.ms) : esc(l.text)}` : 'ยังไม่มีข้อความ';
      return `<button class="li" data-ch="${esc(c.name)}">${chanIcon(c)}<div class="grow"><div class="t1 ell">${esc(c.name)}</div><div class="t2 ell">${prev}</div></div>
        <div style="text-align:right">${l ? `<div class="small muted">${fmtTime(l.ts)}</div>` : ''}${n ? `<span class="pill new">${n}</span>` : ''}</div></button>`;
    }).join('');
    for (const r of $$('[data-ch]', $('cv'))) r.onclick = () => openChatFor(r.dataset.ch);
  };
  if ($('q')) $('q').oninput = draw;
  draw();
};
function openChatFor(name) { enterRoom(name, 'chat'); }
ROUTES.chat = () => {
  if (S.me && !S.me.channel) return go('channels', { then: 'chat' }, true);
  const ch = S.me ? chanInfo(S.me.channel) : { name: '…' };
  mount(`<div class="page">${header(esc(ch.name), `${icon('user')}<span data-chcount></span>`, `<button class="ib" id="hist" aria-label="ประวัติการสื่อสาร">${icon('history')}</button>`)}
    <div class="msgs" id="msgs" aria-live="polite"></div>
    <div class="composer">
      <input id="chatIn" placeholder="${has('chat') ? 'พิมพ์ข้อความ...' : 'แชทพิมพ์ใช้ได้เมื่อใช้ Cloudflare'}" maxlength="500" enterkeyhint="send" aria-label="พิมพ์ข้อความ" ${has('chat') ? '' : 'disabled'}>
      <button class="go" id="goBtn" data-ptt type="button" aria-label="กดค้างเพื่อพูด">${icon('mic')}</button>
    </div></div>`, root => {
    bindBack(root, 'convos');
    $('hist').onclick = () => go('history');
    const goBtn = $('goBtn'), inp = $('chatIn');
    const sync = () => { goBtn.innerHTML = icon(inp.value.trim() ? 'send' : 'mic'); goBtn.setAttribute('aria-label', inp.value.trim() ? 'ส่ง' : 'กดค้างเพื่อพูด'); };
    inp.oninput = sync;
    const sendText = () => { const v = inp.value.trim(); if (!v) return; if (S.conn !== 'online') return toast('ยังไม่ได้เชื่อมต่อ'); sendMsg({ type: 'chat', text: v }); inp.value = ''; sync(); };
    inp.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendText(); } };
    goBtn.addEventListener('pointerdown', e => { if (inp.value.trim()) { e.preventDefault(); e.stopImmediatePropagation(); sendText(); } }, true);
    bindPtt(goBtn);
    $('msgs').addEventListener('click', e => {
      const r = e.target.closest('[data-rid]');
      if (r) return sendMsg({ type: 'react', id: Number(r.dataset.rid), emoji: r.dataset.e });
      const b = e.target.closest('.bubble');
      if (!b || !has('react') || !/^\d+$/.test(b.dataset.id)) return;
      const id = Number(b.dataset.id), by = S.chat.reactions[id] || {};
      sheet(`<h3>แสดงความรู้สึก</h3><div class="picker">${S.config.emojis.map(em => `<button data-e="${em}" class="${(by[em] || []).includes(S.uid) ? 'me' : ''}">${em}</button>`).join('')}</div>`,
        bg => { for (const p of $$('[data-e]', bg)) p.onclick = () => { sendMsg({ type: 'react', id, emoji: p.dataset.e }); closeSheet(); }; });
    });
    if (S.me) markChannelRead(S.me.channel);
    renderChat(true); renderTalk();
  });
};
function renderChat(scroll = true) {
  const list = $('msgs');
  if (!list || !S.me) return;
  if (S.chat.loadedFor !== S.me.channel) { list.innerHTML = '<div class="sys">กำลังโหลด…</div>'; loadHistory(); return; }
  const head = S.chat.more ? '<button class="btn sm" id="older" style="align-self:center">โหลดข้อความก่อนหน้า</button>' : '';
  list.innerHTML = head + (S.chat.msgs.length ? S.chat.msgs.map(msgHtml).join('') : '<div class="sys">ยังไม่มีข้อความในช่องนี้</div>');
  if ($('older')) $('older').onclick = () => loadHistory(true);
  loadAvatars(list);
  if (scroll) list.scrollTop = list.scrollHeight;
}

// ---------------------------------------------------------------- 07 members
ROUTES.members = async p => {
  const tab = p.tab || 'all';
  mount(`<div class="page">${header('สมาชิกทีมงาน')}<div class="tabs" id="mtabs"></div>
    <div class="search">${icon('search')}<input id="q" placeholder="ค้นหาชื่อหรือแผนก..."></div>
    <div class="scroll"><div class="list" id="ml"><div class="empty">กำลังโหลด…</div></div></div></div>`, root => bindBack(root));
  let users = [];
  try { users = await api('/api/users'); } catch (e) { $('ml') && ($('ml').innerHTML = `<div class="empty">${esc(e.message)}</div>`); return; }
  const on = users.filter(u => u.online).length;
  if (!$('mtabs')) return;
  $('mtabs').innerHTML = `<button data-t="all" class="${tab === 'all' ? 'on' : ''}">ทั้งหมด (${users.length})</button><button data-t="on" class="${tab === 'on' ? 'on' : ''}">ออนไลน์ (${on})</button><button data-t="off" class="${tab === 'off' ? 'on' : ''}">ออฟไลน์ (${users.length - on})</button>`;
  for (const b of $$('[data-t]')) b.onclick = () => go('members', { tab: b.dataset.t }, true);
  const draw = () => {
    const q = $('q').value.trim().toLowerCase();
    const list = users.filter(u => (tab === 'all' || (tab === 'on') === u.online) && (!q || `${u.name} ${u.dept} ${u.emp}`.toLowerCase().includes(q)));
    $('ml').innerHTML = list.length ? list.map(u => `<button class="li" data-u="${u.id}">${avatar(u)}<div class="grow"><div class="t1 ell">${esc(u.name)}</div><div class="t2 ell">${esc(u.dept || '-')}${u.online && u.channel ? ` · ${esc(u.channel)}` : ''}</div></div>
      <span class="small" style="display:flex;align-items:center;gap:6px;color:${u.online ? 'var(--ok-fg)' : 'var(--muted)'}"><span class="dot ${u.online ? 'on' : ''}"></span>${u.online ? (S.user && u.id !== S.user.id ? 'ออนไลน์ · แตะเพื่อวอ' : 'ออนไลน์') : u.last_seen ? `ไม่ออนไลน์ (${ago(u.last_seen)})` : 'ออฟไลน์'}</span></button>`).join('') : '<div class="empty">ไม่พบสมาชิก</div>';
    loadAvatars($('ml'));
    for (const r of $$('[data-u]')) r.onclick = () => userSheet(users.find(u => u.id === Number(r.dataset.u)));
  };
  $('q').oninput = draw; draw();
};
function userSheet(u) {
  sheet(`<div class="prof">${avatar(u, 'av')}<h2>${esc(u.name)}</h2><div class="muted">รหัสพนักงาน : ${esc(u.emp)}</div>
    <div style="color:${u.online ? 'var(--ok-fg)' : 'var(--muted)'};margin-top:4px"><span class="dot ${u.online ? 'on' : ''}"></span> ${u.online ? 'ออนไลน์' + (u.channel ? ' · ' + esc(u.channel) : '') : 'ออฟไลน์'}</div></div>
    <div class="list kv">${kv('building', 'แผนก', u.dept)}${kv('brief', 'ตำแหน่ง', u.position)}${kv('antenna', 'ช่องหลัก', u.main_channel_name)}${kv('shield', 'สิทธิ์การใช้งาน', ROLE_NAME[u.role])}</div>
    ${u.online && S.user && u.id !== S.user.id ? `<button class="btn primary" id="callU">${icon('walkie')}วอหาส่วนตัว</button>` : ''}
    ${u.online && u.channel && u.channel !== 'คุยส่วนตัว' ? `<button class="btn" id="joinU" style="margin-top:10px">${icon('mic')}ไปห้อง ${esc(u.channel)}</button>` : ''}
    ${!u.online && S.user && u.id !== S.user.id ? '<p class="small muted" style="text-align:center">วอหาส่วนตัวได้เมื่อผู้ใช้นี้ออนไลน์อยู่</p>' : ''}`, bg => {
    const j = bg.querySelector('#joinU'); if (j) j.onclick = () => { closeSheet(); enterRoom(u.channel, 'ptt'); };
    const cu = bg.querySelector('#callU'); if (cu) cu.onclick = () => { closeSheet(); startCall(u); };
    const av = bg.querySelector('.prof .av'); if (av) { av.style.width = '96px'; av.style.height = '96px'; av.style.margin = '0 auto'; }
  });
}
const kv = (ic, k, v) => `<div class="li">${`<span class="ic">${icon(ic)}</span>`}<div class="grow"><div class="t1">${k}</div><div class="t2">${esc(v || '-')}</div></div></div>`;

// ---------------------------------------------------------------- 08 history
ROUTES.history = async p => {
  const tab = p.tab || 'all';
  mount(`<div class="page">${header('ประวัติการสื่อสาร')}
    <div class="tabs"><button data-t="all" class="${tab === 'all' ? 'on' : ''}">ทั้งหมด</button><button data-t="talk" class="${tab === 'talk' ? 'on' : ''}">เสียง (PTT)</button><button data-t="text" class="${tab === 'text' ? 'on' : ''}">ข้อความ</button></div>
    <div class="scroll" id="hl"><div class="empty">กำลังโหลด…</div></div></div>`, root => {
    bindBack(root);
    for (const b of $$('[data-t]', root)) b.onclick = () => go('history', { tab: b.dataset.t }, true);
  });
  if (!has('history')) { $('hl').innerHTML = '<div class="empty">ประวัติย้อนหลังใช้ได้เมื่อใช้เซิร์ฟเวอร์ Cloudflare</div>'; return; }
  let rows = [];
  try { rows = await api(`/api/history?days=30${tab === 'all' ? '' : '&kind=' + tab}`); } catch (e) { $('hl').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (!$('hl')) return;
  const today = new Date().toDateString(), yest = new Date(Date.now() - 864e5).toDateString();
  let html = '', lastDay = '';
  for (const r of rows) {
    const d = new Date(r.ts).toDateString();
    if (d !== lastDay) { lastDay = d; html += `<div class="sec">${d === today ? `วันนี้ (${fmtDate(r.ts)})` : d === yest ? `เมื่อวาน (${fmtDate(r.ts)})` : fmtDate(r.ts)}</div>`; }
    const can = r.audio && S.config.recording;
    html += `<div class="hrow"><span class="ic">${icon(r.kind === 'talk' ? 'mic' : 'chat')}</span>
      <div class="grow"><div class="t1 ell">${esc(r.name)}${r.dept ? ` (${esc(r.dept)})` : ''}</div>
      <div class="t2 ell">${fmtTime(r.ts)} • ${r.kind === 'talk' ? fmtDur(r.ms) : esc(r.text)} · ${esc(r.channel)}</div></div>
      ${r.kind === 'talk' ? `<button class="playbtn" data-play="${can ? r.id : ''}" aria-label="ฟังเสียง" ${can ? '' : 'disabled'}>${icon('play')}</button>` : ''}</div>`;
  }
  $('hl').innerHTML = html || '<div class="empty">ยังไม่มีประวัติ</div>';
};

// ---------------------------------------------------------------- 09 factory map
let leafletP = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  return leafletP || (leafletP = new Promise((res, rej) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'; document.head.appendChild(css);
    const js = document.createElement('script'); js.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    js.onload = () => res(window.L); js.onerror = () => { leafletP = null; rej(new Error('โหลดแผนที่ไม่ได้ ตรวจสอบอินเทอร์เน็ต')); };
    document.head.appendChild(js);
  }));
}
const MAP_HOME = [16.56, 104.75];   // until the phone's GPS answers
ROUTES.map = async p => {
  const admin = S.user && S.user.role === 'admin';
  mount(`<div class="page">${header('แผนที่โรงงาน', '', admin ? `<button class="ib" id="mapEdit" aria-label="แก้ไขจุดบนแผนที่">${icon('edit')}</button>` : '')}
    <div class="gmap" id="gmap"><div class="empty">กำลังโหลดแผนที่…</div></div>
    <div class="gmapbar">
      <button class="btn sm primary" id="gMe" type="button">${icon('pin')}ตำแหน่งฉัน</button>
      <button class="btn sm" id="gLayer" type="button">${icon('map')}<span id="gLayerT"></span></button>
      ${admin ? `<button class="btn sm hidden" id="gAdd" type="button">${icon('plus')}เพิ่มจุดที่ตำแหน่งฉัน</button>` : ''}
    </div>
    <div class="gmapinfo" id="gInfo" aria-live="polite"></div></div>`, root => bindBack(root));
  let L, data, sosRows = [];
  try { [L, data] = await Promise.all([loadLeaflet(), api('/api/map')]); } catch (e) { const g = $('gmap'); if (g) g.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  try { sosRows = (await api('/api/sos')).filter(x => x.status === 'open' && x.lat != null); } catch {}
  const el = $('gmap'); if (!el || S.route !== 'map') return;
  el.innerHTML = '';
  const map = L.map(el, { zoomControl: true, attributionControl: true }).setView(MAP_HOME, 6);
  const layers = {
    sat: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'ภาพถ่าย © Esri' }),
    osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }),
  };
  let layer = lsGet('walkie_map_layer') === 'osm' ? 'osm' : 'sat';
  const setLayer = k => { for (const v of Object.values(layers)) map.removeLayer(v); layers[k].addTo(map); layer = k; lsSet('walkie_map_layer', k); $('gLayerT').textContent = k === 'sat' ? 'แผนที่ถนน' : 'ภาพดาวเทียม'; };
  setLayer(layer);
  $('gLayer').onclick = () => setLayer(layer === 'sat' ? 'osm' : 'sat');

  let editing = false, placing = null, me = null, meDot = null, meAcc = null, first = true;
  const info = h => { const i = $('gInfo'); if (i) i.innerHTML = h; };
  const pinLayer = L.layerGroup().addTo(map);
  const pinIcon = (pin, cls = '') => L.divIcon({ className: 'gpin-wrap', iconSize: null, iconAnchor: [18, 18],
    html: `<span class="gpin ${cls}"><span class="ic c-${esc(pin.color || 'blue')}">${icon(CH_ICON[pin.icon] || 'pin')}</span>${esc(pin.name)}</span>` });
  const draw = () => {
    pinLayer.clearLayers();
    for (const pin of data.pins.filter(x => x.lat != null && x.lng != null)) {
      const mk = L.marker([pin.lat, pin.lng], { icon: pinIcon(pin), draggable: editing, keyboard: true, title: pin.name }).addTo(pinLayer);
      mk.on('click', () => (editing ? pinEditor(pin, data, draw) : pinSheet(pin)));
      mk.on('dragend', async () => { const ll = mk.getLatLng(); pin.lat = ll.lat; pin.lng = ll.lng; try { await api(`/api/map/pins/${pin.id}`, { method: 'PATCH', body: pin }); toast('ย้ายจุดแล้ว'); } catch (e) { toast(e.message); } });
    }
    for (const x of sosRows) {
      L.marker([x.lat, x.lng], { icon: L.divIcon({ className: 'gpin-wrap', iconSize: null, iconAnchor: [18, 18], html: `<span class="gpin sos"><span class="ic" style="background:#d81e1e">${icon('siren')}</span>เหตุฉุกเฉิน · ${esc(x.reporter)}</span>` }), zIndexOffset: 1000 })
        .addTo(pinLayer).on('click', () => sheet(`<h3 style="color:var(--talk-fg)">🚨 เหตุฉุกเฉิน</h3><p>แจ้งโดย <b>${esc(x.reporter)}</b>${x.reporter_dept ? ' (' + esc(x.reporter_dept) + ')' : ''}<br>${fmtTime(x.ts)} น.${x.place ? ' · ' + esc(x.place) : ''}</p>
          <button class="btn primary" id="sNav">${icon('pin')}นำทางไปจุดเกิดเหตุ</button>`, () => { $('sNav').onclick = () => window.open(`https://www.google.com/maps/dir/?api=1&destination=${x.lat},${x.lng}`, '_blank'); }));
    }
    const unplaced = data.pins.filter(x => x.lat == null || x.lng == null);
    if (editing) info(placing ? `แตะบนแผนที่เพื่อวาง “${esc(placing.name)}” <button class="btn sm" id="gCancel" type="button">ยกเลิก</button>`
      : `โหมดแก้ไข: แตะแผนที่เพื่อเพิ่มจุด · ลากหมุดเพื่อย้าย · แตะหมุดเพื่อแก้ไข${unplaced.length ? `<br>ยังไม่ได้วางบนแผนที่: ${unplaced.map(x => `<button class="chip" data-place="${x.id}" type="button">${esc(x.name)}</button>`).join(' ')}` : ''}`);
    else if (!data.pins.some(x => x.lat != null)) info(admin ? 'ยังไม่มีจุดบนแผนที่ กด ✎ มุมขวาบนเพื่อเพิ่มจุดสำคัญ (เช่น จุดรวมพล)' : '');
    for (const b of $$('[data-place]')) b.onclick = () => { placing = data.pins.find(x => x.id === Number(b.dataset.place)); draw(); };
    const c = $('gCancel'); if (c) c.onclick = () => { placing = null; draw(); };
  };
  draw();

  map.on('click', e => {
    if (!editing) return;
    if (placing) {
      const pin = placing; placing = null; pin.lat = e.latlng.lat; pin.lng = e.latlng.lng;
      api(`/api/map/pins/${pin.id}`, { method: 'PATCH', body: pin }).then(() => { toast('วางจุดแล้ว'); draw(); }).catch(er => toast(er.message));
      return;
    }
    pinEditor({ name: '', icon: 'pin', color: 'blue', x: 50, y: 50, note: '', channel_id: null, lat: e.latlng.lat, lng: e.latlng.lng }, data, draw);
  });
  if (admin) {
    $('mapEdit').onclick = () => { editing = !editing; placing = null; $('gAdd').classList.toggle('hidden', !editing); $('mapEdit').classList.toggle('on', editing); draw(); };
    $('gAdd').onclick = () => {
      if (!me) return toast('ยังไม่ได้ตำแหน่ง GPS ของเครื่องนี้');
      pinEditor({ name: '', icon: 'pin', color: 'blue', x: 50, y: 50, note: '', channel_id: null, lat: me.latitude, lng: me.longitude }, data, draw);
    };
  }

  // the phone's own GPS position
  const focusSos = p.sos && sosRows.find(x => String(x.id) === String(p.sos));
  if (focusSos) { map.setView([focusSos.lat, focusSos.lng], 18); first = false; }
  else { const pts = data.pins.filter(x => x.lat != null).map(x => [x.lat, x.lng]); if (pts.length) { map.fitBounds(pts, { padding: [40, 40], maxZoom: 17 }); } }
  $('gMe').onclick = () => { if (me) map.setView([me.latitude, me.longitude], Math.max(map.getZoom(), 17)); else toast('กำลังหาตำแหน่ง… ตรวจว่าเปิด GPS และอนุญาตตำแหน่งให้แอปแล้ว'); };
  if (!navigator.geolocation) return info('เครื่องนี้ไม่รองรับ GPS');
  const wid = navigator.geolocation.watchPosition(r => {
    if (S.route !== 'map' || !document.body.contains(el)) { navigator.geolocation.clearWatch(wid); map.remove(); return; }
    me = r.coords;
    const ll = [me.latitude, me.longitude];
    if (!meDot) {
      meAcc = L.circle(ll, { radius: me.accuracy, color: '#1d63d6', weight: 1, fillOpacity: .12 }).addTo(map);
      meDot = L.marker(ll, { icon: L.divIcon({ className: 'gpin-wrap', iconSize: null, iconAnchor: [11, 11], html: '<span class="gme" title="ตำแหน่งของฉัน"></span>' }), zIndexOffset: 900 }).addTo(map);
    } else { meDot.setLatLng(ll); meAcc.setLatLng(ll).setRadius(me.accuracy); }
    if (first) { first = false; map.setView(ll, 17); }
    if (!editing && !$('gInfo').innerHTML.includes('ยังไม่มีจุด')) info(`ตำแหน่งของคุณ: ${me.latitude.toFixed(5)}, ${me.longitude.toFixed(5)} (±${Math.round(me.accuracy)} ม.)`);
  }, e => info(e.code === 1 ? 'ยังไม่ได้อนุญาตตำแหน่ง: เปิด GPS แล้วอนุญาต "ตำแหน่ง" ให้แอปนี้ในการตั้งค่าเบราว์เซอร์' : 'หาตำแหน่ง GPS ไม่ได้ ลองออกไปที่โล่งหรือเปิด GPS'),
  { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
};
function pinSheet(p) {
  const ch = p.channel_name ? chanInfo(p.channel_name) : null;
  sheet(`<h3>${esc(p.name)}</h3>${p.note ? `<p class="muted">${esc(p.note)}</p>` : ''}
    ${ch ? `<div class="list"><div class="li">${chanIcon(ch)}<div class="grow"><div class="t1">${esc(ch.name)}</div><div class="t2">${S.counts[ch.name] || 0} คนออนไลน์</div></div></div></div>
    <button class="btn primary" id="pj">${icon('mic')}คุยกับทีมจุดนี้</button>` : ''}
    ${p.lat != null ? `<button class="btn" id="pnav" style="margin-top:10px">${icon('pin')}นำทางไปจุดนี้</button>` : ''}
    <button class="btn" id="ps" style="margin-top:10px;color:var(--talk-fg)">${icon('siren')}แจ้งเหตุที่จุดนี้</button>`, bg => {
    const j = bg.querySelector('#pj'); if (j) j.onclick = () => { closeSheet(); enterRoom(ch.name, 'ptt'); };
    const nv = bg.querySelector('#pnav'); if (nv) nv.onclick = () => window.open(`https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`, '_blank');
    bg.querySelector('#ps').onclick = () => { closeSheet(); go('sos', { place: p.name }); };
  });
}
function pinEditor(p, data, redraw) {
  const icons = ['pin', 'bolt', 'gear', 'box', 'tools', 'flask', 'shield', 'users', 'factory', 'truck', 'fire', 'drop'];
  const colors = ['blue', 'orange', 'green', 'purple', 'red', 'gold', 'teal', 'gray'];
  sheet(`<h3>${p.id ? 'แก้ไขจุด' : 'เพิ่มจุดบนแผนที่'}</h3>
    <label class="lbl">ชื่อจุด</label><div class="field plain"><input id="pn" value="${esc(p.name)}" maxlength="40" placeholder="เช่น ห้องควบคุม"></div>
    <label class="lbl">ไอคอน</label><div class="chips" id="pi">${icons.map(i => `<button data-v="${i}" class="${p.icon === i ? 'on' : ''}" aria-label="${i}">${icon(CH_ICON[i] || 'pin')}</button>`).join('')}</div>
    <label class="lbl">สี</label><div class="chips" id="pc">${colors.map(c => `<button data-v="${c}" class="${p.color === c ? 'on' : ''}"><span class="ic c-${c}" style="width:22px;height:22px;border-radius:50%"></span></button>`).join('')}</div>
    <label class="lbl">ห้องสื่อสารของจุดนี้</label><div class="field plain"><select id="pch"><option value="">— ไม่ระบุ —</option>${S.channels.map(c => `<option value="${c.id}" ${c.id === p.channel_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    <label class="lbl">หมายเหตุ</label><div class="field plain"><input id="pnote" value="${esc(p.note)}" maxlength="200"></div>
    <button class="btn primary" id="psave">บันทึก</button>${p.id ? `<button class="btn" id="pdel" style="margin-top:10px;color:var(--err-fg)">${icon('trash')}ลบจุดนี้</button>` : ''}`, bg => {
    for (const grp of ['pi', 'pc']) for (const b of $$(`#${grp} button`, bg)) b.onclick = () => { $$(`#${grp} button`, bg).forEach(x => x.classList.remove('on')); b.classList.add('on'); };
    bg.querySelector('#psave').onclick = async () => {
      const body = { ...p, name: $('pn').value.trim(), icon: bg.querySelector('#pi .on')?.dataset.v, color: bg.querySelector('#pc .on')?.dataset.v, channel_id: Number($('pch').value) || null, note: $('pnote').value.trim() };
      try {
        if (p.id) await api(`/api/map/pins/${p.id}`, { method: 'PATCH', body }); else await api('/api/map/pins', { method: 'POST', body });
        Object.assign(data, await api('/api/map')); closeSheet(); redraw();
      } catch (e) { toast(e.message); }
    };
    const d = bg.querySelector('#pdel');
    if (d) d.onclick = async () => { if (!confirm(`ลบจุด "${p.name}"?`)) return; try { await api(`/api/map/pins/${p.id}`, { method: 'DELETE' }); Object.assign(data, await api('/api/map')); closeSheet(); redraw(); } catch (e) { toast(e.message); } };
  });
}
function pickImage(maxSide, cb, quality = 0.85, opts = {}) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
  if (opts.camera) inp.setAttribute('capture', 'user');
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'), g = c.getContext('2d');
      if (opts.square) {                       // centre crop for profile photos
        const side = Math.min(img.width, img.height), out = Math.min(maxSide, side);
        c.width = c.height = out;
        g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, out, out);
      } else {
        const k = Math.min(1, maxSide / Math.max(img.width, img.height));
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        g.drawImage(img, 0, 0, c.width, c.height);
      }
      cb(c.toDataURL('image/jpeg', quality)); URL.revokeObjectURL(img.src);
    };
    img.onerror = () => toast('เปิดไฟล์รูปไม่ได้');
    img.src = URL.createObjectURL(f);
  };
  inp.click();
}

// ---------------------------------------------------------------- 10 my tasks
ROUTES.tasks = async p => {
  const tab = p.tab || 'today', lead = S.user && ['lead', 'admin'].includes(S.user.role);
  mount(`<div class="page">${header('งานของฉัน')}
    <div class="tabs"><button data-t="today" class="${tab === 'today' ? 'on' : ''}">วันนี้ <span id="tc"></span></button><button data-t="all" class="${tab === 'all' ? 'on' : ''}">ทั้งหมด</button>${lead ? `<button data-t="assigned" class="${tab === 'assigned' ? 'on' : ''}">ที่มอบหมาย</button>` : ''}</div>
    <div class="scroll" id="tl" style="padding-bottom:${lead ? 90 : 10}px"><div class="empty">กำลังโหลด…</div></div>
    ${lead ? `<button class="btn primary fab" id="newTask">${icon('plus')}มอบหมายงาน</button>` : ''}</div>`, root => {
    bindBack(root);
    for (const b of $$('[data-t]', root)) b.onclick = () => go('tasks', { tab: b.dataset.t }, true);
    if (lead) $('newTask').onclick = taskForm;
  });
  let rows = [];
  try { rows = await api(`/api/tasks?scope=${tab}&dayStart=${new Date().setHours(0, 0, 0, 0)}`); } catch (e) { $('tl') && ($('tl').innerHTML = `<div class="empty">${esc(e.message)}</div>`); return; }
  if (!$('tl')) return;
  if (tab === 'today') $('tc').textContent = rows.filter(t => !t.done_at).length || '';
  $('tl').innerHTML = rows.length ? rows.map(t => {
    const late = !t.done_at && t.due_at && t.due_at < Date.now();
    const due = t.done_at ? `เสร็จแล้ว ${fmtTime(t.done_at)} น.` : t.due_at ? `${late ? 'เลยกำหนด · ' : ''}ก่อน ${fmtTime(t.due_at)} น.${new Date(t.due_at).toDateString() !== new Date().toDateString() ? ' ' + fmtDate(t.due_at) : ''}` : 'ไม่กำหนดเวลา';
    const who = tab === 'assigned' ? `ผู้รับ: ${esc(t.assignee_name)}` : `มอบโดย ${esc(t.creator_name)}`;
    return `<label class="task ${t.done_at ? 'done' : ''}"><input type="checkbox" data-task="${t.id}" ${t.done_at ? 'checked' : ''} aria-label="${esc(t.title)} เสร็จแล้ว">
      <div class="grow"><div class="t1">${esc(t.title)}</div>${t.detail ? `<div class="small muted">${esc(t.detail)}</div>` : ''}<div class="due">${due}</div><div class="small muted">${who}</div></div>
      ${tab === 'assigned' ? `<button class="ib" data-del="${t.id}" aria-label="ลบงาน" style="color:var(--err-fg)">${icon('trash')}</button>` : ''}</label>`;
  }).join('') : `<div class="empty">${tab === 'assigned' ? 'ยังไม่ได้มอบหมายงาน' : 'ไม่มีงานค้าง 🎉'}</div>`;
  for (const c of $$('[data-task]')) c.onchange = async () => {
    try { await api(`/api/tasks/${c.dataset.task}`, { method: 'PATCH', body: { done: c.checked } }); S.openTasks += c.checked ? -1 : 1; renderBadges(); render(); } catch (e) { toast(e.message); c.checked = !c.checked; }
  };
  for (const d of $$('[data-del]')) d.onclick = async e => { e.preventDefault(); if (!confirm('ลบงานนี้?')) return; try { await api(`/api/tasks/${d.dataset.del}`, { method: 'DELETE' }); render(); } catch (er) { toast(er.message); } };
};
async function taskForm() {
  let users = [];
  try { users = await api('/api/users'); } catch {}
  const now = new Date(Date.now() + 2 * 3600e3); now.setMinutes(0, 0, 0);
  const local = new Date(now - now.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  sheet(`<h3>มอบหมายงาน</h3>
    <label class="lbl">ชื่องาน</label><div class="field plain"><input id="tt" maxlength="120" placeholder="เช่น ตรวจสอบอุณหภูมิ Boiler"></div>
    <label class="lbl">รายละเอียด</label><div class="field plain"><textarea id="td" maxlength="500"></textarea></div>
    <label class="lbl">ทำให้เสร็จก่อน</label><div class="field plain"><input id="tdue" type="datetime-local" value="${local}"></div>
    <label class="lbl">มอบให้ทั้งช่อง (ทุกคนที่มีช่องนี้เป็นช่องหลัก)</label><div class="field plain"><select id="tch"><option value="">— ไม่ใช้ —</option>${S.channels.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
    <label class="lbl">หรือเลือกเป็นรายคน</label><div class="search" style="margin:12px 0 6px">${icon('search')}<input id="tq" placeholder="ค้นหาชื่อ..."></div>
    <div class="list" id="tus" style="margin:0 0 12px;max-height:220px;overflow:auto"></div>
    <div class="err" id="terr"></div><button class="btn primary" id="tsave">มอบหมายงาน</button>`, bg => {
    const picked = new Set();
    const draw = () => {
      const q = $('tq').value.trim().toLowerCase();
      $('tus').innerHTML = users.filter(u => !q || `${u.name} ${u.dept}`.toLowerCase().includes(q)).map(u => `<label class="li"><input type="checkbox" data-u="${u.id}" ${picked.has(u.id) ? 'checked' : ''} style="width:22px;height:22px">${avatar(u)}<div class="grow"><div class="t1 ell">${esc(u.name)}</div><div class="t2">${esc(u.dept)}</div></div></label>`).join('');
      for (const c of $$('[data-u]', bg)) c.onchange = () => c.checked ? picked.add(Number(c.dataset.u)) : picked.delete(Number(c.dataset.u));
      loadAvatars($('tus'));
    };
    $('tq').oninput = draw; draw();
    $('tsave').onclick = async () => {
      const title = $('tt').value.trim();
      if (!title) return ($('terr').textContent = 'กรุณาใส่ชื่องาน');
      if (!picked.size && !$('tch').value) return ($('terr').textContent = 'กรุณาเลือกผู้รับงาน');
      try {
        const r = await api('/api/tasks', { method: 'POST', body: { title, detail: $('td').value.trim(), due_at: $('tdue').value ? new Date($('tdue').value).getTime() : null, assignee_ids: [...picked], channel_id: Number($('tch').value) || null } });
        closeSheet(); toast(`มอบหมายงานให้ ${r.count} คนแล้ว`); go('tasks', { tab: 'assigned' }, true);
      } catch (e) { $('terr').textContent = e.message; }
    };
  });
}

// ---------------------------------------------------------------- 11 SOS
ROUTES.sos = p => {
  const me = S.user || { name: S.profile.name, dept: S.profile.dept };
  let pos = null;
  mount(`<div class="sospage">
    <div class="soshead"><button class="ib back" data-back aria-label="กลับ">${icon('back')}</button><h1>แจ้งเหตุฉุกเฉิน</h1>
      <div style="margin-top:8px;font-size:16px;line-height:1.5">กดค้างปุ่มด้านล่าง 1 วินาที<br><b>ทุกเครื่องที่เข้าสู่ระบบจะมีเสียงเตือนทันที</b><br>พร้อมแสดงชื่อคนแจ้งและตำแหน่ง</div></div>
    <div class="sosone">
      <button class="sosring" id="sosHold" type="button" aria-label="กดค้าง 1 วินาทีเพื่อแจ้งเหตุฉุกเฉิน">
        <span class="fill" id="sosFill"></span>
        <span class="in"><svg class="i"><use href="#i-siren"/></svg><b>กดค้าง</b><small>1 วินาที เพื่อแจ้งเหตุ</small></span></button>
      <div class="sosme">ผู้แจ้ง: <b>${esc(me.name || '')}</b>${me.dept ? ` (${esc(me.dept)})` : ''}<br><span id="gpsInfo">${icon('pin')} กำลังหาตำแหน่ง GPS…</span></div>
      <div class="field plain" style="margin:0 18px;align-self:stretch"><input id="sp" maxlength="120" placeholder="จุดเกิดเหตุ (ไม่ใส่ก็ได้) เช่น อาคารหม้อต้ม" value="${esc(p.place || '')}"></div>
      <div class="err" id="serr" role="alert" style="text-align:center"></div>
    </div>
    <div class="sec">เหตุล่าสุด</div><div id="sosList"><div class="empty">กำลังโหลด…</div></div><div style="height:20px"></div></div>`, root => {
    bindBack(root);
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition(r => {
      pos = r.coords; const g = $('gpsInfo'); if (g) g.innerHTML = `${icon('pin')} ส่งพิกัด GPS ไปด้วย (แม่นยำ ±${Math.round(r.coords.accuracy)} ม.)`;
    }, () => { const g = $('gpsInfo'); if (g) g.innerHTML = `${icon('pin')} ไม่ได้รับตำแหน่ง GPS (ยังแจ้งเหตุได้ตามปกติ)`; }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
    const btn = $('sosHold'), fill = $('sosFill');
    let t = null, busy = false;
    const reset = () => { clearTimeout(t); fill.style.transition = 'transform .2s'; fill.style.transform = 'scale(0)'; btn.classList.remove('hold'); };
    const fire = async () => {
      if (busy) return; busy = true; reset();
      btn.classList.add('sent'); btn.querySelector('.in').innerHTML = '<b>กำลังแจ้งเหตุ…</b>';
      try {
        const r = await api('/api/sos', { method: 'POST', body: { place: $('sp').value.trim(), lat: pos ? pos.latitude : null, lng: pos ? pos.longitude : null } });
        vibrate([200, 100, 200]);
        btn.querySelector('.in').innerHTML = `<svg class="i"><use href="#i-check"/></svg><b>แจ้งเหตุแล้ว</b><small>เสียงเตือนดังที่ ${r.delivered} เครื่อง</small>`;
        toast(`แจ้งเหตุแล้ว เสียงเตือนดังที่ ${r.delivered} เครื่องที่เข้าสู่ระบบอยู่`);
        renderSosList();
        setTimeout(() => { busy = false; btn.classList.remove('sent'); const i = btn.querySelector('.in'); if (i) i.innerHTML = '<svg class="i"><use href="#i-siren"/></svg><b>กดค้าง</b><small>1 วินาที เพื่อแจ้งเหตุ</small>'; }, 8000);
      } catch (e) {
        busy = false; btn.classList.remove('sent'); $('serr').textContent = e.message;
        btn.querySelector('.in').innerHTML = '<svg class="i"><use href="#i-siren"/></svg><b>กดค้าง</b><small>1 วินาที เพื่อแจ้งเหตุ</small>';
      }
    };
    btn.onpointerdown = e => {
      if (busy) return; e.preventDefault(); btn.classList.add('hold');
      fill.style.transition = 'transform 1s linear'; fill.style.transform = 'scale(1)';
      t = setTimeout(fire, 1000);
    };
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, () => { if (!busy) reset(); });
    btn.oncontextmenu = e => e.preventDefault();
    btn.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && confirm('แจ้งเหตุฉุกเฉิน? ทุกเครื่องจะมีเสียงเตือน')) { e.preventDefault(); fire(); } };
  });
  renderSosList();
};
async function renderSosList() {
  const el = $('sosList'); if (!el || !ACC()) return;
  let rows = [];
  try { rows = await api('/api/sos'); } catch { return; }
  const lead = S.user && ['lead', 'admin'].includes(S.user.role);
  el.innerHTML = rows.length ? `<div class="list">${rows.map(s => {
    const [n, ic, c] = SOS[s.kind] || SOS.other;
    return `<div class="li"><span class="ic" style="background:${c}">${icon(ic)}</span><div class="grow"><div class="t1">${s.kind === 'general' ? 'แจ้งโดย ' + esc(s.reporter) : n}${s.place ? ` · ${esc(s.place)}` : ''}</div>
      <div class="t2">${esc(s.reporter)} · ${fmtTime(s.ts)} ${fmtDate(s.ts)} · รับทราบ ${s.acks} คน</div></div>
      ${s.status === 'open' ? (lead ? `<button class="btn sm" data-close="${s.id}">ปิดเหตุ</button>` : '<span class="pill talk">กำลังดำเนินการ</span>') : '<span class="pill gray">ปิดแล้ว</span>'}</div>`;
  }).join('')}</div>` : '<div class="empty">ยังไม่มีการแจ้งเหตุ</div>';
  for (const b of $$('[data-close]', el)) b.onclick = async () => { if (!confirm('ปิดเหตุนี้ (สถานการณ์ปลอดภัยแล้ว)?')) return; try { await api(`/api/sos/${b.dataset.close}/close`, { method: 'POST' }); renderSosList(); } catch (e) { toast(e.message); } };
}

// ---------------------------------------------------------------- 12 notifications
ROUTES.notifications = async p => {
  const tab = p.tab || 'all';
  mount(`<div class="page">${header('การแจ้งเตือน')}<div class="tabs"><button data-t="all" class="${tab === 'all' ? 'on' : ''}">ทั้งหมด</button><button data-t="unread" class="${tab === 'unread' ? 'on' : ''}">ยังไม่อ่าน</button></div>
    <div class="scroll"><div class="list ntf" id="nl"><div class="empty">กำลังโหลด…</div></div></div></div>`, root => {
    bindBack(root);
    for (const b of $$('[data-t]', root)) b.onclick = () => go('notifications', { tab: b.dataset.t }, true);
  });
  let server = [];
  if (ACC()) { try { server = await api('/api/notifications'); } catch {} }
  const KIND = { sos: ['siren', '#cf2020'], task: ['task', '#6d3fd8'], system: ['info', '#1d63d6'], msg: ['chat', '#178a44'], talk: ['mic', '#0b7f80'] };
  const items = [
    ...server.map(n => ({ ts: n.ts, kind: n.kind, title: n.title, body: n.body, read: n.read, ref: n.ref })),
    ...S.msgAlerts.map(a => ({ ts: a.ts, kind: a.kind === 'talk' ? 'talk' : 'msg', title: `${a.channel}`, body: `${a.name}: ${a.kind === 'talk' ? 'พูด ' + fmtDur(a.ms) : a.text}`, read: a.read, ch: a.channel })),
  ].sort((a, b) => b.ts - a.ts).filter(n => tab === 'all' || !n.read);
  if (!$('nl')) return;
  $('nl').innerHTML = items.length ? items.map((n, i) => { const [ic, c] = KIND[n.kind] || KIND.system; return `<button class="li" data-i="${i}"><span class="ic" style="background:${c}">${icon(ic)}</span>
    <div class="grow"><div class="t1">${esc(n.title)}</div><div class="t2 ell">${esc(n.body)}</div></div><div style="text-align:right"><div class="small muted">${fmtTime(n.ts)}</div>${n.read ? '' : '<span class="pill new">ใหม่</span>'}</div></button>`; }).join('')
    : '<div class="empty">ไม่มีการแจ้งเตือน</div>';
  for (const b of $$('[data-i]', $('nl'))) b.onclick = () => {
    const n = items[Number(b.dataset.i)];
    if (n.ch) openChatFor(n.ch); else if (n.kind === 'sos') go('sos'); else if (n.kind === 'task') go('tasks');
  };
  if (ACC()) { api('/api/notifications/read', { method: 'POST' }).then(() => { S.unread = 0; renderBadges(); }).catch(() => {}); }
  S.msgAlerts.forEach(a => (a.read = true)); lsSet('walkie_alerts', JSON.stringify(S.msgAlerts)); renderBadges();
};

// ---------------------------------------------------------------- 13 profile
/** change profile photo: take a photo, choose from the gallery, or remove it — preview before saving */
function changeAvatar() {
  if (!S.user) return toast('ใช้ได้เมื่อเข้าสู่ระบบด้วยบัญชีพนักงาน');
  const u = S.user;
  const save = async url => {
    try {
      await api('/api/me', { method: 'PATCH', body: { avatar: url } });
      if (url) { avCache.set(u.id, url); S.user.has_avatar = 1; } else { avCache.delete(u.id); S.user.has_avatar = 0; }
      lsSet('walkie_user', JSON.stringify(S.user)); closeSheet(); render(); toast(url ? 'เปลี่ยนรูปโปรไฟล์แล้ว' : 'ลบรูปโปรไฟล์แล้ว');
    } catch (e) { toast(e.message); }
  };
  const preview = url => sheet(`<h3 style="text-align:center">รูปโปรไฟล์ใหม่</h3>
    <div style="display:flex;justify-content:center;margin:8px 0 16px"><img src="${url}" alt="ตัวอย่างรูปโปรไฟล์" style="width:180px;height:180px;border-radius:50%;object-fit:cover;border:4px solid var(--primary-soft)"></div>
    <button class="btn primary" type="button" id="avSave">${icon('check')}ใช้รูปนี้</button>
    <button class="btn" type="button" id="avAgain" style="margin-top:10px">เลือกรูปใหม่</button>`, () => {
    $('avSave').onclick = () => { $('avSave').disabled = true; save(url); };
    $('avAgain').onclick = changeAvatar;
  });
  const pick = camera => pickImage(320, preview, 0.85, { square: true, camera });
  sheet(`<h3>เปลี่ยนรูปโปรไฟล์</h3>
    <div style="display:flex;justify-content:center;margin:4px 0 14px">${avatar(u, 'av')}</div>
    <div class="list" style="margin:0">
      <button class="li" type="button" id="avCam"><span class="ic" style="background:var(--primary-soft);color:var(--primary-fg)">${icon('camera')}</span><div class="grow t1">ถ่ายรูป</div></button>
      <button class="li" type="button" id="avGal"><span class="ic" style="background:var(--primary-soft);color:var(--primary-fg)">${icon('user')}</span><div class="grow t1">เลือกจากคลังภาพ</div></button>
      ${u.has_avatar ? `<button class="li" type="button" id="avDel"><span class="ic" style="background:var(--panel-2);color:var(--err-fg)">${icon('trash')}</span><div class="grow t1" style="color:var(--err-fg)">ลบรูปโปรไฟล์</div></button>` : ''}
    </div>`, bg => {
    $('avCam').onclick = () => pick(true);
    $('avGal').onclick = () => pick(false);
    const d = $('avDel'); if (d) d.onclick = () => { if (confirm('ลบรูปโปรไฟล์?')) save(null); };
    loadAvatars(bg);
  });
}
ROUTES.profile = () => {
  const u = S.user;
  if (!u) return mount(`<div class="page">${header('ข้อมูลผู้ใช้')}<div class="empty">${esc(S.profile.name)} · ${esc(S.profile.dept)}</div></div>`, r => bindBack(r));
  mount(`<div class="page">${header('ข้อมูลผู้ใช้')}<div class="scroll">
    <div class="prof"><div class="bigav">${avatar(u)}<button class="cam" id="cam" aria-label="เปลี่ยนรูปโปรไฟล์">${icon('camera')}</button></div>
      <button class="btn sm" type="button" id="cam2" style="margin:10px auto 0">${icon('camera')}เปลี่ยนรูปโปรไฟล์</button>
      <h2>${esc(u.name)}</h2><div class="muted">รหัสพนักงาน : ${esc(u.emp)}</div><div data-conn style="display:flex;justify-content:center;align-items:center;gap:6px;color:var(--ok-fg);margin-top:4px"></div></div>
    <div class="list kv">${kv('building', 'แผนก', u.dept)}${kv('brief', 'ตำแหน่ง', u.position)}${kv('antenna', 'ช่องหลัก', u.main_channel_name)}${kv('shield', 'สิทธิ์การใช้งาน', ROLE_NAME[u.role])}</div>
    <div class="list"><button class="li" id="chpw"><span class="ic" style="background:var(--primary-soft);color:var(--primary-fg)">${icon('lock')}</span><div class="grow t1">เปลี่ยนรหัสผ่าน</div><span class="chev">${icon('chev')}</span></button></div>
  </div></div>`, root => {
    bindBack(root, 'settings'); setConn(S.conn);
    $('cam').onclick = $('cam2').onclick = changeAvatar;
    const big = root.querySelector('.bigav .av'); if (big) { big.style.cursor = 'pointer'; big.onclick = changeAvatar; }
    $('chpw').onclick = () => sheet(`<h3>เปลี่ยนรหัสผ่าน</h3>
      <div class="field">${icon('lock', 'i lead')}<input id="op" type="password" placeholder="รหัสผ่านเดิม" autocomplete="current-password"></div>
      <div class="field">${icon('lock', 'i lead')}<input id="np" type="password" placeholder="รหัสผ่านใหม่ (อย่างน้อย 6 ตัว)" autocomplete="new-password"></div>
      <div class="err" id="perr"></div><button class="btn primary" id="psave">บันทึก</button>`, bg => {
      bg.querySelector('#psave').onclick = async () => {
        try { await api('/api/me/password', { method: 'POST', body: { old: $('op').value, new: $('np').value } }); closeSheet(); toast('เปลี่ยนรหัสผ่านแล้ว'); }
        catch (e) { $('perr').textContent = e.message; }
      };
    });
  });
};

// ---------------------------------------------------------------- 14 audio settings
function savePrefs() { lsSet('walkie_prefs', JSON.stringify(S.prefs)); }
ROUTES.audio = () => {
  const pr = { ...S.prefs };
  mount(`<div class="page">${header('ตั้งค่าเสียง')}<div class="scroll">
    <div class="list">
      <label class="setrow">${icon('bell', 'i lead')}<div class="grow"><b>เสียงแจ้งเตือน</b><small>เสียงบี๊บตอนเริ่ม/จบการพูด</small></div><input type="checkbox" class="sw" id="pBeep" ${pr.beep ? 'checked' : ''}></label>
      <label class="setrow web-only">${icon('wave', 'i lead')}<div class="grow"><b>Noise Cancellation</b><small>ลดเสียงรบกวนจากเครื่องจักร</small></div><input type="checkbox" class="sw" id="pNc" ${pr.nc ? 'checked' : ''}></label>
      <div class="setrow web-only" style="flex-wrap:wrap">${icon('volume', 'i lead')}<div class="grow"><b>ระดับเสียง (<span id="volV">${pr.volume}</span>%)</b></div>
        <input type="range" id="pVol" min="0" max="100" step="5" value="${pr.volume}" aria-label="ระดับเสียง" style="flex-basis:100%"></div>
      <div class="setrow">${icon('mic', 'i lead')}<div class="grow"><b>โหมด Push to Talk</b><small id="modeTxt"></small></div></div>
      <div style="padding:0 16px 16px" class="chips" id="pMode"><button data-v="hold" class="${pr.mode === 'hold' ? 'on' : ''}">กดค้างเพื่อพูด (Hold to Talk)</button><button data-v="toggle" class="${pr.mode === 'toggle' ? 'on' : ''}">แตะเพื่อเริ่ม/จบ</button></div>
    </div>
    <div class="list native-only">
      <label class="setrow">${icon('headset', 'i lead')}<div class="grow"><b>ปุ่มหูฟังเป็นปุ่มกดพูด</b><small>กดค้าง = พูด · กดสั้น = เริ่ม, กดอีกครั้ง = จบ</small></div><input type="checkbox" class="sw" id="optHeadset"></label>
      <label class="setrow">${icon('radio', 'i lead')}<div class="grow"><b>ปุ่ม PTT มือถือ rugged</b><small>Samsung XCover, Sonim ฯลฯ</small></div><input type="checkbox" class="sw" id="optRugged"></label>
    </div>
    <div class="pad"><button class="btn primary" id="pSave">บันทึกการตั้งค่า</button></div></div></div>`, root => {
    bindBack(root, 'settings');
    const modeTxt = () => { $('modeTxt').innerHTML = `${pr.mode === 'hold' ? 'กดค้างเพื่อพูด (Hold to Talk)' : 'แตะครั้งเดียวเริ่มพูด แตะอีกครั้งจบ'} <span class="pill ok">ใช้งานอยู่</span>`; };
    modeTxt();
    $('pVol').oninput = () => { $('volV').textContent = $('pVol').value; };
    for (const b of $$('#pMode button', root)) b.onclick = () => { pr.mode = b.dataset.v; $$('#pMode button', root).forEach(x => x.classList.toggle('on', x === b)); modeTxt(); };
    if (NATIVE) WN.getDeviceStatus().then(d => { $('optHeadset').checked = !!d.options.headsetPtt; $('optRugged').checked = !!d.options.ruggedPtt; }).catch(() => {});
    $('pSave').onclick = () => {
      const ncChanged = pr.nc !== $('pNc').checked;
      Object.assign(S.prefs, { beep: $('pBeep').checked, nc: $('pNc').checked, volume: Number($('pVol').value), mode: pr.mode });
      savePrefs(); applyVolume();
      if (ncChanged && processor) { micStream.getTracks().forEach(t => t.stop()); processor.disconnect(); processor = null; }   // re-open mic with new setting
      if (NATIVE) WN.setOptions({ headsetPtt: $('optHeadset').checked, ruggedPtt: $('optRugged').checked });
      toast('บันทึกการตั้งค่าแล้ว'); back('settings');
    };
  });
};

// ---------------------------------------------------------------- settings
ROUTES.settings = () => {
  const u = S.user || { name: S.profile.name, dept: S.profile.dept }, role = S.user?.role || 'user';
  const lead = ['lead', 'admin'].includes(role), admin = role === 'admin';
  const row = (id, ic, title, sub = '', right = icon('chev')) => `<button class="setrow" id="${id}" style="width:100%;background:none;border:0;border-bottom:1px solid var(--line-soft);text-align:left;color:var(--text)">${icon(ic, 'i lead')}<div class="grow"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</div><span class="chev" style="color:var(--primary-fg)">${right}</span></button>`;
  mount(`<div class="page">${header('ตั้งค่า')}<div class="scroll">
    <button class="card row" id="sProf" style="margin:14px;padding:14px;width:calc(100% - 28px);text-align:left;color:var(--text)">${avatar(S.user || u)}
      <div class="grow"><b style="font-size:19px">${esc(u.name)}</b><div class="small muted">${S.user ? `รหัส ${esc(S.user.emp)} · ` : ''}${esc(u.dept || '')}</div></div>${icon('chev')}</button>
    <div class="list">
      ${row('sInfo', 'user', 'ข้อมูลส่วนตัว')}
      ${S.user ? row('sPhoto', 'camera', 'เปลี่ยนรูปโปรไฟล์', 'ถ่ายรูป หรือเลือกจากคลังภาพ') : ''}
      ${row('sNotif', 'bell', 'การแจ้งเตือน', 'Notification' in window ? (Notification.permission === 'granted' ? 'เปิดอยู่' : Notification.permission === 'denied' ? 'ถูกปิดในเบราว์เซอร์' : 'แตะเพื่ออนุญาต') : 'เบราว์เซอร์ไม่รองรับ')}
      ${row('sAudio', 'headset', 'อุปกรณ์เสียง (PTT)')}
      ${row('sLang', 'globe', 'ภาษา', '', '<span class="small muted">ไทย</span>')}
      ${row('sTheme', curTheme() === 'dark' ? 'moon' : 'sun', 'ธีม', '', `<span class="small muted">${curTheme() === 'dark' ? 'กลางคืน (มืด)' : 'ภาคสนาม (สว่าง)'}</span>`)}
      <label class="setrow web-only">${icon('sun', 'i lead')}<div class="grow"><b>เปิดจอค้างไว้ระหว่างใช้งาน</b><small>ได้ยินเสียงแน่นอนที่สุดสำหรับเว็บแอป</small></div><input type="checkbox" class="sw" id="optWake" ${wakeOn() ? 'checked' : ''}></label>
      <label class="setrow">${icon('volume', 'i lead')}<div class="grow"><b>ได้ยินเสียงเมื่อพับ / ปิดแอป</b><small>${NATIVE ? 'เปิด = ได้ยินแม้พับแอป ปิดจอ หรือปัดปิดแอป · ปิด = เงียบเมื่อออกจากหน้าแอป' : IOS ? 'เปิด = ได้ยินขณะพับแอปชั่วครู่ (iPhone อาจหยุดเสียงเมื่อพับนาน)' : 'เปิด = ได้ยินเมื่อพับแอปหรือปิดจอ · ถ้าปัดปิดแอปทิ้ง ให้ใช้แอป Android'}</small></div><input type="checkbox" class="sw" id="optKeep" ${keepOn() ? 'checked' : ''}></label>
      ${!NATIVE && !standalone() ? row('sInstall', 'download', 'ติดตั้งแอปลงหน้าจอ', installEvt ? 'แตะเพื่อติดตั้ง ใช้งานเต็มจอเหมือนแอป' : IOS ? 'Safari: ปุ่มแชร์ > เพิ่มไปยังหน้าจอโฮม' : 'แตะเพื่อดูวิธีติดตั้ง') : ''}
      ${NATIVE ? row('sBatt', 'battery', 'ให้แอปทำงานตอนจอดับ', 'ปิดการประหยัดแบตเตอรี่') : ''}
    </div>
    <div class="list">
      ${row('sInvite', 'qr', 'เชิญเพื่อนร่วมทีม', 'แสดง QR ให้สแกนเปิดแอป')}
      ${row('sHist', 'history', 'ประวัติการสื่อสาร')}
      ${row('sMembers', 'team', 'สมาชิกทีมงาน')}
      ${lead ? row('sReport', 'chart', 'รายงานการใช้งาน') : ''}
      ${lead ? row('sLog', 'download', 'Log ละเอียด / ส่งออก CSV') : ''}
      ${admin ? row('sAdmin', 'settings', 'จัดการระบบ (Admin)', 'สมาชิก กลุ่ม สิทธิ์ ประกาศ') : ''}
    </div>
    <div class="list">
      ${row('sHelp', 'help', 'ช่วยเหลือ / คู่มือการใช้งาน')}
      ${row('sAbout', 'info', 'เกี่ยวกับแอป')}
      <button class="setrow" id="sOut" style="width:100%;background:none;border:0;text-align:left;color:var(--err-fg)">${icon('logout', 'i lead')}<div class="grow"><b>ออกจากระบบ</b></div></button>
    </div></div></div>`, root => {
    bindBack(root);
    const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    on('sProf', () => go('profile')); on('sPhoto', changeAvatar); on('sInfo', () => go('profile')); on('sAudio', () => go('audio'));
    on('sNotif', async () => { if ('Notification' in window && Notification.permission === 'default') { await Notification.requestPermission(); render(); } else if (NATIVE) WN.openAppSettings(); else toast('ตั้งค่าการแจ้งเตือนได้ที่การตั้งค่าเว็บไซต์ของเบราว์เซอร์'); });
    on('sLang', () => toast('ตอนนี้รองรับภาษาไทย'));
    on('sTheme', () => { applyTheme(curTheme() === 'dark' ? 'light' : 'dark', true); render(); });
    on('sInstall', doInstall); on('sBatt', () => WN.openBatterySettings());
    on('sInvite', invite); on('sHist', () => go('history')); on('sMembers', () => ACC() ? go('members') : toast('ใช้ได้เมื่อใช้เซิร์ฟเวอร์ Cloudflare'));
    on('sReport', () => go('report')); on('sLog', () => { location.href = (serverBase || '') + '/log.html'; }); on('sAdmin', () => go('admin'));
    on('sHelp', help); on('sAbout', about);
    on('sOut', () => { if (confirm('ออกจากระบบ?')) signOut(); });
    const w = $('optWake'); if (w) w.onchange = () => { lsSet('walkie_wake', w.checked ? '1' : '0'); setWake(w.checked); };
    const k = $('optKeep'); if (k) k.onchange = () => { lsSet('walkie_keep', k.checked ? '1' : '0'); setKeepAlive(k.checked); toast(k.checked ? 'ได้ยินเสียงเมื่อพับ / ปิดแอป: เปิด' : 'ได้ยินเสียงเมื่อพับ / ปิดแอป: ปิด (เงียบเมื่อออกจากหน้าแอป)'); };
  });
};
function help() {
  sheet(`<h3>ช่วยเหลือ / คู่มือ</h3><ul style="padding-left:20px;line-height:1.7;font-size:15px">
    <li><b>กดค้าง</b>ปุ่มสีส้มเพื่อพูด ปล่อยเพื่อจบ พูดได้ทีละคนต่อช่อง ครั้งละไม่เกิน 60 วินาที</li>
    <li>ปุ่ม <b style="color:var(--talk-fg)">สีแดง</b> = คุณกำลังพูด · <b style="color:var(--listen-fg)">สีเขียว</b> = กำลังรับฟัง</li>
    <li>เปลี่ยนช่อง: แตะการ์ด "ช่องสื่อสารปัจจุบัน" หรือเมนู "กลุ่ม"</li>
    <li>ข้อความ: พิมพ์แล้วกดส่ง หรือกดค้างปุ่มไมค์เพื่อพูด แตะ ▶ เพื่อฟังย้อนหลัง</li>
    <li><b>แจ้งเหตุฉุกเฉิน</b>: เลือกประเภท แล้วกดค้างปุ่มแดง 1 วินาที ทุกเครื่องจะมีเสียงไซเรน</li>
    <li>สร้างห้องเอง: เมนู <b>กลุ่ม</b> → <b>สร้างห้องใหม่</b> ตั้งรหัสห้องหรือไม่ก็ได้ ห้องที่มีรหัส คนอื่นต้องใส่รหัสครั้งแรกก่อนเข้า</li>
    <li class="web-only">ติดตั้งแอปลงหน้าจอ แล้วพับแอปไว้ได้ ยังได้ยินเสียงเพื่อน (Android) · iPhone ให้เปิดแอปค้างไว้</li></ul>
    ${!NATIVE && !standalone() ? '<button class="btn primary" type="button" id="hInstall">ติดตั้งแอปลงหน้าจอ</button>' : ''}`, () => { const b = $('hInstall'); if (b) b.onclick = doInstall; });
}
function about() {
  sheet(`<div style="text-align:center"><img class="appicon-img" src="brand/app-icon.png" alt="" style="width:84px;height:84px;margin:6px auto">
    <img class="wordmark-img" src="brand/wordmark.png" alt="WORMADI" style="margin:6px auto 0"><div class="muted">Walkie Talkie สำหรับทีมงานโรงงาน · เวอร์ชัน 2.1</div>
    <div style="margin:12px 0">${orgLogo()}</div><div style="font-weight:600">${esc(S.config.org)}</div>
    <p class="small muted">เสียงที่พูดถูกบันทึกเพื่อฟังย้อนหลัง ${S.config.recording ? 'และลบอัตโนมัติตามระยะเวลาที่กำหนด' : '(ยังไม่เปิดระบบบันทึกเสียง)'} · ข้อความและประวัติการใช้งานเก็บเพื่อความปลอดภัยของทีม</p></div>`);
}

// ---------------------------------------------------------------- 15 admin
ROUTES.admin = async p => {
  const tab = p.tab || 'users';
  mount(`<div class="page">${header('จัดการระบบ (Admin)')}
    <div class="admtabs"><button data-t="users" class="${tab === 'users' ? 'on' : ''}">${icon('team')}สมาชิก</button><button data-t="groups" class="${tab === 'groups' ? 'on' : ''}">${icon('users')}กลุ่ม</button><button data-t="roles" class="${tab === 'roles' ? 'on' : ''}">${icon('task')}สิทธิ์</button></div>
    ${tab !== 'roles' ? `<div class="search">${icon('search')}<input id="q" placeholder="${tab === 'users' ? 'ค้นหาพนักงาน...' : 'ค้นหากลุ่ม...'}"></div>` : ''}
    <div class="scroll" id="al" style="padding-bottom:90px"><div class="empty">กำลังโหลด…</div></div>
    ${tab !== 'roles' ? `<button class="btn accent fab" id="addBtn">${icon('plus')}${tab === 'users' ? 'เพิ่มพนักงาน' : 'เพิ่มกลุ่ม'}</button>` : `<button class="btn primary fab" id="annBtn">${icon('megaphone')}ประกาศถึงทุกคน</button>`}</div>`, root => {
    bindBack(root, 'settings');
    for (const b of $$('[data-t]', root)) b.onclick = () => go('admin', { tab: b.dataset.t }, true);
  });
  try {
    if (tab === 'groups') {
      const list = await api('/api/admin/channels');
      const draw = () => {
        const q = ($('q').value || '').toLowerCase();
        $('al').innerHTML = `<div class="list">${list.filter(c => !q || c.name.toLowerCase().includes(q)).map(c => `<button class="li" data-c="${c.id}" style="${c.active ? '' : 'opacity:.6'}">${chanIcon(c)}<div class="grow"><div class="t1 ell">${esc(c.name)}</div><div class="t2">${esc(c.sub || '')}${c.active ? '' : ' · ปิดใช้งาน'}</div></div><span class="chev">${icon('edit')}</span></button>`).join('')}</div>`;
        for (const b of $$('[data-c]')) b.onclick = () => groupForm(list.find(c => c.id === Number(b.dataset.c)));
      };
      $('q').oninput = draw; draw();
      $('addBtn').onclick = () => groupForm({ name: '', sub: '', icon: 'radio', color: 'blue', sort: (list.length + 1) * 10, active: 1 });
    } else {
      const users = await api('/api/admin/users');
      if (tab === 'roles') {
        $('al').innerHTML = ['admin', 'lead', 'user'].map(r => `<div class="sec">${ROLE_NAME[r]} (${users.filter(u => u.role === r && u.active).length})</div>
          <div class="small muted" style="margin:0 18px 6px">${r === 'admin' ? 'จัดการสมาชิก กลุ่ม สิทธิ์ แผนที่ และประกาศ' : r === 'lead' ? 'มอบหมายงาน ปิดเหตุฉุกเฉิน ดูรายงานและ log' : 'พูด/ฟัง แชท แจ้งเหตุ งานของตัวเอง'}</div>
          <div class="list">${users.filter(u => u.role === r && u.active).map(u => `<div class="li">${avatar(u)}<div class="grow"><div class="t1 ell">${esc(u.name)}</div><div class="t2">${esc(u.dept)}</div></div>
            <select data-role="${u.id}" aria-label="สิทธิ์ของ ${esc(u.name)}" style="border-radius:10px;padding:6px;border:1px solid var(--line-soft);background:var(--panel)">${['user', 'lead', 'admin'].map(x => `<option value="${x}" ${x === u.role ? 'selected' : ''}>${ROLE_NAME[x]}</option>`).join('')}</select></div>`).join('') || '<div class="empty">—</div>'}</div>`).join('');
        for (const s of $$('[data-role]')) s.onchange = async () => {
          const u = users.find(x => x.id === Number(s.dataset.role));
          try { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { ...u, role: s.value } }); toast(`เปลี่ยนสิทธิ์ ${u.name} แล้ว`); render(); } catch (e) { toast(e.message); s.value = u.role; }
        };
        $('annBtn').onclick = announce;
      } else {
        const draw = () => {
          const q = ($('q').value || '').toLowerCase();
          $('al').innerHTML = `<div class="list">${users.filter(u => !q || `${u.name} ${u.emp} ${u.dept}`.toLowerCase().includes(q)).map(u => `<button class="li" data-u="${u.id}" style="${u.active ? '' : 'opacity:.6'}">${avatar(u)}<div class="grow"><div class="t1 ell">${esc(u.name)}</div><div class="t2">${esc(u.emp)} · ${esc(u.dept || '-')}${u.active ? '' : ' · ปิดใช้งาน'}${u.role !== 'user' ? ` · ${ROLE_NAME[u.role]}` : ''}</div></div><span class="chev" style="color:var(--primary)">${icon('edit')}</span></button>`).join('') || '<div class="empty">ไม่พบพนักงาน</div>'}</div>`;
          loadAvatars($('al'));
          for (const b of $$('[data-u]')) b.onclick = () => userForm(users.find(u => u.id === Number(b.dataset.u)));
        };
        $('q').oninput = draw; draw();
        $('addBtn').onclick = () => userForm(null);
      }
    }
  } catch (e) { $('al') && ($('al').innerHTML = `<div class="empty">${esc(e.message)}</div>`); }
};
function userForm(u) {
  const isNew = !u; u = u || { emp: '', name: '', dept: '', position: '', main_channel: null, role: 'user', active: 1 };
  sheet(`<h3>${isNew ? 'เพิ่มพนักงาน' : 'แก้ไขพนักงาน'}</h3>
    <label class="lbl">รหัสพนักงาน</label><div class="field plain"><input id="fe" value="${esc(u.emp)}" maxlength="32" autocapitalize="off"></div>
    <label class="lbl">ชื่อ-นามสกุล</label><div class="field plain"><input id="fn" value="${esc(u.name)}" maxlength="40"></div>
    <label class="lbl">แผนก</label><div class="field plain"><input id="fd" value="${esc(u.dept)}" maxlength="40" list="deptList"></div>
    <label class="lbl">ตำแหน่ง</label><div class="field plain"><input id="fp" value="${esc(u.position)}" maxlength="60"></div>
    <label class="lbl">ช่องหลัก</label><div class="field plain"><select id="fc"><option value="">— ไม่ระบุ —</option>${S.channels.map(c => `<option value="${c.id}" ${c.id === u.main_channel ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    <label class="lbl">สิทธิ์การใช้งาน</label><div class="field plain"><select id="fr">${['user', 'lead', 'admin'].map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${ROLE_NAME[r]}</option>`).join('')}</select></div>
    <label class="lbl">${isNew ? 'รหัสผ่านเริ่มต้น' : 'ตั้งรหัสผ่านใหม่ (เว้นว่าง = ไม่เปลี่ยน)'}</label><div class="field plain"><input id="fw" type="text" autocomplete="new-password" placeholder="อย่างน้อย 6 ตัว"></div>
    ${isNew ? '' : `<label class="check"><input type="checkbox" id="fa" ${u.active ? 'checked' : ''}> เปิดใช้งานบัญชี</label>`}
    <div class="err" id="ferr"></div><button class="btn primary" id="fsave">บันทึก</button>`, bg => {
    bg.querySelector('#fsave').onclick = async () => {
      const body = { emp: $('fe').value.trim(), name: $('fn').value.trim(), dept: $('fd').value.trim(), position: $('fp').value.trim(), main_channel: Number($('fc').value) || null, role: $('fr').value, password: $('fw').value || undefined, active: isNew ? 1 : $('fa').checked };
      try { isNew ? await api('/api/admin/users', { method: 'POST', body }) : await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body }); closeSheet(); toast('บันทึกแล้ว'); render(); }
      catch (e) { $('ferr').textContent = e.message; }
    };
  });
}
function groupForm(c) {
  const icons = ['star', 'gear', 'bolt', 'box', 'tools', 'flask', 'shield', 'factory', 'truck', 'building', 'radio', 'users'];
  const colors = ['gold', 'green', 'yellow', 'purple', 'orange', 'blue', 'red', 'teal', 'gray'];
  sheet(`<h3>${c.id ? 'แก้ไขกลุ่ม' : 'เพิ่มกลุ่มสื่อสาร'}</h3>
    <label class="lbl">ชื่อกลุ่ม</label><div class="field plain"><input id="gn" value="${esc(c.name)}" maxlength="40"></div>
    <label class="lbl">คำอธิบาย</label><div class="field plain"><input id="gs" value="${esc(c.sub)}" maxlength="60" placeholder="เช่น Boiler / Power Plant"></div>
    <label class="lbl">ไอคอน</label><div class="chips" id="gi">${icons.map(i => `<button data-v="${i}" class="${c.icon === i ? 'on' : ''}" aria-label="${i}">${icon(CH_ICON[i])}</button>`).join('')}</div>
    <label class="lbl">สี</label><div class="chips" id="gc">${colors.map(x => `<button data-v="${x}" class="${c.color === x ? 'on' : ''}" aria-label="${x}"><span class="ic c-${x}" style="width:22px;height:22px;border-radius:50%"></span></button>`).join('')}</div>
    <label class="lbl">ลำดับ</label><div class="field plain"><input id="go" type="number" value="${c.sort}"></div>
    ${c.id ? `<label class="check"><input type="checkbox" id="ga" ${c.active ? 'checked' : ''}> เปิดใช้งานกลุ่ม</label>` : ''}
    <div class="err" id="gerr"></div><button class="btn primary" id="gsave">บันทึก</button>`, bg => {
    for (const grp of ['gi', 'gc']) for (const b of $$(`#${grp} button`, bg)) b.onclick = () => { $$(`#${grp} button`, bg).forEach(x => x.classList.remove('on')); b.classList.add('on'); };
    bg.querySelector('#gsave').onclick = async () => {
      const body = { name: $('gn').value.trim(), sub: $('gs').value.trim(), icon: bg.querySelector('#gi .on')?.dataset.v, color: bg.querySelector('#gc .on')?.dataset.v, sort: Number($('go').value), active: c.id ? $('ga').checked : 1 };
      try { c.id ? await api(`/api/admin/channels/${c.id}`, { method: 'PATCH', body }) : await api('/api/admin/channels', { method: 'POST', body }); await loadChannels(); closeSheet(); toast('บันทึกแล้ว'); render(); }
      catch (e) { $('gerr').textContent = e.message; }
    };
  });
}
function announce() {
  sheet(`<h3>ประกาศถึงทุกคน</h3><label class="lbl">หัวข้อ</label><div class="field plain"><input id="at" maxlength="80" placeholder="เช่น ซ้อมอพยพหนีไฟ 14:00 น."></div>
    <label class="lbl">รายละเอียด</label><div class="field plain"><textarea id="ab" maxlength="300"></textarea></div><div class="err" id="aerr"></div><button class="btn primary" id="asend">${icon('megaphone')}ส่งประกาศ</button>`, bg => {
    bg.querySelector('#asend').onclick = async () => {
      try { await api('/api/admin/announce', { method: 'POST', body: { title: $('at').value.trim(), body: $('ab').value.trim() } }); closeSheet(); toast('ส่งประกาศแล้ว'); } catch (e) { $('aerr').textContent = e.message; }
    };
  });
}

// ---------------------------------------------------------------- 16 report
ROUTES.report = async p => {
  const days = Number(p.days) || 7;
  mount(`<div class="page">${header('รายงานการใช้งาน')}
    <div class="tabs">${[1, 7, 30].map(d => `<button data-d="${d}" class="${d === days ? 'on' : ''}">${d === 1 ? 'วันนี้' : d + ' วัน'}</button>`).join('')}</div>
    <div class="scroll" id="rp"><div class="empty">กำลังโหลด…</div></div></div>`, root => {
    bindBack(root, 'settings');
    for (const b of $$('[data-d]', root)) b.onclick = () => go('report', { days: b.dataset.d }, true);
  });
  let r;
  try { r = await api(`/api/report?days=${days}`); } catch (e) { $('rp') && ($('rp').innerHTML = `<div class="empty">${esc(e.message)}</div>`); return; }
  if (!$('rp')) return;
  const bars = (rows, key) => { const max = Math.max(1, ...rows.map(x => x.n)); return rows.map(x => `<div class="barrow"><span class="ell">${esc(x[key])}</span><span class="bar"><i style="width:${Math.round(x.n / max * 100)}%"></i></span><b>${x.n}</b></div>`).join('') || '<div class="muted small">ยังไม่มีข้อมูล</div>'; };
  $('rp').innerHTML = `<div class="stat4">
      <div class="stat">${icon('team')}<b>${r.users}</b><small>สมาชิกทั้งหมด</small></div>
      <div class="stat green">${icon('wifi')}<b>${r.online}</b><small>ออนไลน์</small></div>
      <div class="stat">${icon('antenna')}<b>${r.channels}</b><small>ช่องสื่อสาร</small></div>
      <div class="stat">${icon('chat')}<b>${r.notifications}</b><small>การแจ้งเตือน</small></div></div>
    <div class="stat4" style="grid-template-columns:repeat(3,1fr);padding-top:8px">
      <div class="stat">${icon('mic')}<b>${r.talks}</b><small>ครั้งที่พูด</small></div>
      <div class="stat">${icon('history')}<b>${Math.round(r.talk_ms / 60000)}</b><small>นาทีที่พูดรวม</small></div>
      <div class="stat">${icon('siren')}<b>${r.sos}</b><small>แจ้งเหตุ SOS</small></div></div>
    <div class="card" style="margin:12px 14px;padding:14px 16px"><b>ปริมาณการสื่อสารตามแผนก (ครั้ง)</b>${bars(r.byDept, 'dept')}</div>
    <div class="card" style="margin:12px 14px;padding:14px 16px"><b>ตามช่องสื่อสาร (ครั้ง)</b>${bars(r.byChannel, 'channel')}</div>
    <div class="pad"><a class="btn" href="${(serverBase || '') + '/log.html'}">${icon('download')}Log ละเอียด / ส่งออก CSV</a></div>`;
};

// ================================================================ QR invite / scan
function inviteUrl() { return (NATIVE ? serverBase : location.origin) + '/'; }
function invite() {
  const url = inviteUrl();
  let svg = '';
  try { const q = qrcode(0, 'M'); q.addData(url); q.make(); svg = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); } catch {}
  sheet(`<h3>เชิญเพื่อนร่วมทีม</h3><p class="small muted">ให้เพื่อนสแกน QR นี้ด้วยกล้องมือถือ แล้วเข้าสู่ระบบด้วยรหัสพนักงานของตัวเอง (ผู้ดูแลระบบเป็นคนสร้างบัญชีให้)</p>
    <div class="qr">${svg}</div><div style="text-align:center;font-size:14px;word-break:break-all">${esc(url)}</div>
    <button class="btn" id="cp" style="margin-top:12px">คัดลอกลิงก์</button>`, bg => {
    bg.querySelector('#cp').onclick = async () => { try { await navigator.clipboard.writeText(url); toast('คัดลอกแล้ว'); } catch { toast('คัดลอกไม่ได้'); } };
  });
}
async function scanQr() {
  if (!('BarcodeDetector' in window)) return sheet(`<h3>สแกน QR</h3><p>เครื่องนี้สแกนในแอปไม่ได้ ให้เปิดแอปกล้องของมือถือแล้วสแกน QR จากหัวหน้าทีม ลิงก์จะเปิดแอปนี้ให้เอง</p>`);
  let stream, loop;
  const bg = sheet(`<h3>สแกน QR เพื่อเข้าใช้งาน</h3><video class="scan" id="sv" playsinline muted></video><p class="small muted" id="sm">หันกล้องไปที่ QR จากหัวหน้าทีม</p>`);
  const stop = () => { clearInterval(loop); stream && stream.getTracks().forEach(t => t.stop()); };
  new MutationObserver((_, o) => { if (!document.body.contains(bg)) { stop(); o.disconnect(); } }).observe($('app'), { childList: true });
  try {
    const det = new BarcodeDetector({ formats: ['qr_code'] });
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const v = $('sv'); v.srcObject = stream; await v.play();
    loop = setInterval(async () => {
      try {
        const r = await det.detect(v);
        if (!r[0]) return;
        let u; try { u = new URL(r[0].rawValue); } catch { $('sm').textContent = 'QR นี้ไม่ใช่ลิงก์ของแอป'; return; }
        stop(); closeSheet();
        if (NATIVE) { $('server').value = u.origin; probeServer(); toast('ได้ที่อยู่เซิร์ฟเวอร์แล้ว ใส่รหัสพนักงานเพื่อเข้าสู่ระบบ'); }
        else if (u.origin !== location.origin) location.href = u.href;
        else toast('สแกนแล้ว ใส่รหัสพนักงานเพื่อเข้าสู่ระบบ');
      } catch {}
    }, 350);
  } catch (e) { $('sm') && ($('sm').textContent = 'เปิดกล้องไม่ได้: ' + (e.message || e)); }
}

// ================================================================ PWA install / screen-off helpers
let installEvt = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
window.addEventListener('appinstalled', () => { installEvt = null; toast('ติดตั้งแล้ว เปิดจากไอคอนบนหน้าจอได้เลย'); for (const el of $$('[data-install]')) el.remove(); });
const UA = navigator.userAgent || '';
const IOS = /iPhone|iPad|iPod/i.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const INAPP = /\bLine\/|FBAN|FBAV|FB_IAB|Instagram|Messenger|MicroMessenger|Zalo|TikTok/i.test(UA);
// LINE's in-app browser cannot install apps: ask LINE to reopen this page in the phone's normal browser
if (!NATIVE && /\bLine\//i.test(UA) && !/openExternalBrowser=1/.test(location.search)) {
  const u = new URL(location.href); u.searchParams.set('openExternalBrowser', '1'); location.replace(u.toString());
}
async function doInstall() {
  if (installEvt) { installEvt.prompt(); const c = await installEvt.userChoice.catch(() => null); installEvt = null; if (c && c.outcome === 'accepted') toast('กำลังติดตั้ง… เปิดจากไอคอน WORMADI บนหน้าจอ'); renderInstallBars(); return; }
  installGuide();
}
function installGuide() {
  const link = location.origin + location.pathname;
  const step = (n, t) => `<li style="margin:8px 0"><b>${n}.</b> ${t}</li>`;
  let body;
  if (INAPP) body = `<p>ตอนนี้เปิดอยู่ในแอปแชท (LINE / Facebook) ซึ่งติดตั้งแอปไม่ได้</p><ol style="padding-left:4px;list-style:none">
      ${step(1, 'แตะเมนู <b>⋮</b> หรือ <b>⋯</b> มุมขวา')}${step(2, IOS ? 'เลือก <b>เปิดใน Safari</b>' : 'เลือก <b>เปิดในเบราว์เซอร์ / เปิดใน Chrome</b>')}${step(3, 'แล้วกดปุ่ม <b>ติดตั้งแอป</b> อีกครั้ง')}</ol>
      <button class="btn" id="cpLink" type="button">คัดลอกลิงก์ไปเปิดเอง</button>`;
  else if (IOS) body = `<p>iPhone / iPad ต้องใช้ <b>Safari</b></p><ol style="padding-left:4px;list-style:none">
      ${step(1, 'แตะปุ่ม <b>แชร์</b> (สี่เหลี่ยมมีลูกศรชี้ขึ้น) ด้านล่างหรือด้านบนของ Safari')}${step(2, 'เลื่อนลงแล้วเลือก <b>เพิ่มไปยังหน้าจอโฮม</b>')}${step(3, 'กด <b>เพิ่ม</b> แล้วเปิดจากไอคอน WORMADI')}</ol>
      <p class="small muted">iPhone จะหยุดเสียงเมื่อพับแอปนานๆ เพราะข้อจำกัดของ iOS ระหว่างใช้งานวอให้เปิดแอปค้างไว้</p>`;
  else body = `<ol style="padding-left:4px;list-style:none">
      ${step(1, 'เปิดลิงก์นี้ด้วย <b>Chrome</b>')}${step(2, 'แตะเมนู <b>⋮</b> มุมขวาบน')}${step(3, 'เลือก <b>ติดตั้งแอป</b> หรือ <b>เพิ่มลงในหน้าจอหลัก</b>')}${step(4, 'เปิดจากไอคอน WORMADI บนหน้าจอ')}</ol>
      <p class="small muted">Samsung Internet: เมนู ≡ → เพิ่มหน้าลงใน → หน้าจอหลัก</p>`;
  sheet(`<div style="text-align:center"><img class="appicon-img" src="brand/app-icon.png" alt="" style="width:72px;height:72px;margin:4px auto"></div>
    <h3 style="text-align:center;margin-top:6px">ติดตั้ง WORMADI ลงหน้าจอ</h3>${body}`, () => {
    const b = $('cpLink'); if (b) b.onclick = async () => { try { await navigator.clipboard.writeText(link); toast('คัดลอกลิงก์แล้ว'); } catch { prompt('คัดลอกลิงก์นี้', link); } };
  });
}
function installBar() {
  if (NATIVE || standalone()) return '';
  let until = 0; try { until = Number(localStorage.getItem('walkie_install_later')) || 0; } catch {}
  if (until > Date.now()) return '';
  return `<div class="install-bar" data-install><img src="brand/app-icon.png" alt=""><div class="grow"><b>ติดตั้ง WORMADI ลงหน้าจอ</b><small>เปิดเร็ว เต็มจอ และฟังต่อได้เมื่อพับแอป</small></div>
    <button class="btn primary sm" type="button" data-install-go>ติดตั้ง</button><button class="ib" type="button" data-install-x aria-label="ไว้ทีหลัง">${icon('x')}</button></div>`;
}
function bindInstallBar(root) {
  for (const b of $$('[data-install-go]', root)) b.onclick = doInstall;
  for (const b of $$('[data-install-x]', root)) b.onclick = () => { lsSet('walkie_install_later', String(Date.now() + 3 * 86_400_000)); renderInstallBars(); };
}
function renderInstallBars() { for (const el of $$('[data-install]')) { const h = installBar(); if (h) { el.outerHTML = h; } else el.remove(); } bindInstallBar(document); }
if (!NATIVE && 'serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
let wakeLock = null, keepAudio = null;
const wakeOn = () => lsGet('walkie_wake') === '1', keepOn = () => lsGet('walkie_keep') !== '0';   // listening in the background is on unless turned off
async function setWake(on) {
  if (on && 'wakeLock' in navigator && !document.hidden) { try { wakeLock = await navigator.wakeLock.request('screen'); } catch {} }
  else if (!on && wakeLock) { try { await wakeLock.release(); } catch {} wakeLock = null; }
}
function setKeepAlive(on, quiet) {
  if (NATIVE) return;
  if (on && !keepAudio) {
    const rate = 8000, n = rate, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, (Math.random() * 6 - 3) | 0, true);
    keepAudio = new Audio(URL.createObjectURL(new Blob([b], { type: 'audio/wav' }))); keepAudio.loop = true;
    keepAudio.play().catch(() => { keepAudio = null; if (!quiet) toast('แตะหน้าจอหนึ่งครั้งเพื่อเริ่มฟังต่อเมื่อพับแอป'); });
    if ('mediaSession' in navigator) for (const a of ['play', 'pause']) { try { navigator.mediaSession.setActionHandler(a, () => { wantTalk ? (pressed = false, stopTalking()) : (pressed = true, startTalking()); keepAudio && keepAudio.play().catch(() => {}); }); } catch {} }
    updateMediaSession();
  } else if (!on && keepAudio) { keepAudio.pause(); keepAudio = null; }
}
function updateMediaSession() {
  if (NATIVE || !keepAudio || !('mediaSession' in navigator) || !S.me) return;
  const t = S.state.talker;
  try { navigator.mediaSession.metadata = new MediaMetadata({ title: talking ? 'คุณกำลังพูด' : t ? `${t} กำลังพูด` : 'พร้อมรับการสื่อสาร', artist: `WORMADI · ${S.me.channel}`, artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }] }); navigator.mediaSession.playbackState = 'playing'; } catch {}
}
document.addEventListener('pointerdown', () => { if (S.me && keepOn() && !keepAudio) setKeepAlive(true); if (S.me && wakeOn() && !wakeLock) setWake(true); }, { passive: true });

// ================================================================ Android app bridge
async function probeServer() {
  const raw = ($('server')?.value || '').trim();
  const info = t => { const el = $('serverInfo'); if (el) el.textContent = t; };
  serverBase = '';
  if (!raw) return info('ใส่ที่อยู่เซิร์ฟเวอร์');
  info('กำลังตรวจสอบ…');
  try {
    const r = await WN.probe({ server: raw });
    if (r.needTrust) {
      if (confirm(`เซิร์ฟเวอร์ใช้ใบรับรองที่สร้างเอง\nลายนิ้วมือ: ${r.sha256}\nตรงกับที่หน้าจอเซิร์ฟเวอร์แสดงหรือไม่?`)) { await WN.trustCert({ server: r.base, sha256: r.sha256 }); return probeServer(); }
      return info('ยังไม่ได้ยืนยันใบรับรอง');
    }
    serverBase = r.base; lsSet('walkie_server', raw); lsSet('walkie_server_base', r.base);
    await loadConfig(); await loadChannels();
    info('✓ เชื่อมต่อได้'); render();
  } catch (e) { info('✗ ' + (e.message || e)); }
}
async function nativeJoin() {
  try { await WN.ensurePermissions(); } catch {}
  const ch = lsGet('walkie_channel') || (S.user && S.user.main_channel_name) || S.channels[0]?.name || '';
  try { await WN.join({ server: serverBase, name: S.user ? S.user.name : S.profile.name, dept: S.user ? S.user.dept : S.profile.dept || '', code: S.token || '', uid: S.uid, channel: ch }); setConn('connecting'); }
  catch (e) { toast('เริ่มบริการไม่ได้: ' + (e.message || e)); }
}
function onNativeEvent(m) {
  switch (m.type) {
    case 'conn': setConn(m.state, m); break;
    case 'talking': talking = !!m.talking; wantTalk = !!m.want; if (!wantTalk) setMeter(0); renderTalk(); break;
    case 'level': setMeter(m.v); break;
    case 'left': S.me = null; talking = wantTalk = false; setConn('offline'); break;
    case 'toast': toast(m.text); break;
    default: onMessage(m);
  }
}

// ================================================================ start
(async function start() {
  if (NATIVE) {
    await WN.addListener('walkie', onNativeEvent);
    const st = await WN.getStatus();
    if (st.server) serverBase = st.server;
  }
  await loadConfig();
  await loadChannels();
  renderBadges();
  const signedIn = ACC() ? !!S.token : !!S.profile.name;
  if (signedIn && ACC() && S.user && S.user.must_change) { go('setpw', {}, true); return; }
  if (signedIn) {
    if (ACC()) refreshMe();
    stopped = false;
    if (NATIVE) {
      const st = await WN.getStatus();
      if (st.active && st.joined) { onMessage(st.joined); if (st.state) onMessage(st.state); setConn(st.conn); }
      else nativeJoin();
    } else connect();
  }
  if (!location.hash || location.hash === '#/' || location.hash === '#') go(signedIn ? 'home' : 'splash', {}, true);
  else render();
})();
