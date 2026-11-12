-- เวลาที่พนักงานเข้าห้องครั้งแรก: คนเข้าทีหลังจะเห็นแชทตั้งแต่ตอนเข้าห้องเท่านั้น (ออกจากห้อง = ล้างเวลา)
CREATE TABLE IF NOT EXISTS room_since (
  user_id INTEGER NOT NULL,
  channel TEXT    NOT NULL,
  ts      INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel)
);
