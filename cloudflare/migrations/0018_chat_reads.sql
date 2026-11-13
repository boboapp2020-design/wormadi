-- ข้อความที่ยังไม่ได้อ่าน นับที่เซิร์ฟเวอร์ (นับได้แม้ข้อความมาตอนปิดแอป): เวลาที่อ่านล่าสุดต่อห้อง/แชท
CREATE TABLE IF NOT EXISTS chat_reads (
  user_id INTEGER NOT NULL,
  channel TEXT NOT NULL,          -- ชื่อห้อง / dm:a:b / '*' = จุดเริ่มนับของผู้ใช้คนนี้
  ts INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel)
);
