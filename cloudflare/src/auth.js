// บัญชีพนักงาน: รหัสผ่านเก็บแบบ PBKDF2-SHA256 (100,000 รอบ + salt) และ session token เก็บเฉพาะค่า hash
// รูปแบบรหัสผ่านที่เก็บ: pbkdf2$<รอบ>$<salt base64>$<hash base64>  (scripts/create-user.js ใช้รูปแบบเดียวกัน)

const ITER = 100_000;                 // สูงสุดที่ Workers รองรับ
const enc = new TextEncoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export const ROLES = ['user', 'lead', 'admin'];
export const roleAtLeast = (role, min) => ROLES.indexOf(role) >= ROLES.indexOf(min);

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(await pbkdf2(password, salt, ITER))}`;
}

export async function verifyPassword(password, stored) {
  const [kind, iter, salt, hash] = String(stored || '').split('$');
  if (kind !== 'pbkdf2') return false;
  const got = new Uint8Array(await pbkdf2(password, unb64(salt), Number(iter)));
  const want = unb64(hash);
  return got.length === want.length && crypto.subtle.timingSafeEqual(got, want);
}

export async function sha256(text) {
  return b64(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export function newToken() {
  return b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
}

export async function createSession(db, userId, remember) {
  const token = newToken();
  const now = Date.now();
  const ttl = remember ? 90 * 86_400_000 : 16 * 3_600_000;   // จดจำ = 90 วัน, ไม่จดจำ = 16 ชั่วโมง (1 กะ+)
  await db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), userId, now, now + ttl).run();
  return { token, expires: now + ttl };
}

export const PUBLIC_USER = 'u.id, u.emp, u.name, u.dept, u.position, u.main_channel, u.role, u.active, u.last_seen, u.must_change, (u.avatar IS NOT NULL) AS has_avatar';

/** Returns the signed-in user (without password) or null. */
export async function userFromToken(db, token) {
  if (!token || token.length < 20) return null;
  const row = await db.prepare(
    `SELECT ${PUBLIC_USER} FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`
  ).bind(await sha256(token), Date.now()).first();
  return row || null;
}

export function bearer(req) {
  const h = req.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
