// ห้องวอ (Durable Object): โปรโตคอลเดียวกับ server/server.js
// - join / ptt_start / ptt_end / leave  ->  joined / state / talk_granted / busy / talk_start / talk_end
// - เสียง PCM 16-bit เป็น binary ส่งต่อเฉพาะจากคนที่ถือสิทธิ์พูด
// เพิ่มเติม (client เดิมไม่สนใจข้อความชนิดใหม่):
// - บัญชีพนักงาน: join ต้องมี token (หรือ code = token สำหรับแอป Android) ผิด -> {type:'error', code:'auth'}
// - บันทึกเสียงแต่ละครั้งที่พูดเป็นไฟล์ WAV ลง R2 (ถ้าผูก bucket "REC") แล้วฟังย้อนผ่าน /api/audio/<id>
// - chat / react / roster / notify, และ /broadcast สำหรับ SOS กับงาน (เรียกจาก worker)
// - {"type":"ping"} -> {"type":"pong"} ตอบโดย runtime (ไม่ปลุก DO) และใช้ตัดเครื่องที่หายไป
// ใช้ WebSocket Hibernation API: ไม่มีใครพูด = DO หลับได้
import { compress } from './codec.js';
import { DurableObject } from 'cloudflare:workers';
import { userFromToken } from './auth.js';
import { pushTo } from './push.js';

const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';
const SWEEP_MS = 25_000;
const STALE_MS = 50_000;
export const EMOJIS = ['👍', '✅', '❤️', '🙏', '😂'];
// the all-hands channel: everyone who is not in a separate room is here and hears each other
export const LOBBY = 'ทุกคน';

export class WalkieRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.maxTalkMs = Number(env.MAX_TALK_MS) || 60_000;
    this.talker = new Map(); // channel -> { ws, name, uid, since, timer, rate }
    this.rec = new Map();    // channel -> { chunks: ArrayBuffer[], bytes }
    this.hearing = new Map(); // ws -> the room whose voice this listener hears now (one room at a time, no mixing)
    this.channels = null;    // names, loaded from D1 (or env.CHANNELS without a database)
    this.meta = new Map();   // name -> { id, locked, created_by }
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async loadChannels(force) {
    if (this.channels && !force) return this.channels;
    let list = [];
    if (this.env.DB) {
      // with a database the rooms are exactly what is in D1 (may be none: people create their own)
      try {
        const { results } = await this.env.DB.prepare('SELECT id, name, (pass IS NOT NULL) AS locked, created_by FROM channels WHERE active = 1 ORDER BY sort, id').all();
        list = results.map(r => r.name);
        this.meta = new Map(results.map(r => [r.name, { id: r.id, locked: !!r.locked, created_by: r.created_by }]));
      } catch { list = this.channels || []; }
    } else {
      list = String(this.env.CHANNELS || '').split('|').map(s => s.trim()).filter(Boolean);
      if (!list.length) list = ['ช่อง 1 - ทั่วไป'];
    }
    this.channels = this.env.DB ? [LOBBY, ...list.filter(n => n !== LOBBY)] : list;
    return list;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/channels') {
      const chans = await this.loadChannels();
      return Response.json(chans.map(name => ({ name, users: this.uniqueIn(name).length })));
    }
    if (url.pathname === '/online') {
      const seen = new Map();
      for (const ws of this.authed()) { const c = this.info(ws); if (c.channel && c.uid) seen.set(c.uid, c.channel); }
      return Response.json([...seen].map(([id, channel]) => ({ id, channel })));
    }
    if (url.pathname === '/reload') {           // rooms created / changed / deleted
      await this.loadChannels(true);
      for (const ws of this.authed()) {
        const c = this.info(ws);
        const gone = this.roomsOf(c).filter(r => !r.startsWith('dm:') && !this.channels.includes(r));
        if (gone.length) {                       // room deleted: take it out of this person's rooms
          const keep = this.roomsOf(c).filter(r => !gone.includes(r));
          let active = gone.includes(c.channel) ? (keep.find(r => !r.startsWith('dm:')) || LOBBY) : c.channel;
          if (!keep.includes(active)) keep.unshift(active);
          this.setInfo(ws, { ...c, channel: active, rooms: keep });
          for (const g of gone) {
            this.afterLeft(ws, c, g);
            this.send(ws, { type: 'error', code: 'room_deleted', channel: g, message: `ห้อง "${g}" ถูกลบแล้ว` });
          }
        }
        this.send(ws, { type: 'channels', channels: this.channels });
      }
      this.broadcastRoster();
      return new Response('ok');
    }
    if (url.pathname === '/kick') {             // the account signed in on another device
      const { userId } = await req.json();
      let n = 0;
      for (const ws of this.authed()) {
        if (this.info(ws).uid !== Number(userId)) continue;
        this.leave(ws);
        this.send(ws, { type: 'error', code: 'replaced', message: 'บัญชีนี้เข้าสู่ระบบจากเครื่องอื่นแล้ว เครื่องนี้จึงออกจากระบบ' });
        try { ws.close(4002, 'replaced'); } catch {}
        n++;
      }
      return Response.json({ kicked: n });
    }
    if (url.pathname === '/broadcast') {        // SOS, task assigned, notification
      const { msg, userIds, channel } = await req.json();
      const only = Array.isArray(userIds) ? new Set(userIds.map(Number)) : null;
      let n = 0;
      for (const ws of this.authed()) {
        const c = this.info(ws);
        if ((only && only.has(c.uid)) || (channel && this.roomsOf(c).includes(channel)) || (!only && !channel)) { this.send(ws, msg); n++; }
      }
      return Response.json({ delivered: n });
    }
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    await this.loadChannels();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    this.setInfo(server, { cid: randomId(), uid: null, name: null, dept: '', role: 'user', channel: null, rooms: [], ok: !this.env.DB });
    await this.ensureAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** open room, or the creator / an admin / someone who already entered the room password */
  async canEnter(ch, uid, role) {
    const m = this.meta.get(ch);
    if (!m || !this.env.DB) return true;
    if (role === 'admin' || (uid && m.created_by === uid)) return true;
    if (uid) {
      try { if (await this.env.DB.prepare('SELECT 1 FROM channel_bans WHERE channel_id = ? AND user_id = ?').bind(m.id, uid).first()) return false; } catch {}
    }
    if (!m.locked) return true;
    if (!uid) return false;
    try { return !!(await this.env.DB.prepare('SELECT 1 FROM channel_access WHERE channel_id = ? AND user_id = ?').bind(m.id, uid).first()); }
    catch { return false; }
  }

  // ---------------------------------------------------------------- helpers
  info(ws) { try { return ws.deserializeAttachment(); } catch { return null; } }
  setInfo(ws, v) { ws.serializeAttachment(v); }
  authed() { return this.ctx.getWebSockets().filter(ws => this.info(ws)?.ok); }
  /** the rooms this connection is in (old single-room clients: just their channel) */
  roomsOf(c) { return c && Array.isArray(c.rooms) && c.rooms.length ? c.rooms : c && c.channel ? [c.channel] : []; }
  members(ch) { return this.ctx.getWebSockets().filter(ws => this.roomsOf(this.info(ws)).includes(ch)); }
  joinedAll() { return this.authed().filter(ws => this.roomsOf(this.info(ws)).length); }
  /** one entry per person (the same account may be open on two phones) */
  uniqueIn(ch) {
    const seen = new Map();
    for (const ws of this.members(ch)) { const c = this.info(ws); seen.set(c.uid ?? `c${c.cid}`, c); }
    return [...seen.values()];
  }
  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch {} }

  broadcastState(ch) {
    const list = this.members(ch);
    const users = this.uniqueIn(ch).map(c => ({ id: c.uid ?? c.cid, name: c.name, dept: c.dept }));
    const t = this.talker.get(ch);
    for (const ws of list) this.send(ws, { type: 'state', channel: ch, users, talker: t ? t.name : null });
  }

  broadcastRoster() {
    const all = this.joinedAll();
    const byId = new Map();
    for (const ws of all) {
      const c = this.info(ws);
      const mask = r => (r && r.startsWith('dm:') ? 'คุยส่วนตัว' : r);
      byId.set(c.uid ?? `c${c.cid}`, { id: c.uid ?? c.cid, name: c.name, dept: c.dept, channel: mask(c.channel), rooms: this.roomsOf(c).map(mask),
        talking: this.roomsOf(c).some(r => this.talker.get(r)?.ws === ws) });
    }
    const users = [...byId.values()];
    const msg = { type: 'roster', users, channels: (this.channels || []).map(name => ({ name, users: users.filter(u => u.rooms.includes(name)).length })) };
    for (const ws of this.authed()) this.send(ws, msg);   // also people who are not in a room yet
  }

  /** a room text message reaches people whose app is closed: a push with the text (at most one per person per room every 2 minutes) */
  async pushRoomText(room, me, m) {
    try {
      const db = this.env.DB; if (!db) return;
      const online = new Set(); for (const ws of this.authed()) { const c = this.info(ws); if (c.uid) online.add(c.uid); }
      const ch = await db.prepare('SELECT id, (pass IS NOT NULL) AS locked FROM channels WHERE name = ? AND active = 1').bind(room).first();
      const now = Date.now(), ref = 'ch:' + room;
      const lobby = room === LOBBY;
      if (!lobby && !ch) return;
      const { results } = await db.prepare(
        `SELECT DISTINCT p.user_id FROM push_subs p JOIN users u ON u.id = p.user_id AND u.active = 1 AND COALESCE(u.room_push, 1) = 1
         WHERE p.user_id != ?1 AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = p.user_id AND n.ref = ?2 AND n.ts > ?3)
           AND (?4 = 1 OR u.main_channel = ?5 OR p.user_id IN (SELECT user_id FROM channel_access WHERE channel_id = ?5)
                OR (?6 = 0 AND p.user_id IN (SELECT user_id FROM messages WHERE channel = ?7 AND ts > ?8 AND user_id IS NOT NULL)))
           AND NOT EXISTS (SELECT 1 FROM channel_bans b WHERE b.channel_id = ?5 AND b.user_id = p.user_id)`)
        .bind(me.uid || 0, ref, now - 120_000, lobby ? 1 : 0, ch ? ch.id : -1, ch && ch.locked ? 1 : 0, room, now - 3 * 86_400_000).all();
      const ids = results.map(r => r.user_id).filter(id => !online.has(id));
      if (!ids.length) return;
      const title = `${me.name} · ${room}`, body = String(m.text || '').slice(0, 140);
      await db.batch(ids.map(id => db.prepare("INSERT INTO notifications (ts, user_id, kind, title, body, ref) VALUES (?, ?, 'room', ?, ?, ?)").bind(now, id, title, body, ref)));
      await pushTo(this.env, ids);
    } catch (e) { console.error('room push', e); }
  }

  publish(ch, msg) {
    for (const ws of this.members(ch)) this.send(ws, { type: 'chat', msg });
    if (this.meta.get(ch)?.locked || ch.startsWith('dm:')) return;     // never show locked / private messages to people outside
    const note = { type: 'notify', channel: ch, msg };
    for (const ws of this.joinedAll()) if (!this.roomsOf(this.info(ws)).includes(ch)) this.send(ws, note);
  }

  async releaseFloor(ch, reason = 'end') {
    const t = this.talker.get(ch);
    if (!t) return;
    clearTimeout(t.timer);
    this.talker.delete(ch);
    const rec = this.rec.get(ch);
    this.rec.delete(ch);
    const ms = Date.now() - t.since;
    for (const ws of this.members(ch)) {
      if (this.hearing.get(ws) === ch) this.hearing.delete(ws);
      this.send(ws, { type: 'talk_end', name: t.name, reason, ms, channel: ch });
    }
    this.broadcastState(ch);
    this.broadcastRoster();
    this.log('talk', ch, t.name, ms, reason);
    const msg = await this.store({ channel: ch, kind: 'talk', name: t.name, dept: t.dept, uid: t.devUid, userId: t.uid, ms });
    if (!msg) return;
    if (!this.env.REC && this.env.DB && rec && rec.bytes >= 3200) {   // no R2: compressed clip in D1
      try {
        const c = compress(rec.chunks, rec.bytes, t.rate || 16000);
        await this.env.DB.batch([
          this.env.DB.prepare('INSERT OR REPLACE INTO audio_clips (msg_id, ts, rate, data) VALUES (?, ?, ?, ?)').bind(msg.id, msg.ts, c.rate, c.data),
          this.env.DB.prepare(`UPDATE messages SET audio = 'db' WHERE id = ?`).bind(msg.id),
        ]);
        msg.audio = 1;
      } catch (e) { console.error('recording save failed', e); }
    }
    if (this.env.REC && rec && rec.bytes >= 3200) {             // >= 0.1 s of audio
      const key = `rec/${new Date().toISOString().slice(0, 10)}/${msg.id}.wav`;
      try {
        await this.env.REC.put(key, wav(rec.chunks, rec.bytes, t.rate), { httpMetadata: { contentType: 'audio/wav' } });
        await this.env.DB.prepare('UPDATE messages SET audio = ? WHERE id = ?').bind(key, msg.id).run();
        msg.audio = 1;
      } catch (e) { console.error('recording save failed', e); }
    }
    this.publish(ch, msg);
    if (msg.audio) this.ctx.waitUntil(this.pushRoomTalk(ch, t, msg));
  }

  async wentOffline(ws) {
    try {
      const c = this.info(ws);
      if (!c || !c.uid || !this.env.DB) return;
      if (this.authed().some(o => o !== ws && this.info(o).uid === c.uid)) return;      // still on another screen
      await this.env.DB.prepare("INSERT INTO chat_reads (user_id, channel, ts) VALUES (?, '#talk', ?) ON CONFLICT(user_id, channel) DO UPDATE SET ts = excluded.ts").bind(c.uid, Date.now()).run();
    } catch {}
  }
  /** someone talked in a room: members whose app is closed get a push (at most one per person per room a minute); they can listen when they open the app */
  async pushRoomTalk(room, t, m) {
    try {
      const db = this.env.DB; if (!db || room.startsWith('dm:')) return;
      const online = new Set(); for (const ws of this.authed()) { const c = this.info(ws); if (c.uid) online.add(c.uid); }
      const now = Date.now(), ref = 'talk:' + room;
      const { results } = await db.prepare(
        `SELECT DISTINCT p.user_id FROM push_subs p JOIN users u ON u.id = p.user_id AND u.active = 1 AND COALESCE(u.room_push, 1) = 1
           JOIN room_since s ON s.user_id = p.user_id AND s.channel = ?1
         WHERE p.user_id != ?2 AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = p.user_id AND n.ref = ?3 AND n.ts > ?4)`)
        .bind(room, t.uid || 0, ref, now - 60_000).all();
      const ids = results.map(r => r.user_id).filter(id => !online.has(id));
      if (!ids.length) return;
      const title = `🎙 ${t.name} วอในห้อง ${room}`, body = `พูด ${Math.max(1, Math.round((m.ms || 0) / 1000))} วินาที · แตะเพื่อเปิดฟัง`;
      await db.batch(ids.map(id => db.prepare("INSERT INTO notifications (ts, user_id, kind, title, body, ref) VALUES (?, ?, 'room', ?, ?, ?)").bind(now, id, title, body, ref)));
      await pushTo(this.env, ids);
    } catch (e) { console.error('talk push', e); }
  }

  /** leave every room (disconnect / old "leave") */
  leave(ws) {
    const c = this.info(ws);
    const rooms = this.roomsOf(c);
    this.hearing.delete(ws);
    if (!c || !rooms.length) return;
    this.setInfo(ws, { ...c, channel: null, rooms: [] });
    for (const ch of rooms) this.afterLeft(ws, c, ch);
    this.broadcastRoster();
    if (c.uid && this.env.DB) this.ctx.waitUntil?.(this.env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(Date.now(), c.uid).run().catch(() => {}));
  }
  /** this connection is no longer in room ch (its attachment is already updated) */
  afterLeft(ws, c, ch) {
    if (this.talker.get(ch)?.ws === ws) this.releaseFloor(ch, 'left');
    if (this.hearing.get(ws) === ch) this.hearing.delete(ws);
    if (ch.startsWith('dm:') && !this.uniqueIn(ch).some(o => o.uid === c.uid))
      for (const o of this.members(ch)) this.send(o, { type: 'call_end', by: c.name, channel: ch });
    this.broadcastState(ch);
    this.log('leave', ch, c.name);
  }

  log(event, channel, name, ms = null, reason = null) {
    if (!this.env.DB) return;
    const p = this.env.DB
      .prepare('INSERT INTO walkie_log (ts, event, channel, name, ms, reason) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(Date.now(), event, channel, name || '', ms, reason)
      .run()
      .catch(e => console.error('log write failed', e));
    this.ctx.waitUntil?.(p);
  }

  async store({ channel, kind, name, dept = '', uid = '', userId = null, text = null, ms = null }) {
    const ts = Date.now();
    if (!this.env.DB) return { id: ts, ts, channel, kind, name, dept, uid, text, ms };
    try {
      const r = await this.env.DB
        .prepare('INSERT INTO messages (ts, channel, kind, name, dept, uid, user_id, text, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(ts, channel, kind, name || '', dept || '', uid || '', userId, text, ms)
        .run();
      return { id: r.meta.last_row_id, ts, channel, kind, name, dept, uid, user_id: userId, text, ms, audio: 0 };
    } catch (e) {
      console.error('message write failed', e);
      return null;
    }
  }

  async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  // ---------------------------------------------------------------- websocket events
  async webSocketMessage(ws, data) {
    const me = this.info(ws);
    if (!me) return;

    if (typeof data !== 'string') {
      const t = this.talker.get(me.channel);
      if (!t || t.ws !== ws) return;
      for (const other of this.members(me.channel)) if (other !== ws && this.hearing.get(other) === me.channel) { try { other.send(data); } catch {} }
      const r = this.rec.get(me.channel);
      if (r && r.bytes < (this.maxTalkMs / 1000 + 2) * 2 * (t.rate || 16000)) { r.chunks.push(data.slice(0)); r.bytes += data.byteLength; }
      return;
    }

    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'join': {
        await this.loadChannels();
        let name, dept = '', uid = me.uid, role = me.role;
        if (this.env.DB) {
          if (!me.ok || msg.token || msg.code) {
            const user = await userFromToken(this.env.DB, String(msg.token || msg.code || ''));
            if (!user) {
              this.send(ws, { type: 'error', code: 'auth', message: 'กรุณาเข้าสู่ระบบใหม่' });
              try { ws.close(4001, 'auth'); } catch {}
              return;
            }
            if (user.must_change) {
              this.send(ws, { type: 'error', code: 'must_change', message: 'กรุณาตั้งรหัสผ่านใหม่ก่อนใช้งาน' });
              try { ws.close(4003, 'must_change'); } catch {}
              return;
            }
            name = user.name; dept = user.dept; uid = user.id; role = user.role;
          } else { name = me.name; dept = me.dept; }
        } else {
          name = String(msg.name || '').trim().slice(0, 24) || `ผู้ใช้ ${me.cid}`;
          dept = String(msg.dept || '').trim().slice(0, 32);
        }
        const devUid = /^[\w-]{6,40}$/.test(String(msg.uid || '')) ? String(msg.uid) : '';
        const dm = /^dm:(\d+):(\d+)$/.exec(String(msg.channel || ''));
        let ch = this.channels.includes(msg.channel) ? msg.channel
          : dm && uid && Number(dm[1]) < Number(dm[2]) && [Number(dm[1]), Number(dm[2])].includes(uid) ? msg.channel : null;
        if (ch && !dm && !(await this.canEnter(ch, uid, role))) {
          const banned = this.env.DB && uid && this.meta.get(ch) && await this.env.DB.prepare('SELECT 1 FROM channel_bans WHERE channel_id = ? AND user_id = ?').bind(this.meta.get(ch).id, uid).first();
          this.send(ws, banned ? { type: 'error', code: 'banned', channel: ch, message: `คุณถูกนำออกจากกลุ่ม "${ch}" เข้าได้อีกเมื่อผู้สร้างกลุ่มเชิญ` }
            : { type: 'error', code: 'locked', channel: ch, message: `ห้อง "${ch}" มีรหัส ใส่รหัสห้องก่อน` });
          if (this.info(ws).channel) return;     // stay in the current room
          ch = null;
        }
        if (!ch && this.env.DB) ch = LOBBY;       // no separate room -> everyone together
        const cur = this.info(ws);
        if (!ch) {                               // (LAN server without accounts only)
          if (cur.channel) this.leave(ws);
          this.setInfo(ws, { ...this.info(ws), ok: true, uid, name, dept, role, devUid, channel: null });
          this.send(ws, { type: 'joined', id: uid ?? cur.cid, name, channel: null, channels: this.channels, uid: devUid, emojis: EMOJIS });
          this.broadcastRoster();
          break;
        }
        // rooms: old clients send one channel (= their only room); new clients also send "rooms" to stay in several
        const rooms = [ch];
        if (Array.isArray(msg.rooms) && this.env.DB) {
          for (const r of msg.rooms.map(String).slice(0, 20)) {
            if (rooms.includes(r)) continue;
            const d = /^dm:(\d+):(\d+)$/.exec(r);
            const ok = this.channels.includes(r) ? await this.canEnter(r, uid, role)
              : !!(d && uid && Number(d[1]) < Number(d[2]) && [Number(d[1]), Number(d[2])].includes(uid));
            if (ok) rooms.push(r);
          }
        }
        const before = this.roomsOf(cur);
        if (cur.channel && this.talker.get(cur.channel)?.ws === ws) await this.releaseFloor(cur.channel, 'left');   // switching / re-joining stops my talk
        const now = { ...this.info(ws), ok: true, uid, name, dept, role, devUid, channel: ch, rooms };
        this.setInfo(ws, now);
        for (const r of before) if (!rooms.includes(r)) this.afterLeft(ws, cur, r);
        if (this.env.DB && uid) {                 // remember when I joined each room: later joiners never see earlier chat
          try {
            const t = Date.now(), live = rooms.filter(x => !x.startsWith('dm:'));
            const st = live.map(x => this.env.DB.prepare('INSERT OR IGNORE INTO room_since (user_id, channel, ts) VALUES (?, ?, ?)').bind(uid, x, t));
            for (const x of before) if (!rooms.includes(x) && !x.startsWith('dm:')) st.push(this.env.DB.prepare('DELETE FROM room_since WHERE user_id = ? AND channel = ?').bind(uid, x));
            if (st.length) await this.env.DB.batch(st);
          } catch {}
        }
        this.send(ws, { type: 'joined', id: uid ?? now.cid, name, channel: ch, rooms, channels: this.channels, uid: devUid, emojis: EMOJIS });
        if (uid && this.pages && this.pages.has(uid)) {
          const pg = this.pages.get(uid); this.pages.delete(uid);
          if (Date.now() - pg.ts < 180_000 && this.authed().some(o => this.info(o).uid === pg.from.id)) this.send(ws, { type: 'call', from: pg.from, channel: pg.channel });
        }
        for (const r of rooms) {
          if (!before.includes(r)) { this.broadcastState(r); this.log('join', r, name); }
          else if (r === ch) this.broadcastState(r);
        }
        this.broadcastRoster();
        break;
      }
      case 'ptt_start': {
        if (!me.channel) return;
        const ch = me.channel;
        const t = this.talker.get(ch);
        if (t && t.ws !== ws) return this.send(ws, { type: 'busy', by: t.name, channel: ch });
        if (t) clearTimeout(t.timer); // same talker asked again: restart the limit
        const timer = setTimeout(() => this.releaseFloor(ch, 'timeout'), this.maxTalkMs);
        const rate = Number(msg.rate) >= 8000 && Number(msg.rate) <= 48000 ? Number(msg.rate) : 16000;
        this.talker.set(ch, { ws, name: me.name, dept: me.dept, uid: me.uid, devUid: me.devUid, since: t ? t.since : Date.now(), timer, rate });
        if (!t) this.rec.set(ch, { chunks: [], bytes: 0 });
        this.send(ws, { type: 'talk_granted', maxMs: this.maxTalkMs });
        for (const other of this.members(ch)) {
          if (other === ws) continue;
          const h = this.hearing.get(other);
          if (!h || h === ch || !this.talker.has(h)) { this.hearing.set(other, ch); this.send(other, { type: 'talk_start', name: me.name, rate, channel: ch }); }
          else this.send(other, { type: 'talk_also', name: me.name, channel: ch, hearing: h });
        }
        this.broadcastState(ch);
        this.broadcastRoster();
        break;
      }
      case 'ptt_end':
        if (this.talker.get(me.channel)?.ws === ws) await this.releaseFloor(me.channel);
        break;
      case 'kick': {                           // the group's creator (or an admin) removes someone
        const to = Number(msg.to), ch = String(msg.channel || '');
        const meta = this.meta.get(ch);
        if (!me.uid || !to || to === me.uid || !meta) return;
        if (!(me.role === 'admin' || meta.created_by === me.uid)) return this.send(ws, { type: 'error', code: 'kick', message: 'นำคนออกได้เฉพาะผู้สร้างกลุ่ม' });
        if (this.env.DB) {
          try {
            await this.env.DB.batch([
              this.env.DB.prepare('INSERT OR REPLACE INTO channel_bans (channel_id, user_id, ts) VALUES (?, ?, ?)').bind(meta.id, to, Date.now()),
              this.env.DB.prepare('DELETE FROM channel_access WHERE channel_id = ? AND user_id = ?').bind(meta.id, to),
            ]);
          } catch (e) { console.error('kick failed', e); }
        }
        let name = '';
        for (const o of this.authed()) {
          const c = this.info(o);
          if (c.uid !== to) continue;
          name = c.name;
          if (this.roomsOf(c).includes(ch)) {
            const keep = this.roomsOf(c).filter(r => r !== ch);
            let active = c.channel === ch ? (keep.find(r => !r.startsWith('dm:')) || LOBBY) : c.channel;
            if (!keep.includes(active)) keep.unshift(active);
            this.setInfo(o, { ...c, channel: active, rooms: keep });
            this.afterLeft(o, c, ch);
            try { await this.env.DB.prepare('DELETE FROM room_since WHERE user_id = ? AND channel = ?').bind(to, ch).run(); } catch {}
            this.send(o, { type: 'kicked', channel: ch, by: me.name });
          }
        }
        this.send(ws, { type: 'kick_done', to, name, channel: ch });
        break;
      }
      case 'invite': {                         // invite someone into a room I can enter
        const to = Number(msg.to), ch = String(msg.channel || '');
        if (!me.uid || !to || to === me.uid || !this.channels.includes(ch)) return;
        if (!(await this.canEnter(ch, me.uid, me.role))) return this.send(ws, { type: 'error', code: 'invite', message: 'เชิญได้เฉพาะห้องที่คุณเข้าได้' });
        const meta = this.meta.get(ch) || {};
        if (this.env.DB) {
          try {
            const now = Date.now();
            await this.env.DB.batch([
              // pending until the invitee accepts: no access is given yet
              this.env.DB.prepare('INSERT OR REPLACE INTO room_invites (channel_id, user_id, from_id, ts) VALUES (?, ?, ?, ?)').bind(meta.id, to, me.uid, now),
              this.env.DB.prepare('INSERT INTO notifications (ts, user_id, kind, title, body, ref) VALUES (?, ?, ?, ?, ?, ?)')
                .bind(now, to, 'invite', `${me.name} เชิญคุณเข้ากลุ่ม "${ch}"`, 'แตะเพื่อตอบรับ', 'room:' + ch),
            ]);
          } catch (e) { console.error('invite failed', e); }
        }
        const targets = this.authed().filter(o => this.info(o).uid === to);
        for (const o of targets) this.send(o, { type: 'invite', from: { id: me.uid, name: me.name, dept: me.dept }, channel: ch, locked: !!meta.locked });
        this.send(ws, { type: 'invite_sent', to, channel: ch, online: targets.length > 0 });
        break;
      }
      case 'invite_reply': {                   // the invitee accepts or declines; only then can they enter
        const ch = String(msg.channel || ''), accept = !!msg.accept, meta = this.meta.get(ch);
        if (!me.uid || !meta || !this.env.DB) return;
        const inv = await this.env.DB.prepare('SELECT from_id FROM room_invites WHERE channel_id = ? AND user_id = ?').bind(meta.id, me.uid).first();
        if (!inv) return this.send(ws, { type: 'error', code: 'invite', message: 'คำเชิญนี้ใช้ไม่ได้แล้ว' });
        const now = Date.now();
        await this.env.DB.batch([
          this.env.DB.prepare('DELETE FROM room_invites WHERE channel_id = ? AND user_id = ?').bind(meta.id, me.uid),
          ...(accept ? [
            this.env.DB.prepare('INSERT OR IGNORE INTO channel_access (channel_id, user_id, ts) VALUES (?, ?, ?)').bind(meta.id, me.uid, now),
            this.env.DB.prepare('DELETE FROM channel_bans WHERE channel_id = ? AND user_id = ?').bind(meta.id, me.uid),
          ] : []),
        ]);
        this.send(ws, { type: 'invite_done', channel: ch, accept });
        for (const o of this.authed().filter(o => this.info(o).uid === inv.from_id)) this.send(o, { type: 'invite_answer', channel: ch, name: me.name, accept });
        break;
      }
      case 'call': {                           // private walkie call to someone who is online
        const to = Number(msg.to);
        if (!me.uid || !to || to === me.uid) return;
        const targets = this.authed().filter(o => this.info(o).uid === to);
        const channel = `dm:${Math.min(me.uid, to)}:${Math.max(me.uid, to)}`;
        const from = { id: me.uid, name: me.name, dept: me.dept };
        if (!targets.length) {                   // app closed: ring their phone with a push (the caller's app repeats this every 20 s)
          if (!this.env.DB || !(await this.env.DB.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').bind(to).first())) return this.send(ws, { type: 'call_fail', to, reason: 'offline', message: 'ไม่พบผู้ใช้นี้' });
          const now = Date.now(); this.pages = this.pages || new Map();
          const prev = this.pages.get(to), fresh = !prev || prev.from.id !== me.uid || now - (prev.pushAt || 0) > 15_000;
          const page = { from, channel, ts: now, pushAt: fresh ? now : prev.pushAt }; this.pages.set(to, page);
          let r = { sent: 0, ready: false };
          if (fresh && this.env.DB) {
            try {
              await this.env.DB.prepare("INSERT INTO notifications (ts, user_id, kind, title, body, ref) VALUES (?, ?, 'call', ?, ?, ?)").bind(now, to, `📻 ${me.name} วอส่วนตัวหาคุณ`, 'แตะเพื่อเปิดแอป แล้วคุยได้เลย', 'call:' + me.uid).run();
              r = await pushTo(this.env, [to]);
            } catch (e) { console.error('call push', e); }
          }
          return this.send(ws, { type: 'call_ringing', to, channel, offline: true, pushed: fresh, sent: (r && r.sent) || 0, ready: !!(r && r.ready) });
        }
        for (const o of targets) this.send(o, { type: 'call', from, channel });
        this.send(ws, { type: 'call_ringing', to, channel });
        break;
      }
      case 'call_reply': {
        const to = Number(msg.to);
        if (!me.uid || !to) return;
        for (const o of this.authed()) if (this.info(o).uid === to) this.send(o, { type: 'call_reply', from: { id: me.uid, name: me.name }, accept: !!msg.accept, channel: msg.channel });
        // the callee's other phones stop ringing
        for (const o of this.authed()) if (o !== ws && this.info(o).uid === me.uid) this.send(o, { type: 'call_handled' });
        break;
      }
      case 'leave':
        this.leave(ws);
        break;
      case 'chat': {
        if (!me.channel) return;
        const text = String(msg.text || '').replace(/\s+$/g, '').slice(0, 500);
        if (!text.trim()) return;
        const now = Date.now();
        if (me.lastChat && now - me.lastChat < 300) return; // flood guard
        this.setInfo(ws, { ...me, lastChat: now });
        const room = msg.channel && this.roomsOf(me).includes(msg.channel) ? msg.channel : me.channel;
        const m = await this.store({ channel: room, kind: 'text', name: me.name, dept: me.dept, uid: me.devUid, userId: me.uid, text });
        if (m) { this.publish(room, m); this.ctx.waitUntil(this.pushRoomText(room, me, m)); }
        break;
      }
      case 'react': {
        if (!me.channel || !this.env.DB || !EMOJIS.includes(msg.emoji)) return;
        const who = me.devUid || `user${me.uid}`;
        const id = Number(msg.id);
        const row = await this.env.DB.prepare('SELECT channel FROM messages WHERE id = ?').bind(id).first();
        if (!row || !this.roomsOf(me).includes(row.channel)) return;
        const del = await this.env.DB.prepare('DELETE FROM reactions WHERE msg_id = ? AND uid = ? AND emoji = ?').bind(id, who, msg.emoji).run();
        if (!del.meta.changes) {
          await this.env.DB.prepare('INSERT INTO reactions (msg_id, uid, emoji, name, ts) VALUES (?, ?, ?, ?, ?)').bind(id, who, msg.emoji, me.name, Date.now()).run();
        }
        const by = await reactionsFor(this.env.DB, [id]);
        for (const other of this.members(row.channel)) this.send(other, { type: 'react', id, by: by[id] || {} });
        break;
      }
      case 'roster':
        this.broadcastRoster();
        break;
      case 'ping':
        this.send(ws, { type: 'pong' });
        break;
    }
  }

  async webSocketClose(ws, code) {
    await this.wentOffline(ws);
    this.leave(ws);
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch {}
  }

  async webSocketError(ws) {
    await this.wentOffline(ws);
    this.leave(ws);
  }

  async alarm() {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      if (last && now - last.getTime() > STALE_MS) {
        this.leave(ws);
        try { ws.close(4000, 'stale'); } catch {}
      }
    }
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }
}

/** 16-bit mono PCM chunks -> WAV file bytes */
export function wav(chunks, bytes, rate = 16000) {
  const len = bytes & ~1;
  const out = new Uint8Array(44 + len);
  const v = new DataView(out.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, 36 + len, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len, true);
  let o = 44;
  for (const c of chunks) { const b = new Uint8Array(c); const n = Math.min(b.length, 44 + len - o); out.set(b.subarray(0, n), o); o += n; if (o >= out.length) break; }
  return out;
}

/** { msgId: { emoji: [uid, ...] } } */
export async function reactionsFor(db, ids) {
  if (!ids.length) return {};
  const { results } = await db
    .prepare(`SELECT msg_id, emoji, uid FROM reactions WHERE msg_id IN (${ids.map(() => '?').join(',')}) ORDER BY ts`)
    .bind(...ids)
    .all();
  const out = {};
  for (const r of results) ((out[r.msg_id] ??= {})[r.emoji] ??= []).push(r.uid);
  return out;
}

function randomId() {
  return crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000_000;
}

export function safeEqual(a, b) {
  const e = new TextEncoder();
  const x = e.encode(a), y = e.encode(b);
  if (x.length !== y.length) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}
