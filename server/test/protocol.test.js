// ทดสอบโปรโตคอลของ server.js แบบอัตโนมัติ (ไม่ต้องใช้มือถือ)
// รัน: npm test   (เปิดเซิร์ฟเวอร์ชั่วคราวที่พอร์ตสุ่ม แล้วปิดเอง)
// ทดสอบ Cloudflare: cd cloudflare && npm test  (สร้างบัญชีทดสอบแล้วส่ง WALKIE_URL / WALKIE_TOKENS มาให้)
//   เซิร์ฟเวอร์นั้นต้องตั้งเวลาพูดสูงสุด 500 ms (MAX_TALK_MS=500) เพื่อให้ข้อทดสอบหมดเวลาทำงาน
const REMOTE = process.env.WALKIE_URL || null;
const TOKENS = JSON.parse(process.env.WALKIE_TOKENS || '{}');   // Cloudflare: name -> session token
process.env.PORT = 0;
process.env.WALKIE_HEARTBEAT_MS = 100; // เร่ง heartbeat ให้ทดสอบได้เร็ว
process.env.WALKIE_MAX_TALK_MS = 500; // จำกัดเวลาพูด 0.5 วิ แทน 60 วิ
const assert = require('assert');
const WebSocket = require('ws');
const server = REMOTE ? null : require('../server');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let port, base;

function client(opts = {}) {
  const ws = new WebSocket(base.replace(/^http/, 'ws'), opts);
  const msgs = [], bins = [];
  ws.on('message', (d, isBin) => (isBin ? bins.push(d) : msgs.push(JSON.parse(d))));
  ws.json = m => ws.send(JSON.stringify(m.type === 'join' && TOKENS[m.name] ? { ...m, token: TOKENS[m.name] } : m));
  ws.wait = async (type, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const i = msgs.findIndex(m => m.type === type);
      if (i >= 0) return msgs.splice(i, 1)[0];
      await sleep(10);
    }
    throw new Error('timeout waiting for ' + type);
  };
  ws.msgs = msgs; ws.bins = bins;
  return new Promise(r => ws.on('open', () => r(ws)));
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('join ได้รับ joined + รายชื่อช่อง และ state', async () => {
  const a = await client();
  a.json({ type: 'join', name: 'A', channel: 'ช่อง 2 - ฝ่ายผลิต' });
  const j = await a.wait('joined');
  assert.equal(j.channel, 'ช่อง 2 - ฝ่ายผลิต');
  assert.equal(j.channels.filter(c => c !== 'ทุกคน').length, 4);   // Cloudflare also has the all-hands channel
  const s = await a.wait('state');
  assert.deepEqual(s.users.map(u => u.name), ['A']);
  a.close();
});

test('พูดได้ทีละคน: B ได้ busy ขณะ A พูด, เสียงส่งต่อเฉพาะคนที่ถือสิทธิ์', async () => {
  const ch = 'ช่อง 1 - ทั่วไป';
  const a = await client(), b = await client();
  a.json({ type: 'join', name: 'A', channel: ch }); await a.wait('joined');
  b.json({ type: 'join', name: 'B', channel: ch }); await b.wait('joined');
  a.json({ type: 'ptt_start', rate: 16000 });
  await a.wait('talk_granted');
  const ts = await b.wait('talk_start');
  assert.equal(ts.name, 'A'); assert.equal(ts.rate, 16000);
  b.json({ type: 'ptt_start', rate: 16000 });
  const busy = await b.wait('busy');
  assert.equal(busy.by, 'A');
  const pcm = Buffer.alloc(1280, 7);
  a.send(pcm); b.send(Buffer.alloc(1280, 9)); // B's audio must be dropped
  await sleep(150);
  assert.equal(b.bins.length, 1); assert.equal(b.bins[0][0], 7);
  assert.equal(a.bins.length, 0);
  a.json({ type: 'ptt_end' });
  const te = await b.wait('talk_end');
  assert.equal(te.name, 'A'); assert.equal(te.reason, 'end');
  a.close(); b.close();
});

test('ptt_start ซ้ำโดยคนเดิมเริ่มนับเวลาใหม่ ไม่ทิ้ง timer เก่าค้าง (แก้บั๊ก)', async () => {
  const a = await client();
  a.json({ type: 'join', name: 'A2', channel: 'ช่อง 3 - คลังสินค้า' }); await a.wait('joined');
  const t0 = Date.now();
  a.json({ type: 'ptt_start' }); await a.wait('talk_granted');
  await sleep(350);
  a.json({ type: 'ptt_start' }); await a.wait('talk_granted');
  const te = await a.wait('talk_end', 2000);
  const at = Date.now() - t0;
  assert.equal(te.reason, 'timeout');
  assert.ok(at >= 800, `timer เก่ายังทำงาน: หมดเวลาที่ ${at} ms (ควร ≥ 850)`);
  a.close();
});

test('พูดเกินเวลาจำกัด -> talk_end reason timeout', async () => {
  const a = await client();
  a.json({ type: 'join', name: 'T', channel: 'ช่อง 3 - คลังสินค้า' }); await a.wait('joined');
  a.json({ type: 'ptt_start' }); await a.wait('talk_granted');
  const te = await a.wait('talk_end', 2000);
  assert.equal(te.reason, 'timeout');
  a.close();
});

test('คนที่ถือสิทธิ์หลุด -> ปล่อยสิทธิ์ (left) ให้คนอื่นพูดต่อได้', async () => {
  const ch = 'ช่อง 4 - รปภ.';
  const a = await client(), b = await client();
  a.json({ type: 'join', name: 'A', channel: ch }); await a.wait('joined');
  b.json({ type: 'join', name: 'B', channel: ch }); await b.wait('joined');
  a.json({ type: 'ptt_start' }); await a.wait('talk_granted');
  a.terminate();
  const te = await b.wait('talk_end');
  assert.equal(te.reason, 'left');
  b.json({ type: 'ptt_start' }); await b.wait('talk_granted');
  b.close();
});

(REMOTE ? () => {} : test)('heartbeat: เครื่องที่ไม่ตอบ ping ถูกตัดออกจากช่อง (โทรศัพท์หลุด Wi-Fi)', async () => {
  const ch = 'ช่อง 1 - ทั่วไป';
  const ghost = await client({ autoPong: false }), b = await client();
  ghost.json({ type: 'join', name: 'Ghost', channel: ch }); await ghost.wait('joined');
  b.json({ type: 'join', name: 'B', channel: ch }); await b.wait('joined');
  ghost.json({ type: 'ptt_start' }); await ghost.wait('talk_granted');
  const te = await b.wait('talk_end', 3000);
  assert.equal(te.reason, 'left');
  await sleep(50);
  const last = b.msgs.filter(m => m.type === 'state').pop();
  assert.deepEqual(last.users.map(u => u.name), ['B']);
  b.close();
});

test('เว็บเดิม (client ปกติ) ไม่ถูกตัดโดย heartbeat', async () => {
  const a = await client();
  a.json({ type: 'join', name: 'Web', channel: 'ช่อง 2 - ฝ่ายผลิต' }); await a.wait('joined');
  await sleep(1200); // หลายรอบ heartbeat
  assert.equal(a.readyState, WebSocket.OPEN);
  a.close();
});

test('/api/channels ตอบ JSON รายชื่อช่อง', async () => {
  const res = await fetch(`${base}/api/channels`);
  const list = await res.json();
  assert.equal(list.filter(c => !c.lobby).length, 4);
  assert.ok('name' in list[0] && 'users' in list[0]);
});

if (REMOTE && TOKENS.A) {
  test('token ผิด -> error auth แล้วถูกตัด', async () => {
    const a = await client();
    a.send(JSON.stringify({ type: 'join', name: 'X', code: 'wrong' }));
    const e = await a.wait('error');
    assert.equal(e.code, 'auth');
    await new Promise(r => (a.readyState === WebSocket.CLOSED ? r() : a.on('close', r)));
  });
  test('แชท: ข้อความถึงทั้งช่อง + แจ้งเตือนคนช่องอื่น + กดถูกใจ + ประวัติ', async () => {
    const a = await client(), b = await client(), c = await client();
    a.json({ type: 'join', name: 'แชทA', channel: 'ช่อง 1 - ทั่วไป', uid: 'uid-aaaaaa', dept: 'ผลิต' }); await a.wait('joined');
    b.json({ type: 'join', name: 'แชทB', channel: 'ช่อง 1 - ทั่วไป', uid: 'uid-bbbbbb' }); await b.wait('joined');
    c.json({ type: 'join', name: 'แชทC', channel: 'ช่อง 2 - ฝ่ายผลิต', uid: 'uid-cccccc' }); await c.wait('joined');
    a.json({ type: 'chat', text: 'มีปัญหาที่สายพาน' });
    const mb = (await b.wait('chat')).msg, ma = (await a.wait('chat')).msg;
    assert.equal(mb.id, ma.id); assert.equal(mb.text, 'มีปัญหาที่สายพาน'); assert.equal(mb.kind, 'text');
    assert.equal(mb.uid, 'uid-aaaaaa'); assert.equal(mb.dept, 'ผลิต');
    const n = await c.wait('notify');
    assert.equal(n.channel, 'ช่อง 1 - ทั่วไป'); assert.equal(n.msg.id, mb.id);
    b.json({ type: 'react', id: mb.id, emoji: '👍' });
    let r = await a.wait('react');
    assert.deepEqual(r.by, { '👍': ['uid-bbbbbb'] });
    b.json({ type: 'react', id: mb.id, emoji: '👍' }); // toggle off
    r = await a.wait('react');
    assert.deepEqual(r.by, {});
    c.json({ type: 'react', id: mb.id, emoji: '👍' }); // other channel: ignored
    await sleep(200);
    assert.ok(!a.msgs.some(m => m.type === 'react'));
    a.json({ type: 'ptt_start' }); await a.wait('talk_granted'); await sleep(120); a.json({ type: 'ptt_end' });
    const talk = (await b.wait('chat')).msg;
    assert.equal(talk.kind, 'talk'); assert.equal(talk.name, 'แชทA'); assert.ok(talk.ms > 0);
    const hist = await (await fetch(`${base}/api/messages?channel=${encodeURIComponent('ช่อง 1 - ทั่วไป')}&limit=5`, { headers: { Authorization: 'Bearer ' + TOKENS.Lead } })).json();
    const ids = hist.msgs.map(m => m.id);
    assert.ok(ids.includes(mb.id) && ids.includes(talk.id));
    assert.ok(ids.indexOf(mb.id) < ids.indexOf(talk.id), 'เรียงเก่า -> ใหม่');
    assert.equal((await fetch(`${base}/api/messages?channel=x`)).status, 401);
    const roster = c.msgs.filter(m => m.type === 'roster').pop();
    assert.ok(roster.users.some(u => u.name === 'แชทA' && u.channel === 'ช่อง 1 - ทั่วไป' && u.dept === 'ผลิต'));
    a.close(); b.close(); c.close();
  });
  test('ping แบบข้อความ -> pong', async () => {
    const a = await client();
    a.send('{"type":"ping"}');
    await a.wait('pong');
    a.close();
  });
  test('log ใน D1: ต้องมีรหัส และมีรายการ talk ที่เพิ่งพูด', async () => {
    const no = await fetch(`${base}/api/log`);
    assert.equal(no.status, 401);
    const r = await fetch(`${base}/api/log?events=talk&limit=50`, { headers: { Authorization: 'Bearer ' + TOKENS.Lead } });
    const rows = await r.json();
    assert.ok(rows.some(x => x.event === 'talk' && x.name === 'A' && x.reason === 'end'), 'ไม่พบ talk ของ A');
    const buf = Buffer.from(await (await fetch(`${base}/api/log?format=csv`, { headers: { Authorization: 'Bearer ' + TOKENS.Lead } })).arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'CSV ต้องมี BOM ให้ Excel อ่านภาษาไทยได้');
    assert.ok(buf.toString('utf8', 3).startsWith('เวลา (ไทย)'));
  });
}

(async () => {
  if (REMOTE) base = REMOTE.replace(/\/$/, '');
  else {
    await new Promise(r => (server.listening ? r() : server.on('listening', r)));
    port = server.address().port;
    base = `http://127.0.0.1:${port}`;
  }
  let fail = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('ผ่าน ', t.name); }
    catch (e) { fail++; console.log('ตก   ', t.name, '\n      ', e.message); }
  }
  console.log(fail ? `\n✗ ไม่ผ่าน ${fail}/${tests.length}` : `\n✓ ผ่านทั้งหมด ${tests.length} ข้อ`);
  process.exit(fail ? 1 : 0);
})();
