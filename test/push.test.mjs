// node test/push.test.mjs : phone pop-up text, device names, which browser addresses are accepted
import assert from "node:assert/strict";
import { pushPayload, deviceName, subOk, ALERT_VIEW } from "../netlify/push.mjs";
import { ALERTS } from "../netlify/telegram.mjs";

// every alert opens a page
for (const a of ALERTS) assert.ok(ALERT_VIEW[a.k], "no page for alert " + a.k);
// Telegram HTML -> title and body, no tags, entities decoded
const p = pushPayload("po_approval", "🟡 <b>PO 2056</b> · Plant 2\nShree Steels &amp; Co · ₹48,260\nEN31 &lt;40 dia&gt;\nSent for approval by Raj.");
assert.equal(p.title, "🟡 PO 2056 · Plant 2");
assert.equal(p.body, "Shree Steels & Co · ₹48,260\nEN31 <40 dia>\nSent for approval by Raj.");
assert.equal(p.url, "/#go=appr"); assert.equal(p.tag, "po_approval:PO 2056");
assert.equal(pushPayload("pay_due", "💰 <b>Supplier payments</b> · 27-11\n\n<b>Overdue: ₹12,000</b>").url, "/#go=acct");
assert.equal(deviceName("Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36"), "Android phone · Chrome");
assert.equal(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1"), "iPhone · Safari");
const keys = { p256dh: "B" + "a".repeat(86), auth: "c".repeat(22) };
assert.ok(subOk({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys }));
assert.ok(subOk({ endpoint: "https://web.push.apple.com/QH1", keys }));
assert.ok(!subOk({ endpoint: "https://evil.example/x", keys }), "only real push services");
assert.ok(!subOk({ endpoint: "http://fcm.googleapis.com/x", keys }));
assert.ok(!subOk({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "x", auth: "y" } }));
console.log("push: ok");
