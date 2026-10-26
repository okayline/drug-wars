// Drugwar Worker (v1.4.0). The page is a static asset; /api/* comes here first.
//
//   POST /api/bank/new                   make a bank: { code, balance: 0 }
//   GET  /api/bank?code=12345678         look a bank up: { code, balance }, or 404
//   POST /api/bank/save {code, balance}  store the balance (clamped to 0..CAP): { balance }
//   POST /api/bank/claim {code}          collect the cash from your sold deals: { owed }
//   GET  /api/deals?city=N&code=C        the deals that are up in city N (0..5), newest first: { deals: [{ id, drug, units, price, mine }] }
//   POST /api/deals {code, city, drug, units, price}   put a deal up (stays up for a day)
//   POST /api/deals/buy {code, id, units}              buy from a deal; the cash is owed to the seller's bank
//
// A bank is an 8-digit code and a balance; whoever has the code has the bank. The game runs in the page, so the
// server can't see what a player holds. It only keeps the balance and limits what one request can do.

const CAP = 50000; // the most a bank carries from one game to the next
const MAX_UNITS = 100;    // one deal, and one purchase
const MAX_PRICE = 150000; // per unit (the top of the original game's price spikes)
const MAX_OPEN = 5;       // deals one bank can have up at once
const LIFE = 86400;       // a deal stays up this long (seconds)
const SHOW = 6;           // deals shown per city

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS ? env.ASSETS.fetch(req) : new Response("Not found", { status: 404 });
    try {
      const route = ROUTES[`${req.method} ${url.pathname}`];
      if (!route) return json({ error: "No such thing." }, 404);
      return await route(req, env, url);
    } catch (e) {
      if (e instanceof Oops) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Something broke." }, 500);
    }
  },
};

class Oops extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const ROUTES = {
  "POST /api/bank/new": make, "GET /api/bank": look, "POST /api/bank/save": save, "POST /api/bank/claim": claim,
  "GET /api/deals": deals, "POST /api/deals": post, "POST /api/deals/buy": buy,
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const now = () => Math.floor(Date.now() / 1000);

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Fixed window per hashed IP and action. Returns true if allowed.
async function rateLimit(env, req, action, limit, windowSecs) {
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const key = action + ":" + (await sha256("ip:" + ip)).slice(0, 32);
  const t = now(), windowStart = t - (t % windowSecs);
  const row = await env.DB.prepare(
    `INSERT INTO drugwars_rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count`).bind(key, windowStart).first();
  if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM drugwars_rate_limits WHERE window_start < ?").bind(t - 86400).run();
  return row.count <= limit;
}

const codeOf = (v) => {
  const s = String(v);
  if (!/^[1-9][0-9]{7}$/.test(s)) throw new Oops("That request didn't make sense.");
  return s;
};

async function make(req, env) {
  if (!(await rateLimit(env, req, "new-bank", 5, 3600))) throw new Oops("Too many new banks from here. Try again later.", 429);
  for (let i = 0; i < 5; i++) {
    const code = String(10000000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90000000));
    const t = now();
    const r = await env.DB.prepare("INSERT OR IGNORE INTO drugwars_banks (code, balance, created_at, updated_at) VALUES (?, 0, ?, ?)").bind(code, t, t).run();
    if (r.meta.changes === 1) return json({ code, balance: 0 });
  }
  throw new Oops("Something broke.", 500);
}

async function look(req, env, url) {
  if (!(await rateLimit(env, req, "look-bank", 60, 3600))) throw new Oops("Too many tries. Try again later.", 429);
  const code = codeOf(url.searchParams.get("code"));
  const b = await env.DB.prepare("SELECT balance FROM drugwars_banks WHERE code = ?").bind(code).first();
  if (!b) throw new Oops("No such bank.", 404);
  return json({ code, balance: b.balance });
}

async function save(req, env) {
  let b;
  try { b = await req.json(); } catch {}
  if (!b || typeof b !== "object") throw new Oops("That request didn't make sense.");
  const code = codeOf(b.code);
  if (!Number.isInteger(b.balance) || b.balance < 0) throw new Oops("That request didn't make sense.");
  const balance = Math.min(CAP, b.balance);
  const r = await env.DB.prepare("UPDATE drugwars_banks SET balance = ?, updated_at = ? WHERE code = ?").bind(balance, now(), code).run();
  if (r.meta.changes !== 1) throw new Oops("No such bank.", 404);
  return json({ balance });
}

const whole = (v, lo, hi) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Oops("That request didn't make sense.");
  return v;
};
async function json_(req) {
  let b;
  try { b = await req.json(); } catch {}
  if (!b || typeof b !== "object") throw new Oops("That request didn't make sense.");
  return b;
}
async function needBank(env, code) {
  const b = await env.DB.prepare("SELECT code FROM drugwars_banks WHERE code = ?").bind(code).first();
  if (!b) throw new Oops("No such bank.", 404);
}

async function claim(req, env) {
  const code = codeOf((await json_(req)).code);
  const r = await env.DB.prepare("SELECT owed FROM drugwars_banks WHERE code = ?").bind(code).first();
  if (!r) throw new Oops("No such bank.", 404);
  // take back exactly what was read, so a deal that sells in between isn't lost
  if (r.owed > 0) await env.DB.prepare("UPDATE drugwars_banks SET owed = owed - ? WHERE code = ?").bind(r.owed, code).run();
  return json({ owed: r.owed });
}

async function deals(req, env, url) {
  const city = whole(Number(url.searchParams.get("city")), 0, 5);
  const code = url.searchParams.get("code");
  const { results } = await env.DB.prepare(
    "SELECT id, drug, units_left, price, seller FROM drugwars_asks WHERE city = ? AND units_left > 0 AND created_at > ? ORDER BY id DESC LIMIT ?")
    .bind(city, now() - LIFE, SHOW).all();
  return json({ deals: results.map((r) => ({ id: r.id, drug: r.drug, units: r.units_left, price: r.price, mine: r.seller === code })) });
}

async function post(req, env) {
  const b = await json_(req);
  const code = codeOf(b.code), city = whole(b.city, 0, 5), drug = whole(b.drug, 0, 5);
  const units = whole(b.units, 1, MAX_UNITS), price = whole(b.price, 1, MAX_PRICE);
  await needBank(env, code);
  if (!(await rateLimit(env, req, "post-deal", 30, 3600))) throw new Oops("Too many deals. Try again later.", 429);
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM drugwars_asks WHERE seller = ? AND units_left > 0 AND created_at > ?").bind(code, now() - LIFE).first();
  if (open.n >= MAX_OPEN) throw new Oops("Too many deals up.", 400);
  const r = await env.DB.prepare("INSERT INTO drugwars_asks (seller, city, drug, units_left, price, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(code, city, drug, units, price, now()).first();
  return json({ id: r.id });
}

async function buy(req, env) {
  const b = await json_(req);
  const code = codeOf(b.code), id = whole(b.id, 1, Number.MAX_SAFE_INTEGER), units = whole(b.units, 1, MAX_UNITS);
  await needBank(env, code);
  if (!(await rateLimit(env, req, "buy-deal", 120, 3600))) throw new Oops("Too many tries. Try again later.", 429);
  const a = await env.DB.prepare("SELECT seller, price FROM drugwars_asks WHERE id = ? AND created_at > ?").bind(id, now() - LIFE).first();
  if (!a) throw new Oops("Sold out.", 409);
  if (a.seller === code) throw new Oops("That's your own deal.", 400);
  const r = await env.DB.prepare("UPDATE drugwars_asks SET units_left = units_left - ? WHERE id = ? AND units_left >= ?").bind(units, id, units).run();
  if (r.meta.changes !== 1) throw new Oops("Sold out.", 409);
  await env.DB.prepare("UPDATE drugwars_banks SET owed = owed + ? WHERE code = ?").bind(units * a.price, a.seller).run();
  return json({ price: a.price });
}
