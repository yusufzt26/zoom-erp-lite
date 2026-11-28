// node test/mail.test.mjs : helpers; with ZPO_DB_URL=postgres://... also the /api/mail endpoint (mail server faked)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { guessService, smtpCandidates, sealer, cleanSend, addrList, fromLine, smtpWhy } from "../netlify/mail.mjs";

// which mail service, from the address or the company domain's MX
assert.equal(guessService("a@gmail.com"), "google");
assert.equal(guessService("a@outlook.com"), "microsoft");
assert.equal(guessService("sales@zoomtechnologies.net", ["aspmx.l.google.com"]), "google");
assert.equal(guessService("sales@zoomtechnologies.net", ["zoomtechnologies-net.mail.protection.outlook.com"]), "microsoft");
assert.equal(guessService("sales@zoomtechnologies.net", ["mx.zoho.in"]), "zoho");
assert.equal(guessService("sales@zoomtechnologies.net", ["mail.zoomtechnologies.net"]), "");
assert.deepEqual(smtpCandidates("a@gmail.com", "google"), [{ host: "smtp.gmail.com", port: 465, secure: true }]);
assert.deepEqual(smtpCandidates("a@x.net", "").map((c) => c.host + ":" + c.port), ["mail.x.net:465", "mail.x.net:587", "smtp.x.net:465"]);
assert.deepEqual(smtpCandidates("a@x.net", "google", { host: "Mail.X.net", port: "587" }), [{ host: "mail.x.net", port: 587, secure: false }]);
// app password kept encrypted, readable only with the same key
const S = sealer("k1"), sealed = S.seal("abcd efgh ijkl mnop");
assert.ok(!sealed.includes("abcd")); assert.equal(S.open(sealed), "abcd efgh ijkl mnop"); assert.throws(() => sealer("k2").open(sealed));
// addresses
assert.deepEqual(addrList("a@x.com, A@x.com; b@y.in  bad"), ["a@x.com", "b@y.in"]);
assert.equal(cleanSend({ to: ["a@x.com", "nope"], subject: "s" }).error, "This is not an email address: nope");
assert.match(cleanSend({ to: [], subject: "s" }).error, /at least one/);
assert.match(cleanSend({ to: ["a@x.com"], subject: " " }).error, /subject/);
const c = cleanSend({ to: ["a@x.com"], cc: "a@x.com, c@z.com", subject: "PO 1\r\nBcc: evil@x.com", text: "hi", files: [{ name: "PO/1.pdf", b64: Buffer.from("%PDF").toString("base64") }], doc: { type: "po", no: 1 } });
assert.deepEqual(c.cc, ["c@z.com"], "cc drops what is already in To"); assert.equal(c.subject, "PO 1 Bcc: evil@x.com", "no header injection"); assert.equal(c.files[0].filename, "PO-1.pdf");
assert.match(cleanSend({ to: ["a@x.com"], subject: "s", files: [{ name: "a.pdf", b64: "A".repeat(6 * 1024 * 1024) }] }).error, /too big/);
assert.match(cleanSend({ to: Array.from({ length: 21 }, (_, i) => `p${i}@x.com`), subject: "s" }).error, /Too many/);
assert.equal(fromLine('Ra"j', "r@x.com"), '"Raj" <r@x.com>');
assert.match(smtpWhy({ response: "535 5.7.8 Username and Password not accepted" }, "google"), /app password/);
assert.match(smtpWhy({ message: "getaddrinfo ENOTFOUND mail.x.net" }, ""), /Could not find your mail server/);
console.log("mail helpers: ok");

if (!process.env.ZPO_DB_URL) { console.log("mail api: skipped (set ZPO_DB_URL to a test database)"); process.exit(0); }
const pg = (await import("pg")).default;
const db = new pg.Pool({ connectionString: process.env.ZPO_DB_URL });
const sql = (t, p) => db.query(t, p).then((r) => r.rows);
const dir = new URL("../netlify/database/migrations/", import.meta.url);
await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
for (const f of readdirSync(dir).sort()) await sql(readFileSync(new URL(f, dir), "utf8"));
const masters = { users: [{ name: "Yusuf", role: "Admin", email: "yusuf@gmail.com" }, { name: "Raj", role: "Purchase", email: "raj@zoomtechnologies.net" }, { name: "Nik", role: "Staff" }], depts: [], projects: [] };
await sql("INSERT INTO records(coll,id,data,rev,created_rev,updated_by) VALUES('masters','_',$1,nextval('rev_seq'),currval('rev_seq'),'Yusuf')", [JSON.stringify(masters)]);
const tok = {}; for (const n of ["Yusuf", "Raj", "Nik"]) { await sql("INSERT INTO logins(name,pass_hash) VALUES($1,'x')", [n]); tok[n] = "t-" + n; await sql("INSERT INTO sessions(token_hash,name,expires_at) VALUES($1,$2,NOW()+interval '1 day')", [createHash("sha256").update(tok[n]).digest("hex"), n]); }

// fake mail server: "good-pass" works; company mail answers only on mail.<domain>:587
const sent = [], tried = [];
const nodemailer = (await import("nodemailer")).default;
nodemailer.createTransport = (o) => ({
  async verify() { tried.push(o.host + ":" + o.port); if (o.host === "mail.zoomtechnologies.net" && o.port !== 587) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); if (o.auth.pass !== "goodpass") throw Object.assign(new Error("Invalid login"), { response: "535 5.7.8 Username and Password not accepted" }); return true; },
  async sendMail(m) { if (o.auth.pass !== "goodpass") throw new Error("535 auth"); sent.push({ ...m, via: o.host + ":" + o.port, user: o.auth.user }); return { messageId: "<id" + sent.length + ">" }; },
});
const api = (await import("../netlify/functions/api.mjs")).default;
const call = async (who, b) => { const r = await api(new Request("https://erp.example/api/mail", { method: b ? "POST" : "GET", headers: { authorization: "Bearer " + tok[who], "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined })); return { status: r.status, j: await r.json() }; };

let r = await call("Yusuf"); assert.equal(r.status, 200); assert.equal(r.j.email, "yusuf@gmail.com"); assert.equal(r.j.ready, false); assert.equal(r.j.guess, "google");
// no email in Users & rights: cannot set up
assert.match((await call("Nik", { action: "save", pass: "goodpass" })).j.error, /not in Users & rights/);
// not set up yet: send is refused with a hint
r = await call("Yusuf", { action: "send", to: ["a@x.com"], subject: "s" }); assert.equal(r.status, 400); assert.equal(r.j.setup, true);
// wrong app password
r = await call("Yusuf", { action: "save", service: "google", pass: "bad" }); assert.equal(r.status, 400); assert.match(r.j.error, /app password/);
// right one (spaces in Google's 16 letters are fine): saved encrypted, test email to self
sent.length = 0; r = await call("Yusuf", { action: "save", service: "google", pass: "good pass" }); assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.ready, true);
assert.equal(sent[0].to, "yusuf@gmail.com"); assert.match(sent[0].from, /"Yusuf" <yusuf@gmail.com>/);
const row = (await sql("SELECT * FROM mail_accounts WHERE name='Yusuf'"))[0]; assert.ok(!row.pass_enc.includes("goodpass")); assert.equal(row.host, "smtp.gmail.com");
assert.ok(!JSON.stringify((await call("Yusuf")).j).includes("goodpass"), "password never goes back to the browser");
// send a PO with the PDF, from his own mailbox
sent.length = 0; const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
r = await call("Yusuf", { action: "send", to: ["sales@purohit.in", "accounts@purohit.in"], cc: "boss@zoom.net", subject: "Purchase Order 2101", text: "Please find attached", files: [{ name: "PO-2101-Purohit.pdf", b64: pdf }], doc: { type: "po", no: "2101", party: "Purohit" } });
assert.equal(r.status, 200, JSON.stringify(r.j)); assert.deepEqual(r.j.to, ["sales@purohit.in", "accounts@purohit.in"]);
assert.equal(sent[0].from, '"Yusuf" <yusuf@gmail.com>'); assert.equal(sent[0].replyTo, "yusuf@gmail.com"); assert.equal(sent[0].user, "yusuf@gmail.com"); assert.equal(sent[0].bcc, undefined, "Gmail keeps its own Sent copy");
assert.equal(sent[0].attachments[0].filename, "PO-2101-Purohit.pdf"); assert.equal(sent[0].attachments[0].content.toString(), "%PDF-1.4 test");
r = await call("Raj", { action: "log", type: "po", no: "2101" }); assert.equal(r.j.sent[0].to_list, "sales@purohit.in, accounts@purohit.in"); assert.equal(r.j.sent[0].name, "Yusuf");
// company mail on its own server: found by itself on mail.<domain>:587; a copy to self by BCC since it keeps no Sent copy
tried.length = 0; r = await call("Raj", { action: "save", service: "", pass: "goodpass" }); assert.equal(r.status, 200, JSON.stringify(r.j)); assert.deepEqual(tried, ["mail.zoomtechnologies.net:465", "mail.zoomtechnologies.net:587"]);
assert.equal(r.j.account.savesSent, false);
sent.length = 0; r = await call("Raj", { action: "send", to: ["a@x.com"], subject: "Invoice ZT118", copyMe: true, doc: { type: "inv", no: "ZT118" } }); assert.equal(r.status, 200); assert.deepEqual(sent[0].bcc, ["raj@zoomtechnologies.net"]); assert.equal(sent[0].via, "mail.zoomtechnologies.net:587");
// the Admin changes his email in Users & rights: he must set up again before sending
masters.users[1].email = "raj@gmail.com"; await sql("UPDATE records SET data=$1 WHERE coll='masters'", [JSON.stringify(masters)]);
r = await call("Raj"); assert.equal(r.j.ready, false); assert.equal(r.j.changed, true);
r = await call("Raj", { action: "send", to: ["a@x.com"], subject: "x" }); assert.equal(r.status, 400); assert.equal(r.j.setup, true);
// remove
assert.equal((await call("Yusuf", { action: "remove" })).j.ready, false);
console.log("mail api: ok");
await db.end(); process.exit(0);
