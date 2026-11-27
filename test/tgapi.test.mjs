// ZPO_DB_URL=postgres://... node test/tgapi.test.mjs : Telegram bot setup, linking, groups and alerts through the API, Telegram itself faked (skipped without ZPO_DB_URL)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
if (!process.env.ZPO_DB_URL) { console.log("tgapi: skipped (set ZPO_DB_URL to a test database)"); process.exit(0); }
const db = new pg.Pool({ connectionString: process.env.ZPO_DB_URL });
const sql = (t, p) => db.query(t, p).then((r) => r.rows);
const dir = new URL("../netlify/database/migrations/", import.meta.url);
await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
for (const f of readdirSync(dir).sort()) await sql(readFileSync(new URL(f, dir), "utf8"));
const masters = { users: [{ name: "Yusuf", role: "Admin" }, { name: "Dir", role: "Director" }, { name: "Raj", role: "Purchase" }, { name: "Singh", role: "Department head", dept: "Design" }, { name: "Niksal", role: "Staff", dept: "Design" }, { name: "Acc", role: "Accounts" }], depts: [{ name: "Design", hod: "Singh" }], projects: [] };
await sql("INSERT INTO records(coll,id,data,rev,created_rev,updated_by) VALUES('masters','_',$1,nextval('rev_seq'),currval('rev_seq'),'Yusuf')", [JSON.stringify(masters)]);
const tok = {}; for (const n of masters.users.map((u) => u.name)) { await sql("INSERT INTO logins(name,pass_hash) VALUES($1,'x')", [n]); tok[n] = "t-" + n; await sql("INSERT INTO sessions(token_hash,name,expires_at) VALUES($1,$2,NOW()+interval '1 day')", [createHash("sha256").update(tok[n]).digest("hex"), n]); }

// fake Telegram
const sent = []; let hook = null;
globalThis.fetch = async (u, o) => { const m = String(u).match(/bot([^/]+)\/(\w+)$/); const p = JSON.parse(o.body || "{}"); const R = (result, ok = true) => new Response(JSON.stringify(ok ? { ok, result } : { ok, description: result, error_code: 403 }));
  if (m[1] !== "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw8") return R("Unauthorized", false);
  if (m[2] === "getMe") return R({ username: "zt_test_bot" }); if (m[2] === "setWebhook") { hook = p; return R(true); }
  if (m[2] === "sendMessage") { if (p.chat_id === "999") return R("Forbidden: bot was blocked by the user", false); sent.push(p); return R({}); } return R(true); };
const api = (await import("../netlify/functions/api.mjs")).default;
const call = async (who, path, b) => { const r = await api(new Request("https://erp.example/api/" + path, { method: b ? "POST" : "GET", headers: { authorization: "Bearer " + tok[who], "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined })); return { status: r.status, j: await r.json() }; };
const tgUpd = async (u, secret = hook.secret_token) => (await api(new Request("https://erp.example/api/telegram/hook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret, "content-type": "application/json" }, body: JSON.stringify(u) }))).status;

// only the Admin sets the token; a wrong token is refused; the token is never sent back
assert.equal((await call("Raj", "telegram", { action: "token", token: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw8" })).status, 403);
assert.equal((await call("Yusuf", "telegram", { action: "token", token: "123456789:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw8" })).status, 400);
let r = await call("Yusuf", "telegram", { action: "token", token: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw8" });
assert.equal(r.status, 200); assert.equal(r.j.bot, "zt_test_bot"); assert.equal(hook.url, "https://erp.example/api/telegram/hook");
assert.ok(!JSON.stringify(r.j).includes("AAHdqTcv")); assert.ok(!JSON.stringify((await call("Raj", "telegram")).j).includes("saw8"));
// webhook without the secret is refused
assert.equal(await tgUpd({ message: { chat: { id: 1, type: "private" }, text: "/start X" } }, "wrong"), 401);

// people link by tapping Start with their code
const link = async (who, chat) => { const { j } = await call(who, "telegram", { action: "link" }); assert.match(j.url, /^https:\/\/t\.me\/zt_test_bot\?start=[A-Z2-9]{8}$/); await tgUpd({ message: { chat: { id: chat, type: "private" }, from: { first_name: who }, text: "/start " + j.code } }); return j.code; };
const used = await link("Dir", 101); await link("Raj", 102); await link("Singh", 103); await link("Niksal", 104); await link("Acc", 105);
assert.equal((await sql("SELECT COUNT(*)::int n FROM tg_links"))[0].n, 5);
assert.ok(sent.some((m) => m.chat_id === "101" && /Linked to ZT-ERP as <b>Dir<\/b>/.test(m.text)));
// a used code does not work again
await tgUpd({ message: { chat: { id: 555, type: "private" }, text: "/start " + used } }); assert.match(sent.at(-1).text, /expired/);
assert.equal((await call("Dir", "telegram")).j.link.tg_name, "Dir");

// bot added to a group -> listed for the Admin, who ticks alerts
await tgUpd({ my_chat_member: { chat: { id: -100500, type: "supergroup", title: "Purchase approvals" }, new_chat_member: { status: "member" } } });
r = await call("Yusuf", "telegram"); assert.equal(r.j.groups[0].title, "Purchase approvals");
await call("Yusuf", "telegram", { action: "group", chat_id: "-100500", alerts: ["po_approval", "my_po", "nonsense"] });
assert.deepEqual((await sql("SELECT alerts FROM tg_groups"))[0].alerts, ["po_approval"]);

// request submitted -> department head; approved -> purchase and requester
sent.length = 0;
await call("Niksal", "sync", { changes: [{ coll: "reqs", id: "080", isNew: true, data: { no: "080", by: "Niksal", dept: "Design", checker: "Singh", status: "Submitted", lines: [{ desc: "Insert drill 8 mm" }] } }] });
assert.deepEqual(sent.map((m) => m.chat_id), ["103"]); assert.match(sent[0].text, /Purchase request 080/); assert.equal(sent[0].reply_markup.inline_keyboard[0][0].url, "https://erp.example");
sent.length = 0;
await call("Singh", "sync", { changes: [{ coll: "reqs", id: "080", data: { no: "080", by: "Niksal", dept: "Design", checker: "Singh", status: "Approved", apprBy: "Singh", lines: [] } }] });
assert.deepEqual(sent.map((m) => m.chat_id).sort(), ["102", "104"]);
// saving again with the same status sends nothing
sent.length = 0; await call("Singh", "sync", { changes: [{ coll: "reqs", id: "080", data: { no: "080", by: "Niksal", status: "Approved", note: "x" } }] }); assert.equal(sent.length, 0);

// PO for approval -> director and the group; Dir switched it off -> only the group
await call("Raj", "sync", { changes: [{ coll: "saved", id: "2060", isNew: true, data: { no: 2060, status: "Pending approval", sup: "Shree Steels", total: 1000, history: [{ by: "Raj", action: "Sent for approval" }] } }] });
assert.deepEqual(sent.map((m) => m.chat_id).sort(), ["-100500", "101"]);
await call("Dir", "telegram", { action: "prefs", prefs: { po_approval: false, pay_due: true } });
sent.length = 0; await call("Raj", "sync", { changes: [{ coll: "saved", id: "2061", isNew: true, data: { no: 2061, status: "Pending approval", history: [{ by: "Raj", action: "Sent for approval" }] } }] });
assert.deepEqual(sent.map((m) => m.chat_id), ["-100500"]);
// approved -> the purchaser
sent.length = 0; await call("Yusuf", "sync", { changes: [{ coll: "saved", id: "2061", data: { no: 2061, status: "Approved", history: [{ by: "Raj", action: "Sent for approval" }, { by: "Yusuf", action: "Approved" }] } }] });
assert.deepEqual(sent.map((m) => m.chat_id), ["102"]);

// payments: Accounts sends the open bills, the daily alert goes to Accounts (and not to Staff)
const t = new Date(Date.now() + 5.5 * 3600e3); const d = (n) => { const x = new Date(t); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
assert.equal((await call("Niksal", "telegram", { action: "dues", bills: [{ sup: "X", due: d(-1), bal: 5 }] })).j.skipped, true);
await call("Acc", "telegram", { action: "dues", bills: [{ sup: "Shree Steels", due: d(-5), bal: 12000 }, { sup: "Om Tools", due: d(2), bal: 3000 }] });
sent.length = 0; r = await call("Yusuf", "telegram", { action: "daily-now" });
assert.deepEqual(sent.map((m) => m.chat_id), ["105"]); assert.match(sent[0].text, /Overdue: ₹12,000/); assert.match(sent[0].text, /Om Tools/);
// the scheduled run does not repeat it the same day
const daily = (await import("../netlify/functions/tg-daily.mjs")).default; sent.length = 0; await daily(); assert.equal(sent.length, 0);

// a chat that blocked the bot is unlinked
await sql("UPDATE tg_links SET chat_id='999' WHERE name='Raj'");
await call("Yusuf", "sync", { changes: [{ coll: "saved", id: "2062", isNew: true, data: { no: 2062, status: "Sent back", history: [{ by: "Raj", action: "Sent for approval" }] } }] });
assert.equal((await sql("SELECT COUNT(*)::int n FROM tg_links WHERE name='Raj'"))[0].n, 0);
// /stop unlinks; unlink from the ERP too
await tgUpd({ message: { chat: { id: 103, type: "private" }, text: "/stop" } }); assert.ok(!(await call("Singh", "telegram")).j.link);
await call("Niksal", "telegram", { action: "unlink" }); assert.ok(!(await call("Niksal", "telegram")).j.link);
// bot removed from the group
await tgUpd({ my_chat_member: { chat: { id: -100500, type: "supergroup", title: "Purchase approvals" }, new_chat_member: { status: "kicked" } } });
assert.equal((await sql("SELECT active FROM tg_groups"))[0].active, false);
console.log("tgapi: ok"); await db.end(); process.exit(0);
