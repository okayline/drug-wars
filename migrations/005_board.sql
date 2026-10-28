-- Drugwar names and the daily board (Cloudflare D1: the moba-beat database)
--   npx wrangler d1 execute moba-beat --remote --file=migrations/005_board.sql
-- A bank gets a random two-word name (src/names.js); banks made before this get one the first time it is needed.
ALTER TABLE drugwars_banks ADD COLUMN name TEXT;
ALTER TABLE drugwars_banks ADD COLUMN name_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS drugwars_banks_name ON drugwars_banks (name_key);
-- The daily board: each bank's best finished run of the (UTC) day, by money at the end (bank + cash - debt).
CREATE TABLE IF NOT EXISTS drugwars_board (
  day    INTEGER NOT NULL,            -- unix seconds / 86400
  bank   TEXT NOT NULL REFERENCES drugwars_banks(code),
  money  INTEGER NOT NULL,
  PRIMARY KEY (day, bank)
);
CREATE INDEX IF NOT EXISTS drugwars_board_top ON drugwars_board (day, money DESC);
