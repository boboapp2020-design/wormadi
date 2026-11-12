-- คำเชิญเข้ากลุ่มที่รอผู้ถูกเชิญกดยอมรับ (ยังไม่ให้สิทธิ์เข้า จนกว่าจะยอมรับ)
CREATE TABLE IF NOT EXISTS room_invites (
  channel_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  from_id    INTEGER,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
