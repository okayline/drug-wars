-- Drugwar server-held runs (Cloudflare D1: the moba-beat database; every table is named drugwars_...)
--   npx wrangler d1 execute moba-beat --remote --file=migrations/003_runs.sql
--
-- A run is one 30-move game. The server holds everything the player has (cash, debt, coat, guns, damage)
-- and checks every action, so the page can't claim money or drugs it doesn't have.
-- The bank (drugwars_banks.balance) is the only thing that outlives a run.
CREATE TABLE IF NOT EXISTS drugwars_runs (
  id          INTEGER PRIMARY KEY,
  bank        TEXT NOT NULL REFERENCES drugwars_banks(code),
  state       TEXT NOT NULL DEFAULT 'live',  -- 'live' or 'over'
  ver         INTEGER NOT NULL DEFAULT 0,    -- bumped by every action; a request must name the version it saw
  move        INTEGER NOT NULL DEFAULT 1,    -- 1..30 (the original's "day")
  loc         INTEGER NOT NULL DEFAULT 0,    -- 0..5, the order of PLACES in public/index.html (0 = the Bronx)
  cash        INTEGER NOT NULL,
  debt        INTEGER NOT NULL,
  coat        INTEGER NOT NULL,              -- how many units the trenchcoat holds
  guns        INTEGER NOT NULL DEFAULT 0,
  damage      INTEGER NOT NULL DEFAULT 0,    -- 50 and you die
  st          TEXT NOT NULL,                 -- JSON: units held of each drug, 6 numbers
  prices      TEXT NOT NULL,                 -- JSON: today's price of each drug, 6 numbers
  pending     TEXT,                          -- JSON: a question or chase waiting for an answer, or NULL
  score       INTEGER,                       -- set when the run is over
  started_at  INTEGER NOT NULL,              -- unix seconds
  updated_at  INTEGER NOT NULL
);
-- one live run per bank
CREATE UNIQUE INDEX IF NOT EXISTS drugwars_runs_live ON drugwars_runs (bank) WHERE state = 'live';

-- Every accepted action, newest last. (A hash chain over these lines can come later.)
CREATE TABLE IF NOT EXISTS drugwars_log (
  id          INTEGER PRIMARY KEY,
  run         INTEGER NOT NULL REFERENCES drugwars_runs(id),
  bank        TEXT NOT NULL,
  move        INTEGER NOT NULL,
  kind        TEXT NOT NULL,                 -- buy, sell, jet, loan, deposit, withdraw, collect, post, buydeal, answer, chase
  drug        INTEGER,
  qty         INTEGER,
  amount      INTEGER,                       -- cash that moved (negative = the player paid)
  cash_after  INTEGER NOT NULL,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drugwars_log_run ON drugwars_log (run, id);
