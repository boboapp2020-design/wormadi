// สร้างไอคอน PWA (PNG) แบบไม่ต้องใช้ไลบรารีเพิ่ม: ปุ่มกดพูดสีเขียวบนพื้นเขียวเข้มแบบวิทยุ
// รัน: node tools/make-icons.js   -> server/public/icons/*.png + icon.svg
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'server', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

const BG = [0x0f, 0x15, 0x12], RING = [0x1b, 0x7a, 0x43], BTN = [0x2e, 0xcc, 0x71], DOT = [0xe8, 0xef, 0xe9];

// shapes in a 0..1 coordinate space; maskable icons keep content inside the 80% safe zone
function shapeColor(x, y, maskable) {
  const s = maskable ? 0.78 : 1;               // shrink artwork for maskable safe zone
  const u = (x - 0.5) / s + 0.5, v = (y - 0.5) / s + 0.5;
  const r = Math.hypot(u - 0.5, v - 0.56);
  if (u > 0.62 && u < 0.69 && v > 0.1 && v < 0.3) return DOT;   // antenna
  if (r < 0.22) return BTN;                     // talk button
  if (r < 0.3) return RING;                     // ring
  if (Math.abs(v - 0.2) < 0.012 && u > 0.36 && u < 0.6) return RING; // speaker slot
  return null;
}

function render(size, { maskable = false, rounded = true } = {}) {
  const SS = 4; // supersampling for smooth edges
  const px = Buffer.alloc(size * size * 4);
  const rad = rounded && !maskable ? 0.22 : 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const fx = (x + (sx + 0.5) / SS) / size, fy = (y + (sy + 0.5) / SS) / size;
      // rounded-square background (full bleed for maskable)
      if (rad) {
        const dx = Math.max(rad - fx, 0, fx - (1 - rad)), dy = Math.max(rad - fy, 0, fy - (1 - rad));
        if (Math.hypot(dx, dy) > rad) continue;
      }
      const c = shapeColor(fx, fy, maskable) || BG;
      r += c[0]; g += c[1]; b += c[2]; a += 255;
    }
    const n = SS * SS, i = (y * size + x) * 4;
    const cov = a / n / 255;
    px[i] = cov ? r / (n * cov) : 0; px[i + 1] = cov ? g / (n * cov) : 0; px[i + 2] = cov ? b / (n * cov) : 0; px[i + 3] = a / n;
  }
  return png(size, size, px);
}

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = ihdr[11] = ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }

const files = {
  'icon-192.png': render(192),
  'icon-512.png': render(512),
  'maskable-512.png': render(512, { maskable: true }),
  'apple-touch-180.png': render(180, { rounded: false }), // iOS rounds corners itself
};
for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), buf);

fs.writeFileSync(path.join(OUT, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" rx="22" fill="#0f1512"/>
<rect x="62" y="10" width="7" height="20" fill="#e8efe9"/>
<rect x="36" y="19" width="24" height="2.4" fill="#1b7a43"/>
<circle cx="50" cy="56" r="30" fill="#1b7a43"/><circle cx="50" cy="56" r="22" fill="#2ecc71"/>
</svg>
`);
console.log('icons ->', OUT, Object.keys(files).join(', '), '+ icon.svg');
