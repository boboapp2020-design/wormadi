-- log ของวอ: พูด (talk), เข้าช่อง (join), ออกช่อง (leave)
CREATE TABLE IF NOT EXISTS walkie_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,   -- เวลา (ms since epoch, UTC) ตอนเกิดเหตุการณ์ / ตอนพูดจบ
  event   TEXT    NOT NULL,   -- talk | join | leave
  channel TEXT    NOT NULL,
  name    TEXT    NOT NULL,
  ms      INTEGER,            -- ความยาวที่พูด (เฉพาะ talk)
  reason  TEXT                -- end | timeout | left (เฉพาะ talk)
);
CREATE INDEX IF NOT EXISTS idx_walkie_log_ts ON walkie_log (ts);
CREATE INDEX IF NOT EXISTS idx_walkie_log_channel_ts ON walkie_log (channel, ts);
