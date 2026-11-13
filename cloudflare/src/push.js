// Web Push (เตือนเหตุฉุกเฉินแม้ปิดเว็บแอป) — ส่งแบบไม่มีเนื้อหา (no payload) จึงไม่ต้องเข้ารหัสข้อความ
// service worker (server/public/sw.js) ได้รับแล้วดึงรายละเอียดเหตุล่าสุดจาก /api/sos เอง
// ต้องมี: vars.VAPID_PUBLIC (wrangler.jsonc) + secret VAPID_PRIVATE_JWK (wrangler secret put VAPID_PRIVATE_JWK)

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let keyCache = null;
async function signingKey(env) {
  if (!keyCache) keyCache = crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return keyCache;
}

/** Authorization header for one push service (aud = its origin) */
async function vapidAuth(env, endpoint) {
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://wormadi.boboapp2020.workers.dev' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(env), enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${env.VAPID_PUBLIC}`;
}

export const pushReady = env => !!(env.VAPID_PUBLIC && env.VAPID_PRIVATE_JWK);

/** wake every subscribed device (except `exceptUserId`); removes subscriptions the push service says are gone */
export async function pushAll(env, { exceptUserId = null, urgency = 'high', ttl = 3600 } = {}) {
  if (!pushReady(env)) return { sent: 0, ready: false };
  const { results } = await env.DB.prepare('SELECT endpoint FROM push_subs WHERE user_id IS NOT ?').bind(exceptUserId).all();
  return send(env, results, urgency, ttl);
}

/** wake only these people's devices (private chat / voice message while their app is closed) */
export async function pushTo(env, userIds, { urgency = 'high', ttl = 86400 } = {}) {
  if (!pushReady(env) || !userIds.length) return { sent: 0, ready: pushReady(env) };
  const { results } = await env.DB.prepare(`SELECT endpoint FROM push_subs WHERE user_id IN (${userIds.map(() => '?').join(',')})`).bind(...userIds).all();
  return send(env, results, urgency, ttl);
}

async function send(env, results, urgency, ttl) {
  const db = env.DB;
  let sent = 0;
  await Promise.allSettled(results.map(async ({ endpoint }) => {
    try {
      const r = await fetch(endpoint, { method: 'POST', headers: { Authorization: await vapidAuth(env, endpoint), TTL: String(ttl), Urgency: urgency, 'Content-Length': '0' } });
      if (r.status === 404 || r.status === 410) await db.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(endpoint).run();
      else if (r.ok) sent++;
      else console.error('push failed', r.status, await r.text().catch(() => ''));
    } catch (e) { console.error('push error', e); }
  }));
  return { sent, ready: true };
}
