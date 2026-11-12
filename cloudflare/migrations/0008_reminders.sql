-- บันทึก / เตือน (แทน "งานของฉัน"): บันทึกส่วนตัว + เตือนตามเวลา (ครั้งเดียว / ทุกวัน / ทุกกะ / ทุกสัปดาห์)
CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,              -- เจ้าของ (เห็นได้คนเดียว)
  title      TEXT    NOT NULL,
  note       TEXT    NOT NULL DEFAULT '',
  due_at     INTEGER,                       -- เวลาที่ตั้งไว้ (แสดงผล)
  next_at    INTEGER,                       -- เวลาที่จะเตือนครั้งถัดไป (NULL = ไม่เตือน)
  rpt        TEXT    NOT NULL DEFAULT 'none',  -- none | daily | shift (8 ชม.) | weekly
  channel    TEXT,                          -- เตือนคนในกลุ่มนี้ด้วย (ไม่บังคับ)
  done_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_next ON reminders (next_at);
CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders (user_id);
