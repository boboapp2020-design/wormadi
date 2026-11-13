-- ความคิดเห็นในรายงานเหตุการณ์ (ลบตามรายงาน: เก็บ 7 วัน)
CREATE TABLE IF NOT EXISTS incident_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  text        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incident_comments ON incident_comments (incident_id, id);
