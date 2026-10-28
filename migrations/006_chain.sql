-- Drugwar tamper-proof log (Cloudflare D1: the moba-beat database)
--   npx wrangler d1 execute moba-beat --remote --file=migrations/006_chain.sql
-- Each bank's lines in drugwars_log become one hash chain (see src/ledger.js): hash = SHA-256(prev_hash + "|" + record).
-- Lines written before this have no hash and are not part of a chain.
ALTER TABLE drugwars_log ADD COLUMN prev_hash TEXT;
ALTER TABLE drugwars_log ADD COLUMN hash TEXT;
-- a bank's chain can't fork: two lines can't build on the same one
CREATE UNIQUE INDEX IF NOT EXISTS drugwars_log_chain ON drugwars_log (bank, prev_hash) WHERE prev_hash IS NOT NULL;
