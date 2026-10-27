// Drugwar Worker (v2.0.0). The page is a static asset; /api/* comes here first.
//
//   POST /api/bank/new                   make a bank: { code, balance: 0 }
//   GET  /api/bank?code=12345678         look a bank up: { code, balance }, or 404
//   GET  /api/deals?city=N&code=C        the deals that are up in city N (0..5), newest first: { deals: [{ id, drug, units, price, mine }] }
//   GET  /api/run?code=C                 the bank's live run, if it has one: { run, balance, msgs: [] }
//   POST /api/run/start {code}           start a run (or pick up the live one)
//   POST /api/run/act {code, ver, a, ...}  do one thing in the live run. `ver` is the run version the page last saw.
//        a = buy {drug, n} | sell {drug, n} | jet {to} | loan {kind: "repay"|"borrow", n} | bank {kind: "deposit"|"withdraw", n}
//          | collect | post {drug, units, price} | buydeal {id, units} | answer {yes} | run | fight
//
// A bank is an 8-digit code and a balance; whoever has the code has the bank. A RUN is one 30-move game. The server
// holds everything the player has (cash, debt, coat, guns, damage, prices) and checks every action before it changes
// anything, so the page can't claim cash or drugs it doesn't have. The bank balance is the only thing that outlives
// a run. Muggings, chases and finds are rolled here, not in the page.
//
// Every action is one atomic D1 batch. A request names the run version it saw (`ver`); the batch only goes through
// if the run is still at that version, so a double-sent or replayed request can't be applied twice.

const CAP = 50000; // the most a bank holds
const MAX_UNITS = 100;    // one deal, and one purchase
const MAX_PRICE = 150000; // per unit (the top of the original game's price spikes)
const MAX_OPEN = 5;       // deals one bank can have up at once
const LIFE = 86400;       // a deal stays up this long (seconds)
const SHOW = 6;           // deals shown per city

const MOVES = 30;         // a run ends when the move counter reaches 31, like the original's day 31
const START_CASH = 2000, START_DEBT = 5000, START_COAT = 100;
const LOAN_MAX = 5000;    // the most the shark lends in one go
const DRUGS = ["COCAINE", "HEROINE", "ACID", "WEED", "SPEED", "LUDES"];
const GUNS = ["BARRETTA", "SATURDAY NIGHT SPECIAL", ".44 MAGNUM"];

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
  "POST /api/bank/new": make, "GET /api/bank": look,
  "GET /api/deals": deals,
  "GET /api/run": runLook, "POST /api/run/start": runStart, "POST /api/run/act": runAct,
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const now = () => Math.floor(Date.now() / 1000);
const R = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296; // [0, 1)
const round = Math.round, int = Math.floor;

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
  const b = await env.DB.prepare("SELECT balance, owed FROM drugwars_banks WHERE code = ?").bind(code).first();
  if (!b) throw new Oops("No such bank.", 404);
  return b;
}

// ---------- banks ----------

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

async function deals(req, env, url) {
  const city = whole(Number(url.searchParams.get("city")), 0, 5);
  const code = url.searchParams.get("code");
  const { results } = await env.DB.prepare(
    "SELECT id, drug, units_left, price, seller FROM drugwars_asks WHERE city = ? AND units_left > 0 AND created_at > ? ORDER BY id DESC LIMIT ?")
    .bind(city, now() - LIFE, SHOW).all();
  return json({ deals: results.map((r) => ({ id: r.id, drug: r.drug, units: r.units_left, price: r.price, mine: r.seller === code })) });
}

// ---------- the game (rules from the TI-82/83 BASIC "J.M.'S DRUGWAR 2.00") ----------
// g is a run: { id, ver, state, move, loc, cash, debt, coat, guns, damage, st[6], pr[6], pending, score }.
// The rule functions change g and push the lines the page should show into msgs.

const carried = (g) => g.st.reduce((a, b) => a + b, 0);
const free = (g) => g.coat - carried(g);

function rollPrices(g) {
  g.pr = [round(R() * 12000 + 16000), round(R() * 7000 + 5000), round(R() * 34 + 10) * 100,
          round(R() * 42 + 33) * 10, round(R() * 15 + 7) * 10, round(R() * 4 + 1) * 10];
}

// the score the original shows: total money on a scale of 1 to 100
function finish(g, balance, msgs) {
  g.state = "over"; g.pending = null;
  const total = balance + g.cash - g.debt;
  g.score = total <= 0 ? 0 : Math.min(100, round(Math.sqrt(total / 31.5)));
}

function fire(g, msgs) { // true if you died
  msgs.push("THEY'RE FIRING AT YOU!!");
  if (R() < 0.5) { msgs.push("THEY MISSED!!"); return false; }
  g.damage += 3; msgs.push("YOU'VE BEEN HIT!");
  if (g.damage >= 50) { msgs.push("YOU'VE BEEN KILLED!!"); return true; }
  return false;
}

function chaseStart(g, d, msgs) { // d = deputies; pigs = d + 1
  msgs.push(`OFFICER HARDASS AND ${d} OF HIS DEPPUTIES ARE AFTER YOU!`);
  g.pending = { type: "chase", d };
}

// RUN or FIGHT while the cops are on you. Returns true if you died.
function chaseAct(g, a, msgs) {
  let d = g.pending.d;
  if (a === "run") {
    if (R() < 0.5) { msgs.push("YOU LOST THEM IN AN ALLEY!!"); g.pending = null; return false; }
    msgs.push("YOU CAN'T SHAKE THEM!");
  } else {
    if (g.guns === 0) { msgs.push("YOU DON'T HAVE ANY GUNS! YOU HAVE TO RUN!"); return false; }
    if (R() < 0.5) {
      msgs.push("YOU KILLED ONE!!"); d--;
      if (d < 0) {
        const cash = int(R() * 1250 + 750); g.cash += cash;
        msgs.push(`YOU FOUND ${cash} DOLLARS ON OFFICER HARDASS' CARCASS!!`);
        g.pending = g.cash >= 1200 && g.damage > 0 ? { type: "doc" } : null; // the doctor, if you can pay
        return false;
      }
      g.pending = { type: "chase", d };
    } else msgs.push("YOU MISSED!!!");
  }
  return fire(g, msgs);
}

// a new day's prices and whatever happens in it. Sets g.pending if the player has to answer something.
function newDay(g, msgs) {
  rollPrices(g);
  const D = round(R() * 20);
  switch (D) {
    case 1: g.pr[5] = 2; msgs.push("RIVAL DEALERS ARE SELLING CHEAP LUDES!!!"); break;
    case 2: g.pr[3] = 122; msgs.push("WEED PRICES HAVE BOTTOMED-OUT!!!"); break;
    case 3: g.pr[1] = int(850 + R() * 1150); msgs.push("PIGS ARE SELLING CHEAP HEROINE FROM LAST WEEK'S RAID!!!!"); break;
    case 4: case 5: g.pr[1] = int(18000 + R() * 25000); msgs.push("ADDICTS ARE BUYING HEROINE AT OUTRAGEOUS PRICES!!!"); break;
    case 6: case 7: g.pr[0] = int(80000 + R() * 60000); msgs.push("PIGS MADE A BIG COKE BUST! PRICES ARE OUTRAGEOUS!!!!"); break;
    case 8: g.cash = 2 * int(g.cash / 3); msgs.push("YOU WERE MUGGED IN THE SUBWAY!"); break;
    case 9: case 10: case 11:
      if (carried(g) >= 50) chaseStart(g, { 9: 1, 10: 3, 11: 4 }[D], msgs);
      break;
    case 12: case 13:
      if (g.cash >= 500 && free(g) >= 5) g.pending = { type: "gun", gun: GUNS[int(R() * 3)] };
      break;
    case 14: g.pending = { type: "weed" }; break;
    case 15: if (g.cash >= 300) g.pending = { type: "coat" }; break;
    case 16:
      if (free(g) >= 8) {
        const X = int(R() * 7 + 1), i = [5, 4, 3, 2, 1][int(R() * 5)];
        g.st[i] += X; msgs.push(`YOU FOUND: ${X} UNITS OF: ${DRUGS[i]} ON A DEAD DUDE IN THE SUBWAY!!!`);
      }
      break;
    case 17: g.pr[2] = int(250 + R() * 550); msgs.push("THE MARKET HAS BEEN FLOODED WITH CHEAP HOME-MADE ACID!!!!"); break;
  }
}

// ---------- runs ----------

const parse = (r) => ({
  id: r.id, bank: r.bank, ver: r.ver, state: r.state, move: r.move, loc: r.loc, cash: r.cash, debt: r.debt, coat: r.coat,
  guns: r.guns, damage: r.damage, st: JSON.parse(r.st), pr: JSON.parse(r.prices),
  pending: r.pending ? JSON.parse(r.pending) : null, score: r.score,
});

const view = (g, balance, msgs) => ({
  run: { ver: g.ver, move: g.move, loc: g.loc, cash: g.cash, debt: g.debt, coat: g.coat, free: free(g), guns: g.guns, damage: g.damage,
         st: g.st, prices: g.pr, pending: g.pending, over: g.state === "over", score: g.score },
  balance, msgs,
});

async function runLook(req, env, url) {
  const code = codeOf(url.searchParams.get("code"));
  const bank = await needBank(env, code);
  const row = await env.DB.prepare("SELECT * FROM drugwars_runs WHERE bank = ? AND state = 'live'").bind(code).first();
  return json(row ? view(parse(row), bank.balance, []) : { run: null, balance: bank.balance, msgs: [] });
}

async function runStart(req, env) {
  const code = codeOf((await json_(req)).code);
  const bank = await needBank(env, code);
  const live = await env.DB.prepare("SELECT * FROM drugwars_runs WHERE bank = ? AND state = 'live'").bind(code).first();
  if (live) return json(view(parse(live), bank.balance, []));
  if (!(await rateLimit(env, req, "start-run", 30, 3600))) throw new Oops("Too many runs from here. Try again later.", 429);

  const g = { ver: 0, state: "live", move: 1, loc: 0, cash: START_CASH, debt: START_DEBT, coat: START_COAT, guns: 0, damage: 0,
              st: [0, 0, 0, 0, 0, 0], pr: [], pending: null, score: null };
  const msgs = [];
  newDay(g, msgs);
  const t = now();
  let id;
  try {
    const r = await env.DB.prepare(
      `INSERT INTO drugwars_runs (bank, state, ver, move, loc, cash, debt, coat, guns, damage, st, prices, pending, score, started_at, updated_at)
       VALUES (?, 'live', 0, 1, 0, ?, ?, ?, 0, 0, ?, ?, ?, NULL, ?, ?) RETURNING id`)
      .bind(code, g.cash, g.debt, g.coat, JSON.stringify(g.st), JSON.stringify(g.pr), g.pending ? JSON.stringify(g.pending) : null, t, t).first();
    id = r.id;
  } catch (e) { // another request started one at the same moment (the unique index): use that one
    const again = await env.DB.prepare("SELECT * FROM drugwars_runs WHERE bank = ? AND state = 'live'").bind(code).first();
    if (!again) throw e;
    return json(view(parse(again), bank.balance, []));
  }
  g.id = id;
  await env.DB.prepare("INSERT INTO drugwars_log (run, bank, move, kind, amount, cash_after, at) VALUES (?, ?, 1, 'start', 0, ?, ?)").bind(id, code, g.cash, t).run();
  return json(view(g, bank.balance, msgs));
}

// run `fn` on a copy of the live run and commit the result as one atomic batch
async function runAct(req, env) {
  const b = await json_(req);
  const code = codeOf(b.code);
  if (!(await rateLimit(env, req, "run-act", 1500, 3600))) throw new Oops("Too many tries. Try again later.", 429);
  const row = await env.DB.prepare("SELECT * FROM drugwars_runs WHERE bank = ? AND state = 'live'").bind(code).first();
  if (!row) throw new Oops("No run going.", 404);
  const g = parse(row);
  if (b.ver !== g.ver) throw new Oops("Out of date.", 409);
  const bank = await env.DB.prepare("SELECT balance, owed FROM drugwars_banks WHERE code = ?").bind(code).first();
  const a = b.a, msgs = [];

  // fx: what to record and what else to change. pre runs before the run row, post after; each is skipped
  // (and the whole action fails) unless the run is still at the version the request saw.
  const fx = { kind: a, drug: null, qty: null, amount: 0, pre: null, post: null, balance: bank.balance };
  const GUARD = "EXISTS (SELECT 1 FROM drugwars_runs WHERE id = ? AND ver = ?)";
  const guardArgs = [g.id, g.ver];

  const QUESTION = ["answer"], CHASE = ["run", "fight"];
  if (g.pending) {
    const ok = g.pending.type === "chase" ? CHASE : QUESTION;
    if (!ok.includes(a)) throw new Oops("Answer first.", 409);
  } else if (QUESTION.includes(a) || CHASE.includes(a)) throw new Oops("Nothing to answer.", 409);

  const cash0 = g.cash;
  let died = false, ends = false;
  switch (a) {
    case "buy": {
      const i = whole(b.drug, 0, 5), n = whole(b.n, 1, 100000), cost = n * g.pr[i];
      if (cost > g.cash) throw new Oops("Not enough cash.");
      if (n > free(g)) throw new Oops("Not enough room.");
      g.st[i] += n; g.cash -= cost; fx.drug = i; fx.qty = n;
      break;
    }
    case "sell": {
      const i = whole(b.drug, 0, 5), n = whole(b.n, 1, 100000);
      if (n > g.st[i]) throw new Oops("You don't have that much.");
      g.st[i] -= n; g.cash += n * g.pr[i]; fx.drug = i; fx.qty = n;
      break;
    }
    case "jet": {
      const to = whole(b.to, 0, 5);
      g.loc = to; g.move++; g.debt = int(g.debt * 1.1);
      fx.balance = Math.min(CAP, int(bank.balance * 1.06)); // the bank pays 6% a move
      fx.post = { sql: "UPDATE drugwars_banks SET balance = ?, updated_at = ? WHERE code = ? AND (SELECT changes()) = 1", args: [fx.balance, now(), code] };
      fx.qty = to;
      if (g.move >= MOVES + 1) ends = true; else newDay(g, msgs);
      break;
    }
    case "loan": {
      if (g.loc !== 0) throw new Oops("The loan shark only deals in the Bronx.");
      const n = whole(b.n, 1, 1000000000);
      if (b.kind === "repay") { if (n > g.cash || n > g.debt) throw new Oops("That's more than you have or owe."); g.debt -= n; g.cash -= n; }
      else if (b.kind === "borrow") { if (n > LOAN_MAX) throw new Oops("You think he's crazy, man?!"); g.debt += n; g.cash += n; }
      else throw new Oops("That request didn't make sense.");
      fx.kind = "loan:" + b.kind; fx.qty = n;
      break;
    }
    case "bank": {
      if (g.loc !== 0) throw new Oops("The bank is in the Bronx.");
      const n = whole(b.n, 1, 1000000000);
      if (b.kind === "deposit") {
        if (n > g.cash) throw new Oops("You don't have that much cash.");
        if (bank.balance + n > CAP) throw new Oops("The bank can't hold that much.");
        g.cash -= n; fx.balance = bank.balance + n;
        fx.post = { sql: "UPDATE drugwars_banks SET balance = balance + ?, updated_at = ? WHERE code = ? AND balance + ? <= ? AND (SELECT changes()) = 1", args: [n, now(), code, n, CAP] };
      } else if (b.kind === "withdraw") {
        if (n > bank.balance) throw new Oops("You don't have that much in the bank.");
        g.cash += n; fx.balance = bank.balance - n;
        fx.pre = { sql: `UPDATE drugwars_banks SET balance = balance - ?, updated_at = ? WHERE code = ? AND balance >= ? AND ${GUARD}`, args: [n, now(), code, n, ...guardArgs] };
      } else throw new Oops("That request didn't make sense.");
      fx.kind = "bank:" + b.kind; fx.qty = n;
      break;
    }
    case "collect": { // the cash from your deals that sold
      if (g.loc !== 0) throw new Oops("The bank is in the Bronx.");
      const x = Math.min(bank.owed, CAP - bank.balance);
      if (x <= 0) return json(view(g, bank.balance, []));
      fx.balance = bank.balance + x; fx.qty = x;
      fx.pre = { sql: `UPDATE drugwars_banks SET balance = balance + ?, owed = owed - ?, updated_at = ? WHERE code = ? AND owed >= ? AND balance + ? <= ? AND ${GUARD}`,
                 args: [x, x, now(), code, x, x, CAP, ...guardArgs] };
      msgs.push(`YOUR DEALS PAID YOU $${x}`);
      break;
    }
    case "post": { // put a deal up in the city you're in; the units come out of your coat
      const i = whole(b.drug, 0, 5), units = whole(b.units, 1, MAX_UNITS), price = whole(b.price, 1, MAX_PRICE);
      if (units > g.st[i]) throw new Oops("You don't have that much.");
      if (!(await rateLimit(env, req, "post-deal", 30, 3600))) throw new Oops("Too many deals. Try again later.", 429);
      const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM drugwars_asks WHERE seller = ? AND units_left > 0 AND created_at > ?").bind(code, now() - LIFE).first();
      if (open.n >= MAX_OPEN) throw new Oops("Too many deals up.");
      g.st[i] -= units; fx.drug = i; fx.qty = units; fx.amount = 0;
      fx.post = { sql: "INSERT INTO drugwars_asks (seller, city, drug, units_left, price, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT changes()) = 1",
                  args: [code, g.loc, i, units, price, now()] };
      break;
    }
    case "buydeal": { // buy from another player's deal in this city; the cash is owed to the seller's bank
      const id = whole(b.id, 1, Number.MAX_SAFE_INTEGER), units = whole(b.units, 1, MAX_UNITS);
      if (!(await rateLimit(env, req, "buy-deal", 240, 3600))) throw new Oops("Too many tries. Try again later.", 429);
      const d = await env.DB.prepare("SELECT seller, city, drug, price FROM drugwars_asks WHERE id = ? AND created_at > ?").bind(id, now() - LIFE).first();
      if (!d || d.city !== g.loc) throw new Oops("Sold out.", 409);
      if (d.seller === code) throw new Oops("That's your own deal.");
      const cost = units * d.price;
      if (cost > g.cash) throw new Oops("Not enough cash.");
      if (units > free(g)) throw new Oops("Not enough room.");
      g.st[d.drug] += units; g.cash -= cost; fx.drug = d.drug; fx.qty = units;
      fx.pre = { sql: `UPDATE drugwars_asks SET units_left = units_left - ? WHERE id = ? AND units_left >= ? AND created_at > ? AND ${GUARD}`,
                 args: [units, id, units, now() - LIFE, ...guardArgs] };
      fx.post = { sql: "UPDATE drugwars_banks SET owed = owed + ? WHERE code = ? AND (SELECT changes()) = 1", args: [cost, d.seller] };
      break;
    }
    case "answer": {
      const yes = b.yes === true, p = g.pending;
      g.pending = null; fx.kind = "answer:" + p.type;
      if (!yes) break;
      if (p.type === "gun") { if (g.cash < 400 || free(g) < 5) throw new Oops("You can't."); g.guns++; g.cash -= 400; g.coat -= 5; }
      else if (p.type === "coat") { if (g.cash < 200) throw new Oops("You can't."); g.coat += 10; g.cash -= 200; }
      else if (p.type === "doc") { if (g.cash < 1000) throw new Oops("You can't."); g.cash -= 1000; g.damage = 0; }
      else if (p.type === "weed") {
        msgs.push("YOU HALLUCINATE ON THE WILDEST TRIP OF YOUR LIFE, STUMBLE ON TO THE SUBWAY TRACKS AND GET CREAMED BY A TRAIN.\n\nJUST SAY NO TO DRUGS.");
        died = true;
      }
      break;
    }
    case "run": case "fight":
      died = chaseAct(g, a, msgs);
      break;
    default: throw new Oops("That request didn't make sense.");
  }
  fx.amount = g.cash - cash0;
  if (died || ends) finish(g, fx.balance, msgs);

  // ---- commit: [pre] -> run row -> log -> [post], each step only if the one before changed a row ----
  const t = now();
  const stmts = [];
  if (fx.pre) stmts.push(env.DB.prepare(fx.pre.sql).bind(...fx.pre.args));
  const runIdx = stmts.length;
  stmts.push(env.DB.prepare(
    `UPDATE drugwars_runs SET state = ?, ver = ver + 1, move = ?, loc = ?, cash = ?, debt = ?, coat = ?, guns = ?, damage = ?, st = ?, prices = ?, pending = ?, score = ?, updated_at = ?
     WHERE id = ? AND ver = ?${fx.pre ? " AND (SELECT changes()) = 1" : ""}`)
    .bind(g.state, g.move, g.loc, g.cash, g.debt, g.coat, g.guns, g.damage, JSON.stringify(g.st), JSON.stringify(g.pr),
          g.pending ? JSON.stringify(g.pending) : null, g.score, t, g.id, g.ver));
  stmts.push(env.DB.prepare(
    "INSERT INTO drugwars_log (run, bank, move, kind, drug, qty, amount, cash_after, at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT changes()) = 1")
    .bind(g.id, code, g.move, fx.kind, fx.drug, fx.qty, fx.amount, g.cash, t));
  if (fx.post) stmts.push(env.DB.prepare(fx.post.sql).bind(...fx.post.args));
  const res = await env.DB.batch(stmts);
  if (res[runIdx].meta.changes !== 1) throw new Oops(a === "buydeal" ? "Too late." : "Out of date.", 409);

  g.ver++;
  const after = await env.DB.prepare("SELECT balance FROM drugwars_banks WHERE code = ?").bind(code).first();
  return json(view(g, after.balance, msgs));
}
