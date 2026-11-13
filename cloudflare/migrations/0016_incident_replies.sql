-- ตอบกลับความคิดเห็น (แบบโซเชียล): parent_id = ความคิดเห็นหลักของเธรด · reply_to = คนที่ถูกตอบ
ALTER TABLE incident_comments ADD COLUMN parent_id INTEGER;
ALTER TABLE incident_comments ADD COLUMN reply_to INTEGER;
