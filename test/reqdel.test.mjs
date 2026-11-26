// ZPO_DB_URL=postgres://... node test/reqdel.test.mjs : who may delete a purchase request, on a real Postgres (skipped without ZPO_DB_URL)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
if (!process.env.ZPO_DB_URL) { console.log("reqdel: skipped (set ZPO_DB_URL to a test database)"); process.exit(0); }
const db = new pg.Pool({ connectionString: process.env.ZPO_DB_URL });
const sql = (t, p) => db.query(t, p).then((r) => r.rows);
const dir = new URL("../netlify/database/migrations/", import.meta.url);
await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
for (const f of readdirSync(dir).sort()) await sql(readFileSync(new URL(f, dir), "utf8"));
const masters = { users: [{ name: "Yusuf", role: "Admin" }, { name: "Niksal", role: "Staff", dept: "Design" }, { name: "Singh", role: "Department head", dept: "Design" }, { name: "Shweta", role: "Staff", dept: "Design" }, { name: "Raj", role: "Purchase", dept: "Purchase" }],
  depts: [{ name: "Design", hod: "Singh" }, { name: "Purchase", hod: "" }], projects: [] };
await sql("INSERT INTO records(coll,id,data,rev,created_rev,updated_by) VALUES('masters','_',$1,nextval('rev_seq'),currval('rev_seq'),'Yusuf')", [JSON.stringify(masters)]);
const tok = {}; for (const n of ["Yusuf", "Niksal", "Singh", "Shweta", "Raj"]) { await sql("INSERT INTO logins(name,pass_hash) VALUES($1,'x')", [n]); tok[n] = "t-" + n; await sql("INSERT INTO sessions(token_hash,name,expires_at) VALUES($1,$2,NOW()+interval '1 day')", [createHash("sha256").update(tok[n]).digest("hex"), n]); }
const api = (await import("../netlify/functions/api.mjs")).default;
const sync = async (who, changes) => { const r = await api(new Request("http://x/api/sync", { method: "POST", headers: { authorization: "Bearer " + tok[who], "content-type": "application/json" }, body: JSON.stringify({ changes }) })); return (await r.json()).results; };
const alive = async (id) => (await sql("SELECT 1 FROM records WHERE coll='reqs' AND id=$1 AND NOT deleted", [id])).length === 1;
const req = (no, extra = {}) => ({ coll: "reqs", id: no, data: { no, by: "Niksal", dept: "Design", status: "Approved", lines: [], ...extra } });
const del = (who, no) => sync(who, [{ coll: "reqs", id: no, deleted: true }]);
await sync("Niksal", ["070", "071", "072", "073", "074", "075"].map((n) => req(n)));

// someone else in the department, and Purchase, may not delete
assert.ok((await del("Shweta", "070"))[0].error); assert.ok(await alive("070"));
assert.ok((await del("Raj", "070"))[0].error); assert.ok(await alive("070"));
// the requester and the department head may, while no PO is made
assert.ok(!(await del("Niksal", "070"))[0].error); assert.ok(!(await alive("070")));
assert.ok(!(await del("Singh", "071"))[0].error); assert.ok(!(await alive("071")));
// a PO made from it (single request, or one of several on a Pre-estimate PO) blocks them; a rejected PO does not
await sync("Raj", [{ coll: "saved", id: "2056", data: { no: 2056, reqNo: "072", status: "Approved" } }, { coll: "saved", id: "2057", data: { no: 2057, reqNo: "073, 074", reqNos: ["073", "074"], status: "Pending approval" } }, { coll: "saved", id: "2058", data: { no: 2058, reqNo: "075", status: "Rejected" } }]);
assert.ok((await del("Niksal", "072"))[0].error); assert.ok(await alive("072"));
assert.ok((await del("Singh", "074"))[0].error); assert.ok(await alive("074"));
assert.ok(!(await del("Niksal", "075"))[0].error); assert.ok(!(await alive("075")));
// poNo on the request blocks too
await sync("Niksal", [req("076", { poNo: 2060 })]); assert.ok((await del("Niksal", "076"))[0].error);
// the admin may delete any time
assert.ok(!(await del("Yusuf", "072"))[0].error); assert.ok(!(await alive("072")));
console.log("reqdel: ok");
await db.end(); process.exit(0);
