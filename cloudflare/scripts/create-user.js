// สร้างหรือรีเซ็ตบัญชีพนักงานจากคอมพิวเตอร์ (ใช้สร้างผู้ดูแลระบบคนแรก หรือกรณีลืมรหัสผ่าน admin)
//   node scripts/create-user.js --emp admin --name "ผู้ดูแลระบบ" --role admin [--password xxx] [--dept ...] [--position ...] [--local]
// ไม่ใส่ --password = สุ่มรหัสผ่านให้แล้วพิมพ์ออกมา · ไม่ใส่ --local = เขียนลงฐานข้อมูลจริงบน Cloudflare
// รหัสผ่านเก็บแบบ PBKDF2-SHA256 100,000 รอบ รูปแบบเดียวกับ src/auth.js
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
}
if (!args.emp || !args.name) {
  console.log('ใช้: node scripts/create-user.js --emp <รหัสพนักงาน> --name "<ชื่อ>" [--role user|lead|admin] [--password <รหัส>] [--dept ..] [--position ..] [--local]');
  process.exit(1);
}
const role = ['user', 'lead', 'admin'].includes(args.role) ? args.role : 'user';
const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const password = typeof args.password === 'string' ? args.password : Array.from(crypto.randomBytes(12), b => ABC[b % ABC.length]).join('');
const salt = crypto.randomBytes(16);
const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
const stored = `pbkdf2$100000$${salt.toString('base64')}$${hash.toString('base64')}`;
const q = v => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

const sql = `INSERT INTO users (emp, name, dept, position, role, pass, created_at) VALUES (${q(args.emp)}, ${q(args.name)}, ${q(args.dept || '')}, ${q(args.position || '')}, ${q(role)}, ${q(stored)}, ${Date.now()})
ON CONFLICT(emp) DO UPDATE SET name = excluded.name, role = excluded.role, pass = excluded.pass, active = 1;
DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE emp = ${q(args.emp)});`;

const root = path.join(__dirname, '..');
execFileSync(process.execPath, [path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'd1', 'execute', 'walkie-log', args.local ? '--local' : '--remote', ...(args['persist-to'] ? ['--persist-to', args['persist-to']] : []), '--command', sql],
  { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
console.log(`✓ บัญชี ${args.emp} (${role}) พร้อมใช้งาน${args.local ? ' [local]' : ''}`);
if (typeof args.password !== 'string') console.log(`  รหัสผ่าน: ${password}`);
