// End-to-end tests of the Worker API, with Node's built-in SQLite standing in for D1.
// Hashes are recomputed with node:crypto, not the code under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import worker, { setClock } from "../src/worker.js";

// a tiny D1 lookalike (copied from scatter-exe test/worker.test.mjs)
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const prep = (sql, args = []) => ({
    sql, args,
    bind: (...a) => prep(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  const batch = async (stmts) => {
    db.exec("BEGIN");
    try {
      const out = stmts.map((st) => /^\s*(SELECT|WITH)/i.test(st.sql) || /RETURNING/i.test(st.sql)
        ? { results: db.prepare(st.sql).all(...st.args), meta: { changes: 0 } }
        : { results: [], meta: { changes: db.prepare(st.sql).run(...st.args).changes } });
      db.exec("COMMIT");
      return out;
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  };
  return { prepare: (sql) => prep(sql), batch, raw: db };
}

const sha = (t) => createHash("sha256").update(t).digest("hex");
const T0 = Date.parse("2027-01-01T08:00:00Z") / 1000;
const RUN = "a1b2c3d4e5f60718", RUN2 = "0123456789abcdef";

function setup() {
  let t = T0;
  setClock(() => t);
  const env = { DB: fakeD1() };
  const jar = {};
  const call = async (who, method, path, body) => {
    const headers = { "content-type": "application/json", "cf-connecting-ip": "ip-" + who };
    if (jar[who]) headers.cookie = jar[who];
    const res = await worker.fetch(new Request("https://dw.test" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
    for (const c of res.headers.getSetCookie()) jar[who] = c.split(";")[0];
    return { status: res.status, ...(await res.json()) };
  };
  return { env, call, wait: (s) => (t += s) };
}

test("a deal is up the moment it's posted, in its own city only, and just looking makes no player", async () => {
  const { env, call } = setup();
  assert.deepEqual(await call("ann", "GET", "/api/market?city=2"), { status: 200, listings: [] });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM drugwars_players").get().n, 0);
  const posted = await call("ann", "POST", "/api/list", { run: RUN, city: 2, drug: 0, units: 10, price: 20000 });
  assert.equal(posted.status, 200);
  assert.deepEqual(await call("bob", "GET", "/api/market?city=2"), { status: 200, listings: [{ id: posted.id, drug: 0, units: 10, price: 20000, mine: false }] });
  assert.equal((await call("ann", "GET", "/api/market?city=2")).listings[0].mine, true);
  assert.deepEqual(await call("bob", "GET", "/api/market?city=3"), { status: 200, listings: [] });
});

test("a buy takes units off the deal and writes a ledger entry chained from GENESIS; the second chains from the first", async () => {
  const { env, call } = setup();
  const { id } = await call("ann", "POST", "/api/list", { run: RUN, city: 1, drug: 3, units: 10, price: 500 });
  const b1 = await call("bob", "POST", "/api/buy", { listing: id, units: 4 });
  assert.deepEqual(b1, { status: 200, ok: true, drug: 3, units: 4, price: 500, total: 2000 });
  assert.equal((await call("bob", "GET", "/api/market?city=1")).listings[0].units, 6);
  const b2 = await call("cat", "POST", "/api/buy", { listing: id, units: 6 });
  assert.equal(b2.total, 3000);
  assert.deepEqual((await call("cat", "GET", "/api/market?city=1")).listings, [], "a sold-out deal is gone");
  const rows = env.DB.raw.prepare("SELECT record, prev_hash, hash FROM drugwars_deals ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].prev_hash, "0".repeat(64));
  assert.equal(rows[0].hash, sha(rows[0].prev_hash + "|" + rows[0].record));
  assert.equal(rows[1].prev_hash, rows[0].hash);
  assert.equal(rows[1].hash, sha(rows[1].prev_hash + "|" + rows[1].record));
  const rec = JSON.parse(rows[0].record);
  assert.deepEqual([rec.units, rec.price, rec.total, rec.city, rec.drug], [4, 500, 2000, 1, 3]);
  assert.ok(!("name" in rec), "records hold player ids, never names");
});

test("you can't buy more than is left, buy your own deal, or buy a deal that's gone", async () => {
  const { call, wait } = setup();
  const { id } = await call("ann", "POST", "/api/list", { run: RUN, city: 0, drug: 1, units: 5, price: 100 });
  assert.equal((await call("bob", "POST", "/api/buy", { listing: id, units: 6 })).status, 409);
  assert.equal((await call("ann", "POST", "/api/buy", { listing: id, units: 1 })).error, "That's your own deal.");
  assert.equal((await call("bob", "POST", "/api/buy", { listing: 999, units: 1 })).error, "That deal is gone.");
  wait(86400 + 1);
  assert.equal((await call("bob", "POST", "/api/buy", { listing: id, units: 1 })).error, "That deal is gone.", "a deal stays up a day");
  assert.deepEqual((await call("bob", "GET", "/api/market?city=0")).listings, []);
});

test("cash comes back once, to the run that listed the deal and no other", async () => {
  const { call } = setup();
  const { id } = await call("ann", "POST", "/api/list", { run: RUN, city: 0, drug: 0, units: 3, price: 1000 });
  await call("bob", "POST", "/api/buy", { listing: id, units: 2 });
  assert.deepEqual(await call("ann", "POST", "/api/claim", { run: RUN2 }), { status: 200, cash: 0, deals: 0 }, "another run gets nothing");
  assert.deepEqual(await call("bob", "POST", "/api/claim", { run: RUN }), { status: 200, cash: 0, deals: 0 }, "the buyer gets nothing");
  assert.deepEqual(await call("ann", "POST", "/api/claim", { run: RUN }), { status: 200, cash: 2000, deals: 1 });
  assert.deepEqual(await call("ann", "POST", "/api/claim", { run: RUN }), { status: 200, cash: 0, deals: 0 }, "each deal pays once");
  await call("cat", "POST", "/api/buy", { listing: id, units: 1 });
  assert.deepEqual(await call("ann", "POST", "/api/claim", { run: RUN }), { status: 200, cash: 1000, deals: 1 });
});

test("the limits: units, price, open deals, city, drug", async () => {
  const { call } = setup();
  const ok = { run: RUN, city: 0, drug: 0, units: 1, price: 1 };
  for (const bad of [{ units: 101 }, { units: 0 }, { price: 150001 }, { price: 1.5 }, { city: 6 }, { drug: -1 }, { run: "nope" }])
    assert.equal((await call("ann", "POST", "/api/list", { ...ok, ...bad })).status, 400, JSON.stringify(bad));
  for (let i = 0; i < 5; i++) assert.equal((await call("ann", "POST", "/api/list", ok)).status, 200);
  assert.equal((await call("ann", "POST", "/api/list", ok)).status, 409, "5 deals at once");
  assert.equal((await call("bob", "POST", "/api/list", ok)).status, 200, "another player has their own 5");
});
