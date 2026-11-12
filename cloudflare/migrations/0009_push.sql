-- Web Push: เครื่องที่ลงทะเบียนรับเตือนเหตุฉุกเฉิน (1 บัญชี = 1 เครื่อง · ออกจากระบบ = ลบ)
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  p256dh     TEXT,
  auth       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subs (user_id);

-- คนที่ถูกผู้สร้างกลุ่มนำออก (เข้าไม่ได้จนกว่าจะได้รับเชิญอีกครั้ง)
CREATE TABLE IF NOT EXISTS channel_bans (
  channel_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
