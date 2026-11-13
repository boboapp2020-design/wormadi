// เกมดวลเพื่อน: XO และ หมากฮอสสากล — ตรวจกติกาที่เซิร์ฟเวอร์ทั้งหมด ฝั่งแอปแค่วาดกระดานและส่งตาเดิน
// state: XO       -> { b: [9 ช่อง: '', 'X', 'O'] }          p1 = X เดินก่อน
//        หมากฮอส  -> { b: [10 แถว][10 ช่อง], q }             p1 = 'a'/'A' (ล่าง เดินขึ้น), p2 = 'b'/'B' (บน เดินลง) · ตัวใหญ่ = โคน

export const KINDS = ['xo', 'checkers'];

// ------------------------------------------------------------------ XO
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
export const xoStart = () => ({ b: Array(9).fill('') });
function xoMove(st, side, mv) {
  const i = Number(mv?.cell);
  if (!Number.isInteger(i) || i < 0 || i > 8) return { error: 'ช่องไม่ถูกต้อง' };
  if (st.b[i]) return { error: 'ช่องนี้ถูกใช้แล้ว' };
  const b = st.b.slice(); b[i] = side === 1 ? 'X' : 'O';
  const line = LINES.find(l => l.every(k => b[k] === b[i]));
  if (line) return { state: { b, line }, end: { winner: side } };
  if (b.every(Boolean)) return { state: { b }, end: { winner: 0 } };
  return { state: { b } };
}

// ------------------------------------------------------------------ หมากฮอสสากล (International draughts 10x10)
// กติกา: 20 ตัวต่อฝ่าย · ลูกธรรมดาเดินเฉียงไปข้างหน้า 1 ช่อง แต่กินได้ทั้งไปหน้าและถอยหลัง · โคนบินเฉียงได้ไกลทั้งเดินและกิน
//        ต้องกินเสมอ และต้องเลือกทางที่กินได้ "มากตัวที่สุด" · กินต่อเนื่องได้หลายตัวในตาเดียว ห้ามข้ามตัวเดิมสองครั้ง
//        ตัวที่ถูกกินจะถูกยกออกหลังจบตา · ลูกธรรมดาจะเป็นโคนเมื่อ "จบตา" ที่แถวสุดท้าย (ผ่านเฉยๆ ระหว่างกินไม่นับ)
//        ชนะเมื่อฝ่ายตรงข้ามไม่มีตัว หรือเดินไม่ได้ · เสมอเมื่อ 50 ตาติดกันไม่มีการกินและไม่มีลูกธรรมดาเดิน
const N = 10;
const DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const inb = (r, c) => r >= 0 && r < N && c >= 0 && c < N;
const owner = ch => (ch === 'a' || ch === 'A' ? 1 : ch === 'b' || ch === 'B' ? 2 : 0);
const fwd = side => (side === 1 ? -1 : 1);
const lastRow = side => (side === 1 ? 0 : N - 1);
export function checkersStart() {
  const b = Array.from({ length: N }, () => Array(N).fill(''));
  for (let r = 0; r < 4; r++) for (let c = 0; c < N; c++) if ((r + c) % 2 === 1) b[r][c] = 'b';
  for (let r = N - 4; r < N; r++) for (let c = 0; c < N; c++) if ((r + c) % 2 === 1) b[r][c] = 'a';
  return { b, q: 0 };
}
function captures(b, side, r0, c0) {
  const king = b[r0][c0] === 'A' || b[r0][c0] === 'B', foe = side === 1 ? 2 : 1, out = [];
  const free = (r, c) => b[r][c] === '' || (r === r0 && c === c0);          // the piece's own start square is empty while it moves
  const walk = (r, c, caps, path) => {
    let more = false;
    for (const [dr, dc] of DIRS) {
      if (!king) {
        const mr = r + dr, mc = c + dc, lr = r + 2 * dr, lc = c + 2 * dc;
        if (inb(lr, lc) && owner(b[mr][mc]) === foe && !caps.includes(mr * N + mc) && free(lr, lc)) {
          more = true; walk(lr, lc, [...caps, mr * N + mc], [...path, [lr, lc]]);
        }
      } else {
        let rr = r + dr, cc = c + dc;
        while (inb(rr, cc) && free(rr, cc)) { rr += dr; cc += dc; }
        if (!inb(rr, cc) || owner(b[rr][cc]) !== foe || caps.includes(rr * N + cc)) continue;
        let lr = rr + dr, lc = cc + dc;
        while (inb(lr, lc) && free(lr, lc)) {
          more = true; walk(lr, lc, [...caps, rr * N + cc], [...path, [lr, lc]]);
          lr += dr; lc += dc;
        }
      }
    }
    if (!more && path.length > 1) out.push({ path, caps: caps.map(k => [Math.floor(k / N), k % N]) });
  };
  walk(r0, c0, [], [[r0, c0]]);
  return out;
}
function steps(b, side, r0, c0) {
  const king = b[r0][c0] === 'A' || b[r0][c0] === 'B', out = [];
  for (const [dr, dc] of DIRS) {
    if (!king && dr !== fwd(side)) continue;
    let r = r0 + dr, c = c0 + dc;
    while (inb(r, c) && b[r][c] === '') {
      out.push({ path: [[r0, c0], [r, c]], caps: [] });
      if (!king) break;
      r += dr; c += dc;
    }
  }
  return out;
}
export function legalMoves(b, side) {
  const caps = [], simple = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (owner(b[r][c]) !== side) continue;
    caps.push(...captures(b, side, r, c)); simple.push(...steps(b, side, r, c));
  }
  if (!caps.length) return simple;
  const most = Math.max(...caps.map(m => m.caps.length));
  return caps.filter(m => m.caps.length === most);                          // ต้องกิน และต้องกินให้มากที่สุด
}
function checkersMove(st, side, mv) {
  const want = JSON.stringify(mv?.path);
  const legal = legalMoves(st.b, side).find(m => JSON.stringify(m.path) === want);
  if (!legal) return { error: 'เดินแบบนี้ไม่ได้ (ต้องกิน และต้องเลือกทางที่กินได้มากที่สุด)' };
  const b = st.b.map(row => row.slice()), [r0, c0] = legal.path[0], [r1, c1] = legal.path[legal.path.length - 1];
  const piece = b[r0][c0], man = piece === 'a' || piece === 'b';
  b[r0][c0] = '';
  for (const [r, c] of legal.caps) b[r][c] = '';
  b[r1][c1] = man && r1 === lastRow(side) ? piece.toUpperCase() : piece;      // จบตาที่แถวสุดท้าย = เป็นโคน
  const q = legal.caps.length || man ? 0 : (st.q || 0) + 1;
  const foe = side === 1 ? 2 : 1;
  const next = { b, q, last: legal.path, caps: legal.caps };
  if (!legalMoves(b, foe).length) return { state: next, end: { winner: side } };
  if (q >= 50) return { state: next, end: { winner: 0 } };
  return { state: next };
}

// ------------------------------------------------------------------ public
export const startState = kind => (kind === 'xo' ? xoStart() : checkersStart());
/** side: 1 = p1, 2 = p2 → { state, end?: { winner: 1|2|0 } } or { error } */
export function applyMove(kind, state, side, mv) {
  return kind === 'xo' ? xoMove(state, side, mv) : checkersMove(state, side, mv);
}
/** legal full-turn paths for the player to move (the app uses these to highlight and to send the move) */
export function legalFor(kind, state, side) {
  return kind === 'checkers' ? legalMoves(state.b, side).map(m => m.path) : [];
}
