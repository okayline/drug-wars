-- Drugwar server bank (Cloudflare D1: the moba-beat database; every table is named drugwars_...)
--   npx wrangler d1 execute moba-beat --remote --file=migrations/001_banks.sql
-- A bank is an 8-digit code and a balance. Whoever has the code has the bank.
CREATE TABLE IF NOT EXISTS drugwars_banks (
  code        TEXT PRIMARY KEY,
  balance     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,       -- unix seconds
  updated_at  INTEGER NOT NULL
);
-- rate limits per hashed IP and hour (also created by the earlier dealers version)
CREATE TABLE IF NOT EXISTS drugwars_rate_limits (
  key           TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
