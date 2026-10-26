// Drugwar Worker (v1.4.0). The page is a static asset; /api/* comes here first.
//
//   POST /api/bank/new                   make a bank: { code, balance: 0 }
//   GET  /api/bank?code=12345678         look a bank up: { code, balance }, or 404
//   POST /api/bank/save {code, balance}  store the balance (clamped to 0..CAP): { balance }
//
// A bank is an 8-digit code and a balance; whoever has the code has the bank. The game runs in the page, so the
// server can't see what a player holds. It only keeps the balance and limits what one request can do.

const CAP = 5000; // the most a bank carries from one game to the next

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

const ROUTES = { "POST /api/bank/new": make, "GET /api/bank": look, "POST /api/bank/save": save };

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
