-- Drugwar street trades (Cloudflare D1: the moba-beat database; every table is named drugwars_...)
--   npx wrangler d1 execute moba-beat --remote --file=migrations/004_street.sql
-- Also needs the price secret, set once (not in the code):
--   npx wrangler secret put PRICE_SECRET
--
-- What players bought from and sold to the street, per city, drug and hour. net is units: buying adds, selling subtracts.
-- The street reads the last day of these to push its prices (see street() in src/worker.js); the push fades hour by hour.
-- The street's own prices are not stored: they are worked out from the hour and the secret.
CREATE TABLE IF NOT EXISTS drugwars_trades (
  period  INTEGER NOT NULL,           -- unix seconds / PERIOD (one hour)
  city    INTEGER NOT NULL,           -- 0..5, the order of PLACES in public/index.html
  drug    INTEGER NOT NULL,           -- 0..5, the order of DRUGS in public/index.html
  net     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (period, city, drug)
);
