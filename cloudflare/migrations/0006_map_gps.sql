-- แผนที่จริง: หมุดมีพิกัด GPS (lat/lng) · x/y เดิมยังเก็บไว้
ALTER TABLE map_pins ADD COLUMN lat REAL;
ALTER TABLE map_pins ADD COLUMN lng REAL;
