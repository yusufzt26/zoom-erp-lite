// ZPO_DB_URL=postgres://... node test/restore.test.mjs : restore to an earlier date, on a real Postgres (skipped without ZPO_DB_URL)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
if (!process.env.ZPO_DB_URL) { console.log("restore: skipped (set ZPO_DB_URL to a test database)"); process.exit(0); }
const db = new pg.Pool({ connectionString: process.env.ZPO_DB_URL });
const sql = (t, p) => db.query(t, p).then((r) => r.rows);
const dir = new URL("../netlify/database/migrations/", import.meta.url);
await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
const files = readdirSync(dir).sort(); const restoreMig = files.find((f) => f.includes("restore_points"));
for (const f of files.filter((f) => f !== restoreMig)) await sql(readFileSync(new URL(f, dir), "utf8"));
// data from before this feature: written straight into records
const masters = { users: [{ name: "Yusuf", role: "Admin" }, { name: "Dir", role: "Director" }, { name: "Sam", role: "Store" }], depts: ["Tool room"], projects: [] };
await sql("INSERT INTO records(coll,id,data,rev,created_rev,updated_by) VALUES('masters','_',$1,nextval('rev_seq'),currval('rev_seq'),'Yusuf')", [JSON.stringify(masters)]);
for (let i = 1; i <= 3; i++) await sql("INSERT INTO records(coll,id,data,rev,created_rev,updated_by) VALUES('saved',$1,$2,nextval('rev_seq'),currval('rev_seq'),'Yusuf')", [String(2000 + i), JSON.stringify({ no: 2000 + i, sup: "Old supplier " + i, total: 100 * i })]);
await sql(readFileSync(new URL(restoreMig, dir), "utf8"));
assert.equal((await sql("SELECT COUNT(*)::int n FROM record_history"))[0].n, 4, "existing records seeded into history");
await sql(readFileSync(new URL(restoreMig, dir), "utf8")); // running it twice changes nothing
assert.equal((await sql("SELECT COUNT(*)::int n FROM record_history"))[0].n, 4);
const tok = {}; for (const n of ["Yusuf", "Dir", "Sam"]) { await sql("INSERT INTO logins(name,pass_hash) VALUES($1,'x')", [n]); tok[n] = "t-" + n; await sql("INSERT INTO sessions(token_hash,name,expires_at) VALUES($1,$2,NOW()+interval '1 day')", [createHash("sha256").update(tok[n]).digest("hex"), n]); }
const api = (await import("../netlify/functions/api.mjs")).default;
const call = async (who, path, b) => { const r = await api(new Request("http://x/api/" + path, { method: b ? "POST" : "GET", headers: { authorization: "Bearer " + tok[who], "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined })); return { status: r.status, ...(await r.json()) }; };
const sync = (who, changes) => call(who, "sync", { changes });
const live = async (coll) => (await sql("SELECT id,data FROM records WHERE coll=$1 AND NOT deleted ORDER BY id", [coll]));
const pause = () => new Promise((r) => setTimeout(r, 30));

// rights: Store user cannot use it, Director can
assert.equal((await call("Sam", "restore")).status, 403);
assert.equal((await call("Dir", "restore")).status, 200);

// normal work, then a "good" moment
await sync("Sam", [{ coll: "grns", id: "1", data: { no: 1, poNo: 2001 } }]);
await sync("Yusuf", [{ coll: "saved", id: "2001", data: { no: 2001, sup: "Old supplier 1", total: 150 } }]);
await pause(); const good = new Date().toISOString(); await pause();
const customersBefore = (await live("customers")).length;

// mistake 1: bad import of 60 customers (auto restore point before it)
await sync("Yusuf", Array.from({ length: 60 }, (_, i) => ({ coll: "customers", id: "c" + i, data: { id: "c" + i, name: "Junk " + i } })));
// mistake 2: bulk delete of 3 POs
await sync("Dir", ["2001", "2002", "2003"].map((id) => ({ coll: "saved", id, deleted: true })));
// a user rights change after the good moment must survive the restore
const m2 = { ...masters, users: [...masters.users, { name: "New buyer", role: "Purchase" }], depts: ["Tool room", "Junk dept"] };
await sync("Yusuf", [{ coll: "masters", id: "_", data: m2 }]);
assert.equal((await live("customers")).length, 60); assert.equal((await live("saved")).length, 0);

let L = await call("Dir", "restore");
const autos = L.points.filter((p) => p.kind === "auto");
assert.equal(autos.length, 2, "one automatic point before the import, one before the bulk delete");
assert.match(autos.find((p) => p.by_name === "Dir").label, /deleted 3 POs/);
assert.ok(L.days.length >= 1 && L.start);

// preview tells what will happen, changes nothing
const pv = await call("Dir", "restore", { action: "preview", at: good });
const by = Object.fromEntries(pv.changes.map((c) => [c.coll, c]));
assert.equal(by.customers.removed, 60); assert.equal(by.saved.back, 3); assert.ok(!by.grns, "GRN made before the good moment untouched");
assert.equal((await live("customers")).length, 60);

// restore only POs from the automatic point before the bulk delete: the customer import stays
const before = autos.find((p) => p.by_name === "Dir");
let r = await call("Dir", "restore", { action: "run", point: before.pid, colls: ["saved"] });
assert.equal(r.ok, true); assert.equal((await live("saved")).length, 3); assert.equal((await live("customers")).length, 60);
assert.equal((await live("saved")).find((x) => x.id === "2001").data.total, 150, "PO comes back as it was last saved, not as it was first made");

// restore everything to the good moment
const revBefore = (await sql("SELECT MAX(rev)::int r FROM records"))[0].r;
r = await call("Yusuf", "restore", { action: "run", at: good });
assert.equal(r.ok, true); assert.equal((await live("customers")).length, customersBefore);
assert.equal((await live("grns")).length, 1);
const mNow = (await live("masters"))[0].data;
assert.deepEqual(mNow.depts, ["Tool room"], "masters go back"); assert.ok(mNow.users.some((u) => u.name === "New buyer"), "users and rights stay as today");
// other browsers see the restore through normal sync (new revs, deletes included)
const s = await call("Sam", "sync?since=" + revBefore);
assert.ok(s.records.some((x) => x.coll === "customers" && x.deleted)); assert.ok(s.records.some((x) => x.coll === "masters"));

// undo the restore: the junk customers come back
L = await call("Yusuf", "restore"); const undo = L.points.find((p) => p.pid === r.undo);
assert.equal(undo.kind, "before-restore");
await call("Yusuf", "restore", { action: "run", point: undo.pid });
assert.equal((await live("customers")).length, 60); assert.deepEqual((await live("masters"))[0].data.depts, ["Tool room", "Junk dept"]);

// limits: before history started, in the future, and a manual point
assert.equal((await call("Yusuf", "restore", { action: "preview", at: "2020-01-01T00:00:00Z" })).status, 400);
assert.equal((await call("Yusuf", "restore", { action: "preview", at: new Date(Date.now() + 864e5).toISOString() })).status, 400);
const mp = await call("Dir", "restore", { action: "point", label: "Before year-end changes" }); assert.equal(mp.ok, true);
assert.equal((await call("Sam", "restore", { action: "run", point: mp.pid })).status, 403);
// a restore to the point just made changes nothing
assert.equal((await call("Dir", "restore", { action: "preview", point: mp.pid })).total, 0);
await db.end(); console.log("restore: all tests passed"); process.exit(0);
