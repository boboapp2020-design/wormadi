// เทสต์ REST API + การบันทึกเสียง (รันผ่าน test/run.js ซึ่งเตรียมบัญชีและส่ง WALKIE_URL / WALKIE_TOKENS มาให้)
const assert = require('assert');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', '..', 'server', 'node_modules', 'ws'));
const base = process.env.WALKIE_URL;
const T = JSON.parse(process.env.WALKIE_TOKENS);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(method, p, token, body) {
  const r = await fetch(base + p, { method, headers: token ? { Authorization: 'Bearer ' + token } : {}, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), type };
}
function client(token, channel = 'ช่อง 1 - ทั่วไป') {
  return new Promise(res => {
    const ws = new WebSocket(base.replace(/^http/, 'ws'));
    ws.msgs = []; ws.bins = [];
    ws.on('message', (d, isBin) => (isBin ? ws.bins.push(d) : ws.msgs.push(JSON.parse(d))));
    ws.wait = async (type, ms = 3000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { const i = ws.msgs.findIndex(m => m.type === type); if (i >= 0) return ws.msgs.splice(i, 1)[0]; await sleep(10); }
      throw new Error('timeout waiting for ' + type);
    };
    ws.on('open', async () => { ws.send(JSON.stringify({ type: 'join', token, channel })); await ws.wait('joined'); res(ws); });
  });
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

test('login: รหัสผิด 401, ถูกได้ token + ข้อมูลผู้ใช้ (ไม่มีรหัสผ่านหลุดออกมา)', async () => {
  assert.equal((await call('POST', '/api/login', null, { emp: 't-login', password: 'nope' })).status, 401);
  const ok = await call('POST', '/api/login', null, { emp: 'T-LOGIN', password: 'pass-t-login', remember: true });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token.length > 30);
  assert.equal(ok.body.user.name, 'Login');
  assert.ok(!('pass' in ok.body.user));
  const me = await call('GET', '/api/me', ok.body.token);
  assert.equal(me.body.user.emp, 't-login');
  await call('POST', '/api/logout', ok.body.token);
  assert.equal((await call('GET', '/api/me', ok.body.token)).status, 401, 'logout ต้องทำให้ token ใช้ไม่ได้');
});

test('ใส่รหัสผิด 5 ครั้ง = ล็อก 10 นาที', async () => {
  for (let i = 0; i < 5; i++) await call('POST', '/api/login', null, { emp: 't-t', password: 'x' });
  const r = await call('POST', '/api/login', null, { emp: 't-t', password: 'pass-t-t' });
  assert.equal(r.status, 429);
});

test('ทุก API ต้อง login (ยกเว้น config/channels/login)', async () => {
  assert.equal((await call('GET', '/api/config')).status, 200);
  assert.equal((await call('GET', '/api/channels')).status, 200);
  for (const p of ['/api/users', '/api/tasks', '/api/sos', '/api/map', '/api/notifications', '/api/history', '/api/report', '/api/admin/users'])
    assert.equal((await call('GET', p)).status, 401, p);
});

test('สิทธิ์: พนักงานทั่วไปเข้า admin/report/มอบงานไม่ได้', async () => {
  assert.equal((await call('GET', '/api/admin/users', T.A)).status, 403);
  assert.equal((await call('GET', '/api/report', T.A)).status, 403);
  assert.equal((await call('POST', '/api/tasks', T.A, { title: 'x', assignee_ids: [1] })).status, 403);
});

test('admin: เพิ่มพนักงาน, แก้, ปิดบัญชีแล้ว login ไม่ได้, รหัสซ้ำไม่ได้', async () => {
  const c = await call('POST', '/api/admin/users', T.Admin, { emp: 'E100', name: 'ทดสอบ เพิ่ม', dept: 'QA', role: 'user', password: 'secret12' });
  assert.equal(c.status, 200);
  assert.equal((await call('POST', '/api/admin/users', T.Admin, { emp: 'e100', name: 'ซ้ำ', password: 'secret12' })).status, 409);
  const login = await call('POST', '/api/login', null, { emp: 'E100', password: 'secret12' });
  assert.equal(login.status, 200);
  await call('PATCH', `/api/admin/users/${c.body.id}`, T.Admin, { emp: 'E100', name: 'ทดสอบ เพิ่ม', dept: 'QA', role: 'user', active: false });
  assert.equal((await call('GET', '/api/me', login.body.token)).status, 401, 'ปิดบัญชีต้องเตะออก');
  assert.equal((await call('POST', '/api/login', null, { emp: 'E100', password: 'secret12' })).status, 401);
  const self = (await call('GET', '/api/me', T.Admin)).body.user;
  assert.equal((await call('PATCH', `/api/admin/users/${self.id}`, T.Admin, { name: 'Admin', role: 'user' })).status, 400, 'ลดสิทธิ์ตัวเองไม่ได้');
});

test('admin: เพิ่มกลุ่มใหม่ -> ห้องวอเห็นทันที', async () => {
  const ws = await client(T.B);
  assert.equal((await call('POST', '/api/admin/channels', T.Admin, { name: 'ช่องทดสอบ', icon: 'flask', color: 'blue', sort: 50 })).status, 200);
  const m = await ws.wait('channels');
  assert.ok(m.channels.includes('ช่องทดสอบ'));
  const list = (await call('GET', '/api/channels')).body;
  assert.ok(list.some(c => c.name === 'ช่องทดสอบ' && c.icon === 'flask'));
  ws.close();
});

test('งาน: หัวหน้ามอบงาน -> ผู้รับได้แจ้งเตือนสด + เห็นในงานวันนี้ -> ติ๊กเสร็จ -> หัวหน้าได้แจ้งเตือน', async () => {
  const bId = (await call('GET', '/api/me', T.B)).body.user.id;
  const wsB = await client(T.B), wsLead = await client(T.Lead, 'ช่อง 2 - ฝ่ายผลิต');
  const r = await call('POST', '/api/tasks', T.Lead, { title: 'ตรวจสอบอุณหภูมิ Boiler', assignee_ids: [bId], due_at: Date.now() + 3600_000 });
  assert.equal(r.status, 200);
  const n = await wsB.wait('notification');
  assert.match(n.notification.title, /ตรวจสอบอุณหภูมิ Boiler/);
  const mine = (await call('GET', '/api/tasks?scope=today', T.B)).body;
  const t = mine.find(x => x.title === 'ตรวจสอบอุณหภูมิ Boiler');
  assert.ok(t && t.creator_name === 'Lead');
  assert.equal((await call('PATCH', `/api/tasks/${t.id}`, T.A, { done: true })).status, 403, 'คนอื่นติ๊กงานเราไม่ได้');
  assert.equal((await call('PATCH', `/api/tasks/${t.id}`, T.B, { done: true })).status, 200);
  const back = await wsLead.wait('notification');
  assert.match(back.notification.title, /งานเสร็จแล้ว/);
  const unread = (await call('GET', '/api/me', T.B)).body.unread;
  assert.ok(unread >= 1);
  await call('POST', '/api/notifications/read', T.B);
  assert.equal((await call('GET', '/api/me', T.B)).body.unread, 0);
  wsB.close(); wsLead.close();
});

test('SOS: แจ้งเหตุ -> ทุกเครื่องได้ทันที (ทุกช่อง) -> รับทราบ -> หัวหน้าปิดเหตุ', async () => {
  const a = await client(T.A, 'ช่อง 1 - ทั่วไป'), w = await client(T.Web, 'ช่อง 3 - คลังสินค้า');
  const r = await call('POST', '/api/sos', T.A, { kind: 'fire', place: 'อาคารหม้อต้ม', note: 'ควันออกจากห้องไฟ' });
  assert.equal(r.status, 200);
  assert.ok(r.body.delivered >= 2);
  const s = await w.wait('sos');
  assert.equal(s.sos.kind_name, 'เพลิงไหม้'); assert.equal(s.sos.reporter, 'A'); assert.equal(s.sos.place, 'อาคารหม้อต้ม');
  await call('POST', `/api/sos/${r.body.id}/ack`, T.Web);
  const ack = await a.wait('sos_ack');
  assert.equal(ack.by, 'Web'); assert.equal(ack.acks, 1);
  assert.equal((await call('POST', `/api/sos/${r.body.id}/close`, T.A)).status, 403);
  assert.equal((await call('POST', `/api/sos/${r.body.id}/close`, T.Lead)).status, 200);
  await w.wait('sos_closed');
  const list = (await call('GET', '/api/sos', T.Web)).body;
  assert.equal(list[0].status, 'closed'); assert.equal(list[0].acked, 1);
  const notes = (await call('GET', '/api/notifications', T.Web)).body;
  assert.ok(notes.some(n => n.kind === 'sos'));
  a.close(); w.close();
});

test('แผนที่: admin เพิ่มหมุด, พนักงานเห็น, พนักงานแก้ไม่ได้', async () => {
  const before = (await call('GET', '/api/map', T.A)).body.pins.length;
  assert.ok(before >= 4, 'มีหมุดเริ่มต้น');
  assert.equal((await call('POST', '/api/map/pins', T.A, { name: 'x', x: 1, y: 1 })).status, 403);
  const r = await call('POST', '/api/map/pins', T.Admin, { name: 'ห้องควบคุม', icon: 'bolt', color: 'orange', x: 40, y: 50 });
  assert.equal(r.status, 200);
  const pins = (await call('GET', '/api/map', T.A)).body.pins;
  assert.ok(pins.some(p => p.name === 'ห้องควบคุม' && p.x === 40));
  const img = 'data:image/png;base64,' + Buffer.from([137, 80, 78, 71]).toString('base64');
  assert.equal((await call('PUT', '/api/map/image', T.Admin, { data: img })).status, 200);
  const got = await call('GET', '/api/map/image', T.A);
  assert.equal(got.type, 'image/png');
});

test('บันทึกเสียง: พูด 1 วิ -> มีไฟล์ WAV ฟังย้อนได้ + อยู่ในประวัติ', async () => {
  const a = await client(T.A2, 'ช่อง 4 - รปภ.');
  a.send(JSON.stringify({ type: 'ptt_start', rate: 16000 }));
  await a.wait('talk_granted');
  const pcm = Buffer.alloc(1280);
  for (let i = 0; i < 640; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 3) * 8000), i * 2);
  for (let i = 0; i < 8; i++) { a.send(pcm); await sleep(40); }
  a.send(JSON.stringify({ type: 'ptt_end' }));
  const c = await a.wait('chat');
  assert.equal(c.msg.kind, 'talk'); assert.equal(c.msg.audio, 1);
  const wav = await call('GET', `/api/audio/${c.msg.id}`, T.B);
  assert.equal(wav.status, 200);
  assert.equal(wav.body.toString('ascii', 0, 4), 'RIFF');
  if (process.env.WALKIE_NOREC) {   // stored compressed in D1: 8 kHz, about the same waveform
    assert.equal(wav.body.readUInt32LE(24), 8000);
    assert.equal(wav.body.length, 44 + 8 * 1280 / 2);
    const want = (pcm.readInt16LE(2 * 10) + pcm.readInt16LE(2 * 11)) / 2;
    assert.ok(Math.abs(wav.body.readInt16LE(44 + 2 * 5) - want) < 400, 'เนื้อเสียงใกล้เคียงกับที่ส่ง');
  } else {
    assert.equal(wav.body.readUInt32LE(24), 16000);
    assert.equal(wav.body.length, 44 + 8 * 1280);
    assert.equal(wav.body.readInt16LE(44 + 2 * 5), pcm.readInt16LE(2 * 5), 'เนื้อเสียงตรงกับที่ส่ง');
  }
  assert.equal((await call('GET', `/api/audio/${c.msg.id}`)).status, 401);
  const h = (await call('GET', '/api/history?kind=talk', T.B)).body;
  assert.ok(h.some(x => x.id === c.msg.id && x.audio === 1));
  a.close();
});

test('รายชื่อ: บอกใครออนไลน์อยู่ช่องไหน', async () => {
  const w = await client(T.Web, 'ช่อง 2 - ฝ่ายผลิต');
  await sleep(200);
  const users = (await call('GET', '/api/users', T.A)).body;
  const web = users.find(u => u.name === 'Web');
  assert.equal(web.online, true); assert.equal(web.channel, 'ช่อง 2 - ฝ่ายผลิต');
  assert.ok(users.some(u => !u.online));
  assert.ok(!('pass' in web));
  w.close();
});

test('รายงาน: หัวหน้าเห็นยอดรวมและแยกตามแผนก', async () => {
  const r = await call('GET', '/api/report?days=7', T.Lead);
  assert.equal(r.status, 200);
  assert.ok(r.body.users >= 10 && r.body.channels >= 4 && r.body.talks >= 1 && r.body.sos >= 1);
  assert.ok(Array.isArray(r.body.byDept) && r.body.byDept.length >= 1);
});

test('โปรไฟล์: เปลี่ยนรูป และเปลี่ยนรหัสผ่าน', async () => {
  const img = 'data:image/jpeg;base64,' + Buffer.from([255, 216, 255]).toString('base64');
  assert.equal((await call('PATCH', '/api/me', T.Web, { avatar: img })).status, 200);
  const id = (await call('GET', '/api/me', T.Web)).body.user.id;
  assert.equal((await call('GET', `/api/avatar/${id}`, T.A)).type, 'image/jpeg');
  assert.equal((await call('PATCH', '/api/me', T.Web, { avatar: 'data:text/html;base64,PHNjcmlwdD4=' })).status, 400, 'กันไฟล์ที่ไม่ใช่รูป');
  assert.equal((await call('POST', '/api/me/password', T.Web, { old: 'wrong', new: 'newpass1' })).status, 400);
  assert.equal((await call('POST', '/api/me/password', T.Web, { old: 'pass-t-web', new: 'newpass1' })).status, 200);
  assert.equal((await call('POST', '/api/login', null, { emp: 't-web', password: 'newpass1' })).status, 200);
});

// an employee from the (private) staff list, unit ลูกหีบ
const STAFF_ID = (() => { try { const row = require('fs').readFileSync(require('path').join(__dirname, '..', 'data', 'staff.csv'), 'utf8').split(/\r?\n/).find(l => l.includes('หน่วยลูกหีบ')); return row ? row.split(',')[0].trim() : null; } catch { return null; } })();

test('พนักงานนำเข้า: รหัสพนักงาน + 1234 เข้าได้ แต่ต้องตั้งรหัสใหม่ก่อนใช้งาน', async () => {
  assert.equal((await call('POST', '/api/login', null, { emp: STAFF_ID, password: 'wrong' })).status, 401);
  const r = await call('POST', '/api/login', null, { emp: STAFF_ID, password: '1234' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.must_change, 1);
  assert.equal(r.body.user.dept, 'ลูกหีบ');
  const tk = r.body.token;
  assert.equal((await call('GET', '/api/me', tk)).status, 200, 'ดูข้อมูลตัวเองได้');
  for (const p of ['/api/users', '/api/tasks', '/api/messages?channel=1', '/api/sos'])
    assert.equal((await call('GET', p, tk)).status, 403, p);
  // WS join refused
  const ws = new WebSocket(base.replace(/^http/, 'ws'));
  const got = await new Promise((res, rej) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', token: tk, channel: 'ช่อง 1 - ทั่วไป' })));
    ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'error' || m.type === 'joined') res(m); });
    setTimeout(() => rej(new Error('ws timeout')), 3000);
  });
  ws.close();
  assert.equal(got.code, 'must_change');
  assert.equal((await call('POST', '/api/me/password', tk, { old: '1234', new: '1234' })).status, 400, 'ห้ามใช้รหัสเดิม');
  assert.equal((await call('POST', '/api/me/password', tk, { old: '1234', new: 'mypass99' })).status, 200);
  assert.equal((await call('GET', '/api/users', tk)).status, 200, 'ตั้งรหัสแล้วใช้งานได้');
  const again = await call('POST', '/api/login', null, { emp: STAFF_ID, password: 'mypass99' });
  assert.equal(again.body.user.must_change, 0);
  assert.equal((await call('POST', '/api/login', null, { emp: STAFF_ID, password: '1234' })).status, 401, 'รหัส 1234 ใช้ไม่ได้แล้ว');
});

test('ห้อง: พนักงานสร้างห้องเปิด/ห้องมีรหัส, คนอื่นต้องใส่รหัสก่อน, ลบได้เฉพาะคนสร้าง', async () => {
  const list = async tk => (await call('GET', '/api/channels', tk)).body;
  // open room
  const open = await call('POST', '/api/channels', T.A, { name: 'ห้องทดสอบเปิด', sub: 'ทดสอบ' });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  assert.equal((await call('POST', '/api/channels', T.B, { name: 'ห้องทดสอบเปิด' })).status, 409, 'ชื่อซ้ำไม่ได้');
  assert.equal((await call('POST', '/api/channels', T.A, { name: 'x', password: '12' })).status, 400, 'รหัสสั้นเกินไป');
  // locked room
  const lk = await call('POST', '/api/channels', T.A, { name: 'ห้องลับทดสอบ', password: 'abcd' });
  assert.equal(lk.status, 200);
  const forB = (await list(T.B)).find(c => c.name === 'ห้องลับทดสอบ');
  assert.equal(forB.locked, 1); assert.equal(forB.access, false); assert.equal(forB.can_delete, false);
  const forA = (await list(T.A)).find(c => c.name === 'ห้องลับทดสอบ');
  assert.equal(forA.access, true, 'คนสร้างเข้าได้เลย'); assert.equal(forA.can_delete, true);
  assert.ok(!('pass' in forB), 'ไม่ส่ง hash รหัสห้องออกมา');
  // B cannot enter or read until unlocked
  const b = await client(T.B, 'ห้องทดสอบเปิด');
  b.send(JSON.stringify({ type: 'join', token: T.B, channel: 'ห้องลับทดสอบ' }));
  const e = await b.wait('error');
  assert.equal(e.code, 'locked');
  assert.equal((await call('GET', '/api/messages?channel=' + encodeURIComponent('ห้องลับทดสอบ'), T.B)).status, 403);
  assert.equal((await call('POST', `/api/channels/${lk.body.id}/unlock`, T.B, { password: 'wrong' })).status, 403);
  assert.equal((await call('POST', `/api/channels/${lk.body.id}/unlock`, T.B, { password: 'abcd' })).status, 200);
  assert.equal((await list(T.B)).find(c => c.name === 'ห้องลับทดสอบ').access, true, 'ใส่รหัสครั้งเดียวจำไว้');
  b.send(JSON.stringify({ type: 'join', token: T.B, channel: 'ห้องลับทดสอบ' }));
  assert.equal((await b.wait('joined')).channel, 'ห้องลับทดสอบ');
  assert.equal((await call('GET', '/api/messages?channel=' + encodeURIComponent('ห้องลับทดสอบ'), T.B)).status, 200);
  // delete: only creator (or admin)
  assert.equal((await call('DELETE', `/api/channels/${lk.body.id}`, T.B)).status, 403);
  assert.equal((await call('DELETE', `/api/channels/${lk.body.id}`, T.A)).status, 200);
  const gone = await b.wait('error');
  assert.equal(gone.code, 'room_deleted', 'คนในห้องได้รับแจ้งว่าห้องถูกลบ');
  assert.ok(!(await list(T.B)).some(c => c.name === 'ห้องลับทดสอบ'));
  assert.equal((await call('DELETE', `/api/channels/${open.body.id}`, T.Admin)).status, 200, 'admin ลบห้องใครก็ได้');
  b.close();
});

test('SOS กดปุ่มเดียว (ไม่เลือกประเภท) -> ทุกเครื่องเห็นชื่อคนแจ้ง + หมุดแผนที่มีพิกัด GPS', async () => {
  const w = await client(T.B);
  const r = await call('POST', '/api/sos', T.A, { place: 'หม้อต้ม', lat: 16.5, lng: 104.7 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.kind, 'general');
  const got = await w.wait('sos');
  assert.equal(got.sos.reporter, 'A');
  assert.equal(got.sos.lat, 16.5);
  w.close();
  const pin = await call('POST', '/api/map/pins', T.Admin, { name: 'จุดรวมพล GPS', lat: 16.55, lng: 104.75 });
  assert.equal(pin.status, 200);
  const p = (await call('GET', '/api/map', T.A)).body.pins.find(x => x.id === pin.body.id);
  assert.equal(p.lat, 16.55); assert.equal(p.lng, 104.75);
  assert.equal((await call('POST', '/api/map/pins', T.Admin, { name: 'ผิด', lat: 999, lng: 5 })).status, 200);
  assert.equal((await call('GET', '/api/map', T.A)).body.pins.find(x => x.name === 'ผิด').lat, null, 'พิกัดผิดไม่บันทึก');
});

test('1 บัญชี = 1 เครื่อง: เข้าเครื่องใหม่ เครื่องเดิมถูกออกจากระบบทันที (ทั้ง API และวอ)', async () => {
  const one = await call('POST', '/api/login', null, { emp: 't-solo', password: 'pass-t-solo' });
  assert.equal(one.status, 200);
  const ws1 = await client(one.body.token);
  const two = await call('POST', '/api/login', null, { emp: 't-solo', password: 'pass-t-solo' });
  assert.equal(two.status, 200);
  const e = await ws1.wait('error');
  assert.equal(e.code, 'replaced', 'เครื่องเดิมได้รับแจ้งว่าเข้าจากเครื่องอื่น');
  assert.equal((await call('GET', '/api/me', one.body.token)).status, 401, 'token เครื่องเดิมใช้ไม่ได้แล้ว');
  assert.equal((await call('GET', '/api/me', two.body.token)).status, 200, 'เครื่องใหม่ใช้ได้');
  const ws2 = await client(two.body.token);
  ws2.close();
});

test('วอส่วนตัว: เรียกคนที่ออนไลน์ -> รับสาย -> คุยกัน 2 คน คนอื่นเข้า/ดูไม่ได้ -> วางสาย', async () => {
  const id = async tk => (await call('GET', '/api/me', tk)).body.user.id;
  const [ia, ib] = [await id(T['แชทA']), await id(T['แชทB'])];
  const a = await client(T['แชทA']), b = await client(T['แชทB']), c = await client(T['แชทC']);
  a.send(JSON.stringify({ type: 'call', to: 999999 }));
  assert.equal((await a.wait('call_fail')).reason, 'offline', 'เรียกคนที่ไม่ออนไลน์ไม่ได้');
  a.send(JSON.stringify({ type: 'call', to: ib }));
  const ring = await b.wait('call');
  assert.equal(ring.from.id, ia);
  const dm = ring.channel;
  assert.equal(dm, 'dm:' + Math.min(ia, ib) + ':' + Math.max(ia, ib));
  a.send(JSON.stringify({ type: 'join', channel: dm }));
  assert.equal((await a.wait('joined')).channel, dm);
  b.send(JSON.stringify({ type: 'call_reply', to: ia, accept: true, channel: dm }));
  assert.equal((await a.wait('call_reply')).accept, true);
  b.send(JSON.stringify({ type: 'join', channel: dm }));
  assert.equal((await b.wait('joined')).channel, dm);
  c.send(JSON.stringify({ type: 'join', channel: dm }));
  assert.notEqual((await c.wait('joined')).channel, dm, 'คนที่สามเข้าห้องส่วนตัวไม่ได้');
  a.send(JSON.stringify({ type: 'chat', text: 'ลับ' }));
  await b.wait('chat');
  assert.equal((await call('GET', '/api/messages?channel=' + dm, T['แชทC'])).status, 403);
  assert.ok(!(await call('GET', '/api/history', T['แชทC'])).body.some(m => m.channel === dm), 'คนอื่นไม่เห็นในประวัติ');
  assert.ok((await call('GET', '/api/history', T['แชทB'])).body.some(m => m.channel === dm));
  const u = (await call('GET', '/api/users', T['แชทC'])).body.find(x => x.id === ia);
  assert.equal(u.channel, 'คุยส่วนตัว', 'ไม่บอกว่าคุยกับใคร');
  a.send(JSON.stringify({ type: 'leave' }));
  assert.equal((await b.wait('call_end')).channel, dm, 'อีกฝ่ายรู้ว่าวางสาย');
  a.close(); b.close(); c.close();
});

test('เชิญเข้ากลุ่ม: อีกฝ่ายได้รับทันที + แจ้งเตือน, ต้องกดยอมรับก่อนถึงเข้าได้ (ไม่เข้าอัตโนมัติ), ปฏิเสธได้; เข้าแอปครั้งแรกไม่มีกลุ่ม', async () => {
  const id = async tk => (await call('GET', '/api/me', tk)).body.user.id;
  const ib = await id(T['แชทB']);
  const room = await call('POST', '/api/channels', T['แชทA'], { name: 'กลุ่มเชิญทดสอบ', password: 'pass9' });
  assert.equal(room.status, 200);
  const a = await client(T['แชทA'], 'กลุ่มเชิญทดสอบ');
  const b = new (require(require('path').join(__dirname, '..', '..', 'server', 'node_modules', 'ws')))(base.replace(/^http/, 'ws'));
  b.msgs = []; b.on('message', d => b.msgs.push(JSON.parse(d)));
  await new Promise(r => b.on('open', r));
  b.send(JSON.stringify({ type: 'join', token: T['แชทB'] }));
  const wait = async (ws, type) => { for (let k = 0; k < 300; k++) { const j = ws.msgs.findIndex(m => m.type === type); if (j >= 0) return ws.msgs.splice(j, 1)[0]; await sleep(10); } throw new Error('timeout ' + type); };
  assert.equal((await wait(b, 'joined')).channel, 'ทุกคน', 'ไม่ได้เลือกห้อง = อยู่ห้องรวม ทุกคน');
  a.send(JSON.stringify({ type: 'invite', to: ib, channel: 'กลุ่มเชิญทดสอบ' }));
  const inv = await wait(b, 'invite');
  assert.equal(inv.channel, 'กลุ่มเชิญทดสอบ'); assert.equal(inv.locked, true);
  assert.equal((await a.wait('invite_sent')).online, true);
  const n = (await call('GET', '/api/notifications', T['แชทB'])).body;
  assert.ok(JSON.stringify(n).includes('room:กลุ่มเชิญทดสอบ'), 'มีในการแจ้งเตือน');
  b.send(JSON.stringify({ type: 'join', token: T['แชทB'], channel: 'กลุ่มเชิญทดสอบ' }));
  assert.equal((await wait(b, 'error')).code, 'locked', 'ยังไม่กดยอมรับ = ยังเข้าไม่ได้');
  b.send(JSON.stringify({ type: 'invite_reply', channel: 'กลุ่มเชิญทดสอบ', accept: true }));
  assert.equal((await wait(b, 'invite_done')).accept, true);
  assert.equal((await a.wait('invite_answer')).accept, true, 'คนเชิญรู้ว่าอีกฝ่ายยอมรับ');
  b.send(JSON.stringify({ type: 'join', token: T['แชทB'], channel: 'กลุ่มเชิญทดสอบ' }));
  assert.equal((await wait(b, 'joined')).channel, 'กลุ่มเชิญทดสอบ', 'ยอมรับแล้วเข้ากลุ่มมีรหัสได้');
  b.send(JSON.stringify({ type: 'invite_reply', channel: 'กลุ่มเชิญทดสอบ', accept: true }));
  assert.equal((await wait(b, 'error')).code, 'invite', 'คำเชิญใช้ได้ครั้งเดียว');
  // decline: no access
  const ic = await id(T['แชทC']);
  const c = await client(T['แชทC'], 'ทุกคน');
  a.send(JSON.stringify({ type: 'invite', to: ic, channel: 'กลุ่มเชิญทดสอบ' }));
  await c.wait('invite');
  c.send(JSON.stringify({ type: 'invite_reply', channel: 'กลุ่มเชิญทดสอบ', accept: false }));
  assert.equal((await c.wait('invite_done')).accept, false);
  assert.equal((await a.wait('invite_answer')).accept, false, 'คนเชิญรู้ว่าอีกฝ่ายปฏิเสธ');
  c.send(JSON.stringify({ type: 'join', token: T['แชทC'], channel: 'กลุ่มเชิญทดสอบ' }));
  assert.equal((await c.wait('error')).code, 'locked', 'ปฏิเสธแล้วเข้าไม่ได้');
  a.close(); b.close(); c.close();
  await call('DELETE', '/api/channels/' + room.body.id, T['แชทA']);
});

test('บันทึก / เตือน: ส่วนตัว, ถึงเวลาเครื่องดัง, ทำซ้ำทุกวัน, เลื่อน 10 นาที, แชร์ให้กลุ่ม', async () => {
  const fire = async () => (await fetch(base + '/__test/fire-reminders')).json();
  const a = await client(T['แชทA'], 'ช่อง 2 - ฝ่ายผลิต'), b = await client(T['แชทB'], 'ช่อง 2 - ฝ่ายผลิต');
  const soon = Date.now() + 800;
  const one = await call('POST', '/api/reminders', T['แชทA'], { title: 'เช็คแรงดัน', note: 'ไม่เกิน 30 บาร์', due_at: soon, rpt: 'none' });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  const daily = await call('POST', '/api/reminders', T['แชทA'], { title: 'ส่งรายงานกะ', due_at: soon, rpt: 'daily', channel: 'ช่อง 2 - ฝ่ายผลิต' });
  assert.equal((await call('POST', '/api/reminders', T['แชทA'], { title: '' })).status, 400);
  assert.ok(!(await call('GET', '/api/reminders', T['แชทB'])).body.some(x => x.title === 'เช็คแรงดัน'), 'คนอื่นไม่เห็นบันทึกของเรา');
  await sleep(1000);
  assert.ok((await fire()).fired >= 2);
  const got = [await a.wait('notification'), await a.wait('notification')];
  const mine = got.find(g => g.reminder && g.reminder.id === one.body.id);
  assert.ok(mine, 'เจ้าของได้รับการเตือน'); assert.equal(mine.notification.kind, 'reminder');
  const shared = await b.wait('notification');
  assert.equal(shared.reminder.shared, true, 'คนในกลุ่มได้รับเตือนด้วย');
  const list = (await call('GET', '/api/reminders', T['แชทA'])).body;
  assert.equal(list.find(x => x.id === one.body.id).next_at, null, 'ครั้งเดียว: ไม่เตือนซ้ำ');
  assert.ok(list.find(x => x.id === daily.body.id).next_at > Date.now() + 23 * 3600000, 'ทุกวัน: เลื่อนไปพรุ่งนี้');
  assert.equal((await fire()).fired, 0, 'ไม่เตือนซ้ำในนาทีเดียวกัน');
  assert.equal((await call('PATCH', `/api/reminders/${one.body.id}`, T['แชทA'], { snooze_min: 10 })).status, 200);
  const sn = (await call('GET', '/api/reminders', T['แชทA'])).body.find(x => x.id === one.body.id);
  assert.ok(sn.next_at > Date.now() + 9 * 60000, 'เลื่อน 10 นาที');
  assert.equal((await call('PATCH', `/api/reminders/${one.body.id}`, T['แชทB'], { done: true })).status, 404, 'แก้ของคนอื่นไม่ได้');
  assert.equal((await call('PATCH', `/api/reminders/${one.body.id}`, T['แชทA'], { done: true })).status, 200);
  assert.equal((await call('DELETE', `/api/reminders/${daily.body.id}`, T['แชทA'])).status, 200);
  a.close(); b.close();
});

test('ผู้สร้างกลุ่มนำคนออก: ถูกตัดออกทันที กลับเข้าไม่ได้จนกว่าจะเชิญ · คนที่ไม่ใช่ผู้สร้างนำออกไม่ได้', async () => {
  const id = async tk => (await call('GET', '/api/me', tk)).body.user.id;
  const ib = await id(T['แชทB']);
  const room = await call('POST', '/api/channels', T['แชทA'], { name: 'กลุ่มนำออกทดสอบ' });
  const a = await client(T['แชทA'], 'กลุ่มนำออกทดสอบ'), b = await client(T['แชทB'], 'กลุ่มนำออกทดสอบ'), c = await client(T['แชทC'], 'กลุ่มนำออกทดสอบ');
  c.send(JSON.stringify({ type: 'kick', to: ib, channel: 'กลุ่มนำออกทดสอบ' }));
  assert.equal((await c.wait('error')).code, 'kick', 'คนที่ไม่ใช่ผู้สร้างนำออกไม่ได้');
  a.send(JSON.stringify({ type: 'kick', to: ib, channel: 'กลุ่มนำออกทดสอบ' }));
  assert.equal((await b.wait('kicked')).channel, 'กลุ่มนำออกทดสอบ');
  assert.equal((await a.wait('kick_done')).to, ib);
  b.send(JSON.stringify({ type: 'join', token: T['แชทB'], channel: 'กลุ่มนำออกทดสอบ' }));
  assert.equal((await b.wait('error')).code, 'banned', 'กลับเข้าเองไม่ได้');
  const where = (await call('GET', '/api/users', T['แชทA'])).body.find(u => u.id === ib);
  assert.equal(where.channel, 'ทุกคน', 'ถูกนำออก/ถูกปฏิเสธ = อยู่ห้องรวม ทุกคน');
  a.send(JSON.stringify({ type: 'invite', to: ib, channel: 'กลุ่มนำออกทดสอบ' }));
  await b.wait('invite');
  b.send(JSON.stringify({ type: 'join', token: T['แชทB'], channel: 'กลุ่มนำออกทดสอบ' }));
  assert.equal((await b.wait('error')).code, 'banned', 'เชิญแล้วแต่ยังไม่กดยอมรับ = ยังเข้าไม่ได้');
  b.send(JSON.stringify({ type: 'invite_reply', channel: 'กลุ่มนำออกทดสอบ', accept: true }));
  await b.wait('invite_done');
  b.send(JSON.stringify({ type: 'join', token: T['แชทB'], channel: 'กลุ่มนำออกทดสอบ' }));
  assert.equal((await b.wait('joined')).channel, 'กลุ่มนำออกทดสอบ', 'ยอมรับคำเชิญแล้วเข้าได้อีก');
  b.send(JSON.stringify({ type: 'join', token: T['แชทB'], channel: '' }));
  assert.equal((await b.wait('joined')).channel, 'ทุกคน', 'ออกจากกลุ่มแล้วกลับมาห้องรวม ทุกคน (ยังเชื่อมต่ออยู่)');
  a.close(); b.close(); c.close();
  await call('DELETE', '/api/channels/' + room.body.id, T['แชทA']);
});

test('SOS แม้ไม่อยู่ในกลุ่มไหนก็ได้รับ · ลงทะเบียนแจ้งเตือน (push) และลบเมื่อออกจากระบบ / เข้าเครื่องใหม่', async () => {
  const w = new (require(require('path').join(__dirname, '..', '..', 'server', 'node_modules', 'ws')))(base.replace(/^http/, 'ws'));
  w.msgs = []; w.on('message', d => w.msgs.push(JSON.parse(d)));
  await new Promise(r => w.on('open', r));
  w.send(JSON.stringify({ type: 'join', token: T.B }));          // signed in, no group
  for (let k = 0; k < 300 && !w.msgs.some(m => m.type === 'joined'); k++) await sleep(10);
  const s = await call('POST', '/api/sos', T.A, { place: 'ทดสอบ push' });
  assert.equal(s.status, 200);
  for (let k = 0; k < 300 && !w.msgs.some(m => m.type === 'sos'); k++) await sleep(10);
  assert.ok(w.msgs.some(m => m.type === 'sos'), 'คนที่ไม่อยู่ในกลุ่มก็ได้ยิน SOS');
  w.close();
  const cfg = (await call('GET', '/api/config')).body;
  assert.ok('push' in cfg && 'vapidPublic' in cfg);
  const lg = await call('POST', '/api/login', null, { emp: 't-solo', password: 'pass-t-solo' });
  const sub = { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'x', auth: 'y' } };
  assert.equal((await call('POST', '/api/push', lg.body.token, { subscription: sub })).status, 200);
  assert.equal((await call('POST', '/api/push', lg.body.token, { subscription: { endpoint: 'javascript:x' } })).status, 400);
  await call('POST', '/api/logout', lg.body.token);
  const lg2 = await call('POST', '/api/login', null, { emp: 't-solo', password: 'pass-t-solo' });
  assert.equal(lg2.status, 200);
});

test('แชทส่วนตัว: ส่งถึงอีกฝ่ายทันที, คนที่สามอ่านไม่ได้, มีในรายการแชท, ออฟไลน์ได้แจ้งเตือน', async () => {
  const id = async tk => (await call('GET', '/api/me', tk)).body.user.id;
  const [ia, ib, ic] = [await id(T['แชทA']), await id(T['แชทB']), await id(T['แชทC'])];
  const a = await client(T['แชทA']), b = await client(T['แชทB']);
  const r = await call('POST', `/api/dm/${ib}`, T['แชทA'], { text: 'สวัสดีส่วนตัว' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const got = await b.wait('dm');
  assert.equal(got.msg.text, 'สวัสดีส่วนตัว'); assert.equal(got.from.id, ia); assert.ok(!got.mine);
  assert.equal((await a.wait('dm')).mine, true, 'หน้าจออื่นของคนส่งเห็นด้วย');
  const ch = r.body.msg.channel;
  assert.equal((await call('GET', '/api/messages?channel=' + ch, T['แชทC'])).status, 403, 'คนที่สามอ่านไม่ได้');
  assert.ok((await call('GET', '/api/messages?channel=' + ch, T['แชทB'])).body.msgs.some(x => x.text === 'สวัสดีส่วนตัว'));
  const list = (await call('GET', '/api/dm', T['แชทB'])).body;
  assert.ok(list.some(d => d.channel === ch && d.peer.id === ia), 'อยู่ในรายการแชทส่วนตัว');
  assert.ok(!(await call('GET', '/api/dm', T['แชทC'])).body.some(d => d.channel === ch));
  assert.equal((await call('POST', `/api/dm/${ia}`, T['แชทA'], { text: 'x' })).status, 400, 'ส่งถึงตัวเองไม่ได้');
  assert.equal((await call('POST', `/api/dm/${ib}`, T['แชทA'], { text: '' })).status, 400);
  await call('POST', `/api/dm/${ic}`, T['แชทA'], { text: 'ถึงคนออฟไลน์' });
  const n = (await call('GET', '/api/notifications', T['แชทC'])).body;
  assert.ok(JSON.stringify(n).includes('ถึงคนออฟไลน์'), 'คนที่ไม่ได้ออนไลน์เห็นในการแจ้งเตือน');
  a.close(); b.close();
});

test('ห้องรวม "ทุกคน": ไม่ได้อยู่ห้องแยก = วอได้และทุกคนได้ยิน, คนในห้องแยกไม่ได้ยิน, ลบ/สร้างชื่อนี้ไม่ได้', async () => {
  const WS = require(require('path').join(__dirname, '..', '..', 'server', 'node_modules', 'ws'));
  const open = tk => new Promise(res => { const w = new WS(base.replace(/^http/, 'ws')); w.msgs = []; w.bins = [];
    w.on('message', (d, bin) => (bin ? w.bins.push(d) : w.msgs.push(JSON.parse(d))));
    w.wait = async type => { for (let k = 0; k < 300; k++) { const j = w.msgs.findIndex(m => m.type === type); if (j >= 0) return w.msgs.splice(j, 1)[0]; await sleep(10); } throw new Error('timeout ' + type); };
    w.on('open', () => { w.send(JSON.stringify({ type: 'join', token: tk })); res(w); }); });
  const a = await open(T.A), b = await open(T.B);
  assert.equal((await a.wait('joined')).channel, 'ทุกคน'); assert.equal((await b.wait('joined')).channel, 'ทุกคน');
  const c = await client(T.A2, 'ช่อง 3 - คลังสินค้า');         // someone in a separate room
  a.send(JSON.stringify({ type: 'ptt_start', rate: 16000 })); await a.wait('talk_granted');
  a.send(Buffer.alloc(640)); await sleep(150);
  assert.ok(b.bins.length > 0, 'คนในห้องรวมได้ยิน');
  assert.equal(c.bins.length, 0, 'คนในห้องแยกไม่ได้ยิน');
  a.send(JSON.stringify({ type: 'ptt_end' }));
  const list = (await call('GET', '/api/channels', T.A)).body;
  assert.equal(list[0].name, 'ทุกคน'); assert.equal(list[0].lobby, true); assert.equal(list[0].can_delete, false);
  assert.equal((await call('POST', '/api/channels', T.A, { name: 'ทุกคน' })).status, 409, 'สร้างห้องชื่อซ้ำกับห้องรวมไม่ได้');
  a.close(); b.close(); c.close();
});

test('หลายห้อง: อยู่ได้หลายห้อง, ได้ยินทุกห้องพร้อมบอกว่าห้องไหน, พูดชนกันได้ยินทีละห้อง, เปลี่ยนห้องพูดได้', async () => {
  const WS = require(require('path').join(__dirname, '..', '..', 'server', 'node_modules', 'ws'));
  const open = (tk, channel, rooms) => new Promise(res => { const w = new WS(base.replace(/^http/, 'ws')); w.msgs = []; w.bins = [];
    w.on('message', (d, bin) => (bin ? w.bins.push(d) : w.msgs.push(JSON.parse(d))));
    w.wait = async type => { for (let k = 0; k < 300; k++) { const j = w.msgs.findIndex(m => m.type === type); if (j >= 0) return w.msgs.splice(j, 1)[0]; await sleep(10); } throw new Error('timeout ' + type); };
    w.on('open', async () => { w.send(JSON.stringify({ type: 'join', token: tk, channel, rooms })); res(w); }); });
  // A is in two rooms (talks into ช่อง 1); B only in ช่อง 1; C only in ทุกคน (old style: one room)
  const a = await open(T.A, 'ช่อง 1 - ทั่วไป', ['ทุกคน', 'ช่อง 1 - ทั่วไป']);
  const j = await a.wait('joined');
  assert.equal(j.channel, 'ช่อง 1 - ทั่วไป'); assert.deepEqual([...j.rooms].sort(), ['ช่อง 1 - ทั่วไป', 'ทุกคน'].sort());
  const b = await open(T.B, 'ช่อง 1 - ทั่วไป'), c = await open(T['แชทC'], 'ทุกคน');
  await b.wait('joined'); await c.wait('joined');
  // C talks in ทุกคน -> A hears it and knows the room
  c.send(JSON.stringify({ type: 'ptt_start', rate: 16000 })); await c.wait('talk_granted');
  const s1 = await a.wait('talk_start'); assert.equal(s1.channel, 'ทุกคน'); assert.equal(s1.name, 'แชทC');
  // B talks in ช่อง 1 at the same time -> A is told, but keeps hearing ทุกคน only
  b.send(JSON.stringify({ type: 'ptt_start', rate: 16000 })); await b.wait('talk_granted');
  const also = await a.wait('talk_also'); assert.equal(also.channel, 'ช่อง 1 - ทั่วไป'); assert.equal(also.hearing, 'ทุกคน');
  c.send(Buffer.from([1, 1, 1, 1])); b.send(Buffer.from([2, 2, 2, 2])); await sleep(150);
  assert.ok(a.bins.length >= 1 && a.bins.every(x => x[0] === 1), 'ได้ยินทีละห้อง ไม่ปนกัน');
  c.send(JSON.stringify({ type: 'ptt_end' })); const e1 = await a.wait('talk_end'); assert.equal(e1.channel, 'ทุกคน');
  b.send(JSON.stringify({ type: 'ptt_end' }));
  // next time B talks, A hears ช่อง 1
  await sleep(100);
  b.send(JSON.stringify({ type: 'ptt_start', rate: 16000 })); await b.wait('talk_granted');
  const s2 = await a.wait('talk_start'); assert.equal(s2.channel, 'ช่อง 1 - ทั่วไป');
  b.send(JSON.stringify({ type: 'ptt_end' }));
  // A switches the talk room to ทุกคน but stays in both
  a.send(JSON.stringify({ type: 'join', channel: 'ทุกคน', rooms: ['ทุกคน', 'ช่อง 1 - ทั่วไป'] }));
  const j2 = await a.wait('joined'); assert.equal(j2.channel, 'ทุกคน'); assert.equal(j2.rooms.length, 2);
  const roster = await (async () => { for (let k = 0; k < 50; k++) { const r = a.msgs.filter(m => m.type === 'roster').pop(); if (r) return r; await sleep(20); } })();
  assert.ok(roster.users.find(u => u.name === 'A').rooms.length === 2, 'roster บอกว่าอยู่ 2 ห้อง');
  a.close(); b.close(); c.close();
});

test('แชทกลุ่ม: คนเข้าทีหลังไม่เห็นแชทก่อนหน้า (เห็นเฉพาะตั้งแต่เข้า) · ออกแล้วกลับเข้าใหม่ก็เริ่มนับใหม่', async () => {
  const room = 'ห้องแชทเก่า', mk = await call('POST', '/api/channels', T['แชทA'], { name: room });
  assert.equal(mk.status, 200, JSON.stringify(mk.body));
  const a = await client(T['แชทA'], room);
  a.send(JSON.stringify({ type: 'chat', text: 'ข้อความก่อนเข้า' })); await a.wait('chat');
  await sleep(50);
  const b = await client(T['แชทB'], room);
  await sleep(400); a.send(JSON.stringify({ type: 'chat', text: 'ข้อความหลังเข้า' })); await a.wait('chat'); await sleep(50);
  const seeB = async () => (await call('GET', '/api/messages?channel=' + encodeURIComponent(room), T['แชทB'])).body.msgs.map(x => x.text);
  let tb = await seeB();
  assert.ok(!tb.includes('ข้อความก่อนเข้า'), 'ไม่เห็นแชทก่อนเข้า'); assert.ok(tb.includes('ข้อความหลังเข้า'));
  const ta = (await call('GET', '/api/messages?channel=' + encodeURIComponent(room), T['แชทA'])).body.msgs.map(x => x.text);
  assert.ok(ta.includes('ข้อความก่อนเข้า'), 'คนที่อยู่มาก่อนเห็นครบ');
  a.close(); b.close();
});

test('ฝากข้อความเสียง: ส่งถึงคนออฟไลน์ -> อยู่ในแชทส่วนตัว + แจ้งเตือน + รายการยังไม่ฟัง -> ฟังแล้วหายจากรายการ · คนที่สามฟังไม่ได้', async () => {
  const id = async tk => (await call('GET', '/api/me', tk)).body.user.id;
  const [ia, ib] = [await id(T['แชทA']), await id(T['แชทB'])];
  const pcm = Buffer.alloc(16000 * 2 * 2);                       // 2 s of 16 kHz
  for (let k = 0; k < pcm.length / 2; k++) pcm.writeInt16LE(Math.round(Math.sin(k / 8) * 8000), k * 2);
  const send = (to, body) => fetch(base + '/api/dm/' + to + '/voice?rate=16000', { method: 'POST', headers: { Authorization: 'Bearer ' + T['แชทA'], 'Content-Type': 'application/octet-stream' }, body });
  assert.equal((await send(ib, Buffer.alloc(1000))).status, 400, 'สั้นเกินไป');
  const r = await send(ib, pcm); const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(d.msg.kind, 'talk'); assert.ok(d.msg.ms >= 1900 && d.msg.ms <= 2100, 'ความยาว ' + d.msg.ms);
  const vm = (await call('GET', '/api/voicemail', T['แชทB'])).body;
  const v = vm.find(x => x.id === d.msg.id);
  assert.ok(v, 'อยู่ในรายการยังไม่ฟัง'); assert.equal(v.from_id, ia); assert.equal(v.name, 'แชทA');
  assert.ok(!(await call('GET', '/api/voicemail', T['แชทA'])).body.some(x => x.id === d.msg.id), 'คนส่งไม่มีในรายการของตัวเอง');
  const wav = await call('GET', '/api/audio/' + d.msg.id, T['แชทB']);
  assert.equal(wav.status, 200); assert.ok(wav.type.includes('audio/wav'));
  assert.equal((await call('GET', '/api/audio/' + d.msg.id, T['แชทC'])).status, 403, 'คนที่สามฟังไม่ได้');
  assert.ok((await call('GET', '/api/messages?channel=' + d.msg.channel, T['แชทB'])).body.msgs.some(x => x.id === d.msg.id), 'อยู่ในแชทส่วนตัว');
  assert.ok(JSON.stringify((await call('GET', '/api/notifications', T['แชทB'])).body).includes('ข้อความเสียงจาก'), 'มีในการแจ้งเตือน');
  assert.equal((await call('POST', '/api/voicemail/' + d.msg.id + '/heard', T['แชทC'])).status, 200);
  assert.ok((await call('GET', '/api/voicemail', T['แชทB'])).body.some(x => x.id === d.msg.id), 'คนอื่นกดฟังแทนไม่ได้');
  await call('POST', '/api/voicemail/' + d.msg.id + '/heard', T['แชทB']);
  assert.ok(!(await call('GET', '/api/voicemail', T['แชทB'])).body.some(x => x.id === d.msg.id), 'ฟังแล้วหายจากรายการ');
});

test('แจ้งเตือนเด้งตอนปิดแอป: เครื่องถามว่าจะแสดงอะไร -> แชทส่วนตัว / ข้อความเสียง (ไปหน้าแชทของคนส่ง)', async () => {
  const id = async tk => (await call('GET', '/api/me', tk)).body.user.id;
  const so = (await call('POST', '/api/login', null, { emp: 't-solo', password: 'pass-t-solo' })).body.token;
  const [ia, is] = [await id(T['แชทA']), await id(so)];
  await call('POST', '/api/dm/' + is, T['แชทA'], { text: 'ถึงคนปิดแอป' });
  let l = (await call('GET', '/api/push/latest', so)).body;
  assert.equal(l.kind, 'dm', JSON.stringify(l)); assert.ok(l.body.includes('ถึงคนปิดแอป')); assert.equal(l.url, './#/dm?u=' + ia);
  await sleep(5);
  const pcm = Buffer.alloc(16000 * 2);
  const r = await fetch(base + '/api/dm/' + is + '/voice?rate=16000', { method: 'POST', headers: { Authorization: 'Bearer ' + T['แชทA'] }, body: pcm });
  assert.equal(r.status, 200);
  l = (await call('GET', '/api/push/latest', so)).body;
  assert.equal(l.kind, 'voice', JSON.stringify(l)); assert.ok(l.title.includes('แชทA'));
  assert.equal((await call('GET', '/api/push/latest', T['แชทC'])).body.kind === 'voice', false, 'คนอื่นไม่เห็น');
});

(async () => {
  let fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log('ผ่าน ', n); }
    catch (e) { fail++; console.log('ตก   ', n, '\n      ', e.message); }
  }
  console.log(fail ? `\n✗ API ไม่ผ่าน ${fail}/${tests.length}` : `\n✓ API ผ่านทั้งหมด ${tests.length} ข้อ`);
  process.exit(fail ? 1 : 0);
})();

test('รายงานเหตุการณ์: โพสต์ข้อความ+รูป -> ทุกคนเห็น + คนออนไลน์ได้รับแจ้งทันที · ดูรูปเต็ม · ทำเครื่องหมายแก้ไขแล้ว · ลบได้เฉพาะคนโพสต์', async () => {
  const b = await client(T['แชทB'], 'ทุกคน');
  const px = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg').toString('base64');
  assert.equal((await call('POST', '/api/incidents', T['แชทA'], { text: '' })).status, 400, 'ต้องมีข้อความหรือรูป');
  const r = await call('POST', '/api/incidents', T['แชทA'], { text: 'ท่อไอน้ำรั่ว', place: 'หม้อไอน้ำ 2', photo: px, thumb: px, lat: 16.4, lng: 102.8 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const live = await b.wait('incident');
  assert.equal(live.place, 'หม้อไอน้ำ 2', 'คนออนไลน์ได้รับแจ้ง');
  const list = (await call('GET', '/api/incidents', T['แชทC'])).body;
  const it = list.find(x => x.id === r.body.id);
  assert.ok(it && it.text === 'ท่อไอน้ำรั่ว' && it.thumb === px && it.has_photo && !('photo' in it), 'ทุกคนเห็น · รายการส่งแค่รูปเล็ก');
  assert.equal((await call('GET', `/api/incidents/${r.body.id}/photo`, T['แชทC'])).body.photo, px, 'กดดูรูปเต็มได้');
  assert.equal((await call('PATCH', `/api/incidents/${r.body.id}`, T['แชทC'], { done: true })).status, 403, 'คนอื่น (ไม่ใช่หัวหน้า) เปลี่ยนสถานะไม่ได้');
  assert.equal((await call('PATCH', `/api/incidents/${r.body.id}`, T['แชทA'], { done: true })).status, 200);
  assert.ok((await call('GET', '/api/incidents', T['แชทA'])).body.find(x => x.id === r.body.id).done_at, 'แก้ไขแล้ว');
  assert.equal((await call('DELETE', `/api/incidents/${r.body.id}`, T['แชทC'])).status, 403, 'ลบของคนอื่นไม่ได้');
  assert.equal((await call('DELETE', `/api/incidents/${r.body.id}`, T['แชทA'])).status, 200);
  b.close();
});

test('รายงานเหตุการณ์ระดับสูง: ทุกคนได้รับเตือนพร้อมระดับ · คนอื่นคอมเมนต์ได้ · คนโพสต์ปิดเหตุการณ์ (ปกติแล้ว) · ทุกคนได้รับแจ้ง', async () => {
  const b = await client(T['แชทB'], 'ทุกคน'), c = await client(T['แชทC'], 'ทุกคน');
  const r = await call('POST', '/api/incidents', T['แชทA'], { text: 'ไฟไหม้สายพาน', place: 'ลูกหีบ', level: 'high' });
  assert.equal(r.status, 200);
  assert.equal((await b.wait('incident')).level, 'high', 'ทุกคนได้รับเตือนระดับสูง');
  assert.equal((await c.wait('incident')).level, 'high');
  assert.equal((await call('GET', '/api/incidents', T['แชทB'])).body.find(x => x.id === r.body.id).level, 'high');
  assert.equal((await call('POST', `/api/incidents/${r.body.id}/comments`, T['แชทC'], { text: 'ดับได้แล้ว รอคนโพสต์ยืนยัน' })).status, 200, 'คนอื่นคอมเมนต์ได้');
  assert.equal((await call('POST', `/api/incidents/${r.body.id}/comments`, T['แชทC'], { text: ' ' })).status, 400);
  assert.equal((await b.wait('incident_comment')).id, r.body.id, 'คนออนไลน์เห็นคอมเมนต์ใหม่');
  const cm = (await call('GET', `/api/incidents/${r.body.id}/comments`, T['แชทB'])).body;
  assert.equal(cm.length, 1); assert.equal(cm[0].text, 'ดับได้แล้ว รอคนโพสต์ยืนยัน');
  assert.equal((await call('GET', '/api/incidents', T['แชทB'])).body.find(x => x.id === r.body.id).comments, 1, 'รายการบอกจำนวนคอมเมนต์');
  assert.equal((await call('PATCH', `/api/incidents/${r.body.id}`, T['แชทC'], { done: true })).status, 403, 'คนอื่นปิดเหตุการณ์ไม่ได้');
  assert.equal((await call('PATCH', `/api/incidents/${r.body.id}`, T['แชทA'], { done: true })).status, 200, 'คนโพสต์ปิดเหตุการณ์ได้');
  const d = await b.wait('incident_done');
  assert.equal(d.done, true); assert.equal(d.level, 'high');
  const low = await call('POST', '/api/incidents', T['แชทA'], { text: 'ทดสอบ', level: 'weird' });
  assert.equal((await call('GET', '/api/incidents', T['แชทA'])).body.find(x => x.id === low.body.id).level, 'low', 'ระดับไม่ถูกต้อง = ต่ำ');
  await call('DELETE', `/api/incidents/${r.body.id}`, T['แชทA']); await call('DELETE', `/api/incidents/${low.body.id}`, T['แชทA']);
  b.close(); c.close();
});
