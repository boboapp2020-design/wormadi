// ใช้หน้าเว็บไฟล์เดียวกับเซิร์ฟเวอร์ (server/public/index.html) เป็น UI ของแอป
// รันอัตโนมัติจาก `npm run sync` และ `npm run build:debug`
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '..', 'server', 'public');
const dst = path.join(__dirname, '..', 'www');

fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src)) {
  fs.cpSync(path.join(src, f), path.join(dst, f), { recursive: true });
}
console.log(`copied ${src} -> ${dst}`);
