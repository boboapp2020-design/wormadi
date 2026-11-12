// npm test: Cloudflare จำลองในเครื่อง (ข้อมูลแยกใน .wrangler/test-state) แล้วรันเทสต์
//   1) เทสต์โปรโตคอลชุดเดียวกับเซิร์ฟเวอร์ LAN (ด้วยบัญชีพนักงานจริง)  2) เทสต์ API: login, งาน, SOS, admin, รายงาน, บันทึกเสียง
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const PORT = 8799, URL = `http://127.0.0.1:${PORT}`;
const STATE = path.join(root, '.wrangler', 'test-state');
const W = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const wr = (...a) => execFileSync(process.execPath, [W, ...a], { cwd: root, stdio: 'ignore' });

fs.rmSync(STATE, { recursive: true, force: true });
wr('d1', 'migrations', 'apply', 'walkie-log', '--local', '--persist-to', STATE);
const CH = ['ช่อง 1 - ทั่วไป', 'ช่อง 2 - ฝ่ายผลิต', 'ช่อง 3 - คลังสินค้า', 'ช่อง 4 - รปภ.'];
wr('d1', 'execute', 'walkie-log', '--local', '--persist-to', STATE, '--command',
  `UPDATE channels SET active = 0; ${CH.map((c, i) => `INSERT INTO channels (name, sort) VALUES ('${c}', ${i});`).join(' ')}`);
// test accounts: name -> [emp, role, dept]
const USERS = { A: ['t-a', 'user'], B: ['t-b', 'user'], A2: ['t-a2', 'user'], T: ['t-t', 'user'], Web: ['t-web', 'user'],
  'แชทA': ['t-ca', 'user', 'ผลิต'], 'แชทB': ['t-cb', 'user'], 'แชทC': ['t-cc', 'user'], Lead: ['t-lead', 'lead', 'ฝ่ายผลิต'], Admin: ['t-admin', 'admin', 'IT'], Login: ['t-login', 'user'], Solo: ['t-solo', 'user'] };
for (const [name, [emp, role, dept]] of Object.entries(USERS)) {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'create-user.js'), '--emp', emp, '--name', name, '--role', role, '--dept', dept || '', '--password', 'pass-' + emp, '--local', '--persist-to', STATE], { cwd: root, stdio: 'ignore' });
}

// real staff list (default password 1234, must change on first login)
execFileSync(process.execPath, [path.join(root, 'scripts', 'import-staff.js'), '--local', '--persist-to', STATE], { cwd: root, stdio: 'ignore' });

// npm test -- --norec : run without R2 (recordings stored compressed in D1, like production today)
const NOREC = process.argv.includes('--norec');
if (NOREC) {
  const cfg = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8').replace(/^\s*"r2_buckets".*$/m, '')
    .replace('"main": "src/worker.js"', '"main": "../src/worker.js"').replace('"directory": "../server/public"', '"directory": "../../server/public"').replace('"migrations_dir": "migrations"', '"migrations_dir": "../migrations"');
  fs.writeFileSync(path.join(root, '.wrangler', 'test-norec.jsonc'), cfg);
}
const dev = spawn(process.execPath, [W, 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--inspector-port', '0', '--persist-to', STATE,
  ...(NOREC ? ['--config', path.join(root, '.wrangler', 'test-norec.jsonc')] : []), '--var', 'MAX_TALK_MS:500', '--var', 'TEST_HOOKS:1', '--show-interactive-dev-session=false'], { cwd: root, stdio: 'ignore' });
const stop = code => { try { process.platform === 'win32' ? execFileSync('taskkill', ['/pid', String(dev.pid), '/T', '/F'], { stdio: 'ignore' }) : dev.kill(); } catch {} process.exit(code); };

(async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(URL + '/api/config')).ok) break; } catch {}
    if (i === 59) { console.error('wrangler dev did not start'); stop(1); }
    await new Promise(r => setTimeout(r, 1000));
  }
  const tokens = {};
  for (const [name, [emp]] of Object.entries(USERS)) {
    const r = await (await fetch(URL + '/api/login', { method: 'POST', body: JSON.stringify({ emp, password: 'pass-' + emp }) })).json();
    tokens[name] = r.token;
  }
  const env = { ...process.env, WALKIE_URL: URL, WALKIE_TOKENS: JSON.stringify(tokens), ...(NOREC ? { WALKIE_NOREC: '1' } : {}) };
  const run = file => new Promise(res => spawn(process.execPath, [file], { stdio: 'inherit', env }).on('exit', res));
  const a = await run(path.join(root, '..', 'server', 'test', 'protocol.test.js'));
  console.log('\n---- API ----');
  const b = await run(path.join(__dirname, 'api.test.js'));
  stop(a || b ? 1 : 0);
})();
