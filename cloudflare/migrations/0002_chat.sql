-- ห้องสนทนา: ข้อความพิมพ์ (text) และรายการ "พูด" (talk: บันทึกแค่ใคร/เมื่อไร/นานเท่าไร ไม่อัดเสียง)
CREATE TABLE IF NOT EXISTS messages (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,   -- ms since epoch (UTC)
  channel TEXT    NOT NULL,
  kind    TEXT    NOT NULL,   -- text | talk
  name    TEXT    NOT NULL,
  dept    TEXT,
  uid     TEXT,               -- id ของเครื่อง (สุ่มเก็บในมือถือ) ใช้แยกว่า "ของฉัน"
  text    TEXT,
  ms      INTEGER             -- ความยาวที่พูด (kind = talk)
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages (channel, id);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages (ts);

-- กดถูกใจ: 1 เครื่อง 1 ครั้งต่ออีโมจิต่อข้อความ (กดซ้ำ = ยกเลิก)
CREATE TABLE IF NOT EXISTS reactions (
  msg_id INTEGER NOT NULL,
  uid    TEXT    NOT NULL,
  emoji  TEXT    NOT NULL,
  name   TEXT,
  ts     INTEGER,
  PRIMARY KEY (msg_id, uid, emoji)
);
