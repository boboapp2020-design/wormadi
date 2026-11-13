-- เกมดวลเพื่อน (XO / หมากฮอส): 2 คน ผลัดกันเดิน เก็บ 3 วัน
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- 'xo' | 'checkers'
  p1 INTEGER NOT NULL,                -- คนชวน (เดินก่อน)
  p2 INTEGER NOT NULL,                -- คนถูกชวน
  status TEXT NOT NULL DEFAULT 'invited',   -- invited | playing | done | declined
  state TEXT NOT NULL,
  turn INTEGER,
  winner INTEGER,                     -- user id (ว่าง = เสมอ)
  result TEXT,                        -- win | draw | resign
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_games_p1 ON games(p1);
CREATE INDEX IF NOT EXISTS idx_games_p2 ON games(p2);
