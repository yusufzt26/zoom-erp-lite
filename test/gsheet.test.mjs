// ZPO_DB_URL=postgres://... node test/gsheet.test.mjs : Google Sheet link (sheet key, push, only changed tabs written), on a real Postgres (DB part skipped without ZPO_DB_URL)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { gsRecords, gsDiff, gsScript } from "../netlify/gsheet.mjs";

// pure part: trimming, diff, and the Apps Script itself (run against a pretend Google Sheet)
const tab = (name, rows) => ({ name, rows });
const B = (rows) => ({ sheet: { id: "S1", title: "Sales Order", url: "https://docs.google.com/spreadsheets/d/S1/edit" }, tabs: [tab("Raw Data", rows), tab("Notes", [["a"]])] });
const rows = [["Proforma Number", "ZT Mould Number", "Customer Name", ""], ["SO-245", "ZT2388", "Moul tool systems", ""], ["", "", "", ""]];
let r = gsRecords(B(rows), "Sales order sheet");
assert.deepEqual(r.recs.get("tab:Raw Data").rows, [["Proforma Number", "ZT Mould Number", "Customer Name"], ["SO-245", "ZT2388", "Moul tool systems"]], "empty rows at the end and empty columns on the right are dropped");
assert.equal(r.status.url, "https://docs.google.com/spreadsheets/d/S1/edit");
assert.equal(gsRecords({ sheet: { url: "javascript:alert(1)" }, tabs: [tab("x", [[1]])] }).status.url, "", "only a Google Sheets link is kept");
let d = gsDiff([], r.recs, null); assert.equal(d.write.length, 2); assert.ok(d.status);
const ex = [...r.recs].map(([id, data]) => ({ id, data }));
d = gsDiff(ex, r.recs, { at: new Date().toISOString() }); assert.equal(d.write.length, 0, "nothing changed, nothing written"); assert.equal(d.status, false);
const r2 = gsRecords({ ...B(rows.concat([["SO-246", "ZT2389", "IDEMI"]])), tabs: [tab("Raw Data", rows.concat([["SO-246", "ZT2389", "IDEMI"]]))] });
d = gsDiff(ex, r2.recs, { at: new Date().toISOString() }); assert.equal(d.write.length, 1, "only the changed tab"); assert.deepEqual(d.del, ["tab:Notes"], "a tab no longer sent is removed");
// the script: sends every visible tab with dates as yyyy-mm-dd, skips when nothing changed, makes one 5-minute trigger
let sent = null, props = {}, trig = [];
const sh = (name, v0, hidden = false) => ({ getName: () => name, isSheetHidden: () => hidden, getDataRange: () => { const v = typeof v0 === "function" ? v0() : v0; return { getValues: () => v, getDisplayValues: () => v.map((r) => r.map((c) => (typeof c === "object" ? "x" : String(c)))) }; } });
const ctx = { SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSpreadsheetTimeZone: () => "Asia/Kolkata", getSheets: () => [sh("Raw Data", () => [["ZT Mould Number", "Final Data Date", "Value"], ["ZT2388", new (vm.runInContext("Date", ctx))(Date.UTC(2026, 10, 27)), 450000], ["", "", ""]]), sh("Hidden", [["x"]], true)], getId: () => "S1", getName: () => "Sales Order", getUrl: () => "https://docs.google.com/spreadsheets/d/S1/edit" }) },
  Utilities: { formatDate: (dt) => dt.toISOString().slice(0, 10), base64Encode: (b) => Buffer.from(b).toString("base64"), computeDigest: (a, s) => createHash("md5").update(s).digest(), DigestAlgorithm: { MD5: 1 } },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => (props[k] = v), deleteProperty: (k) => delete props[k] }) },
  UrlFetchApp: { fetch: (u, o) => { sent = { u, o }; return { getResponseCode: () => 200, getContentText: () => "{}" }; } },
  ScriptApp: { getProjectTriggers: () => trig, deleteTrigger: (t) => trig.splice(trig.indexOf(t), 1), newTrigger: (f) => ({ timeBased: () => ({ everyMinutes: (n) => ({ create: () => trig.push({ n, getHandlerFunction: () => f }) }) }) }) },
  Logger: { log() {} } };
vm.createContext(ctx); vm.runInContext(gsScript("https://erp.example/", "KEY1"), ctx);
ctx.setupErpLink(); ctx.setupErpLink();
assert.equal(trig.length, 1, "running setup twice keeps one trigger"); assert.equal(trig[0].n, 5);
assert.equal(sent.u, "https://erp.example/api/gsheet/push"); assert.equal(sent.o.headers["x-sync-key"], "KEY1");
const body = JSON.parse(sent.o.payload); assert.deepEqual(body.tabs.map((t) => t.name), ["Raw Data"], "hidden tabs are not sent");
assert.deepEqual(body.tabs[0].rows, [["ZT Mould Number", "Final Data Date", "Value"], ["ZT2388", "2026-11-27", 450000]]);
sent = null; assert.equal(ctx.sendToErp(), "No change"); assert.equal(sent, null, "an unchanged sheet is not sent again within the hour");

if (!process.env.ZPO_DB_URL) { console.log("gsheet: pure part ok, DB part skipped (set ZPO_DB_URL to a test database)"); process.exit(0); }
const pg = (await import("pg")).default;
const db = new pg.Pool({ connectionString: process.env.ZPO_DB_URL });
const sql = (t, p) => db.query(t, p).then((x) => x.rows);
const dir = new URL("../netlify/database/migrations/", import.meta.url);
await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
for (const f of readdirSync(dir).sort()) await sql(readFileSync(new URL(f, dir), "utf8"));
await sql("INSERT INTO records(coll,id,data,rev,created_rev,updated_by) VALUES('masters','_',$1,nextval('rev_seq'),currval('rev_seq'),'Yusuf')", [JSON.stringify({ users: [{ name: "Yusuf", role: "Admin" }, { name: "Ravi", role: "Accounts", dept: "Accounts" }], depts: [], projects: [] })]);
const tok = {}; for (const n of ["Yusuf", "Ravi"]) { await sql("INSERT INTO logins(name,pass_hash) VALUES($1,'x')", [n]); tok[n] = "t-" + n; await sql("INSERT INTO sessions(token_hash,name,expires_at) VALUES($1,$2,NOW()+interval '1 day')", [createHash("sha256").update(tok[n]).digest("hex"), n]); }
const api = (await import("../netlify/functions/api.mjs")).default;
const call = async (path, { who, key, body, method = "POST" } = {}) => { const h = { "content-type": "application/json" }; if (who) h.authorization = "Bearer " + tok[who]; if (key) h["x-sync-key"] = key;
  const res = await api(new Request("http://x/api/" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined })); return { status: res.status, j: await res.json() }; };

assert.equal((await call("gsheet/key", { who: "Ravi", body: { action: "new" } })).status, 403, "only the admin links a sheet");
const mk = await call("gsheet/key", { who: "Yusuf", body: { action: "new" } }); assert.equal(mk.status, 200); const key = mk.j.secret;
assert.ok(mk.j.script.includes(JSON.stringify(key)) && mk.j.script.includes("http://x/api/gsheet/push"), "the script carries the key and this site's address");
// a Tally key cannot push the sheet and the sheet key cannot push Tally
const tk = (await call("tally/key", { who: "Yusuf", body: { action: "new" } })).j.secret;
assert.equal((await call("gsheet/push", { key: tk, body: B(rows) })).status, 401);
assert.equal((await call("tally/push", { key, body: { companies: [] } })).status, 401);
assert.equal((await call("tally/key", { who: "Yusuf", method: "GET" })).j.keys.length, 1, "Tally page lists only Tally keys");
assert.equal((await call("gsheet/push", { body: B(rows) })).status, 401, "no key, no push");
let p = await call("gsheet/push", { key, body: B(rows) }); assert.equal(p.status, 200); assert.equal(p.j.changed, 2);
const rev0 = Number((await sql("SELECT MAX(rev) r FROM records"))[0].r);
p = await call("gsheet/push", { key, body: B(rows) }); assert.equal(p.j.changed, 0);
assert.equal(Number((await sql("SELECT MAX(rev) r FROM records"))[0].r), rev0, "an unchanged sheet does not make everyone download again");
const s = await call("sync", { who: "Ravi", method: "GET" }); assert.equal(s.j.records.filter((x) => x.coll === "gsheet").length, 3, "every user receives the sheet (2 tabs + status)");
// users cannot write the sheet copy through sync
await call("sync", { who: "Yusuf", body: { changes: [{ coll: "gsheet", id: "tab:Raw Data", data: { rows: [] } }] } });
assert.equal((await sql("SELECT data FROM records WHERE coll='gsheet' AND id='tab:Raw Data'"))[0].data.rows.length, 2);
const k = (await call("gsheet/key", { who: "Yusuf", method: "GET" })).j.keys[0]; assert.ok(k.last_used_at);
await call("gsheet/key", { who: "Yusuf", body: { action: "revoke", id: k.id } });
assert.equal((await call("gsheet/push", { key, body: B(rows) })).status, 401, "a stopped key is refused");
await db.end(); console.log("gsheet: ok");
