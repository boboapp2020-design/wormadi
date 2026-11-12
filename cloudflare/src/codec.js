// บีบอัดเสียงที่พูดเพื่อเก็บใน D1 (ไม่ต้องใช้ R2): 16 kHz PCM -> 8 kHz G.711 μ-law = 8 KB/วินาที (เล็กลง 4 เท่า คุณภาพระดับวิทยุสื่อสาร)

function mulawEncode(x) {
  const BIAS = 0x84, CLIP = 32635;
  let v = Math.round(x), sign = 0;
  if (v < 0) { sign = 0x80; v = -v; }
  if (v > CLIP) v = CLIP;
  v += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (v & mask) === 0 && exp > 0; mask >>= 1) exp--;
  const man = (v >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | man) & 0xff;
}
function mulawDecode(u) {
  u = ~u & 0xff;
  const sign = u & 0x80, exp = (u >> 4) & 7, man = u & 0x0f;
  const x = (((man << 3) + 0x84) << exp) - 0x84;
  return sign ? -x : x;
}

/** PCM16 chunks (ArrayBuffers) at `rate` -> { data: Uint8Array μ-law, rate } at ~8 kHz */
export function compress(chunks, bytes, rate = 16000) {
  const total = bytes >> 1, pcm = new Int16Array(total);
  let o = 0;
  for (const c of chunks) {
    const v = new Int16Array(c, 0, c.byteLength >> 1);
    const n = Math.min(v.length, total - o);
    pcm.set(v.subarray(0, n), o); o += n;
    if (o >= total) break;
  }
  const step = Math.max(1, Math.round(rate / 8000));
  const out = new Uint8Array(Math.floor(o / step));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let k = 0; k < step; k++) s += pcm[i * step + k];
    out[i] = mulawEncode(s / step);
  }
  return { data: out, rate: Math.round(rate / step) };
}

/** μ-law bytes -> playable 16-bit WAV file */
export function toWav(ulaw, rate) {
  const src = ulaw instanceof Uint8Array ? ulaw : new Uint8Array(ulaw);
  const len = src.length * 2, out = new Uint8Array(44 + len), v = new DataView(out.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, 36 + len, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len, true);
  for (let i = 0; i < src.length; i++) v.setInt16(44 + i * 2, mulawDecode(src[i]), true);
  return out;
}
