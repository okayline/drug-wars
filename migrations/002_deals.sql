-- Drugwar player deals (Cloudflare D1: the moba-beat database)
--   npx wrangler d1 execute moba-beat --remote --file=migrations/002_deals.sql
-- owed = cash from sold deals, waiting for the seller to collect it in VISIT BANK.
ALTER TABLE drugwars_banks ADD COLUMN owed INTEGER NOT NULL DEFAULT 0;
-- A deal that's up: units of one drug at one price in one city. It stays up for a day.
CREATE TABLE IF NOT EXISTS drugwars_asks (
  id          INTEGER PRIMARY KEY,
  seller      TEXT NOT NULL REFERENCES drugwars_banks(code),
  city        INTEGER NOT NULL,       -- 0..5, the order of PLACES in public/index.html
  drug        INTEGER NOT NULL,       -- 0..5, the order of DRUGS in public/index.html
  units_left  INTEGER NOT NULL,
  price       INTEGER NOT NULL,       -- per unit
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drugwars_asks_city ON drugwars_asks (city, id);
