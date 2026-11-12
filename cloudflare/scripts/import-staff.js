// นำเข้ารายชื่อพนักงานจากไฟล์ CSV (export จาก Google Sheet) — รันซ้ำได้
//   node scripts/import-staff.js [data/staff.csv] [--local] [--persist-to <dir>] [--dry]
// คอลัมน์: รหัสพนักงาน, ชื่อ-นามสกุล, แผนก (K), หน่วย (L)
// - เอาเฉพาะหน่วยที่อยู่ใน UNITS ด้านล่าง
// - username = รหัสพนักงาน, รหัสผ่านเริ่มต้น 1234 และบังคับตั้งรหัสใหม่ตอนเข้าครั้งแรก (must_change = 1)
// - คนที่มีบัญชีอยู่แล้ว: อัปเดตชื่อ/หน่วย/แผนก/ช่องหลัก แต่ไม่แตะรหัสผ่านและสิทธิ์เดิม
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const flag = n => argv.includes('--' + n);
const opt = n => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--persist-to') || path.join(__dirname, '..', 'data', 'staff.csv');
const DEFAULT_PASSWORD = '1234';

// หน่วย (L) ที่นำเข้า → [ชื่อหน่วยในแอป, ช่องหลัก]
const UNITS = [
  [/^หน่วยลูกหีบ$/, 'ลูกหีบ', 'ฝ่ายผลิต'],
  [/^หน่วยหม้อต้ม$/, 'หม้อต้ม', 'ฝ่ายผลิต'],
  [/^หน่วยหม้อเคี่ยว$/, 'หม้อเคี่ยว', 'ฝ่ายผลิต'],
  [/^หน่วยหม้อปั่น$/, 'หม้อปั่น', 'ฝ่ายผลิต'],
  [/^หน่วยหม้อไอน้ำ$/, 'หม้อไอน้ำ', 'โรงไฟฟ้า (Power Plant)'],
  [/^หน่วยไฟฟ้าผลิต$/, 'ไฟฟ้าผลิต', 'โรงไฟฟ้า (Power Plant)'],
  [/^หน่วยซ่อมบำรุงไฟฟ้า$/, 'ซ่อมบำรุงไฟฟ้า', 'ซ่อมบำรุง (M&E)'],
  [/^หน่วยซ่อมบำรุงเครื่องกล$/, 'ซ่อมบำรุงเครื่องกล', 'ซ่อมบำรุง (M&E)'],
  [/ความปลอด|^จป/, 'จป. (ความปลอดภัย)', 'ความปลอดภัย (Safety)'],
];

// คนที่เพิ่มเป็นรายคน (นอกหน่วยด้านบน) ตามรหัสพนักงาน · ไม่มีช่องหลัก
// one employee ID per line in data/extra-emp.txt (kept out of git: personal data)
const EXTRA_FILE = path.join(__dirname, '..', 'data', 'extra-emp.txt');
const EXTRA_EMP = fs.existsSync(EXTRA_FILE) ? fs.readFileSync(EXTRA_FILE, 'utf8').split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#')) : [];

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')).slice(1);
const people = [], seen = new Set(), counts = {};
for (const [emp0, name0, dept0, unit0] of rows) {
  const emp = String(emp0 || '').trim(), name = String(name0 || '').trim(), unit = String(unit0 || '').trim();
  let hit = UNITS.find(([re]) => re.test(unit));
  if (!hit && EXTRA_EMP.includes(emp)) hit = [null, unit.replace(/^หน่วย/, '') || String(dept0 || '').trim(), null];
  if (!hit || !emp || !name) continue;
  if (seen.has(emp.toLowerCase())) { console.warn(`⚠️ รหัสซ้ำ ${emp} — ข้าม`); continue; }
  seen.add(emp.toLowerCase());
  people.push({ emp, name, dept: hit[1], position: String(dept0 || '').trim(), channel: hit[2] });
  counts[hit[1]] = (counts[hit[1]] || 0) + 1;
}

const q = v => `'${String(v).replace(/'/g, "''")}'`;
const now = Date.now();
const sql = people.map(p => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(DEFAULT_PASSWORD, salt, 100000, 32, 'sha256');
  const pass = `pbkdf2$100000$${salt.toString('base64')}$${hash.toString('base64')}`;
  return `INSERT INTO users (emp, name, dept, position, main_channel, role, pass, created_at, must_change)
VALUES (${q(p.emp)}, ${q(p.name)}, ${q(p.dept)}, ${q(p.position)}, ${p.channel ? `(SELECT id FROM channels WHERE name = ${q(p.channel)})` : 'NULL'}, 'user', ${q(pass)}, ${now}, 1)
ON CONFLICT(emp) DO UPDATE SET name = excluded.name, dept = excluded.dept, position = excluded.position, main_channel = excluded.main_channel, active = 1;`;
}).join('\n');

console.log(`พบ ${people.length} คน จาก ${path.basename(file)}`);
for (const u of Object.keys(counts)) console.log(`  ${u.padEnd(20)} ${counts[u]}`);
if (flag('dry')) process.exit(0);

const root = path.join(__dirname, '..');
const tmp = path.join(root, '.wrangler', 'import-staff.sql');
fs.mkdirSync(path.dirname(tmp), { recursive: true });
fs.writeFileSync(tmp, sql);
try {
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'd1', 'execute', 'walkie-log',
    flag('local') ? '--local' : '--remote', ...(opt('persist-to') ? ['--persist-to', opt('persist-to')] : []), '--file', tmp, '--yes'],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
} finally { fs.unlinkSync(tmp); }
console.log(`✓ นำเข้าแล้ว${flag('local') ? ' [local]' : ''} — เข้าสู่ระบบด้วยรหัสพนักงาน + รหัสผ่าน ${DEFAULT_PASSWORD} แล้วระบบจะให้ตั้งรหัสใหม่`);
