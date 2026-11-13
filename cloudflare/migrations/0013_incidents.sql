-- รายงานเหตุการณ์: กระดานที่ทุกคนโพสต์ข้อความ/รูป เมื่อพบสิ่งผิดปกติ (เก็บ 30 วัน)
CREATE TABLE IF NOT EXISTS incidents (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  user_id  INTEGER NOT NULL,
  text     TEXT    NOT NULL DEFAULT '',
  place    TEXT    NOT NULL DEFAULT '',
  lat      REAL,
  lng      REAL,
  thumb    TEXT,                 -- small JPEG data URL shown in the list
  photo    TEXT,                 -- full JPEG data URL, loaded when tapped
  done_at  INTEGER,              -- marked "แก้ไขแล้ว"
  done_by  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_incidents_ts ON incidents (ts);
