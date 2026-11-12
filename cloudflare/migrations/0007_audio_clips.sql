-- เสียงที่พูด (ฟังย้อนหลัง) เก็บใน D1 แบบบีบอัด μ-law 8 kHz เมื่อไม่ได้ใช้ R2 · ลบอัตโนมัติตาม RECORDING_RETENTION_DAYS
CREATE TABLE IF NOT EXISTS audio_clips (
  msg_id INTEGER PRIMARY KEY,         -- messages.id
  ts     INTEGER NOT NULL,
  rate   INTEGER NOT NULL,
  data   BLOB    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_clips_ts ON audio_clips (ts);
