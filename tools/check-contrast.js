// ตรวจคอนทราสต์สีของทั้งสองธีมตาม WCAG 2.x (AA: ตัวอักษร 4.5:1, ขอบ/ไอคอน/ส่วนควบคุม 3:1)
// อ่านค่าสีจาก CSS variables ใน server/public/theme.css โดยตรง
// รัน: node tools/check-contrast.js
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'theme.css'), 'utf8');
function tokens(selectorRe) {
  const m = css.match(selectorRe);
  if (!m) throw new Error('theme block not found: ' + selectorRe);
  const out = {};
  for (const [, k, v] of m[1].matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) out[k] = v;
  return out;
}
const themes = {
  'ภาคสนาม (light)': tokens(/:root, :root\[data-theme="light"\] \{([^}]*)\}/),
  'กลางคืน (dark)': tokens(/:root\[data-theme="dark"\] \{([^}]*)\}/),
};
const lum = hex => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const TEXT = 4.5, UI = 3;
const pairs = [
  ['text', 'bg', TEXT, 'ตัวอักษรหลักบนพื้นหลัง'], ['text', 'panel', TEXT, 'ตัวอักษรบนการ์ด'], ['text', 'panel-2', TEXT, 'ตัวอักษรบนพื้นรอง'],
  ['text', 'field', TEXT, 'ช่องกรอก'], ['text', 'primary-soft', TEXT, 'พื้นที่เลือก'], ['text', 'mine-bg', TEXT, 'ฟองแชทของฉัน'], ['text', 'other-bg', TEXT, 'ฟองแชทคนอื่น'],
  ['muted', 'bg', TEXT, 'ตัวอักษรรองบนพื้นหลัง'], ['muted', 'panel', TEXT, 'ตัวอักษรรองบนการ์ด'], ['muted', 'other-bg', TEXT, 'เวลาในฟองแชท'],
  ['nav-muted', 'panel', TEXT, 'แท็บล่างที่ไม่ได้เลือก'],
  ['on-primary', 'primary', TEXT, 'ปุ่มหลัก'], ['on-primary', 'primary-2', TEXT, 'ปุ่มหลัก (ส่วนสว่าง)'],
  ['primary-fg', 'panel', TEXT, 'ลิงก์/แท็บที่เลือก'], ['primary-fg', 'bg', TEXT, 'ลิงก์บนพื้นหลัง'], ['primary-fg', 'primary-soft', TEXT, 'เมนูที่เลือก'],
  ['on-head', 'head-a', TEXT, 'หัวหน้าจอ (เข้ม)'], ['on-head', 'head-b', TEXT, 'หัวหน้าจอ (สว่าง)'], ['head-muted', 'head-b', TEXT, 'ข้อความรองบนหัว'],
  ['on-talk', 'talk', TEXT, 'ป้ายกำลังพูด'], ['talk-fg', 'panel', TEXT, 'ข้อความสีแดงบนการ์ด'],
  ['on-listen', 'listen', TEXT, 'ป้ายกำลังรับฟัง'], ['listen-fg', 'panel', TEXT, 'ข้อความสีเขียวบนการ์ด'],
  ['ok-fg', 'panel', TEXT, 'สำเร็จ'], ['warn-fg', 'panel', TEXT, 'เตือน'], ['err-fg', 'panel', TEXT, 'ผิดพลาด'],
  ['on-badge', 'badge', TEXT, 'ตัวเลขแจ้งเตือน'], ['on-accent', 'accent', TEXT, 'ปุ่มส้ม (เพิ่มพนักงาน)'],
  ['toast-fg', 'toast-bg', TEXT, 'กล่องแจ้งเตือนชั่วคราว'],
  ['on-ptt-page', 'ptt-page-a', TEXT, 'หน้าพูดทันที (ส่วนสว่าง)'], ['on-ptt-page', 'ptt-page-b', TEXT, 'หน้าพูดทันที (ส่วนเข้ม)'],
  ['ptt-page-muted', 'ptt-page-b', TEXT, 'ข้อความรองหน้าพูด'], ['ptt-page-muted', 'ptt-card', TEXT, 'การ์ดช่องหน้าพูด'], ['on-ptt-page', 'ptt-card', TEXT, 'ชื่อช่องหน้าพูด'],
  ['on-ptt', 'ptt-idle-a', TEXT, 'ปุ่มพูดสีส้ม (สว่าง)'], ['on-ptt', 'ptt-idle-b', TEXT, 'ปุ่มพูดสีส้ม (เข้ม)'],
  ['on-talk', 'ptt-talk-a', TEXT, 'ปุ่มพูดสีแดง'], ['on-talk', 'ptt-talk-b', TEXT, 'ปุ่มพูดสีแดง (เข้ม)'],
  ['on-listen', 'ptt-listen-a', TEXT, 'ปุ่มพูดสีเขียว'], ['on-listen', 'ptt-listen-b', TEXT, 'ปุ่มพูดสีเขียว (เข้ม)'],
  ['brand-fg', 'panel', TEXT, 'ชื่อแอป (หน้าเข้าสู่ระบบ)'], ['brand-talk', 'panel', TEXT, 'คำว่า Talk สีส้ม'],
  ['on-t-wt', 't-wt-a', TEXT, 'ไทล์ Walkie Talkie'], ['on-t-wt', 't-wt-b', TEXT, 'ไทล์ Walkie Talkie (เข้ม)'],
  ['t-grp-fg', 't-grp-bg', TEXT, 'ไทล์กลุ่มสื่อสาร'], ['text', 't-grp-bg', TEXT, 'ข้อความบนไทล์กลุ่ม'],
  ['on-t-msg', 't-msg-a', TEXT, 'ไทล์ข้อความ'], ['on-t-msg', 't-msg-b', TEXT, 'ไทล์ข้อความ (เข้ม)'],
  ['on-t-sos', 't-sos-a', TEXT, 'ไทล์ SOS'], ['on-t-sos', 't-sos-b', TEXT, 'ไทล์ SOS (เข้ม)'],
  ['t-task-fg', 't-task-bg', TEXT, 'ไทล์งานของฉัน'], ['text', 't-task-bg', TEXT, 'ข้อความบนไทล์งาน'],
  ['t-map-fg', 't-map-bg', TEXT, 'ไทล์แผนที่'], ['text', 't-map-bg', TEXT, 'ข้อความบนไทล์แผนที่'],
  ['line', 'panel', UI, 'ขอบช่องกรอก'], ['line', 'bg', UI, 'ขอบบนพื้นหลัง'], ['primary', 'panel', UI, 'ไอคอนแท็บที่เลือก'],
  ['nav-muted', 'panel', UI, 'ไอคอนแท็บล่าง'], ['ok-dot', 'panel', UI, 'จุดออนไลน์'], ['signal', 'bg', UI, 'แถบสัญญาณ'],
  ['talk', 'bg', UI, 'วงแหวนแดง'], ['listen', 'bg', UI, 'วงแหวนเขียว'], ['focus', 'bg', UI, 'กรอบโฟกัส'], ['focus', 'panel', UI, 'กรอบโฟกัสบนการ์ด'],
];

let failed = 0;
for (const [name, t] of Object.entries(themes)) {
  console.log(`\n== ${name} ==`);
  for (const [fg, bg, min, desc] of pairs) {
    if (!t[fg] || !t[bg]) { console.log(`  ?  ${fg}/${bg} ไม่พบค่าสี`); failed++; continue; }
    const r = ratio(t[fg], t[bg]);
    const ok = r >= min;
    if (!ok) failed++;
    console.log(`  ${ok ? 'ผ่าน' : 'ตก '}  ${r.toFixed(2).padStart(5)}:1 (ต้อง ≥${min})  ${desc}  [${fg} ${t[fg]} / ${bg} ${t[bg]}]`);
  }
}
console.log(failed ? `\n✗ ไม่ผ่าน ${failed} คู่` : `\n✓ ผ่านทุกคู่ (${pairs.length} คู่ต่อธีม)`);
process.exit(failed ? 1 : 0);
