// The ledger: one SHA-256 hash chain of finished deals. Same design as the other games' ledgers (copied from
// scatter-exe src/ledger.js, with one entry kind).
//
//   hash = SHA-256( prev_hash + "|" + record )
//
// The first entry chains from GENESIS. Changing any old record breaks its hash and every hash after it.
// prev_hash is UNIQUE, so two deals can never build on the same head (no forks).

export const GENESIS = "0".repeat(64);

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function head(db) {
  const h = await db.prepare("SELECT hash FROM drugwars_deals ORDER BY id DESC LIMIT 1").first();
  return h ? h.hash : GENESIS;
}

export const isUnique = (e) => /UNIQUE/i.test(String(e && e.message));
