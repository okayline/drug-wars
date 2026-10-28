-- Drugwar hourly checkpoints (Cloudflare D1: the moba-beat database)
--   npx wrangler d1 execute moba-beat --remote --file=migrations/007_checkpoints.sql
-- Needs 006_chain.sql first. One row an hour (see checkpoint() in src/ledger.js), made by the cron in wrangler.jsonc.
CREATE TABLE IF NOT EXISTS drugwars_checkpoints (
  hour        INTEGER PRIMARY KEY,    -- unix seconds / 3600
  banks       INTEGER NOT NULL,       -- banks with a chain at that time
  lines       INTEGER NOT NULL,       -- chained lines at that time
  prev_root   TEXT NOT NULL,          -- the root before this one (64 zeros for the first)
  root        TEXT NOT NULL,          -- SHA-256(prev_root + "|" + "bank:hash,..." for every bank, sorted)
  max_log_id  INTEGER NOT NULL,       -- the newest chained log line it covers
  created_at  INTEGER NOT NULL
);
-- For each bank that played since the last checkpoint: its newest line then. verify() checks these still match.
CREATE TABLE IF NOT EXISTS drugwars_checkpoint_heads (
  hour     INTEGER NOT NULL REFERENCES drugwars_checkpoints(hour),
  bank     TEXT NOT NULL,
  last_id  INTEGER NOT NULL,
  hash     TEXT NOT NULL,
  PRIMARY KEY (hour, bank)
);
CREATE INDEX IF NOT EXISTS drugwars_checkpoint_heads_bank ON drugwars_checkpoint_heads (bank, hour);
