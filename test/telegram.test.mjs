// node test/telegram.test.mjs : who gets which Telegram alert, and the payments digest
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALERTS, alertsFor, dueDigest, eligible, wants, userRights, tokenOk, maskToken, linkCode } from "../netlify/telegram.mjs";

// the app's copy of the alert list must have the same keys
const app = readFileSync(new URL("../app.html", import.meta.url), "utf8");
const keys = [...app.match(/const TG_ALERTS=\[(.*?)\];/)[1].matchAll(/\["(\w+)"/g)].map((m) => m[1]);
assert.deepEqual(keys, ALERTS.map((a) => a.k), "TG_ALERTS in app.html is out of step with netlify/telegram.mjs");

const M = { users: [
  { name: "Owner", role: "Admin" }, { name: "Dir", role: "Director" }, { name: "Buyer", role: "Purchase" },
  { name: "Head", role: "Department head", dept: "Tool room" }, { name: "Ravi", role: "Staff", dept: "Tool room" },
  { name: "Acc", role: "Accounts" }, { name: "V2", role: "Staff", rights: ["v2", "po.approve", "acct.view"] },
] };
const U = (n) => M.users.find((u) => u.name === n);

assert.deepEqual(userRights(U("Dir")), ["req.approve", "po.approve"]);
assert.ok(eligible(U("Acc")).includes("pay_due") && !eligible(U("Acc")).includes("po_approval"));
assert.ok(eligible(U("V2")).includes("po_approval") && eligible(U("V2")).includes("pay_due"));
assert.equal(wants(U("Owner"), {}, "req_ready"), false, "Admin gets request alerts only if switched on");
assert.equal(wants(U("Owner"), { req_ready: true }, "req_ready"), true);
assert.equal(wants(U("Owner"), {}, "po_approval"), true);
assert.equal(wants(U("Dir"), { po_approval: false }, "po_approval"), false);

// request submitted -> its department head
let a = alertsFor("reqs", { no: "071", status: "Draft" }, { no: "071", status: "Submitted", by: "Ravi", dept: "Tool room", checker: "Head", lines: [{ desc: "EN31 bar" }] }, M, "Ravi");
assert.equal(a.length, 1); assert.equal(a[0].k, "req_check"); assert.deepEqual(a[0].to, ["Head"]); assert.match(a[0].text, /Purchase request 071/); assert.match(a[0].text, /EN31 bar/);
// no change in status -> nothing
assert.equal(alertsFor("reqs", { status: "Submitted" }, { status: "Submitted", checker: "Head" }, M, "Ravi").length, 0);
// approved by head -> purchase, and the requester is told
a = alertsFor("reqs", { no: "071", status: "Submitted" }, { no: "071", status: "Approved", by: "Ravi", apprBy: "Head (department head)" }, M, "Head");
assert.deepEqual(a.map((x) => x.k), ["req_ready", "my_req"]); assert.deepEqual(a[0].to, ["Buyer"]); assert.deepEqual(a[1].to, ["Ravi"]);
// own request auto-approved: requester is not told about their own action
a = alertsFor("reqs", null, { no: "072", status: "Approved", by: "Ravi" }, M, "Ravi");
assert.deepEqual(a.map((x) => x.k), ["req_ready"]);
// sent back -> requester
a = alertsFor("reqs", { status: "Submitted" }, { no: "073", status: "Sent back", by: "Ravi", comment: "Add size" }, M, "Head");
assert.equal(a[0].k, "my_req"); assert.match(a[0].text, /Add size/);
// PO sent for approval -> people with po.approve (not Admin while others have it)
const po = { no: "2056", status: "Pending approval", sup: "Shree Steels", total: 48260, plant: "Plant 2", history: [{ by: "Buyer", action: "Sent for approval" }] };
a = alertsFor("saved", { status: "Draft" }, po, M, "Buyer");
assert.equal(a[0].k, "po_approval"); assert.deepEqual(a[0].to.sort(), ["Dir", "V2"]); assert.match(a[0].text, /₹48,260/);
// approved -> the purchaser who made it
a = alertsFor("saved", po, { ...po, status: "Approved", history: [...po.history, { by: "Dir", action: "Approved" }] }, M, "Dir");
assert.deepEqual(a.map((x) => [x.k, x.to]), [["my_po", ["Buyer"]]]);
// old imported POs never alert
assert.equal(alertsFor("saved", null, { ...po, old: true }, M, "Owner").length, 0);
// HTML in names is escaped
a = alertsFor("saved", null, { ...po, sup: "<b>x</b>" }, M, "Buyer"); assert.ok(!a[0].text.includes("<b>x</b>"));

// payments digest
const bills = [{ sup: "A", due: "2026-11-20", bal: 1000 }, { sup: "A", due: "2026-11-25", bal: 500 }, { sup: "B", due: "2026-11-29", bal: 2000 }, { sup: "C", due: "2026-12-20", bal: 9000 }, { sup: "D", due: "", bal: 50 }];
const t = dueDigest(bills, "2026-11-27");
assert.match(t, /Overdue: ₹1,500/); assert.match(t, /A: ₹1,500 \(2 bills\) · due 20-11/); assert.match(t, /next 3 days: ₹2,000/); assert.ok(!t.includes("C:"));
assert.equal(dueDigest([{ sup: "C", due: "2026-12-20", bal: 9000 }], "2026-11-27"), null);

assert.ok(tokenOk("1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw8"));
assert.ok(!tokenOk("hello")); assert.equal(maskToken("1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw8"), "1234567890:…saw8");
assert.match(linkCode((n) => Math.floor(Math.random() * n)), /^[A-HJ-NP-Z2-9]{8}$/);
console.log("telegram tests ok");
