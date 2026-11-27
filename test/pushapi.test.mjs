// ZPO_DB_URL=postgres://... node test/pushapi.test.mjs : phone pop-ups through the API (push service faked), skipped without ZPO_DB_URL
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
import webpush from "web-push";
if (!process.env.ZPO_DB_URL) { console.log("pushapi: skipped (set ZPO_DB_URL to a test database)"); process.exit(0); }
const db = new pg.Pool({ connectionString: process.env.ZPO_DB_URL });
const sql = (t, p) => db.query(t, p).then((r) => r.rows);
const dir = new URL("../netlify/database/migrations/", import.meta.url);
await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
for (const f of readdirSync(dir).sort()) await sql(readFileSync(new URL(f, dir), "utf8"));
const masters = { users: [{ name: "Yusuf", role: "Admin" }, { name: "Dir", role: "Director" }, { name: "Raj", role: "Purchase" }, { name: "Singh", role: "Department head", dept: "Design" }, { name: "Niksal", role: "Staff", dept: "Design" }, { name: "Acc", role: "Accounts" }], depts: [{ name: "Design", hod: "Singh" }], projects: [] };
await sql("INSERT INTO records(coll,id,data,rev,created_rev,updated_by) VALUES('masters','_',$1,nextval('rev_seq'),currval('rev_seq'),'Yusuf')", [JSON.stringify(masters)]);
const tok = {}; for (const n of masters.users.map((u) => u.name)) { await sql("INSERT INTO logins(name,pass_hash) VALUES($1,'x')", [n]); tok[n] = "t-" + n; await sql("INSERT INTO sessions(token_hash,name,expires_at) VALUES($1,$2,NOW()+interval '1 day')", [createHash("sha256").update(tok[n]).digest("hex"), n]); }

// fake push service: records what would pop up on each device; "gone" devices answer 410 like a real uninstalled app
const sent = []; let vapid = null;
webpush.sendNotification = async (sub, payload, o) => { vapid = o.vapidDetails; if (/gone/.test(sub.endpoint)) throw Object.assign(new Error("Gone"), { statusCode: 410 }); sent.push({ to: sub.endpoint.split("/").pop(), ...JSON.parse(payload) }); return { statusCode: 201 }; };
globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, description: "no telegram here" }));
const api = (await import("../netlify/functions/api.mjs")).default;
const call = async (who, path, b, ua = "Mozilla/5.0 (Linux; Android 14) Chrome/131.0 Mobile") => { const r = await api(new Request("https://erp.example/api/" + path, { method: b ? "POST" : "GET", headers: { authorization: "Bearer " + tok[who], "content-type": "application/json", "user-agent": ua }, body: b ? JSON.stringify(b) : undefined })); return { status: r.status, j: await r.json() }; };
const keys = { p256dh: "B" + "a".repeat(86), auth: "c".repeat(22) };
const sub = (id) => ({ endpoint: "https://fcm.googleapis.com/fcm/send/" + id, keys });

// keys are made once and only the public half is sent to the browser
let r = await call("Raj", "push"); assert.equal(r.status, 200); assert.match(r.j.publicKey, /^[A-Za-z0-9_-]{80,}$/);
assert.equal((await call("Dir", "push")).j.publicKey, r.j.publicKey); assert.ok(!JSON.stringify(r.j).includes((await sql("SELECT v FROM push_settings WHERE k='private'"))[0].v));
assert.equal(r.j.devices.length, 0); assert.ok(r.j.alerts.some((a) => a.k === "req_ready" && a.on)); assert.ok(!r.j.people, "only the Admin sees who is on");
// a fake address is refused
assert.equal((await call("Raj", "push", { action: "subscribe", sub: { endpoint: "https://evil.example/x", keys } })).status, 400);
// people turn it on
for (const [n, id] of [["Dir", "dir"], ["Raj", "raj"], ["Singh", "singh"], ["Niksal", "nik"], ["Acc", "acc"]]) assert.equal((await call(n, "push", { action: "subscribe", sub: sub(id) })).status, 200);
r = await call("Raj", "push", { action: "subscribe", sub: sub("raj-pc") }, "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0");
assert.deepEqual(r.j.devices.map((d) => d.device), ["Android phone · Chrome", "Windows PC · Chrome"]);
assert.deepEqual((await call("Yusuf", "push")).j.people.map((x) => [x.name, x.n]), [["Acc", 1], ["Dir", 1], ["Niksal", 1], ["Raj", 2], ["Singh", 1]]);
// test pop-up
sent.length = 0; assert.equal((await call("Niksal", "push", { action: "test" })).status, 200); assert.equal(sent[0].to, "nik"); assert.match(sent[0].title, /Test from ZT-ERP/);
assert.equal(vapid.subject, "https://erp.example");

// request submitted -> department head; approved -> Purchase (both devices) and the requester
sent.length = 0;
await call("Niksal", "sync", { changes: [{ coll: "reqs", id: "080", isNew: true, data: { no: "080", by: "Niksal", dept: "Design", checker: "Singh", status: "Submitted", lines: [{ desc: "Insert drill 8 mm" }] } }] });
assert.deepEqual(sent.map((m) => m.to), ["singh"]); assert.equal(sent[0].title, "🟡 Purchase request 080"); assert.match(sent[0].body, /Insert drill 8 mm/); assert.equal(sent[0].url, "/#go=appr");
sent.length = 0;
await call("Singh", "sync", { changes: [{ coll: "reqs", id: "080", data: { no: "080", by: "Niksal", dept: "Design", checker: "Singh", status: "Approved", apprBy: "Singh", lines: [] } }] });
assert.deepEqual(sent.map((m) => m.to).sort(), ["nik", "raj", "raj-pc"]); assert.equal(sent.find((m) => m.to === "nik").url, "/#go=req");
// PO for approval -> director; the director switches PO pop-ups off -> nobody
sent.length = 0; await call("Raj", "sync", { changes: [{ coll: "saved", id: "2060", isNew: true, data: { no: 2060, status: "Pending approval", sup: "Shree Steels", total: 1000, history: [{ by: "Raj", action: "Sent for approval" }] } }] });
assert.deepEqual(sent.map((m) => m.to), ["dir"]); assert.match(sent[0].body, /Shree Steels · ₹1,000/);
await call("Dir", "push", { action: "prefs", prefs: { po_approval: false, pay_due: true, nonsense: true } });
assert.deepEqual((await sql("SELECT prefs FROM push_prefs WHERE name='Dir'"))[0].prefs, { po_approval: false });
sent.length = 0; await call("Raj", "sync", { changes: [{ coll: "saved", id: "2061", isNew: true, data: { no: 2061, status: "Pending approval", history: [{ by: "Raj", action: "Sent for approval" }] } }] });
assert.equal(sent.length, 0);
// approved -> the purchaser, on both devices
sent.length = 0; await call("Dir", "sync", { changes: [{ coll: "saved", id: "2061", data: { no: 2061, status: "Approved", history: [{ by: "Raj", action: "Sent for approval" }, { by: "Dir", action: "Approved" }] } }] });
assert.deepEqual(sent.map((m) => m.to).sort(), ["raj", "raj-pc"]); assert.equal(sent[0].url, "/#go=saved");

// daily payments pop-up for Accounts, even with no Telegram bot set up
const t = new Date(Date.now() + 5.5 * 3600e3); const d = (n) => { const x = new Date(t); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
await call("Acc", "telegram", { action: "dues", bills: [{ sup: "Shree Steels", due: d(-5), bal: 12000 }, { sup: "Om Tools", due: d(2), bal: 3000 }] });
sent.length = 0; r = await call("Yusuf", "telegram", { action: "daily-now" }); assert.equal(r.j.sent, 1);
assert.deepEqual(sent.map((m) => m.to), ["acc"]); assert.match(sent[0].title, /Supplier payments/); assert.match(sent[0].body, /Overdue: ₹12,000/); assert.equal(sent[0].url, "/#go=acct");
await sql("DELETE FROM tg_settings WHERE k='daily_last'");
const daily = (await import("../netlify/functions/tg-daily.mjs")).default; sent.length = 0; await daily(); assert.deepEqual(sent.map((m) => m.to), ["acc"]);
sent.length = 0; await daily(); assert.equal(sent.length, 0, "once a day");

// a device that is gone is removed; a phone taken over by another login moves to them
await sql("UPDATE push_subs SET endpoint='https://fcm.googleapis.com/fcm/send/gone' WHERE endpoint LIKE '%/dir'");
await call("Raj", "sync", { changes: [{ coll: "saved", id: "2062", isNew: true, data: { no: 2062, status: "Pending approval", history: [{ by: "Raj", action: "Sent for approval" }] } }] });
await call("Dir", "push", { action: "prefs", prefs: {} });
await call("Raj", "sync", { changes: [{ coll: "saved", id: "2063", isNew: true, data: { no: 2063, status: "Pending approval", history: [{ by: "Raj", action: "Sent for approval" }] } }] });
assert.equal((await sql("SELECT COUNT(*)::int n FROM push_subs WHERE name='Dir'"))[0].n, 0);
await call("Singh", "push", { action: "subscribe", sub: sub("nik") }); assert.equal((await sql("SELECT name FROM push_subs WHERE endpoint LIKE '%/nik'"))[0].name, "Singh");
// turn off on one device; renaming a login keeps their pop-ups
r = await call("Raj", "push", { action: "unsubscribe", endpoint: sub("raj-pc").endpoint }); assert.equal(r.j.devices.length, 1);
assert.equal((await call("Yusuf", "logins", { action: "rename", name: "Raj", newName: "Raj Patil" })).status, 200);
assert.equal((await sql("SELECT COUNT(*)::int n FROM push_subs WHERE name='Raj Patil'"))[0].n, 1);
console.log("pushapi: ok"); await db.end(); process.exit(0);
