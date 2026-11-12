-- ห้องที่พนักงานสร้างเอง: ใส่รหัสห้องหรือไม่ก็ได้
ALTER TABLE channels ADD COLUMN pass TEXT;              -- pbkdf2 hash, NULL = ห้องเปิด
ALTER TABLE channels ADD COLUMN created_by INTEGER;     -- users.id (NULL = ระบบ/admin)
ALTER TABLE channels ADD COLUMN created_at INTEGER;
-- ใครปลดล็อกห้องที่มีรหัสแล้วบ้าง (ใส่รหัสถูกครั้งเดียว ครั้งต่อไปเข้าได้เลย)
CREATE TABLE IF NOT EXISTS channel_access (
  channel_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
