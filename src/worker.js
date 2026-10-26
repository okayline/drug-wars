// Drugwar Worker (v1.2.0). The page and its files are static assets; /api/* comes here first.
//
//   GET  /api/market?city=N          the deals that are up in city N (0..5): { listings: [{ id, drug, units, price, mine }] },
//                                    newest first, at most SHOW of them
//   POST /api/list  {run, city, drug, units, price}   put a deal up. It is up at once and stays up for a day.
//   POST /api/buy   {listing, units}                  buy from a deal. The deal and its ledger entry are one D1 batch.
//   POST /api/claim {run}                             collect the cash from your deals that sold, for that run only
//
// The run is a random id the page makes when a game starts. Cash from a sale goes back to the run that listed it, and
// to no other, so a game's score is never fed by an earlier game. The units you list leave your coat; a deal nobody
// buys is lost with them.
//
// The game itself runs in the page, so the server can't see what a player holds or has. It limits what one request can
// do (up to MAX_UNITS at up to MAX_PRICE, MAX_OPEN deals at once) and keeps a hash-chained ledger of every deal.

import { sha256, head, isUnique } from "./ledger.js";

const COOKIE = "dw";
const COOKIE_MAX_AGE = 400 * 86400;
const SEEN_EVERY = 900;   // 15 minutes

const CITIES = 6, DRUGS = 6;
const MAX_UNITS = 100;    // one deal, and one purchase
const MAX_PRICE = 150000; // per unit (the top of the original game's price spikes)
const MAX_OPEN = 5;       // deals one player can have up at once
const LIFE = 86400;       // a deal stays up this long (seconds)
const SHOW = 9;           // deals shown per city (the page picks one by number key)

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
      return json({ error: "Something broke. Try again in a moment." }, 500);
    }
  },
};

class Oops extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const ROUTES = {
  "GET /api/market": market,
  "POST /api/list": list,
  "POST /api/buy": buy,
  "POST /api/claim": claim,
};

// ---------- helpers (copied from scatter-exe src/worker.js) ----------

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

// the clock, in unix seconds (tests move it with setClock)
let clock = () => Math.floor(Date.now() / 1000);
export function setClock(fn) { clock = fn; }
const now = () => clock();

function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readCookie(req) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,})`));
  return m ? m[1] : null;
}

const setCookie = (token) => `${COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
const withCookie = (res, cookie) => { if (cookie) res.headers.append("set-cookie", cookie); return res; };

// The player behind this request's cookie, or null. Never creates one (so crawlers don't make players).
async function findPlayer(req, env) {
  const token = readCookie(req);
  if (!token) return null;
  const p = await env.DB.prepare("SELECT id, seen_at FROM drugwars_players WHERE token_hash = ?").bind(await sha256(token)).first();
  if (!p) return null;
  if (now() - p.seen_at >= SEEN_EVERY) await env.DB.prepare("UPDATE drugwars_players SET seen_at = ? WHERE id = ?").bind(now(), p.id).run();
  return p;
}

// The player behind this request, made on the spot if there isn't one. Returns { player, cookie? }.
async function needPlayer(req, env) {
  const found = await findPlayer(req, env);
  if (found) return { player: found };
  if (!(await rateLimit(env, req, "new-guest", 3, 3600))) throw new Oops("Too many new players from here. Try again later.", 429);
  const token = newToken(), t = now();
  const r = await env.DB.prepare("INSERT INTO drugwars_players (token_hash, created_at, seen_at) VALUES (?, ?, ?) RETURNING id")
    .bind(await sha256(token), t, t).first();
  return { player: r, cookie: setCookie(token) };
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

async function body(req) {
  let b;
  try { b = await req.json(); } catch {}
  if (!b || typeof b !== "object") throw new Oops("That request didn't make sense.");
  return b;
}

const whole = (v, lo, hi, what) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Oops(`${what} must be a whole number from ${lo} to ${hi}.`);
  return v;
};
const runOf = (v) => {
  if (typeof v !== "string" || !/^[a-f0-9]{16,64}$/.test(v)) throw new Oops("That request didn't make sense.");
  return v;
};

// ---------- the dealers ----------

async function market(req, env, url) {
  const city = whole(Number(url.searchParams.get("city")), 0, CITIES - 1, "City");
  const player = await findPlayer(req, env);
  const { results } = await env.DB.prepare(
    "SELECT id, drug, units_left, price, seller_id FROM drugwars_listings WHERE city = ? AND units_left > 0 AND created_at > ? ORDER BY id DESC LIMIT ?")
    .bind(city, now() - LIFE, SHOW).all();
  return json({ listings: results.map((r) => ({ id: r.id, drug: r.drug, units: r.units_left, price: r.price, mine: !!player && player.id === r.seller_id })) });
}

async function list(req, env) {
  const b = await body(req);
  const run = runOf(b.run);
  const city = whole(b.city, 0, CITIES - 1, "City"), drug = whole(b.drug, 0, DRUGS - 1, "Drug");
  const units = whole(b.units, 1, MAX_UNITS, "Units"), price = whole(b.price, 1, MAX_PRICE, "The price");
  const { player, cookie } = await needPlayer(req, env);
  if (!(await rateLimit(env, req, "list", 30, 3600))) throw new Oops("Too many deals from here. Try again later.", 429);
  const t = now();
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM drugwars_listings WHERE seller_id = ? AND units_left > 0 AND created_at > ?")
    .bind(player.id, t - LIFE).first();
  if (open.n >= MAX_OPEN) throw new Oops(`You can have ${MAX_OPEN} deals up at once.`, 409);
  const r = await env.DB.prepare(
    "INSERT INTO drugwars_listings (seller_id, run_id, city, drug, units, units_left, price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(player.id, run, city, drug, units, units, price, t).first();
  return withCookie(json({ id: r.id }), cookie);
}

// Buy from a deal: the ledger entry and the units taken off the deal go in one D1 batch. The entry goes in only if the
// deal still has the units (and is still up), and the units come off only on the same terms, so two buyers can't both
// get the last of it.
async function buy(req, env) {
  const b = await body(req);
  const id = whole(b.listing, 1, Number.MAX_SAFE_INTEGER, "The deal"), units = whole(b.units, 1, MAX_UNITS, "Units");
  const { player, cookie } = await needPlayer(req, env);
  for (let i = 0; i < 6; i++) {
    const t = now();
    const l = await env.DB.prepare("SELECT id, seller_id, city, drug, units_left, price, created_at FROM drugwars_listings WHERE id = ?").bind(id).first();
    if (!l || l.units_left < 1 || l.created_at <= t - LIFE) throw new Oops("That deal is gone.", 409);
    if (l.seller_id === player.id) throw new Oops("That's your own deal.", 409);
    if (units > l.units_left) throw new Oops(`Only ${l.units_left} left.`, 409);
    const total = units * l.price, prev = await head(env.DB);
    const record = JSON.stringify({ listing: l.id, seller: l.seller_id, buyer: player.id, city: l.city, drug: l.drug, units, price: l.price, total, t });
    const hash = await sha256(prev + "|" + record);
    let res;
    try {
      res = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO drugwars_deals (listing_id, seller_id, buyer_id, run_id, city, drug, units, price, total, record, prev_hash, hash, created_at)
           SELECT id, seller_id, ?2, run_id, city, drug, ?3, price, ?4, ?5, ?6, ?7, ?8 FROM drugwars_listings
           WHERE id = ?1 AND units_left >= ?3 AND created_at > ?9`).bind(l.id, player.id, units, total, record, prev, hash, t, t - LIFE),
        env.DB.prepare("UPDATE drugwars_listings SET units_left = units_left - ?2 WHERE id = ?1 AND units_left >= ?2 AND created_at > ?3").bind(l.id, units, t - LIFE),
      ]);
    } catch (e) {
      if (!isUnique(e)) throw e;
      continue;   // someone else's deal went in first: build on the new head
    }
    if (!res[0].meta.changes) continue;   // the deal changed under us: read it again
    return withCookie(json({ ok: true, drug: l.drug, units, price: l.price, total }), cookie);
  }
  throw new Oops("Someone got there first. Try again.", 409);
}

// The cash from this player's deals that sold, for one run. Each deal pays once.
async function claim(req, env) {
  const run = runOf((await body(req)).run);
  const player = await findPlayer(req, env);
  if (!player) return json({ cash: 0, deals: 0 });
  const { results } = await env.DB.prepare("UPDATE drugwars_deals SET claimed_at = ? WHERE seller_id = ? AND run_id = ? AND claimed_at IS NULL RETURNING total")
    .bind(now(), player.id, run).all();
  return json({ cash: results.reduce((a, r) => a + r.total, 0), deals: results.length });
}
