-- บังคับเปลี่ยนรหัสผ่านครั้งแรก (บัญชีที่นำเข้าด้วยรหัสเริ่มต้น หรือที่ admin รีเซ็ตรหัสให้)
ALTER TABLE users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0;
