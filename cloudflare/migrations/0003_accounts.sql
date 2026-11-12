-- บัญชีพนักงาน, กลุ่มสื่อสาร, งาน, เหตุฉุกเฉิน, แผนที่, การแจ้งเตือน, เสียงที่บันทึก

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  emp        TEXT    NOT NULL UNIQUE COLLATE NOCASE,  -- รหัสพนักงาน
  name       TEXT    NOT NULL,
  dept       TEXT    NOT NULL DEFAULT '',             -- แผนก
  position   TEXT    NOT NULL DEFAULT '',             -- ตำแหน่ง
  main_channel INTEGER,                               -- ช่องหลัก (channels.id)
  role       TEXT    NOT NULL DEFAULT 'user',         -- user | lead | admin
  pass       TEXT    NOT NULL,                        -- pbkdf2$iter$salt$hash
  avatar     TEXT,                                    -- data:image/jpeg;base64,... (ย่อเหลือ ~256px)
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                        -- SHA-256 ของ token (ไม่เก็บ token จริง)
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS channels (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT    NOT NULL UNIQUE,
  sub    TEXT    NOT NULL DEFAULT '',                 -- คำอธิบาย เช่น Crushing / Boiling
  icon   TEXT    NOT NULL DEFAULT 'radio',
  color  TEXT    NOT NULL DEFAULT 'blue',
  sort   INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO channels (name, sub, icon, color, sort) VALUES
  ('โรงงาน (ทั้งหมด)', 'ประกาศสำคัญ / ภาพรวม', 'star', 'gold', 1),
  ('ฝ่ายผลิต', 'Crushing / Boiling / Centrifuge', 'gear', 'green', 2),
  ('โรงไฟฟ้า (Power Plant)', 'Boiler / Power Plant', 'bolt', 'yellow', 3),
  ('คลังสินค้า / บรรจุ', 'Warehouse / Packaging', 'box', 'purple', 4),
  ('ซ่อมบำรุง (M&E)', 'Mechanical / Electrical', 'tools', 'orange', 5),
  ('QA / QC', 'คุณภาพ / ห้องแล็บ', 'flask', 'blue', 6),
  ('ความปลอดภัย (Safety)', 'Safety / Emergency', 'shield', 'red', 7);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  detail      TEXT    NOT NULL DEFAULT '',
  due_at      INTEGER,                                -- ms (ก่อน ... น.)
  assignee_id INTEGER NOT NULL,
  created_by  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  done_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks (assignee_id, due_at);

CREATE TABLE IF NOT EXISTS sos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  kind       TEXT    NOT NULL,                        -- fire | injury | chemical | other
  note       TEXT    NOT NULL DEFAULT '',
  place      TEXT    NOT NULL DEFAULT '',
  lat        REAL,
  lng        REAL,
  status     TEXT    NOT NULL DEFAULT 'open',         -- open | closed
  closed_by  INTEGER,
  closed_at  INTEGER
);
CREATE TABLE IF NOT EXISTS sos_acks (
  sos_id  INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  ts      INTEGER NOT NULL,
  PRIMARY KEY (sos_id, user_id)
);

CREATE TABLE IF NOT EXISTS map_pins (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  icon    TEXT NOT NULL DEFAULT 'pin',
  color   TEXT NOT NULL DEFAULT 'blue',
  x       REAL NOT NULL,                              -- % จากซ้าย
  y       REAL NOT NULL,                              -- % จากบน
  channel_id INTEGER,
  note    TEXT NOT NULL DEFAULT ''
);
INSERT INTO map_pins (name, icon, color, x, y, note)
  SELECT 'โรงไฟฟ้า', 'bolt', 'orange', 22, 22, '' WHERE NOT EXISTS (SELECT 1 FROM map_pins);
INSERT INTO map_pins (name, icon, color, x, y, note)
  SELECT 'อาคารผลิต', 'gear', 'blue', 66, 32, '' WHERE (SELECT COUNT(*) FROM map_pins) = 1;
INSERT INTO map_pins (name, icon, color, x, y, note)
  SELECT 'คลังสินค้า', 'box', 'purple', 24, 78, '' WHERE (SELECT COUNT(*) FROM map_pins) = 2;
INSERT INTO map_pins (name, icon, color, x, y, note)
  SELECT 'จุดรวมพล', 'users', 'green', 70, 80, 'จุดรวมพลเมื่อเกิดเหตุฉุกเฉิน' WHERE (SELECT COUNT(*) FROM map_pins) = 3;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- การแจ้งเตือนจากระบบ (user_id NULL = ทุกคน)
CREATE TABLE IF NOT EXISTS notifications (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  user_id INTEGER,
  kind    TEXT NOT NULL,                              -- sos | task | system
  title   TEXT NOT NULL,
  body    TEXT NOT NULL DEFAULT '',
  ref     TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications (ts);
CREATE TABLE IF NOT EXISTS notif_reads (
  user_id INTEGER PRIMARY KEY,
  last_read INTEGER NOT NULL
);

-- เสียงที่บันทึกไว้ (ไฟล์อยู่ใน R2) และผู้ส่งเป็นบัญชีพนักงาน
ALTER TABLE messages ADD COLUMN audio TEXT;
ALTER TABLE messages ADD COLUMN user_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_messages_kind_ts ON messages (kind, ts);
