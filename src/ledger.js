// The ledger: each bank's action log (drugwars_log) is one SHA-256 hash chain.
//
//   hash = SHA-256( prev_hash + "|" + record )
//
// A bank's first line chains from GENESIS. Changing any old line breaks its hash and every hash after it.
// (bank, prev_hash) is UNIQUE in the database, so a bank's chain can't fork. Same design as the other games' ledgers
// (aura-farm, scoundrel.exe, and this game's v1.2 deal ledger). It proves the log wasn't edited; it does not judge whether
// a move was allowed, because the Worker checks that before it writes a line.

export const GENESIS = "0".repeat(64);

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// the part of a line the hash covers (everything but its own id and the two hashes)
export const recordOf = (r) => JSON.stringify([r.bank, r.run, r.move, r.kind, r.drug ?? null, r.qty ?? null, r.amount ?? null, r.cash_after, r.at]);

// the hash of this bank's latest chained line, or GENESIS if it has none
export async function head(db, bank) {
  const h = await db.prepare("SELECT hash FROM drugwars_log WHERE bank = ? AND hash IS NOT NULL ORDER BY id DESC LIMIT 1").bind(bank).first();
  return h ? h.hash : GENESIS;
}

export const isUnique = (e) => /UNIQUE/i.test(String(e && e.message));

// Walk a bank's log and say whether the chain holds. Lines from before the chain began (no hash) are counted, not checked.
export async function verify(db, bank) {
  const { results } = await db.prepare("SELECT * FROM drugwars_log WHERE bank = ? ORDER BY id").bind(bank).all();
  let prev = GENESIS, chained = 0, unchained = 0;
  for (const r of results) {
    if (r.hash === null) {
      if (chained > 0) return { ok: false, lines: results.length, chained, unchained, broken: r.id };
      unchained++;
      continue;
    }
    if (r.prev_hash !== prev || r.hash !== (await sha256(prev + "|" + recordOf(r)))) return { ok: false, lines: results.length, chained, unchained, broken: r.id };
    prev = r.hash; chained++;
  }
  return { ok: true, lines: results.length, chained, unchained, head: prev };
}

// ---------- hourly checkpoints ----------
// Once an hour the Worker (cron, see wrangler.jsonc) takes the newest hash of every bank's chain and folds them into one
// root: root = SHA-256(prev_root + "|" + "bank:hash,bank:hash,..." sorted by bank). Each checkpoint also keeps, for every
// bank that played since the last one, the id and hash of its newest line, so a chain with lines cut off its end, or an old
// line changed, no longer matches (see verify). Anyone can copy the roots out of GET /api/checkpoints.
const HOUR = 3600;

export async function checkpoint(env, t = Math.floor(Date.now() / 1000)) {
  const hour = Math.floor(t / HOUR);
  const have = await env.DB.prepare("SELECT hour FROM drugwars_checkpoints WHERE hour = ?").bind(hour).first();
  if (have) return null;
  const prev = await env.DB.prepare("SELECT root, max_log_id FROM drugwars_checkpoints ORDER BY hour DESC LIMIT 1").first();
  const { results } = await env.DB.prepare(
    `SELECT l.bank, l.id, l.hash FROM drugwars_log l
     JOIN (SELECT bank, MAX(id) AS id FROM drugwars_log WHERE hash IS NOT NULL GROUP BY bank) m ON m.id = l.id
     ORDER BY l.bank`).all();
  if (!results.length) return null;
  const prevRoot = prev ? prev.root : GENESIS, prevMax = prev ? prev.max_log_id : 0;
  const root = await sha256(prevRoot + "|" + results.map((r) => `${r.bank}:${r.hash}`).join(","));
  const maxId = Math.max(...results.map((r) => r.id));
  const lines = (await env.DB.prepare("SELECT COUNT(*) AS n FROM drugwars_log WHERE hash IS NOT NULL").first()).n;
  const stmts = [env.DB.prepare(
    "INSERT INTO drugwars_checkpoints (hour, banks, lines, prev_root, root, max_log_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(hour, results.length, lines, prevRoot, root, maxId, t)];
  for (const r of results.filter((r) => r.id > prevMax)) {
    stmts.push(env.DB.prepare("INSERT INTO drugwars_checkpoint_heads (hour, bank, last_id, hash) VALUES (?, ?, ?, ?)").bind(hour, r.bank, r.id, r.hash));
  }
  try { await env.DB.batch(stmts); } catch (e) { if (isUnique(e)) return null; throw e; } // another run got there first
  return { hour, banks: results.length, lines, root };
}

// the checkpoints that name this bank must still find their line, with the same hash
export async function verifyCheckpoints(db, bank) {
  const { results } = await db.prepare("SELECT hour, last_id, hash FROM drugwars_checkpoint_heads WHERE bank = ? ORDER BY hour").bind(bank).all();
  for (const c of results) {
    const row = await db.prepare("SELECT hash FROM drugwars_log WHERE id = ? AND bank = ?").bind(c.last_id, bank).first();
    if (!row || row.hash !== c.hash) return { ok: false, checkpoints: results.length, broken_at: c.hour };
  }
  return { ok: true, checkpoints: results.length };
}
