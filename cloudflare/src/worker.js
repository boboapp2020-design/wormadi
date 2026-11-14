// Factory Talk บน Cloudflare Workers
//   หน้าเว็บ (PWA) จาก ../server/public, WebSocket ห้องวอที่ "/", REST API ที่ /api/*
//   ทุก API (ยกเว้น config/channels/login) ต้องส่ง  Authorization: Bearer <token>  จาก /api/login
//   สิทธิ์: user (พนักงาน) < lead (หัวหน้า: มอบงาน, ปิดเหตุ SOS, ดูรายงาน/log) < admin (ผู้ดูแลระบบ)
import { WalkieRoom, reactionsFor, EMOJIS, LOBBY } from './room.js';
import { toWav, compress } from './codec.js';
import { KINDS, startState, applyMove, legalFor } from './games.js';
import { pushAll, pushTo, pushReady } from './push.js';
import { hashPassword, verifyPassword, createSession, userFromToken, bearer, sha256, roleAtLeast, ROLES, PUBLIC_USER } from './auth.js';

export { WalkieRoom };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
};
const API = { 'Cache-Control': 'no-store', ...CORS };
const json = (data, status = 200) => Response.json(data, { status, headers: API });
const fail = (status, error) => json({ error }, status);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const SOS_KINDS = { general: 'เหตุฉุกเฉิน', fire: 'เพลิงไหม้', injury: 'อุบัติเหตุ / เจ็บป่วย', chemical: 'สารเคมีรั่วไหล', other: 'ความเสี่ยงอื่นๆ' };
const ICONS = ['star', 'gear', 'bolt', 'box', 'tools', 'flask', 'shield', 'factory', 'truck', 'building', 'radio', 'users', 'pin', 'drop', 'fire'];
const COLORS = ['gold', 'green', 'yellow', 'purple', 'orange', 'blue', 'red', 'teal', 'gray'];

/** typed chat (group + private) is kept CHAT_RETENTION_HOURS (default 24) */
async function cleanChat(env) {
  const cut = Date.now() - (Number(env.CHAT_RETENTION_HOURS) || 24) * 3_600_000;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM reactions WHERE msg_id IN (SELECT id FROM messages WHERE kind = 'text' AND ts < ?)`).bind(cut),
    env.DB.prepare(`DELETE FROM messages WHERE kind = 'text' AND ts < ?`).bind(cut),
    env.DB.prepare(`DELETE FROM notifications WHERE kind = 'dm' AND ts < ?`).bind(cut),
  ]);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if ((req.headers.get('Upgrade') || '').toLowerCase() === 'websocket') return room(env).fetch(req);
    // old link (*.workers.dev) -> main link without the account name; API keeps working for older Android installs
    if (env.PUBLIC_URL && url.hostname.endsWith('.workers.dev') && url.hostname !== new URL(env.PUBLIC_URL).hostname && req.method === 'GET' && !url.pathname.startsWith('/api/'))
      return Response.redirect(env.PUBLIC_URL + url.pathname + url.search, 301);
    if (url.pathname === '/__test/fire-reminders' && env.TEST_HOOKS === '1') return Response.json({ fired: await fireReminders(env) });
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      try { return await api(req, env, url); }
      catch (e) {
        if (e instanceof HttpError) return fail(e.status, e.message);
        console.error(e);
        return fail(500, 'เกิดข้อผิดพลาดในระบบ');
      }
    }
    const res = await env.ASSETS.fetch(req);
    const type = res.headers.get('Content-Type') || '';
    if (res.ok && (url.pathname === '/sw.js' || /text\/(html|css)|javascript/.test(type))) {
      const h = new Headers(res.headers);
      h.set('Cache-Control', 'no-cache');   // updates reach phones on next open
      return new Response(res.body, { status: res.status, headers: h });
    }
    return res;
  },

  // cleanup (cron in wrangler.jsonc)
  async scheduled(evt, env) {
    if (evt && evt.cron === '* * * * *') {
      if (new Date().getUTCMinutes() === 0) await cleanChat(env);   // hourly
      return fireReminders(env);
    }
    await cleanChat(env);
    const day = 86_400_000, now = Date.now();
    await env.DB.prepare('DELETE FROM reminders WHERE done_at IS NOT NULL AND done_at < ?').bind(now - 30 * day).run();
    await env.DB.prepare('DELETE FROM chat_reads WHERE channel NOT IN (\'*\', \'#talk\') AND ts < ?').bind(now - 3 * day).run();
    await env.DB.prepare('DELETE FROM games WHERE updated < ?').bind(now - 3 * day).run();   // duel games keep 3 days
    await env.DB.batch([   // incident board keeps 7 days
      env.DB.prepare('DELETE FROM incident_comments WHERE incident_id IN (SELECT id FROM incidents WHERE ts < ?)').bind(now - 7 * day),
      env.DB.prepare('DELETE FROM incidents WHERE ts < ?').bind(now - 7 * day),
    ]);
    const cutoff = now - (Number(env.LOG_RETENTION_DAYS) || 90) * day;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM walkie_log WHERE ts < ?').bind(cutoff),
      env.DB.prepare('DELETE FROM reactions WHERE msg_id IN (SELECT id FROM messages WHERE ts < ?)').bind(cutoff),
      env.DB.prepare('DELETE FROM messages WHERE ts < ?').bind(cutoff),
      env.DB.prepare('DELETE FROM notifications WHERE ts < ?').bind(cutoff),
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    ]);
    // recordings stored in D1 (no R2)
    const recCut = now - (Number(env.RECORDING_RETENTION_DAYS) || 7) * day;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM audio_clips WHERE ts < ?').bind(recCut),
      env.DB.prepare('DELETE FROM voicemail WHERE ts < ?').bind(recCut),
      env.DB.prepare(`UPDATE messages SET audio = NULL WHERE audio = 'db' AND ts < ?`).bind(recCut),
    ]);
    if (env.REC) {   // recordings: rec/YYYY-MM-DD/<id>.wav
      const keepFrom = new Date(now - (Number(env.RECORDING_RETENTION_DAYS) || 30) * day).toISOString().slice(0, 10);
      let cursor;
      do {
        const page = await env.REC.list({ prefix: 'rec/', cursor });
        const old = page.objects.filter(o => o.key.slice(4, 14) < keepFrom).map(o => o.key);
        if (old.length) await env.REC.delete(old);
        await env.DB.prepare(`UPDATE messages SET audio = NULL WHERE audio LIKE 'rec/%' AND substr(audio, 5, 10) < ?`).bind(keepFrom).run();
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
  },
};

const room = env => env.ROOM.get(env.ROOM.idFromName('main'));
async function roomCall(env, path, body) {
  const r = await room(env).fetch('https://room' + path, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
  return path === '/reload' ? null : r.json();
}
async function readJson(req) { try { return await req.json(); } catch { throw new HttpError(400, 'ข้อมูลไม่ถูกต้อง'); } }
async function need(req, env, minRole = 'user') {
  const user = await userFromToken(env.DB, bearer(req));
  if (!user) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
  if (!roleAtLeast(user.role, minRole)) throw new HttpError(403, 'ไม่มีสิทธิ์ใช้งานส่วนนี้');
  return user;
}
const str = (v, max) => String(v ?? '').trim().slice(0, max);

// ---- rooms with an optional password
/** names of locked rooms this user has not unlocked (admins and the creator always have access) */
async function deniedRooms(db, me) {
  if (roleAtLeast(me.role, 'admin')) return new Set();
  const { results } = await db.prepare(
    `SELECT c.name FROM channels c WHERE c.pass IS NOT NULL AND c.active = 1 AND (c.created_by IS NULL OR c.created_by != ?)
       AND NOT EXISTS (SELECT 1 FROM channel_access a WHERE a.channel_id = c.id AND a.user_id = ?)`).bind(me.id, me.id).all();
  return new Set(results.map(r => r.name));
}
/** private call channel "dm:a:b": only users a and b */
/** unread chat per channel: private chats (any kind) and room text messages from others, newer than my last read (24 h retention) */
async function chatUnread(db, me) {
  const now = Date.now();
  await db.prepare("INSERT OR IGNORE INTO chat_reads (user_id, channel, ts) VALUES (?, '*', ?)").bind(me.id, now).run();   // first call = the starting point
  const { results } = await db.prepare(
    `SELECT m.channel, COUNT(*) AS n FROM messages m
       LEFT JOIN chat_reads r ON r.user_id = ?1 AND r.channel = m.channel
       LEFT JOIN chat_reads b ON b.user_id = ?1 AND b.channel = '*'
     WHERE m.ts > ?2 AND m.ts > COALESCE(r.ts, b.ts, 0) AND COALESCE(m.user_id, 0) != ?1
       AND ((m.channel LIKE 'dm:%' AND (m.channel LIKE ?3 OR m.channel LIKE ?4)) OR (m.channel NOT LIKE 'dm:%' AND m.kind = 'text'))
     GROUP BY m.channel`).bind(me.id, now - 86_400_000, `dm:${me.id}:%`, `dm:%:${me.id}`).all();
  const denied = await deniedRooms(db, me);
  const out = {};
  for (const r of results) if (!denied.has(r.channel)) out[r.channel] = r.n;
  return out;
}
const dmBlocked = (ch, me) => { const m = /^dm:(\d+):(\d+)$/.exec(String(ch || '')); return !!m && ![Number(m[1]), Number(m[2])].includes(me.id); };
// ---- reminders (บันทึก / เตือน)
const RPT_MS = { daily: 86_400_000, shift: 8 * 3_600_000, weekly: 7 * 86_400_000 };
async function fireReminders(env) {
  const now = Date.now(), db = env.DB;
  const { results } = await db.prepare(
    `SELECT r.*, u.name AS owner FROM reminders r JOIN users u ON u.id = r.user_id
     WHERE r.next_at IS NOT NULL AND r.next_at <= ? AND r.done_at IS NULL ORDER BY r.next_at LIMIT 200`).bind(now).all();
  for (const r of results) {
    let next = null;
    if (RPT_MS[r.rpt]) { next = r.due_at || r.next_at; while (next <= now) next += RPT_MS[r.rpt]; }
    await db.prepare('UPDATE reminders SET next_at = ?, due_at = COALESCE(?, due_at) WHERE id = ?').bind(next, next, r.id).run();
    const rem = { id: r.id, title: r.title, note: r.note, due_at: r.next_at, rpt: r.rpt, channel: r.channel, owner: r.owner, owner_id: r.user_id, next_at: next };
    const ins = await db.prepare('INSERT INTO notifications (ts, user_id, kind, title, body, ref) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(now, r.user_id, 'reminder', '⏰ ' + r.title, r.note || 'ถึงเวลาที่ตั้งเตือนไว้', 'rem:' + r.id).run();
    const n = { id: ins.meta.last_row_id, ts: now, kind: 'reminder', title: '⏰ ' + r.title, body: r.note || 'ถึงเวลาที่ตั้งเตือนไว้', ref: 'rem:' + r.id };
    try {
      await roomCall(env, '/broadcast', { msg: { type: 'notification', notification: n, reminder: rem }, userIds: [r.user_id] });
      if (r.channel) {          // shared with a group: everyone in that group right now
        const shared = { ...n, title: `⏰ ${r.title}`, body: `จาก ${r.owner}${r.note ? ' · ' + r.note : ''}` };
        await roomCall(env, '/broadcast', { msg: { type: 'notification', notification: shared, reminder: { ...rem, shared: true } }, channel: r.channel });
      }
    } catch (e) { console.error('reminder broadcast failed', e); }
  }
  return results.length;
}
async function deleteChannel(db, cid) {
  await db.batch([
    db.prepare('DELETE FROM channel_access WHERE channel_id = ?').bind(cid),
    db.prepare('DELETE FROM room_invites WHERE channel_id = ?').bind(cid),
    db.prepare('UPDATE users SET main_channel = NULL WHERE main_channel = ?').bind(cid),
    db.prepare('UPDATE map_pins SET channel_id = NULL WHERE channel_id = ?').bind(cid),
    db.prepare('DELETE FROM channels WHERE id = ?').bind(cid),
  ]);
}
async function notify(env, { userId = null, kind, title, body = '', ref = null }) {
  const r = await env.DB.prepare('INSERT INTO notifications (ts, user_id, kind, title, body, ref) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(Date.now(), userId, kind, title, body, ref).run();
  const n = { id: r.meta.last_row_id, ts: Date.now(), kind, title, body, ref };
  await roomCall(env, '/broadcast', { msg: { type: 'notification', notification: n }, userIds: userId ? [userId] : null });
  return n;
}
function dataUrl(s, maxBytes) {
  const m = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  if (!m) throw new HttpError(400, 'ไฟล์รูปไม่ถูกต้อง (รองรับ PNG / JPEG / WebP)');
  if (m[2].length * 0.75 > maxBytes) throw new HttpError(413, 'ไฟล์รูปใหญ่เกินไป');
  return s;
}
function imageResponse(s) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(s || '');
  if (!m) return fail(404, 'ไม่มีรูป');
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  return new Response(bytes, { headers: { 'Content-Type': m[1], 'Cache-Control': 'private, max-age=60', ...CORS } });
}

// ======================================================================= API
async function api(req, env, url) {
  const p = url.pathname, m = req.method, db = env.DB;
  const seg = p.split('/').filter(Boolean);           // ['api', 'tasks', '12', 'ack']
  const id = Number(seg[2]);

  // ---------------------------------------------------------------- public
  if (p === '/api/config') {
    return json({
      server: 'cloudflare', accounts: true, recording: !!(env.REC || env.DB), push: pushReady(env), vapidPublic: env.VAPID_PUBLIC || '', emojis: EMOJIS, sosKinds: SOS_KINDS,
      features: ['chat', 'react', 'roster', 'history', 'log', 'accounts', 'tasks', 'sos', 'map', 'report'],
      org: env.ORG_NAME || '', app: env.APP_NAME || 'WORMADI',
    });
  }
  if (p === '/api/channels' && m === 'GET') {
    const [{ results }, live, viewer] = await Promise.all([
      db.prepare(`SELECT c.id, c.name, c.sub, c.icon, c.color, (c.pass IS NOT NULL) AS locked, c.created_by, c.created_at, u.name AS creator_name
                   FROM channels c LEFT JOIN users u ON u.id = c.created_by WHERE c.active = 1 ORDER BY c.sort, c.id`).all(),
      roomCall(env, '/channels'),
      userFromToken(db, bearer(req)),
    ]);
    const count = Object.fromEntries(live.map(c => [c.name, c.users]));
    const denied = viewer ? await deniedRooms(db, viewer) : null;
    const lobby = { id: 0, name: LOBBY, sub: 'ทุกคนที่ไม่ได้อยู่ในห้องแยก ได้ยินกันหมด', icon: 'users', color: 'gold', locked: 0, lobby: true,
      created_by: null, creator_name: null, users: count[LOBBY] || 0, access: true, can_delete: false };
    return json([lobby, ...results.filter(c => c.name !== LOBBY).map(c => ({ ...c, users: count[c.name] || 0,
      access: c.locked ? (denied ? !denied.has(c.name) : false) : true,
      can_delete: !!viewer && (roleAtLeast(viewer.role, 'admin') || c.created_by === viewer.id) }))]);
  }
  if (p === '/api/login' && m === 'POST') {
    const b = await readJson(req);
    const emp = str(b.emp, 32), pass = String(b.password || '');
    if (!emp || !pass) return fail(400, 'กรุณาใส่รหัสพนักงานและรหัสผ่าน');
    const key = 'fail:' + emp.toLowerCase();
    const lock = JSON.parse((await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first('value')) || '{"n":0,"until":0}');
    if (lock.until > Date.now()) return fail(429, `ใส่รหัสผิดหลายครั้ง ลองใหม่ใน ${Math.ceil((lock.until - Date.now()) / 60000)} นาที`);
    const u = await db.prepare('SELECT id, pass, active FROM users WHERE emp = ?').bind(emp).first();
    const ok = u && u.active && await verifyPassword(pass, u.pass);
    if (!ok) {
      const n = lock.n + 1;
      await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, JSON.stringify({ n: n >= 5 ? 0 : n, until: n >= 5 ? Date.now() + 10 * 60000 : 0 })).run();
      return fail(401, u && !u.active ? 'บัญชีนี้ถูกปิดใช้งาน ติดต่อผู้ดูแลระบบ' : 'รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง');
    }
    // one account = one device: signing in here signs out every other device of this account
    await db.batch([
      db.prepare('DELETE FROM settings WHERE key = ?').bind(key),
      db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
      db.prepare('DELETE FROM push_subs WHERE user_id = ?').bind(u.id),
    ]);
    await roomCall(env, '/kick', { userId: u.id });
    const s = await createSession(db, u.id, !!b.remember);
    const user = await db.prepare(`SELECT ${PUBLIC_USER} FROM users u WHERE u.id = ?`).bind(u.id).first();
    return json({ token: s.token, expires: s.expires, user });
  }

  // ---------------------------------------------------------------- signed in
  const me = await need(req, env);
  // default/reset password: nothing else works until the user sets their own
  if (me.must_change && !['/api/me', '/api/me/password', '/api/logout'].includes(p)) return fail(403, 'กรุณาตั้งรหัสผ่านใหม่ก่อนใช้งาน');

  if (p === '/api/logout' && m === 'POST') {
    await db.batch([
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(bearer(req))),
      db.prepare('DELETE FROM push_subs WHERE user_id = ?').bind(me.id),
    ]);
    return json({ ok: true });
  }
  if (p === '/api/me' && m === 'GET') {
    const lr = (await db.prepare('SELECT last_read FROM notif_reads WHERE user_id = ?').bind(me.id).first('last_read')) || 0;
    const unread = await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE (user_id IS NULL OR user_id = ?) AND ts > ?').bind(me.id, lr).first('n');
    const tasks = await db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND done_at IS NULL AND next_at IS NOT NULL AND next_at < ?').bind(me.id, Date.now() + 86_400_000).first('n');
    const ch = me.main_channel ? await db.prepare('SELECT name FROM channels WHERE id = ?').bind(me.main_channel).first('name') : null;
    const roomPush = (await db.prepare('SELECT room_push FROM users WHERE id = ?').bind(me.id).first('room_push')) !== 0;
    return json({ user: { ...me, main_channel_name: ch }, unread, openTasks: tasks, chatUnread: await chatUnread(db, me), roomPush });
  }
  if (p === '/api/me' && m === 'PATCH') {
    const b = await readJson(req);
    if ('room_push' in b) await db.prepare('UPDATE users SET room_push = ? WHERE id = ?').bind(b.room_push ? 1 : 0, me.id).run();
    if ('avatar' in b) await db.prepare('UPDATE users SET avatar = ? WHERE id = ?').bind(b.avatar ? dataUrl(b.avatar, 200_000) : null, me.id).run();
    return json({ ok: true });
  }
  if (p === '/api/chat/read' && m === 'POST') {          // I have read this chat up to now
    const ch = str((await readJson(req)).channel, 80);
    if (!ch || dmBlocked(ch, me)) return fail(400, 'ไม่ถูกต้อง');
    await db.prepare('INSERT INTO chat_reads (user_id, channel, ts) VALUES (?, ?, ?) ON CONFLICT(user_id, channel) DO UPDATE SET ts = excluded.ts').bind(me.id, ch, Date.now()).run();
    return json({ ok: true });
  }
  if (p === '/api/me/password' && m === 'POST') {
    const b = await readJson(req);
    const row = await db.prepare('SELECT pass FROM users WHERE id = ?').bind(me.id).first();
    if (!(await verifyPassword(String(b.old || ''), row.pass))) return fail(400, 'รหัสผ่านเดิมไม่ถูกต้อง');
    if (String(b.new || '').length < 6) return fail(400, 'รหัสผ่านใหม่ต้องยาวอย่างน้อย 6 ตัว');
    if (String(b.new) === String(b.old)) return fail(400, 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม');
    await db.prepare('UPDATE users SET pass = ?, must_change = 0 WHERE id = ?').bind(await hashPassword(String(b.new)), me.id).run();
    return json({ ok: true });
  }
  if (seg[1] === 'avatar' && m === 'GET') {
    return imageResponse(await db.prepare('SELECT avatar FROM users WHERE id = ?').bind(id).first('avatar'));
  }
  if (p === '/api/users' && m === 'GET') {
    const [{ results }, online] = await Promise.all([
      db.prepare(`SELECT ${PUBLIC_USER}, c.name AS main_channel_name FROM users u LEFT JOIN channels c ON c.id = u.main_channel WHERE u.active = 1 ORDER BY u.name`).all(),
      roomCall(env, '/online'),
    ]);
    const on = new Map(online.map(o => [o.id, o.channel]));
    return json(results.map(u => { const c = on.get(u.id) || null; return { ...u, online: on.has(u.id), channel: c && c.startsWith('dm:') ? 'คุยส่วนตัว' : c }; }));
  }

  // ---------------------------------------------------------------- rooms anyone can create
  if (p === '/api/channels' && m === 'POST') {
    const b = await readJson(req);
    const name = str(b.name, 40), pass = String(b.password || '');
    if (!name) return fail(400, 'กรุณาตั้งชื่อห้อง');
    if (name === LOBBY) return fail(409, `"${LOBBY}" เป็นห้องรวมของทุกคนอยู่แล้ว ลองตั้งชื่ออื่น`);
    if (pass && (pass.length < 4 || pass.length > 32)) return fail(400, 'รหัสห้องต้องยาว 4–32 ตัว');
    if (!roleAtLeast(me.role, 'admin')) {
      const mine = await db.prepare('SELECT COUNT(*) AS n FROM channels WHERE created_by = ? AND active = 1').bind(me.id).first('n');
      if (mine >= 10) return fail(400, 'สร้างห้องได้สูงสุด 10 ห้องต่อคน ลบห้องที่ไม่ใช้ก่อน');
    }
    const icon = ICONS.includes(b.icon) ? b.icon : 'radio', color = COLORS.includes(b.color) ? b.color : 'blue';
    let r;
    try {
      r = await db.prepare('INSERT INTO channels (name, sub, icon, color, sort, pass, created_by, created_at) VALUES (?, ?, ?, ?, 100, ?, ?, ?)')
        .bind(name, str(b.sub, 60), icon, color, pass ? await hashPassword(pass) : null, me.id, Date.now()).run();
    } catch { return fail(409, 'มีห้องชื่อนี้แล้ว ลองตั้งชื่ออื่น'); }
    await roomCall(env, '/reload');
    return json({ ok: true, id: r.meta.last_row_id, name, locked: !!pass });
  }
  if (seg[1] === 'channels' && id && seg[3] === 'unlock' && m === 'POST') {
    const c = await db.prepare('SELECT id, name, pass FROM channels WHERE id = ? AND active = 1').bind(id).first();
    if (!c) return fail(404, 'ไม่พบห้องนี้');
    if (!c.pass) return json({ ok: true, name: c.name });
    const key = `roomfail:${me.id}:${id}`;
    const lock = JSON.parse((await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first('value')) || '{"n":0,"until":0}');
    if (lock.until > Date.now()) return fail(429, `ใส่รหัสห้องผิดหลายครั้ง ลองใหม่ใน ${Math.ceil((lock.until - Date.now()) / 60000)} นาที`);
    if (!(await verifyPassword(String((await readJson(req)).password || ''), c.pass))) {
      const n = lock.n + 1;
      await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, JSON.stringify({ n: n >= 5 ? 0 : n, until: n >= 5 ? Date.now() + 10 * 60000 : 0 })).run();
      return fail(403, 'รหัสห้องไม่ถูกต้อง');
    }
    await db.batch([
      db.prepare('DELETE FROM settings WHERE key = ?').bind(key),
      db.prepare('INSERT OR IGNORE INTO channel_access (channel_id, user_id, ts) VALUES (?, ?, ?)').bind(id, me.id, Date.now()),
    ]);
    return json({ ok: true, name: c.name });
  }
  if (seg[1] === 'channels' && id && !seg[3] && m === 'DELETE') {
    const c = await db.prepare('SELECT id, created_by FROM channels WHERE id = ?').bind(id).first();
    if (!c) return fail(404, 'ไม่พบห้องนี้');
    if (!roleAtLeast(me.role, 'admin') && c.created_by !== me.id) return fail(403, 'ลบได้เฉพาะห้องที่คุณสร้าง');
    await deleteChannel(db, id);
    await roomCall(env, '/reload');
    return json({ ok: true });
  }

  // ---------------------------------------------------------------- Web Push subscription (SOS alerts when the app is closed)
  if (p === '/api/push' && m === 'POST') {
    const sub = (await readJson(req)).subscription || {};
    const endpoint = str(sub.endpoint, 1000);
    if (!/^https:\/\//.test(endpoint)) return fail(400, 'subscription ไม่ถูกต้อง');
    await db.batch([
      db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint != ?').bind(me.id, endpoint),   // one device per account
      db.prepare('INSERT OR REPLACE INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(endpoint, me.id, str(sub.keys?.p256dh, 200), str(sub.keys?.auth, 100), Date.now()),
    ]);
    return json({ ok: true, ready: pushReady(env) });
  }

  // ---------------------------------------------------------------- บันทึก / เตือน (only the owner sees them)
  if (p === '/api/reminders' && m === 'GET') {
    const { results } = await db.prepare(
      `SELECT id, title, note, due_at, next_at, rpt, channel, done_at, created_at FROM reminders WHERE user_id = ?
       ORDER BY done_at IS NOT NULL, next_at IS NULL, COALESCE(next_at, due_at, created_at) LIMIT 300`).bind(me.id).all();
    return json(results);
  }
  if (seg[1] === 'reminders' && (m === 'POST' || m === 'PATCH')) {
    const b = await readJson(req);
    const cur = m === 'PATCH' ? await db.prepare('SELECT * FROM reminders WHERE id = ? AND user_id = ?').bind(id, me.id).first() : null;
    if (m === 'PATCH' && !cur) return fail(404, 'ไม่พบบันทึกนี้');
    const now = Date.now();
    if (m === 'PATCH' && b.snooze_min) {               // snooze: ring again in N minutes
      await db.prepare('UPDATE reminders SET next_at = ? WHERE id = ?').bind(now + Math.min(Math.max(Number(b.snooze_min) || 10, 1), 240) * 60000, id).run();
      return json({ ok: true });
    }
    if (m === 'PATCH' && 'done' in b && Object.keys(b).length === 1) {   // tick done / undo
      if (b.done) await db.prepare(`UPDATE reminders SET done_at = ?, next_at = CASE WHEN rpt = 'none' THEN NULL ELSE next_at END WHERE id = ?`).bind(now, id).run();
      else await db.prepare('UPDATE reminders SET done_at = NULL, next_at = CASE WHEN due_at > ? THEN due_at ELSE next_at END WHERE id = ?').bind(now, id).run();
      return json({ ok: true });
    }
    const title = str(b.title, 120);
    if (!title) return fail(400, 'กรุณาใส่หัวข้อ');
    const rpt = ['none', 'daily', 'shift', 'weekly'].includes(b.rpt) ? b.rpt : 'none';
    const due = Number.isFinite(Number(b.due_at)) && Number(b.due_at) > 0 ? Number(b.due_at) : null;
    let next = due;
    if (due && RPT_MS[rpt]) while (next <= now - 60000) next += RPT_MS[rpt];
    let channel = str(b.channel, 40) || null;
    if (channel && channel !== LOBBY && (dmBlocked(channel, me) || (await deniedRooms(db, me)).has(channel) ||
        !(await db.prepare('SELECT 1 AS x FROM channels WHERE name = ? AND active = 1').bind(channel).first('x')))) channel = null;
    if (m === 'POST') {
      const r = await db.prepare('INSERT INTO reminders (user_id, title, note, due_at, next_at, rpt, channel, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(me.id, title, str(b.note, 500), next, next, rpt, channel, now).run();
      return json({ ok: true, id: r.meta.last_row_id });
    }
    await db.prepare('UPDATE reminders SET title = ?, note = ?, due_at = ?, next_at = ?, rpt = ?, channel = ?, done_at = NULL WHERE id = ?')
      .bind(title, str(b.note, 500), next, next, rpt, channel, id).run();
    return json({ ok: true });
  }
  if (seg[1] === 'reminders' && id && m === 'DELETE') {
    await db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?').bind(id, me.id).run();
    return json({ ok: true });
  }

  // ---------------------------------------------------------------- รายงานเหตุการณ์ (incident board: everyone posts text / photo)
  if (p === '/api/incidents' && m === 'GET') {
    const { results } = await db.prepare(
      `SELECT i.id, i.ts, i.user_id, i.level, i.text, i.place, i.lat, i.lng, i.thumb, i.photo IS NOT NULL AS has_photo, i.done_at,
              u.name, u.dept, u.avatar IS NOT NULL AS has_avatar, d.name AS done_name,
              (SELECT COUNT(*) FROM incident_comments c WHERE c.incident_id = i.id) AS comments
       FROM incidents i LEFT JOIN users u ON u.id = i.user_id LEFT JOIN users d ON d.id = i.done_by
       ORDER BY i.id DESC LIMIT 100`).all();
    return json(results);
  }
  if (seg[1] === 'incidents' && id && seg[3] === 'comments' && m === 'GET') {
    const { results } = await db.prepare(
      `SELECT c.id, c.ts, c.user_id, c.text, c.parent_id, c.reply_to, u.name, u.dept, u.avatar IS NOT NULL AS has_avatar, r.name AS reply_name
       FROM incident_comments c LEFT JOIN users u ON u.id = c.user_id LEFT JOIN users r ON r.id = c.reply_to
       WHERE c.incident_id = ? ORDER BY c.id LIMIT 300`).bind(id).all();
    return json(results);
  }
  if (seg[1] === 'incidents' && id && seg[3] === 'comments' && m === 'POST') {
    const inc = await db.prepare('SELECT user_id FROM incidents WHERE id = ?').bind(id).first();
    if (!inc) return fail(404, 'ไม่พบรายงานนี้');
    const b = await readJson(req);
    const text = str(b.text, 500);
    if (!text) return fail(400, 'กรุณาพิมพ์ความคิดเห็น');
    let parent = null, replyTo = null;
    if (b.parent_id) {
      const pc = await db.prepare('SELECT id, user_id, parent_id FROM incident_comments WHERE id = ? AND incident_id = ?').bind(Number(b.parent_id), id).first();
      if (!pc) return fail(404, 'ไม่พบความคิดเห็นที่จะตอบ');
      parent = pc.parent_id || pc.id; replyTo = pc.user_id;
    }
    const now = Date.now();
    const r = await db.prepare('INSERT INTO incident_comments (incident_id, user_id, ts, text, parent_id, reply_to) VALUES (?, ?, ?, ?, ?, ?)').bind(id, me.id, now, text, parent, replyTo).run();
    try { await roomCall(env, '/broadcast', { msg: { type: 'incident_comment', id, cid: r.meta.last_row_id, owner: inc.user_id, reply_to: replyTo, from: me.id, name: me.name, text: text.slice(0, 120) } }); } catch {}
    return json({ ok: true, id: r.meta.last_row_id });
  }
  if (seg[1] === 'incidents' && id && seg[3] === 'comments' && seg[4] && m === 'DELETE') {   // delete my own comment (and its replies)
    const cid = Number(seg[4]);
    const c = await db.prepare('SELECT user_id FROM incident_comments WHERE id = ? AND incident_id = ?').bind(cid, id).first();
    if (!c) return fail(404, 'ไม่พบความคิดเห็น');
    if (c.user_id !== me.id && me.role !== 'admin') return fail(403, 'ลบได้เฉพาะความคิดเห็นของตัวเอง');
    await db.batch([db.prepare('DELETE FROM incident_comments WHERE parent_id = ? AND incident_id = ?').bind(cid, id), db.prepare('DELETE FROM incident_comments WHERE id = ?').bind(cid)]);
    return json({ ok: true });
  }
  if (seg[1] === 'incidents' && id && !seg[3] && m === 'GET') {          // one report (the comments page)
    const row = await db.prepare(
      `SELECT i.id, i.ts, i.user_id, i.level, i.text, i.place, i.lat, i.lng, i.thumb, i.photo IS NOT NULL AS has_photo, i.done_at,
              u.name, u.dept, u.avatar IS NOT NULL AS has_avatar, d.name AS done_name
       FROM incidents i LEFT JOIN users u ON u.id = i.user_id LEFT JOIN users d ON d.id = i.done_by WHERE i.id = ?`).bind(id).first();
    if (!row) return fail(404, 'ไม่พบรายงานนี้ (อาจถูกลบแล้ว)');
    return json(row);
  }
  if (seg[1] === 'incidents' && id && seg[3] === 'photo' && m === 'GET') {
    const r = await db.prepare('SELECT photo FROM incidents WHERE id = ?').bind(id).first();
    if (!r || !r.photo) return fail(404, 'ไม่พบรูป');
    return json({ photo: r.photo });
  }
  if (p === '/api/incidents' && m === 'POST') {
    const b = await readJson(req);
    const img = (v, max) => typeof v === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(v) && v.length <= max ? v : null;
    const text = str(b.text, 1000), place = str(b.place, 120);
    const photo = img(b.photo, 1_400_000), thumb = photo ? img(b.thumb, 120_000) : null;
    if (!text && !photo) return fail(400, 'ใส่ข้อความหรือรูปอย่างน้อย 1 อย่าง');
    const lat = Number(b.lat), lng = Number(b.lng), gps = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    const now = Date.now(), level = ['low', 'medium', 'high'].includes(b.level) ? b.level : 'low';
    const r = await db.prepare('INSERT INTO incidents (ts, user_id, level, text, place, lat, lng, thumb, photo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(now, me.id, level, text, place, gps ? lat : null, gps ? lng : null, thumb, photo).run();
    try { await roomCall(env, '/broadcast', { msg: { type: 'incident', id: r.meta.last_row_id, level, name: me.name, dept: me.dept || '', text: text.slice(0, 120), place } }); } catch {}
    return json({ ok: true, id: r.meta.last_row_id });
  }
  if (seg[1] === 'incidents' && id && (m === 'PATCH' || m === 'DELETE')) {
    const cur = await db.prepare('SELECT user_id, level, done_at FROM incidents WHERE id = ?').bind(id).first();
    if (!cur) return fail(404, 'ไม่พบรายงานนี้');
    const boss = me.role === 'admin' || me.role === 'lead';
    if (m === 'DELETE') {
      if (cur.user_id !== me.id && me.role !== 'admin') return fail(403, 'ลบได้เฉพาะคนที่โพสต์');
      await db.batch([db.prepare('DELETE FROM incident_comments WHERE incident_id = ?').bind(id), db.prepare('DELETE FROM incidents WHERE id = ?').bind(id)]);
      return json({ ok: true });
    }
    const b = await readJson(req);
    // the poster closes it as back to normal (a lead / admin can too); the red light stays until then
    if (cur.user_id !== me.id && !boss) return fail(403, 'ปิดเหตุการณ์ได้เฉพาะคนที่โพสต์ (หรือหัวหน้า)');
    await db.prepare('UPDATE incidents SET done_at = ?, done_by = ? WHERE id = ?').bind(b.done ? Date.now() : null, b.done ? me.id : null, id).run();
    try { await roomCall(env, '/broadcast', { msg: { type: 'incident_done', id, done: !!b.done, level: cur.level, name: me.name } }); } catch {}
    return json({ ok: true });
  }

  // ---------------------------------------------------------------- private chat (แชทส่วนตัว)
  // messages live in channel "dm:<smaller id>:<bigger id>", same as the private call channel
  // ---------------------------------------------------------------- duel games (XO / หมากฮอส)
  if (seg[1] === 'games') {
    const SEL = 'SELECT g.*, a.name AS n1, b.name AS n2 FROM games g JOIN users a ON a.id = g.p1 JOIN users b ON b.id = g.p2';
    const view = g => {
      const side = g.p1 === me.id ? 1 : 2, st = JSON.parse(g.state);
      return { id: g.id, kind: g.kind, status: g.status, p1: g.p1, p2: g.p2, n1: g.n1, n2: g.n2, side, state: st, turn: g.turn, winner: g.winner, result: g.result,
        legal: g.status === 'playing' && g.turn === me.id ? legalFor(g.kind, st, side) : [], updated: g.updated };
    };
    const tell = (g, ev) => roomCall(env, '/broadcast', { msg: { type: 'game', id: g.id, kind: g.kind, ev, by: me.name, to: g.p1 === me.id ? g.p2 : g.p1 }, userIds: [g.p1, g.p2] }).catch(() => {});
    const KN = k => (k === 'xo' ? 'XO' : 'หมากฮอส');
    if (!seg[2] && m === 'GET') {
      const { results } = await db.prepare(SEL + " WHERE (g.p1 = ?1 OR g.p2 = ?1) AND (g.status IN ('invited', 'playing') OR (g.status = 'done' AND g.updated > ?2)) ORDER BY g.updated DESC LIMIT 40").bind(me.id, Date.now() - 86_400_000).all();
      return json(results.map(g => ({ ...view(g), state: undefined, legal: undefined })));
    }
    if (!seg[2] && m === 'POST') {
      const b = await readJson(req), opp = Number(b.opponent), kind = String(b.kind);
      if (!KINDS.includes(kind)) return fail(400, 'ไม่มีเกมนี้');
      if (!opp || opp === me.id) return fail(400, 'เลือกเพื่อนที่จะชวนเล่น');
      const u = await db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').bind(opp).first();
      if (!u) return fail(404, 'ไม่พบผู้ใช้นี้');
      const dup = await db.prepare("SELECT id FROM games WHERE kind = ? AND status IN ('invited', 'playing') AND ((p1 = ? AND p2 = ?) OR (p1 = ? AND p2 = ?))").bind(kind, me.id, opp, opp, me.id).first();
      if (dup) return json({ ok: true, id: dup.id, existing: true });
      const now = Date.now();
      const r = await db.prepare("INSERT INTO games (kind, p1, p2, status, state, turn, created, updated) VALUES (?, ?, ?, 'invited', ?, ?, ?, ?)").bind(kind, me.id, opp, JSON.stringify(startState(kind)), me.id, now, now).run();
      const g = { id: r.meta.last_row_id, kind, p1: me.id, p2: opp };
      await tell(g, 'invite');
      await notify(env, { userId: opp, kind: 'game', title: '🎮 ' + me.name + ' ชวนเล่น ' + KN(kind), body: 'เปิดแอปแล้วไปที่ เกมดวลเพื่อน เพื่อตอบรับ', ref: String(g.id) }).catch(() => {});
      await pushTo(env, [opp]).catch(() => {});
      return json({ ok: true, id: g.id });
    }
    if (id && seg[2] && !seg[3] && m === 'GET') {
      const g = await db.prepare(SEL + ' WHERE g.id = ?').bind(id).first();
      if (!g || (g.p1 !== me.id && g.p2 !== me.id)) return fail(404, 'ไม่พบเกมนี้ (อาจหมดอายุแล้ว)');
      return json(view(g));
    }
    if (id && seg[2] && seg[3] && m === 'POST') {
      const g = await db.prepare(SEL + ' WHERE g.id = ?').bind(id).first();
      if (!g || (g.p1 !== me.id && g.p2 !== me.id)) return fail(404, 'ไม่พบเกมนี้ (อาจหมดอายุแล้ว)');
      const now = Date.now(), side = g.p1 === me.id ? 1 : 2;
      if (seg[3] === 'accept' || seg[3] === 'decline') {
        if (g.status !== 'invited' || g.p2 !== me.id) return fail(409, 'ตอบคำชวนนี้ไม่ได้แล้ว');
        const ok = seg[3] === 'accept';
        await db.prepare('UPDATE games SET status = ?, updated = ? WHERE id = ?').bind(ok ? 'playing' : 'declined', now, id).run();
        await tell(g, ok ? 'accept' : 'decline');
        return json({ ok: true });
      }
      if (seg[3] === 'cancel') {                                   // the inviter withdraws, or either side leaves before it starts
        if (g.status === 'done' || g.status === 'declined') return json({ ok: true });
        await db.prepare('DELETE FROM games WHERE id = ?').bind(id).run();
        await tell(g, 'cancel');
        return json({ ok: true });
      }
      if (g.status !== 'playing') return fail(409, 'เกมนี้ไม่ได้กำลังเล่นอยู่');
      if (seg[3] === 'resign') {
        const win = side === 1 ? g.p2 : g.p1;
        await db.prepare("UPDATE games SET status = 'done', winner = ?, result = 'resign', turn = NULL, updated = ? WHERE id = ?").bind(win, now, id).run();
        await tell(g, 'resign');
        return json({ ok: true });
      }
      if (seg[3] === 'move') {
        if (g.turn !== me.id) return fail(409, 'ยังไม่ถึงตาคุณ');
        const out = applyMove(g.kind, JSON.parse(g.state), side, await readJson(req));
        if (out.error) return fail(400, out.error);
        if (out.end) {
          const win = out.end.winner === 0 ? null : out.end.winner === 1 ? g.p1 : g.p2;
          await db.prepare("UPDATE games SET status = 'done', state = ?, winner = ?, result = ?, turn = NULL, updated = ? WHERE id = ?").bind(JSON.stringify(out.state), win, win ? 'win' : 'draw', now, id).run();
        } else {
          await db.prepare('UPDATE games SET state = ?, turn = ?, updated = ? WHERE id = ?').bind(JSON.stringify(out.state), side === 1 ? g.p2 : g.p1, now, id).run();
        }
        const nextTurn = out.end ? null : side === 1 ? g.p2 : g.p1, winId = out.end ? (out.end.winner === 0 ? null : out.end.winner === 1 ? g.p1 : g.p2) : null;
        await Promise.all([tell(g, out.end ? 'end' : 'move'), out.end ? null : pushTo(env, [nextTurn]).catch(() => {})]);
        return json({ ok: true, state: out.state, status: out.end ? 'done' : 'playing', turn: nextTurn, winner: winId, result: out.end ? (winId ? 'win' : 'draw') : null });
      }
    }
    return fail(404, 'ไม่พบ');
  }
  if (p === '/api/dm' && m === 'GET') {          // my private conversations, newest first
    const { results } = await db.prepare(
      `SELECT m.channel, m.kind, m.name, m.text, m.ms, m.ts, m.user_id FROM messages m
       JOIN (SELECT channel, MAX(id) AS id FROM messages WHERE channel LIKE 'dm:%' GROUP BY channel) x ON x.id = m.id
       ORDER BY m.ts DESC LIMIT 100`).all();
    const mine = results.filter(r => !dmBlocked(r.channel, me));
    const ids = mine.map(r => r.channel.split(':').slice(1).map(Number).find(x => x !== me.id));
    const peers = ids.length ? (await db.prepare(`SELECT ${PUBLIC_USER} FROM users u WHERE u.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results : [];
    const online = new Set((await roomCall(env, '/online')).map(o => o.id));
    return json(mine.map((r, i) => ({ ...r, peer: { ...(peers.find(u => u.id === ids[i]) || { id: ids[i], name: '?' }), online: online.has(ids[i]) } })));
  }
  // ---- voice message to someone (usually offline): PCM16 body, ?rate=16000 · kept like other recordings
  if (seg[1] === 'dm' && id && seg[3] === 'voice' && m === 'POST') {
    if (id === me.id) return fail(400, 'ส่งถึงตัวเองไม่ได้');
    const to = await db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').bind(id).first();
    if (!to) return fail(404, 'ไม่พบผู้ใช้นี้');
    const rate = Math.min(48000, Math.max(8000, Number(url.searchParams.get('rate')) || 16000));
    const buf = await req.arrayBuffer();
    const bytes = buf.byteLength - (buf.byteLength % 2);
    if (bytes < rate * 2 * 0.5) return fail(400, 'ข้อความเสียงสั้นเกินไป');
    if (bytes > rate * 2 * 62) return fail(413, 'ข้อความเสียงยาวได้ไม่เกิน 60 วินาที');
    const ms = Math.round(bytes / 2 / rate * 1000);
    const c = compress([buf], bytes, rate);
    const channel = `dm:${Math.min(me.id, id)}:${Math.max(me.id, id)}`, ts = Date.now();
    const r = await db.prepare(`INSERT INTO messages (ts, channel, kind, name, dept, uid, user_id, ms, audio) VALUES (?, ?, 'talk', ?, ?, '', ?, ?, 'db')`)
      .bind(ts, channel, me.name, me.dept || '', me.id, ms).run();
    const mid = r.meta.last_row_id;
    await db.batch([
      db.prepare('INSERT OR REPLACE INTO audio_clips (msg_id, ts, rate, data) VALUES (?, ?, ?, ?)').bind(mid, ts, c.rate, c.data),
      db.prepare('INSERT INTO voicemail (msg_id, to_id, from_id, ts) VALUES (?, ?, ?, ?)').bind(mid, id, me.id, ts),
      db.prepare('INSERT INTO notifications (ts, user_id, kind, title, body, ref) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(ts, id, 'dm', `🎙 ข้อความเสียงจาก ${me.name}`, `ยาว ${Math.max(1, Math.round(ms / 1000))} วินาที`, 'dm:' + me.id),
    ]);
    const msg = { id: mid, ts, channel, kind: 'talk', name: me.name, dept: me.dept || '', uid: '', user_id: me.id, ms, audio: 1, voice: 1 };
    const from = { id: me.id, name: me.name, dept: me.dept || '' };
    const { delivered } = await roomCall(env, '/broadcast', { msg: { type: 'dm', msg, from, to: id }, userIds: [id] });
    if (!(await roomCall(env, '/online')).some(o => o.id === id)) await pushTo(env, [id]).catch(e => console.error('voice push', e));
    await roomCall(env, '/broadcast', { msg: { type: 'dm', msg, from, to: id, mine: true }, userIds: [me.id] });
    return json({ ok: true, msg, delivered });
  }
  if (p === '/api/missed-talks' && m === 'GET') {   // what was said in my rooms while my app was closed (since I went offline, 12 h at most)
    const mark = await db.prepare("SELECT ts FROM chat_reads WHERE user_id = ? AND channel = '#talk'").bind(me.id).first('ts');
    if (!mark) return json([]);
    const { results } = await db.prepare(
      `SELECT m.id, m.ts, m.channel, m.name, m.ms, 1 AS audio FROM messages m JOIN room_since s ON s.user_id = ?1 AND s.channel = m.channel
       WHERE m.kind = 'talk' AND m.audio IS NOT NULL AND COALESCE(m.user_id, 0) != ?1 AND m.ts > ?2 ORDER BY m.id DESC LIMIT 15`)
      .bind(me.id, Math.max(mark, Date.now() - 12 * 3_600_000)).all();
    return json(results.reverse());
  }
  if (p === '/api/missed-talks/seen' && m === 'POST') {
    await db.prepare("INSERT INTO chat_reads (user_id, channel, ts) VALUES (?, '#talk', ?) ON CONFLICT(user_id, channel) DO UPDATE SET ts = excluded.ts").bind(me.id, Date.now()).run();
    return json({ ok: true });
  }
  if (p === '/api/voicemail' && m === 'GET') {     // voice messages I have not listened to yet
    const { results } = await db.prepare(
      `SELECT v.msg_id AS id, v.ts, v.from_id, COALESCE(u.name, mm.name) AS name, u.dept, u.avatar IS NOT NULL AS has_avatar, mm.ms, mm.channel
       FROM voicemail v JOIN messages mm ON mm.id = v.msg_id LEFT JOIN users u ON u.id = v.from_id
       WHERE v.to_id = ? AND v.heard = 0 AND mm.audio IS NOT NULL ORDER BY v.ts`).bind(me.id).all();
    return json(results);
  }
  if (seg[1] === 'voicemail' && id && seg[3] === 'heard' && m === 'POST') {
    await db.prepare('UPDATE voicemail SET heard = 1 WHERE msg_id = ? AND to_id = ?').bind(id, me.id).run();
    return json({ ok: true });
  }
  if (seg[1] === 'dm' && id && m === 'POST') {    // send a private message
    const text = str((await readJson(req)).text, 1000);
    if (!text) return fail(400, 'กรุณาพิมพ์ข้อความ');
    if (id === me.id) return fail(400, 'ส่งถึงตัวเองไม่ได้');
    const to = await db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').bind(id).first();
    if (!to) return fail(404, 'ไม่พบผู้ใช้นี้');
    const channel = `dm:${Math.min(me.id, id)}:${Math.max(me.id, id)}`, ts = Date.now();
    const r = await db.prepare('INSERT INTO messages (ts, channel, kind, name, dept, uid, user_id, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(ts, channel, 'text', me.name, me.dept || '', '', me.id, text).run();
    const msg = { id: r.meta.last_row_id, ts, channel, kind: 'text', name: me.name, dept: me.dept || '', uid: '', user_id: me.id, text, audio: 0 };
    const from = { id: me.id, name: me.name, dept: me.dept || '' };
    const { delivered } = await roomCall(env, '/broadcast', { msg: { type: 'dm', msg, from, to: id }, userIds: [id] });
    await roomCall(env, '/broadcast', { msg: { type: 'dm', msg, from, to: id, mine: true }, userIds: [me.id] });   // my other screens
    const online = (await roomCall(env, '/online')).some(o => o.id === id);
    if (!online) {      // they'll see it in notifications when they open the app + a pop-up on the phone now
      await db.prepare('INSERT INTO notifications (ts, user_id, kind, title, body, ref) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(ts, id, 'dm', `💬 ${me.name}`, text.slice(0, 120), 'dm:' + me.id).run();
      await pushTo(env, [id]).catch(e => console.error('dm push', e));
    }
    return json({ ok: true, msg, delivered });
  }

  // ---------------------------------------------------------------- messages / history / audio
  if (p === '/api/messages' && m === 'GET') {
    const channel = url.searchParams.get('channel');
    if (!channel) return fail(400, 'ต้องระบุ channel');
    if ((await deniedRooms(db, me)).has(channel)) return fail(403, 'ห้องนี้มีรหัส ใส่รหัสห้องก่อน');
    if (dmBlocked(channel, me)) return fail(403, 'เป็นการคุยส่วนตัวของผู้อื่น');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    // only what was said since I joined this room (private chats are between two people: all of it)
    const since = channel.startsWith('dm:') ? 0
      : ((await db.prepare('SELECT ts FROM room_since WHERE user_id = ? AND channel = ?').bind(me.id, channel).first()) || {}).ts || 0;
    const { results } = await db.prepare(
      `SELECT id, ts, channel, kind, name, dept, uid, user_id, text, ms, (audio IS NOT NULL) AS audio
       FROM messages WHERE channel = ? AND id < ? AND ts >= ? ORDER BY id DESC LIMIT ?`).bind(channel, before, since, limit).all();
    results.reverse();
    return json({ msgs: results, reactions: await reactionsFor(db, results.map(r => r.id)), more: results.length === limit });
  }
  if (p === '/api/conversations' && m === 'GET') {
    const { results } = await db.prepare(
      `SELECT m.channel, m.kind, m.name, m.text, m.ms, m.ts, m.id FROM messages m
       JOIN (SELECT channel, MAX(id) AS id FROM messages GROUP BY channel) x ON x.id = m.id`).all();
    const denied = await deniedRooms(db, me);
    return json(results.filter(r => !denied.has(r.channel) && !dmBlocked(r.channel, me)));
  }
  if (p === '/api/history' && m === 'GET') {
    const kind = url.searchParams.get('kind');
    const days = Math.min(Number(url.searchParams.get('days')) || 7, 90);
    const q = (url.searchParams.get('q') || '').trim();
    let sql = `SELECT id, ts, channel, kind, name, dept, user_id, text, ms, (audio IS NOT NULL) AS audio FROM messages WHERE ts > ?`;
    const args = [Date.now() - days * 86_400_000];
    if (kind === 'talk' || kind === 'text') { sql += ' AND kind = ?'; args.push(kind); }
    if (q) { sql += ' AND (name LIKE ? OR channel LIKE ? OR text LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    sql += ' ORDER BY id DESC LIMIT 300';
    const denied = await deniedRooms(db, me);
    return json((await db.prepare(sql).bind(...args).all()).results.filter(r => !denied.has(r.channel) && !dmBlocked(r.channel, me)));
  }
  if (seg[1] === 'audio' && m === 'GET') {
    const row = await db.prepare('SELECT audio, channel FROM messages WHERE id = ?').bind(id).first();
    if (row && ((await deniedRooms(db, me)).has(row.channel) || dmBlocked(row.channel, me))) return fail(403, 'ไม่มีสิทธิ์ฟังเสียงนี้');
    const key = row && row.audio;
    if (key === 'db') {
      const clip = await db.prepare('SELECT rate, data FROM audio_clips WHERE msg_id = ?').bind(id).first();
      if (!clip) return fail(404, 'ไม่พบไฟล์เสียง (อาจถูกลบตามระยะเวลาเก็บ)');
      const out = toWav(new Uint8Array(clip.data), clip.rate);
      return new Response(out, { headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(out.length), 'Cache-Control': 'private, max-age=86400', ...CORS } });
    }
    if (!env.REC) return fail(404, 'ไม่พบไฟล์เสียง');
    const obj = key && await env.REC.get(key);
    if (!obj) return fail(404, 'ไม่พบไฟล์เสียง (อาจถูกลบตามระยะเวลาเก็บ)');
    return new Response(obj.body, { headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(obj.size), 'Cache-Control': 'private, max-age=86400', ...CORS } });
  }
  if (p === '/api/log' && m === 'GET') {
    if (!roleAtLeast(me.role, 'lead')) return fail(403, 'ไม่มีสิทธิ์ใช้งานส่วนนี้');
    return log(env, url);
  }

  // ---------------------------------------------------------------- tasks (งานของฉัน)
  if (p === '/api/tasks' && m === 'GET') {
    const scope = url.searchParams.get('scope') || 'today';
    const base = `SELECT t.*, a.name AS assignee_name, c.name AS creator_name FROM tasks t
                  JOIN users a ON a.id = t.assignee_id JOIN users c ON c.id = t.created_by`;
    let rows;
    if (scope === 'assigned') rows = await db.prepare(`${base} WHERE t.created_by = ? ORDER BY t.done_at IS NOT NULL, t.due_at LIMIT 200`).bind(me.id).all();
    else if (scope === 'all') rows = await db.prepare(`${base} WHERE t.assignee_id = ? ORDER BY t.done_at IS NOT NULL, t.due_at LIMIT 200`).bind(me.id).all();
    else {
      const start = Number(url.searchParams.get('dayStart')) || new Date().setHours(0, 0, 0, 0);
      // today = everything still open + what was finished today
      rows = await db.prepare(`${base} WHERE t.assignee_id = ? AND (t.done_at IS NULL OR t.done_at >= ?)
                               ORDER BY t.done_at IS NOT NULL, t.due_at IS NULL, t.due_at LIMIT 200`).bind(me.id, start).all();
    }
    return json(rows.results);
  }
  if (p === '/api/tasks' && m === 'POST') {
    if (!roleAtLeast(me.role, 'lead')) return fail(403, 'เฉพาะหัวหน้าหรือผู้ดูแลระบบที่มอบงานได้');
    const b = await readJson(req);
    const title = str(b.title, 120);
    if (!title) return fail(400, 'กรุณาใส่ชื่องาน');
    let ids = Array.isArray(b.assignee_ids) ? b.assignee_ids.map(Number).filter(Boolean) : [];
    if (b.channel_id) ids = ids.concat((await db.prepare('SELECT id FROM users WHERE main_channel = ? AND active = 1').bind(Number(b.channel_id)).all()).results.map(r => r.id));
    ids = [...new Set(ids)];
    if (!ids.length) return fail(400, 'กรุณาเลือกผู้รับงาน');
    const due = Number(b.due_at) || null, now = Date.now();
    for (const uid of ids) {
      const r = await db.prepare('INSERT INTO tasks (title, detail, due_at, assignee_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(title, str(b.detail, 500), due, uid, me.id, now).run();
      await notify(env, { userId: uid, kind: 'task', title: `งานใหม่: ${title}`, body: `มอบโดย ${me.name}`, ref: `task:${r.meta.last_row_id}` });
    }
    return json({ ok: true, count: ids.length });
  }
  if (seg[1] === 'tasks' && id && m === 'PATCH') {
    const t = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
    if (!t) return fail(404, 'ไม่พบงาน');
    if (t.assignee_id !== me.id && t.created_by !== me.id && !roleAtLeast(me.role, 'admin')) return fail(403, 'ไม่มีสิทธิ์แก้งานนี้');
    const b = await readJson(req);
    await db.prepare('UPDATE tasks SET done_at = ? WHERE id = ?').bind(b.done ? Date.now() : null, id).run();
    if (b.done && t.created_by !== me.id) await notify(env, { userId: t.created_by, kind: 'task', title: `งานเสร็จแล้ว: ${t.title}`, body: `โดย ${me.name}`, ref: `task:${id}` });
    return json({ ok: true });
  }
  if (seg[1] === 'tasks' && id && m === 'DELETE') {
    const t = await db.prepare('SELECT created_by FROM tasks WHERE id = ?').bind(id).first();
    if (!t) return fail(404, 'ไม่พบงาน');
    if (t.created_by !== me.id && !roleAtLeast(me.role, 'admin')) return fail(403, 'ลบได้เฉพาะคนที่มอบงาน');
    await db.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  // ---------------------------------------------------------------- SOS
  if (p === '/api/push/latest' && m === 'GET') {
    const now = Date.now();
    const sos = await db.prepare(`SELECT s.ts, s.place, u.name AS reporter, u.dept AS reporter_dept FROM sos s JOIN users u ON u.id = s.user_id
      WHERE s.status = 'open' AND s.ts > ? AND s.user_id != ? ORDER BY s.id DESC LIMIT 1`).bind(now - 30 * 60_000, me.id).first();
    const call = await db.prepare(`SELECT ts, title, body FROM notifications WHERE user_id = ? AND kind = 'call' AND ts > ? ORDER BY id DESC LIMIT 1`).bind(me.id, now - 90_000).first();
    const n = await db.prepare(`SELECT ts, kind, title, body, ref FROM notifications WHERE user_id = ? AND kind IN ('dm', 'room') AND ts > ? ORDER BY id DESC LIMIT 1`).bind(me.id, now - 30 * 60_000).first();
    if (sos && (!n || sos.ts >= n.ts)) return json({ kind: 'sos', title: '🚨 แจ้งเหตุฉุกเฉิน', body: `แจ้งโดย ${sos.reporter}${sos.reporter_dept ? ' (' + sos.reporter_dept + ')' : ''}${sos.place ? ' · ' + sos.place : ''}`, url: './#/sos' });
    if (call && (!n || call.ts >= n.ts) && (!sos || call.ts >= sos.ts)) return json({ kind: 'call', title: call.title, body: call.body, url: './' });
    if (n && n.kind === 'room') return json({ kind: 'dm', title: n.title, body: n.body, url: './#/convos', tag: n.ref });
    if (n) { const from = /^dm:(\d+)$/.exec(n.ref || ''); return json({ kind: n.title.startsWith('🎙') ? 'voice' : 'dm', title: n.title, body: n.body, url: from ? `./#/dm?u=${from[1]}` : './#/notifications', tag: n.ref || 'dm' }); }
    return json({ kind: 'none' });
  }
  if (p === '/api/sos' && m === 'GET') {
    const { results } = await db.prepare(
      `SELECT s.*, u.name AS reporter, u.dept AS reporter_dept, (SELECT COUNT(*) FROM sos_acks a WHERE a.sos_id = s.id) AS acks,
              EXISTS(SELECT 1 FROM sos_acks a WHERE a.sos_id = s.id AND a.user_id = ?) AS acked
       FROM sos s JOIN users u ON u.id = s.user_id ORDER BY s.id DESC LIMIT 30`).bind(me.id).all();
    return json(results);
  }
  if (p === '/api/sos' && m === 'POST') {
    const b = await readJson(req);
    if (!SOS_KINDS[b.kind]) b.kind = 'general';            // one-press SOS: no type to choose
    const recent = await db.prepare('SELECT COUNT(*) AS n FROM sos WHERE user_id = ? AND ts > ?').bind(me.id, Date.now() - 60_000).first('n');
    if (recent >= 3) return fail(429, 'แจ้งเหตุถี่เกินไป รอสักครู่');
    const lat = Number.isFinite(Number(b.lat)) && b.lat !== null ? Number(b.lat) : null;
    const lng = Number.isFinite(Number(b.lng)) && b.lng !== null ? Number(b.lng) : null;
    const r = await db.prepare('INSERT INTO sos (ts, user_id, kind, note, place, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(Date.now(), me.id, b.kind, str(b.note, 300), str(b.place, 120), lat, lng).run();
    const sos = { id: r.meta.last_row_id, ts: Date.now(), kind: b.kind, kind_name: SOS_KINDS[b.kind], note: str(b.note, 300), place: str(b.place, 120), lat, lng,
                  reporter: me.name, reporter_dept: me.dept, user_id: me.id, status: 'open', acks: 0 };
    await db.prepare('INSERT INTO notifications (ts, user_id, kind, title, body, ref) VALUES (?, NULL, ?, ?, ?, ?)')
      .bind(sos.ts, 'sos', `แจ้งเหตุฉุกเฉิน: ${sos.kind_name}`, `${me.name} (${me.dept || '-'})${sos.place ? ' · ' + sos.place : ''}`, `sos:${sos.id}`).run();
    const [{ delivered }, push] = await Promise.all([
      roomCall(env, '/broadcast', { msg: { type: 'sos', sos } }),
      pushAll(env, { exceptUserId: me.id }).catch(e => { console.error('sos push', e); return { sent: 0 }; }),
    ]);
    sos.pushed = push.sent || 0;
    return json({ ...sos, delivered });
  }
  if (seg[1] === 'sos' && id && seg[3] === 'ack' && m === 'POST') {
    await db.prepare('INSERT OR IGNORE INTO sos_acks (sos_id, user_id, ts) VALUES (?, ?, ?)').bind(id, me.id, Date.now()).run();
    const acks = await db.prepare('SELECT COUNT(*) AS n FROM sos_acks WHERE sos_id = ?').bind(id).first('n');
    await roomCall(env, '/broadcast', { msg: { type: 'sos_ack', id, by: me.name, acks } });
    return json({ ok: true, acks });
  }
  if (seg[1] === 'sos' && id && seg[3] === 'close' && m === 'POST') {
    if (!roleAtLeast(me.role, 'lead')) return fail(403, 'เฉพาะหัวหน้าหรือผู้ดูแลระบบที่ปิดเหตุได้');
    await db.prepare(`UPDATE sos SET status = 'closed', closed_by = ?, closed_at = ? WHERE id = ?`).bind(me.id, Date.now(), id).run();
    await roomCall(env, '/broadcast', { msg: { type: 'sos_closed', id, by: me.name } });
    return json({ ok: true });
  }

  // ---------------------------------------------------------------- map
  if (p === '/api/map' && m === 'GET') {
    const { results } = await db.prepare('SELECT p.*, c.name AS channel_name FROM map_pins p LEFT JOIN channels c ON c.id = p.channel_id ORDER BY p.id').all();
    const has = await db.prepare(`SELECT 1 AS x FROM settings WHERE key = 'map_image'`).first('x');
    return json({ pins: results, image: !!has });
  }
  if (p === '/api/map/image' && m === 'GET') return imageResponse(await db.prepare(`SELECT value FROM settings WHERE key = 'map_image'`).first('value'));
  if (p === '/api/map/image' && m === 'PUT') {
    if (!roleAtLeast(me.role, 'admin')) return fail(403, 'เฉพาะผู้ดูแลระบบ');
    const b = await readJson(req);
    if (!b.data) await db.prepare(`DELETE FROM settings WHERE key = 'map_image'`).run();
    else await db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('map_image', ?)`).bind(dataUrl(b.data, 1_400_000)).run();
    return json({ ok: true });
  }
  if (seg[1] === 'map' && seg[2] === 'pins') {
    if (!roleAtLeast(me.role, 'admin')) return fail(403, 'เฉพาะผู้ดูแลระบบ');
    const pid = Number(seg[3]);
    if (m === 'DELETE' && pid) { await db.prepare('DELETE FROM map_pins WHERE id = ?').bind(pid).run(); return json({ ok: true }); }
    const b = await readJson(req);
    const v = [str(b.name, 40) || 'จุดใหม่', ICONS.includes(b.icon) ? b.icon : 'pin', COLORS.includes(b.color) ? b.color : 'blue',
      Math.min(Math.max(Number(b.x) || 50, 0), 100), Math.min(Math.max(Number(b.y) || 50, 0), 100), Number(b.channel_id) || null, str(b.note, 200)];
    const coord = (val, lim) => (val === null || val === undefined || val === '' || !Number.isFinite(Number(val)) || Math.abs(Number(val)) > lim ? null : Number(val));
    v.push(coord(b.lat, 90), coord(b.lng, 180));
    if (m === 'POST') { const r = await db.prepare('INSERT INTO map_pins (name, icon, color, x, y, channel_id, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(...v).run(); return json({ id: r.meta.last_row_id }); }
    if (m === 'PATCH' && pid) { await db.prepare('UPDATE map_pins SET name = ?, icon = ?, color = ?, x = ?, y = ?, channel_id = ?, note = ?, lat = ?, lng = ? WHERE id = ?').bind(...v, pid).run(); return json({ ok: true }); }
  }

  // ---------------------------------------------------------------- notifications
  if (p === '/api/notifications' && m === 'GET') {
    const lr = (await db.prepare('SELECT last_read FROM notif_reads WHERE user_id = ?').bind(me.id).first('last_read')) || 0;
    const { results } = await db.prepare('SELECT * FROM notifications WHERE user_id IS NULL OR user_id = ? ORDER BY ts DESC LIMIT 60').bind(me.id).all();
    return json(results.map(n => ({ ...n, read: n.ts <= lr })));
  }
  if (p === '/api/notifications/read' && m === 'POST') {
    await db.prepare('INSERT OR REPLACE INTO notif_reads (user_id, last_read) VALUES (?, ?)').bind(me.id, Date.now()).run();
    return json({ ok: true });
  }

  // ---------------------------------------------------------------- report (lead+)
  if (p === '/api/report' && m === 'GET') {
    if (!roleAtLeast(me.role, 'lead')) return fail(403, 'ไม่มีสิทธิ์ใช้งานส่วนนี้');
    const days = Math.min(Number(url.searchParams.get('days')) || 7, 90);
    const from = Date.now() - days * 86_400_000;
    const [users, chans, notes, byDept, byChan, online, talkMs] = await Promise.all([
      db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').first('n'),
      db.prepare('SELECT COUNT(*) AS n FROM channels WHERE active = 1').first('n'),
      db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE ts > ?').bind(from).first('n'),
      db.prepare(`SELECT COALESCE(NULLIF(u.dept, ''), NULLIF(m.dept, ''), 'ไม่ระบุ') AS dept, COUNT(*) AS n FROM messages m LEFT JOIN users u ON u.id = m.user_id
                  WHERE m.ts > ? GROUP BY 1 ORDER BY n DESC LIMIT 12`).bind(from).all(),
      db.prepare('SELECT channel, COUNT(*) AS n FROM messages WHERE ts > ? GROUP BY channel ORDER BY n DESC').bind(from).all(),
      roomCall(env, '/online'),
      db.prepare(`SELECT COALESCE(SUM(ms), 0) AS ms, COUNT(*) AS n FROM messages WHERE kind = 'talk' AND ts > ?`).bind(from).first(),
    ]);
    const sos = await db.prepare('SELECT COUNT(*) AS n FROM sos WHERE ts > ?').bind(from).first('n');
    return json({ days, users, online: online.length, channels: chans, notifications: notes, sos, talks: talkMs.n, talk_ms: talkMs.ms, byDept: byDept.results, byChannel: byChan.results });
  }

  // ---------------------------------------------------------------- admin
  if (seg[1] === 'admin') {
    if (!roleAtLeast(me.role, 'admin')) return fail(403, 'เฉพาะผู้ดูแลระบบ');
    const aid = Number(seg[3]);
    if (seg[2] === 'users') {
      if (m === 'GET') return json((await db.prepare(`SELECT ${PUBLIC_USER}, c.name AS main_channel_name FROM users u LEFT JOIN channels c ON c.id = u.main_channel ORDER BY u.active DESC, u.name`).all()).results);
      const b = await readJson(req);
      const fields = { emp: str(b.emp, 32), name: str(b.name, 40), dept: str(b.dept, 40), position: str(b.position, 60),
        main_channel: Number(b.main_channel) || null, role: ROLES.includes(b.role) ? b.role : 'user' };
      if (m === 'POST') {
        if (!fields.emp || !fields.name) return fail(400, 'กรุณาใส่รหัสพนักงานและชื่อ');
        if (String(b.password || '').length < 6) return fail(400, 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัว');
        if (await db.prepare('SELECT 1 AS x FROM users WHERE emp = ?').bind(fields.emp).first('x')) return fail(409, 'รหัสพนักงานนี้มีอยู่แล้ว');
        const r = await db.prepare('INSERT INTO users (emp, name, dept, position, main_channel, role, pass, created_at, must_change) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
          .bind(fields.emp, fields.name, fields.dept, fields.position, fields.main_channel, fields.role, await hashPassword(String(b.password)), Date.now()).run();
        return json({ id: r.meta.last_row_id });
      }
      if (m === 'PATCH' && aid) {
        const cur = await db.prepare('SELECT * FROM users WHERE id = ?').bind(aid).first();
        if (!cur) return fail(404, 'ไม่พบผู้ใช้');
        const active = 'active' in b ? (b.active ? 1 : 0) : cur.active;
        if (aid === me.id && (fields.role !== 'admin' || !active)) return fail(400, 'ลดสิทธิ์หรือปิดบัญชีตัวเองไม่ได้');
        if (fields.emp && fields.emp.toLowerCase() !== cur.emp.toLowerCase() && await db.prepare('SELECT 1 AS x FROM users WHERE emp = ?').bind(fields.emp).first('x')) return fail(409, 'รหัสพนักงานนี้มีอยู่แล้ว');
        await db.prepare('UPDATE users SET emp = ?, name = ?, dept = ?, position = ?, main_channel = ?, role = ?, active = ? WHERE id = ?')
          .bind(fields.emp || cur.emp, fields.name || cur.name, fields.dept, fields.position, fields.main_channel, fields.role, active, aid).run();
        if (b.password) {
          if (String(b.password).length < 6) return fail(400, 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัว');
          await db.prepare('UPDATE users SET pass = ?, must_change = 1 WHERE id = ?').bind(await hashPassword(String(b.password)), aid).run();
        }
        if (b.password || !active) await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(aid).run();   // force re-login
        return json({ ok: true });
      }
    }
    if (seg[2] === 'channels') {
      if (m === 'GET') return json((await db.prepare('SELECT id, name, sub, icon, color, sort, active, created_by, created_at, (pass IS NOT NULL) AS locked FROM channels ORDER BY active DESC, sort, id').all()).results);
      const b = await readJson(req);
      const v = [str(b.name, 40), str(b.sub, 60), ICONS.includes(b.icon) ? b.icon : 'radio', COLORS.includes(b.color) ? b.color : 'blue', Number(b.sort) || 100];
      if (m === 'POST') {
        if (!v[0]) return fail(400, 'กรุณาใส่ชื่อกลุ่ม');
        try { await db.prepare('INSERT INTO channels (name, sub, icon, color, sort) VALUES (?, ?, ?, ?, ?)').bind(...v).run(); }
        catch { return fail(409, 'มีกลุ่มชื่อนี้แล้ว'); }
      } else if (m === 'PATCH' && aid) {
        await db.prepare('UPDATE channels SET name = ?, sub = ?, icon = ?, color = ?, sort = ?, active = ? WHERE id = ?').bind(...v, 'active' in b ? (b.active ? 1 : 0) : 1, aid).run();
      } else if (m === 'DELETE' && aid) {
        await deleteChannel(db, aid);
      } else return fail(405, 'not allowed');
      if (m === 'PATCH' && 'password' in b) await db.prepare('UPDATE channels SET pass = ? WHERE id = ?').bind(b.password ? await hashPassword(String(b.password)) : null, aid).run();
      await roomCall(env, '/reload');
      return json({ ok: true });
    }
    if (seg[2] === 'announce' && m === 'POST') {
      const b = await readJson(req);
      if (!str(b.title, 80)) return fail(400, 'กรุณาใส่หัวข้อ');
      return json(await notify(env, { kind: 'system', title: str(b.title, 80), body: str(b.body, 300) }));
    }
  }
  return fail(404, 'not found');
}

async function log(env, url) {
  const p = url.searchParams;
  const to = Number(p.get('to')) || Date.now();
  const from = Number(p.get('from')) || to - 7 * 86_400_000;
  const limit = Math.min(Math.max(Number(p.get('limit')) || 200, 1), 5000);
  const channel = p.get('channel');
  const events = (p.get('events') || 'talk,join,leave').split(',').filter(e => ['talk', 'join', 'leave'].includes(e));
  if (!events.length) return json([]);
  let sql = `SELECT ts, event, channel, name, ms, reason FROM walkie_log WHERE ts BETWEEN ? AND ? AND event IN (${events.map(() => '?').join(',')})`;
  const args = [from, to, ...events];
  if (channel) { sql += ' AND channel = ?'; args.push(channel); }
  sql += ' ORDER BY ts DESC LIMIT ?';
  args.push(limit);
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  if (p.get('format') === 'csv') {
    const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'medium' });
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['เวลา (ไทย),เหตุการณ์,ช่อง,ชื่อ,วินาที,เหตุผล'];
    for (const r of results) lines.push([fmt.format(r.ts), r.event, r.channel, r.name, r.ms == null ? '' : (r.ms / 1000).toFixed(1), r.reason].map(q).join(','));
    return new Response('﻿' + lines.join('\r\n'), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="walkie-log.csv"', ...API },
    });
  }
  return json(results);
}
