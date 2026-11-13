-- ฝากข้อความเสียงส่วนตัว (ส่งถึงคนที่ออฟไลน์) · ตัวเสียงอยู่ใน messages/audio_clips · ตารางนี้จำว่าผู้รับฟังแล้วหรือยัง
CREATE TABLE IF NOT EXISTS voicemail (
  msg_id  INTEGER PRIMARY KEY,        -- messages.id
  to_id   INTEGER NOT NULL,
  from_id INTEGER NOT NULL,
  ts      INTEGER NOT NULL,
  heard   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_voicemail_to ON voicemail (to_id, heard);
