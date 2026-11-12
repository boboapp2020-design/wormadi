// Walkie-Talkie demo server: serves the web app and relays push-to-talk audio.
// Run: npm install && npm start   (then open http://localhost:3000)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const CHANNELS = ['ช่อง 1 - ทั่วไป', 'ช่อง 2 - ฝ่ายผลิต', 'ช่อง 3 - คลังสินค้า', 'ช่อง 4 - รปภ.'];
const MAX_TALK_MS = Number(process.env.WALKIE_MAX_TALK_MS) || 60_000; // auto-release floor after 60s
const HEARTBEAT_MS = Number(process.env.WALKIE_HEARTBEAT_MS) || 20_000; // ping every client; browsers and the Android app answer pings automatically

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
function handler(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  if (urlPath === '/api/channels') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    return res.end(JSON.stringify(CHANNELS.map(name => ({ name, users: [...clients.values()].filter(c => c.channel === name).length }))));
  }
  const file = path.join(PUBLIC, urlPath === '/' ? 'index.html' : path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// HTTPS if cert files exist (needed for microphone on phones over LAN)
const certDir = path.join(__dirname, 'cert');
const useHttps = fs.existsSync(path.join(certDir, 'key.pem')) && fs.existsSync(path.join(certDir, 'cert.pem'));
const server = useHttps
  ? https.createServer({ key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) }, handler)
  : http.createServer(handler);

// ---------- realtime ----------
const wss = new WebSocketServer({ server });
const clients = new Map();      // ws -> { id, name, channel }
const talker = new Map();       // channel -> { ws, since, timer }
let nextId = 1;

const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const inChannel = ch => [...clients.entries()].filter(([, c]) => c.channel === ch);

function broadcastState(ch) {
  const t = talker.get(ch);
  const users = inChannel(ch).map(([, c]) => ({ id: c.id, name: c.name }));
  for (const [ws] of inChannel(ch)) send(ws, { type: 'state', channel: ch, users, talker: t ? clients.get(t.ws)?.name : null });
}

function releaseFloor(ch, reason = 'end') {
  const t = talker.get(ch);
  if (!t) return;
  clearTimeout(t.timer);
  talker.delete(ch);
  const name = clients.get(t.ws)?.name;
  for (const [ws] of inChannel(ch)) send(ws, { type: 'talk_end', name, reason, ms: Date.now() - t.since });
  broadcastState(ch);
}

function leave(ws) {
  const c = clients.get(ws);
  if (!c || !c.channel) return;
  const ch = c.channel;
  if (talker.get(ch)?.ws === ws) releaseFloor(ch, 'left');
  c.channel = null;
  broadcastState(ch);
}

wss.on('connection', ws => {
  clients.set(ws, { id: nextId++, name: null, channel: null });
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    const me = clients.get(ws);
    if (isBinary) {
      // audio chunk: relay only if this client holds the floor
      const t = talker.get(me.channel);
      if (!t || t.ws !== ws) return;
      for (const [other] of inChannel(me.channel)) if (other !== ws && other.readyState === 1) other.send(data, { binary: true });
      return;
    }
    let msg; try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'join': {
        const name = String(msg.name || '').trim().slice(0, 24) || `ผู้ใช้ ${me.id}`;
        const ch = CHANNELS.includes(msg.channel) ? msg.channel : CHANNELS[0];
        leave(ws);
        me.name = name; me.channel = ch;
        send(ws, { type: 'joined', id: me.id, name, channel: ch, channels: CHANNELS });
        broadcastState(ch);
        break;
      }
      case 'ptt_start': {
        if (!me.channel) return;
        const t = talker.get(me.channel);
        if (t && t.ws !== ws) return send(ws, { type: 'busy', by: clients.get(t.ws)?.name });
        if (t) clearTimeout(t.timer);
        const timer = setTimeout(() => releaseFloor(me.channel, 'timeout'), MAX_TALK_MS);
        talker.set(me.channel, { ws, since: Date.now(), timer });
        send(ws, { type: 'talk_granted', maxMs: MAX_TALK_MS });
        for (const [other] of inChannel(me.channel)) if (other !== ws) send(other, { type: 'talk_start', name: me.name, rate: msg.rate || 16000 });
        broadcastState(me.channel);
        break;
      }
      case 'ptt_end':
        if (talker.get(me.channel)?.ws === ws) releaseFloor(me.channel);
        break;
      case 'leave':
        leave(ws);
        break;
    }
  });

  ws.on('close', () => { leave(ws); clients.delete(ws); });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; } // 'close' handler cleans up channel + floor
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  const proto = useHttps ? 'https' : 'http';
  console.log(`📻 Walkie demo running: ${proto}://localhost:${PORT}`);
  if (useHttps) {
    try {
      const fp = new (require('crypto').X509Certificate)(fs.readFileSync(path.join(certDir, 'cert.pem'))).fingerprint256;
      console.log(`   cert SHA-256 (ตรวจให้ตรงกับในแอป): ${fp}`);
    } catch {}
  }
  const nets = require('os').networkInterfaces();
  for (const list of Object.values(nets)) for (const n of list) if (n.family === 'IPv4' && !n.internal) console.log(`   on your network: ${proto}://${n.address}:${PORT}`);
});

module.exports = server;
