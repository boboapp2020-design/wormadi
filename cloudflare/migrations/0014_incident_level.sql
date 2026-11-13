-- ระดับเหตุการณ์: low | medium | high (high = เตือนทุกคน ไฟแดงค้างจนกว่าจะมีคนกดว่าแก้ไขแล้ว)
ALTER TABLE incidents ADD COLUMN level TEXT NOT NULL DEFAULT 'low';
