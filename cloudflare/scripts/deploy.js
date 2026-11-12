// npm run deploy  — ขึ้น Cloudflare ครั้งเดียวจบ (รันซ้ำได้)
// 1) ตรวจว่า login แล้ว  2) สร้างฐานข้อมูล D1 "walkie-log" ถ้ายังไม่มี แล้วเขียน database_id ลง wrangler.jsonc
// 3) สร้างตารางบน D1 จริง (migrations)  4) ตั้งรหัสเข้าใช้ ACCESS_CODE ถ้ายังไม่ได้ตั้ง  5) deploy
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const root = path.join(__dirname, '..');
const WRANGLER = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = path.join(root, 'wrangler.jsonc');
const DB = 'walkie-log';
const PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

const run = (args, opts = {}) => execFileSync(process.execPath, [WRANGLER, ...args], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
const live = args => { const r = spawnSync(process.execPath, [WRANGLER, ...args], { cwd: root, stdio: 'inherit' }); if (r.status) process.exit(r.status); };
const ask = q => new Promise(res => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, a => { rl.close(); res(a.trim()); }); });

(async () => {
  // 1) login
  let who = '';
  try { who = run(['whoami']); } catch (e) { who = String(e.stdout || ''); }
  if (!/associated with the email|You are logged in/i.test(who)) {
    console.log('\nยังไม่ได้ login Cloudflare  ให้รัน:\n\n  npx wrangler login\n\nแล้วรัน npm run deploy อีกครั้ง\n');
    process.exit(1);
  }
  console.log('✓ login Cloudflare แล้ว');

  // 2) D1 database
  let cfg = fs.readFileSync(CONFIG, 'utf8');
  if (cfg.includes(PLACEHOLDER)) {
    let id = null;
    try {
      const list = JSON.parse(run(['d1', 'list', '--json']));
      id = (list.find(d => d.name === DB) || {}).uuid || null;
    } catch {}
    if (!id) {
      console.log(`สร้างฐานข้อมูล D1 "${DB}" ...`);
      const out = run(['d1', 'create', DB]);
      id = (out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0];
      if (!id) { console.error(out); throw new Error('อ่าน database_id ไม่ได้'); }
    }
    cfg = cfg.replace(PLACEHOLDER, id);
    fs.writeFileSync(CONFIG, cfg);
    console.log(`✓ D1 "${DB}" = ${id} (เขียนลง wrangler.jsonc แล้ว)`);
  } else console.log(`✓ D1 "${DB}" ตั้งค่าไว้แล้ว`);

  // 3) tables
  live(['d1', 'migrations', 'apply', DB, '--remote']);

  // 4) first admin account (only when there is no admin yet)
  let admins = 0;
  try {
    const out = JSON.parse(run(['d1', 'execute', DB, '--remote', '--json', '--command', `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`]));
    admins = out[0].results[0].n;
  } catch {}
  if (!admins) {
    console.log('\nยังไม่มีผู้ดูแลระบบ กำลังสร้างบัญชี admin ...');
    execFileSync(process.execPath, [path.join(__dirname, 'create-user.js'), '--emp', 'admin', '--name', 'ผู้ดูแลระบบ', '--role', 'admin'], { cwd: root, stdio: 'inherit' });
    console.log('  (เข้าสู่ระบบแล้วเปลี่ยนรหัสผ่านที่ ตั้งค่า > ข้อมูลส่วนตัว และเพิ่มพนักงานที่ ตั้งค่า > จัดการระบบ)');
  } else console.log(`✓ มีผู้ดูแลระบบแล้ว ${admins} คน`);

  // 5) recordings: R2 if the account has it, otherwise compressed clips in D1 (both can be replayed).
  let config = CONFIG;
  try {
    const list = run(['r2', 'bucket', 'list']);
    if (!list.includes('walkie-recordings')) run(['r2', 'bucket', 'create', 'walkie-recordings']);
    console.log('✓ R2 bucket walkie-recordings พร้อม (บันทึกเสียงฟังย้อนหลังได้)');
  } catch (e) {
    console.log('✓ ไม่ได้ใช้ R2: เสียงที่พูดเก็บแบบบีบอัดในฐานข้อมูล D1 แทน (ฟังย้อนหลังได้ตามปกติ)');
    config = path.join(root, '.wrangler', 'deploy-norec.jsonc');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const txt = fs.readFileSync(CONFIG, 'utf8').replace(/^\s*"r2_buckets".*$/m, '')
      .replace('"main": "src/worker.js"', '"main": "../src/worker.js"')
      .replace('"directory": "../server/public"', '"directory": "../../server/public"')
      .replace('"migrations_dir": "migrations"', '"migrations_dir": "../migrations"');
    fs.writeFileSync(config, txt);
  }

  // 6) deploy
  live(['deploy', '--config', config]);

  // 7) main link without the account name: https://wormadi.pages.dev (front for the Worker)
  const r = spawnSync(process.execPath, [WRANGLER, 'pages', 'deploy', '--project-name', 'wormadi', '--branch', 'main', '--commit-dirty=true'], { cwd: path.join(root, 'pages'), stdio: 'inherit' });
  if (r.status) process.exit(r.status);

  // 8) the code -> GitHub (only what is already committed). GitHub Pages serves the app from this repo:
  //    https://boboapp2020-design.github.io/wormadi/ -> server/public/  (the second link)
  const top = path.join(root, '..');
  const gc = spawnSync('git', ['push'], { cwd: top, stdio: 'inherit', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (gc.status) console.log('\n⚠️ git push ไป GitHub (wormadi) ไม่สำเร็จ — ตรวจการเชื่อมต่อ/สิทธิ์ GitHub');

  console.log('\nเสร็จแล้ว');
  console.log('  ลิงก์ 1 (Cloudflare): https://wormadi.pages.dev');
  console.log('  ลิงก์ 2 (GitHub):     https://boboapp2020-design.github.io/wormadi/' + (gc.status ? '  (ยังไม่ได้อัปเดต)' : '  (อัปเดตใน 1–2 นาที)'));
})().catch(e => { console.error('\n✗', e.message); process.exit(1); });
