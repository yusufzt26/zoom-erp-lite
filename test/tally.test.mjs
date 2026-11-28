// ZPO_DB_URL=postgres://... node test/tally.test.mjs : Tally sync key and push, on a real Postgres (skipped without ZPO_DB_URL)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tallyRecords, tallyDiff, stable } from "../netlify/tally.mjs";

// pure part: records and diff
const P = (bills, ok = true) => ({ pc: "ACCOUNTS-PC", v: "1.0.0", companies: [{ name: "Zoom Technologies", ok, error: ok ? "" : "Company not open in Tally", bills, ledgers: [{ n: "ABC Engg", k: "cust", g: "Sundry Debtors", gst: "27aaaca1234a1z5", due: 1500, bw: true }], vch: [{ g: "g1", t: "rcpt", d: "2026-11-20", no: "12", l: "ABC Engg", amt: 500, vt: "Receipt" }] }] });
let r = tallyRecords(P([{ k: "cust", l: "ABC Engg", ref: "Z1/26-27", d: "2026-10-01", due: 1000 }, { k: "cust", l: "ABC Engg", ref: "Z1/26-27", d: "2026-10-01", due: 500 }, { k: "bad", l: "X", ref: "1", due: 9 }]), "Accounts PC");
assert.equal([...r.recs.values()].filter((x) => x.t === "b").length, 1, "same bill twice is added up, unknown kind skipped");
assert.equal([...r.recs.values()].find((x) => x.t === "b").due, 1500);
assert.equal([...r.recs.values()].find((x) => x.t === "l").gstin, "27AAACA1234A1Z5");
assert.equal(r.status.companies[0].cust, 1500);
assert.equal(stable({ b: 1, a: [1, { d: 2, c: 3 }] }), stable({ a: [1, { c: 3, d: 2 }], b: 1 }));
let d = tallyDiff([], r.recs, r.okCos); assert.equal(d.write.length, 3); assert.equal(d.del.length, 0);
const ex = [...r.recs].map(([id, data]) => ({ id, data: JSON.parse(JSON.stringify(data)) }));
d = tallyDiff(ex, r.recs, r.okCos); assert.equal(d.write.length, 0, "nothing changed, nothing written");
const r2 = tallyRecords(P([]), "x"); d = tallyDiff(ex, r2.recs, r2.okCos); assert.equal(d.del.length, 1, "paid bill disappears");
const r3 = tallyRecords(P([], false), "x"); d = tallyDiff(ex, r3.recs, r3.okCos); assert.equal(d.del.length, 0, "company not readable: keep its last data");
// purchase totals by month
const PP = (pur, purOk = true) => { const p = P([]); p.purFrom = "2025-04-01"; Object.assign(p.companies[0], { pur, purOk }); return p; };
const r4 = tallyRecords(PP([{ m: "2026-11", t: "pur", amt: 118000, net: 100000, n: 3 }, { m: "2026-11", t: "dn", amt: 11800, net: 10000, n: 1 }, { m: "bad", t: "pur", amt: 1 }, { m: "2026-10", t: "x", amt: 1 }]), "x");
const P4 = [...r4.recs.values()].filter((x) => x.t === "p");
assert.equal(P4.length, 2, "bad months and types skipped"); assert.equal(r4.status.purFrom, "2025-04-01"); assert.equal(r4.status.companies[0].pur, 118000); assert.ok(r4.purCos.has("Zoom Technologies"));
const ex4 = [...r4.recs].map(([id, data]) => ({ id, data: JSON.parse(JSON.stringify(data)) }));
const r5 = tallyRecords(PP([], false), "x"); d = tallyDiff(ex4, r5.recs, r5.okCos, r5.purCos); assert.equal(d.del.filter((id) => id.startsWith("p:")).length, 0, "purchases not read: keep the last totals");
const r6 = tallyRecords(P([]), "x"); d = tallyDiff(ex4, r6.recs, r6.okCos, r6.purCos); assert.equal(d.del.filter((id) => id.startsWith("p:")).length, 0, "older sync program: keep the last totals");
const r7 = tallyRecords(PP([]), "x"); d = tallyDiff(ex4, r7.recs, r7.okCos, r7.purCos); assert.equal(d.del.filter((id) => id.startsWith("p:")).length, 2, "month no longer sent: removed");

if (!process.env.ZPO_DB_URL) { console.log("tally: pure part ok, DB part skipped (set ZPO_DB_URL to a test database)"); process.exit(0); }
const pg = (await import("pg")).default;
const db = new pg.Pool({ connectionString: process.env.ZPO_DB_URL });
const sql = (t, p) => db.query(t, p).then((x) => x.rows);
const dir = new URL("../netlify/database/migrations/", import.meta.url);
await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
for (const f of readdirSync(dir).sort()) await sql(readFileSync(new URL(f, dir), "utf8"));
const masters = { users: [{ name: "Yusuf", role: "Admin" }, { name: "Ravi", role: "Accounts", dept: "Accounts" }], depts: [], projects: [] };
await sql("INSERT INTO records(coll,id,data,rev,created_rev,updated_by) VALUES('masters','_',$1,nextval('rev_seq'),currval('rev_seq'),'Yusuf')", [JSON.stringify(masters)]);
const tok = {}; for (const n of ["Yusuf", "Ravi"]) { await sql("INSERT INTO logins(name,pass_hash) VALUES($1,'x')", [n]); tok[n] = "t-" + n; await sql("INSERT INTO sessions(token_hash,name,expires_at) VALUES($1,$2,NOW()+interval '1 day')", [createHash("sha256").update(tok[n]).digest("hex"), n]); }
const api = (await import("../netlify/functions/api.mjs")).default;
const call = async (path, { who, key, body, method = "POST" } = {}) => { const h = { "content-type": "application/json" }; if (who) h.authorization = "Bearer " + tok[who]; if (key) h["x-sync-key"] = key;
  const res = await api(new Request("http://x/api/" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined })); return { status: res.status, j: await res.json() }; };

// only the admin makes keys
assert.equal((await call("tally/key", { who: "Ravi", body: { action: "new" } })).status, 403);
const mk = await call("tally/key", { who: "Yusuf", body: { action: "new", label: "Accounts PC" } }); assert.equal(mk.status, 200); const key = mk.j.secret; assert.ok(key.length > 20);
assert.equal((await sql("SELECT COUNT(*)::int n FROM sync_keys WHERE key_hash=$1", [createHash("sha256").update(key).digest("hex")]))[0].n, 1, "only the hash is stored");
// push needs the key; a user login is not enough
assert.equal((await call("tally/push", { body: P([]) })).status, 401);
assert.equal((await call("tally/push", { key: "wrong", body: P([]) })).status, 401);
assert.equal((await call("tally/ping", { key })).j.label, "Accounts PC");
let p = await call("tally/push", { key, body: P([{ k: "cust", l: "ABC Engg", ref: "Z1/26-27", d: "2026-10-01", due: 1000 }, { k: "sup", l: "Kirti Alloys", ref: "INV-9", d: "2026-11-01", due: 2500 }]) });
assert.equal(p.status, 200); assert.equal(p.j.changed, 4); // 2 bills, 1 ledger, 1 voucher (status separately)
const rows = async () => sql("SELECT id,data,updated_by FROM records WHERE coll='tally' AND NOT deleted ORDER BY id");
assert.equal((await rows()).length, 5);
assert.equal((await rows()).find((x) => x.id === "status").updated_by, "Tally sync (ACCOUNTS-PC)");
// same data again: only the status changes
const h0 = (await sql("SELECT COUNT(*)::int n FROM record_history WHERE coll='tally'"))[0].n;
p = await call("tally/push", { key, body: P([{ k: "cust", l: "ABC Engg", ref: "Z1/26-27", d: "2026-10-01", due: 1000 }, { k: "sup", l: "Kirti Alloys", ref: "INV-9", d: "2026-11-01", due: 2500 }]) });
assert.equal(p.j.changed, 0); assert.equal((await sql("SELECT COUNT(*)::int n FROM record_history WHERE coll='tally'"))[0].n, h0 + 1);
// supplier bill paid in Tally: gone
p = await call("tally/push", { key, body: P([{ k: "cust", l: "ABC Engg", ref: "Z1/26-27", d: "2026-10-01", due: 400 }]) });
assert.equal(p.j.changed, 1); assert.equal(p.j.removed, 1);
// users cannot write the Tally copy through normal saving
const sv = await call("sync", { who: "Yusuf", body: { changes: [{ coll: "tally", id: "status", data: { x: 1 } }] } });
assert.ok(sv.j.results[0].error); assert.notEqual((await rows()).find((x) => x.id === "status").data.x, 1);
// ...but the ledger links (tallymap) save like any other record
assert.ok(!(await call("sync", { who: "Ravi", body: { changes: [{ coll: "tallymap", id: "_", data: { led: { "ABC Engg": { party: "ABC ENGINEERING" } } } }] } })).j.results[0].error);
// the sync GET hands the Tally copy to the app
const g = await call("sync?since=0", { who: "Ravi", method: "GET" }); assert.ok(g.j.records.some((x) => x.coll === "tally" && x.id === "status"));
// stopped key no longer works
await call("tally/key", { who: "Yusuf", body: { action: "revoke", id: mk.j.keys[0].id } });
assert.equal((await call("tally/ping", { key })).status, 401);
console.log("tally: ok");
await db.end(); process.exit(0);
