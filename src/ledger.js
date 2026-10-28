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
