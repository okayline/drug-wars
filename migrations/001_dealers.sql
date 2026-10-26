-- v1.2.0: the dealers (src/worker.js). New tables only; nothing existing is touched.
--   npx wrangler d1 execute moba-beat --remote --file=migrations/001_dealers.sql

-- A player is a browser cookie. The cookie holds a random token; only its SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS drugwars_players (
  id          INTEGER PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,       -- unix seconds
  seen_at     INTEGER NOT NULL
);

-- New players and new deals, counted per hashed IP and hour.
CREATE TABLE IF NOT EXISTS drugwars_rate_limits (
  key           TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- A deal that's up: units of one drug at one price in one city. It is up the moment it is made and stays up for a day.
-- run_id is the seller's run (a random id the page makes), so the cash only goes back to that run.
CREATE TABLE IF NOT EXISTS drugwars_listings (
  id          INTEGER PRIMARY KEY,
  seller_id   INTEGER NOT NULL REFERENCES drugwars_players(id),
  run_id      TEXT NOT NULL,
  city        INTEGER NOT NULL,       -- 0..5, the order of PLACES in public/index.html
  drug        INTEGER NOT NULL,       -- 0..5, the order of DRUGS in public/index.html
  units       INTEGER NOT NULL,
  units_left  INTEGER NOT NULL,
  price       INTEGER NOT NULL,       -- per unit
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drugwars_listings_city ON drugwars_listings (city, id);

-- The ledger: every finished deal, in one SHA-256 hash chain (hash = SHA-256(prev_hash + "|" + record)).
-- Records hold player ids, never names. prev_hash is UNIQUE, so the chain can't fork.
-- claimed_at is when the seller's run collected the cash.
CREATE TABLE IF NOT EXISTS drugwars_deals (
  id          INTEGER PRIMARY KEY,
  listing_id  INTEGER NOT NULL REFERENCES drugwars_listings(id),
  seller_id   INTEGER NOT NULL,
  buyer_id    INTEGER NOT NULL,
  run_id      TEXT NOT NULL,
  city        INTEGER NOT NULL,
  drug        INTEGER NOT NULL,
  units       INTEGER NOT NULL,
  price       INTEGER NOT NULL,
  total       INTEGER NOT NULL,
  record      TEXT NOT NULL,
  prev_hash   TEXT NOT NULL UNIQUE,
  hash        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  claimed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS drugwars_deals_seller ON drugwars_deals (seller_id, run_id);
