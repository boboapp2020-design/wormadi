-- แจ้งเตือนเมื่อห้องที่อยู่มีคนวอ/พิมพ์ ขณะปิดแอป (ผู้ใช้ปิดเองได้ที่ ตั้งค่า > ได้ยินตลอดเวลา)
ALTER TABLE users ADD COLUMN room_push INTEGER NOT NULL DEFAULT 1;
