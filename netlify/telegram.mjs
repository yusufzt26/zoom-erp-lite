// Telegram alerts: who gets which alert, the message text, and the call to the Telegram Bot API (free).
// Pure functions here are tested in test/telegram.test.mjs; the database work is in netlify/functions/api.mjs.

// Every alert the ERP can send. To add one: add it here, then call alertsFor / a digest that returns it.
// who: which users may get it ("right:<key>" = users with that right, "named" = the person named in the document)
// def: on by default for users who may get it (each user can switch alerts off in their Telegram settings)
export const ALERTS = [
  { k: "req_check", label: "Purchase request waiting for my approval", who: "named", def: true, group: true },
  { k: "req_approve", label: "Purchase request waiting for director approval", who: "right:req.approve", def: true, group: true },
  { k: "req_ready", label: "Approved purchase request ready for PO", who: "right:po.create", def: true, group: true },
  { k: "po_approval", label: "PO waiting for approval", who: "right:po.approve", def: true, group: true },
  { k: "my_req", label: "My purchase request approved or sent back", who: "named", def: true, group: false },
  { k: "my_po", label: "My PO approved or sent back", who: "named", def: true, group: false },
  { k: "pay_due", label: "Supplier payments due (daily, 9:30 AM)", who: "right:acct.view", def: true, group: true },
];
export const ALERT_KEYS = ALERTS.map((a) => a.k);
const AL = Object.fromEntries(ALERTS.map((a) => [a.k, a]));

// rights, same rules as rightsOf() in app.html, for the keys alerts need
const LEG = { "page.acct": ["acct.view"], "acct.book": ["acct.view", "acct.create"], "po.create": ["po.create"], "po.approve": ["po.approve"], "req.approve": ["req.approve"], "req.check": ["req.check"], "page.appr": ["po.approve"] };
const ROLE = {
  Director: ["req.approve", "po.approve"], Approver: ["req.approve", "po.approve"],
  Purchase: ["po.create"], Purchaser: ["po.create"], Accounts: ["acct.view", "acct.create"],
  "Department head": ["req.check"], Checker: ["req.check"], HOD: ["req.check"],
};
export function userRights(u) {
  if (!u) return [];
  if (u.role === "Admin") return ["*"];
  if (Array.isArray(u.rights)) return u.rights.includes("v2") ? u.rights.slice() : [...new Set(u.rights.flatMap((k) => LEG[k] || [k]))];
  return ROLE[u.role] || [];
}
export const userHas = (u, k) => { const r = userRights(u); return r.includes("*") || r.includes(k); };

// alerts this user may switch on (Admin: all; others by rights; "named" alerts go to anyone named in a document)
export function eligible(u) {
  return ALERTS.filter((a) => !a.who.startsWith("right:") || userHas(u, a.who.slice(6))).map((a) => a.k);
}
// is this alert on for this user (their own choice, else the default; Admin gets only PO approvals and payments by default)
export function wants(u, prefs, k) {
  if (!eligible(u).includes(k)) return false;
  const p = prefs && typeof prefs === "object" ? prefs[k] : undefined;
  if (typeof p === "boolean") return p;
  if (u && u.role === "Admin" && !["po_approval", "pay_due", "my_req", "my_po"].includes(k)) return false;
  return !!AL[k].def;
}

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const inr = (n) => "₹" + Math.round(+n || 0).toLocaleString("en-IN");
const lineTxt = (lines) => { const L = (Array.isArray(lines) ? lines : []).filter((l) => l && (l.desc || l.item)); if (!L.length) return ""; const f = String(L[0].desc || L[0].item).slice(0, 60); return L.length > 1 ? `${f} + ${L.length - 1} more` : f; };
const lastBy = (doc, re) => { const h = (Array.isArray(doc.history) ? doc.history : []).filter((x) => x && re.test(String(x.action || ""))); return h.length ? String(h[h.length - 1].by || "") : ""; };
const poMaker = (p) => lastBy(p, /approval|pre-estimate|draft/i) || ((p.history || [])[0] || {}).by || "";

// One saved document changed from `before` to `after` (data objects; before is null for a new one).
// Returns alerts: { k, to: [names] (users), text }. Groups get every alert whose key they are set up for.
export function alertsFor(coll, before, after, masters, me) {
  if (!after || after.old) return [];
  const was = before ? String(before.status || "") : "", st = String(after.status || "");
  if (was === st) return [];
  const users = (masters && Array.isArray(masters.users) ? masters.users : []).filter(Boolean);
  const withRight = (k) => { const a = users.filter((u) => u.role !== "Admin" && userHas(u, k)).map((u) => u.name); return a.length ? a : users.filter((u) => u.role === "Admin").map((u) => u.name); };
  const out = [], plant = after.plant ? ` · ${esc(after.plant)}` : "", what = lineTxt(after.lines);
  if (coll === "reqs") {
    const head = `<b>Purchase request ${esc(after.no)}</b>${plant}\n${esc(after.by || "")}${after.dept ? " (" + esc(after.dept) + ")" : ""}${after.job ? " · Job " + esc(after.job) : ""}${what ? "\n" + esc(what) : ""}`;
    if (st === "Submitted") {
      const to = after.checker ? [after.checker] : users.filter((u) => u.dept === after.dept && userHas(u, "req.check") && u.role !== "Admin").map((u) => u.name);
      out.push({ k: "req_check", to: to.filter((n) => n !== after.by), text: `🟡 ${head}\nWaiting for your approval.` });
    }
    if (st === "Checked") out.push({ k: "req_approve", to: withRight("req.approve"), text: `🟡 ${head}\nChecked by ${esc(after.chkBy || "department head")}. Waiting for director approval.` });
    if (st === "Approved") {
      out.push({ k: "req_ready", to: withRight("po.create"), text: `🟢 ${head}\nApproved by ${esc(after.apprBy || me || "")}. Ready for a PO.` });
      if (after.by) out.push({ k: "my_req", to: [after.by], text: `✅ Your ${head.replace("<b>Purchase request", "<b>purchase request")}\nApproved. It is now with Purchase.` });
    }
    if (st === "Sent back" && after.by) out.push({ k: "my_req", to: [after.by], text: `↩️ Your ${head.replace("<b>Purchase request", "<b>purchase request")}\nSent back${me ? " by " + esc(me) : ""}${after.comment ? ": " + esc(after.comment) : "."}` });
  }
  if (coll === "saved") {
    const head = `<b>PO ${esc(after.no)}</b>${plant}\n${esc(after.sup || "No supplier")}${after.total ? " · " + inr(after.total) : ""}${after.ref ? "\nRef " + esc(after.ref) : ""}${what ? "\n" + esc(what) : ""}`;
    const maker = poMaker(after);
    if (st === "Pending approval") out.push({ k: "po_approval", to: withRight("po.approve").filter((n) => n !== maker || users.length === 1), text: `🟡 ${head}\nSent for approval${maker ? " by " + esc(maker) : ""}.` });
    if (st === "Approved" && was && maker) out.push({ k: "my_po", to: [maker], text: `✅ ${head}\nApproved${me ? " by " + esc(me) : ""}.` });
    if (st === "Sent back" && maker) out.push({ k: "my_po", to: [maker], text: `↩️ ${head}\nSent back${me ? " by " + esc(me) : ""}${after.backNote ? ": " + esc(after.backNote) : "."}` });
  }
  // nobody is told about what they did themselves
  return out.map((a) => ({ ...a, to: [...new Set(a.to.filter((n) => n && n !== me))] })).filter((a) => a.to.length || a.k !== "my_req" && a.k !== "my_po");
}

// Daily payments digest from the open supplier bills the app last sent (each: sup, ref, due YYYY-MM-DD, bal, plant).
export function dueDigest(bills, today, soonDays = 3) {
  const B = (Array.isArray(bills) ? bills : []).filter((b) => b && +b.bal > 0.5 && /^\d{4}-\d{2}-\d{2}$/.test(String(b.due || "")));
  const soonEnd = new Date(today + "T00:00:00Z"); soonEnd.setUTCDate(soonEnd.getUTCDate() + soonDays); const se = soonEnd.toISOString().slice(0, 10);
  const over = B.filter((b) => b.due < today), soon = B.filter((b) => b.due >= today && b.due <= se);
  if (!over.length && !soon.length) return null;
  const bySup = (L) => { const m = new Map(); L.forEach((b) => { const o = m.get(b.sup) || { sup: b.sup, amt: 0, n: 0, due: b.due }; o.amt += +b.bal; o.n++; if (b.due < o.due) o.due = b.due; m.set(b.sup, o); }); return [...m.values()].sort((a, b) => b.amt - a.amt); };
  const dm = (d) => { const [y, m, dd] = d.split("-"); return `${dd}-${m}`; };
  const block = (L, max = 8) => { const S = bySup(L); return S.slice(0, max).map((o) => `• ${esc(o.sup)}: ${inr(o.amt)}${o.n > 1 ? ` (${o.n} bills)` : ""} · due ${dm(o.due)}`).join("\n") + (S.length > max ? `\n• …and ${S.length - max} more suppliers` : ""); };
  const sum = (L) => L.reduce((a, b) => a + +b.bal, 0);
  let t = `💰 <b>Supplier payments</b> · ${dm(today)}`;
  if (over.length) t += `\n\n<b>Overdue: ${inr(sum(over))}</b>\n${block(over)}`;
  if (soon.length) t += `\n\n<b>Due in the next ${soonDays} days: ${inr(sum(soon))}</b>\n${block(soon)}`;
  return t;
}

// the 8-character code in the link people tap to link their Telegram (no 0/O/1/I so it is easy to read)
export function linkCode(rand) { const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < 8; i++) s += A[rand(A.length)]; return s; }
export const maskToken = (t) => { const s = String(t || ""); return s ? s.split(":")[0] + ":…" + s.slice(-4) : ""; };
export const tokenOk = (t) => /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(String(t || "").trim());

// Telegram Bot API call. Returns the result, or throws with Telegram's own description.
export async function tg(token, method, params = {}, ms = 8000) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params), signal: AbortSignal.timeout(ms) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw Object.assign(new Error(j.description || "Telegram error " + r.status), { code: j.error_code || r.status });
  return j.result;
}
