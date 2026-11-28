// Tally sync (read-only copy of Tally on the accounts PC).
// The sync program sends what Tally shows now; this turns it into records of the "tally" collection
// and works out which records changed, so only real changes are written (and kept in record_history).
import { createHash } from "node:crypto";

const S = (v, n = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const N = (v) => { const x = Number(v); return isFinite(x) ? Math.round(x * 100) / 100 : 0; };
const D = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
const h = (...a) => createHash("sha1").update(a.join("\u0001")).digest("hex").slice(0, 24);

// same JSON for the same content, whatever the key order (Postgres jsonb reorders keys)
export function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  return JSON.stringify(v ?? null);
}

export const LIMITS = { companies: 10, bills: 30000, ledgers: 20000, vch: 30000, pur: 120 };

// payload from the sync program -> { status, recs: Map(id -> data), okCos: Set(company), purCos: Set(company whose purchases were read) }
// Purchases ("p" records) are monthly totals of Tally purchase vouchers ("pur") and debit notes ("dn"); amt with GST, net before GST.
export function tallyRecords(b, keyLabel, now = new Date()) {
  const cos = Array.isArray(b && b.companies) ? b.companies.slice(0, LIMITS.companies) : [];
  const recs = new Map(); const okCos = new Set(); const purCos = new Set(); const sum = [];
  for (const c of cos) {
    const co = S(c && c.name); if (!co) continue;
    const ok = !!c.ok; const st = { name: co, ok, error: ok ? "" : S(c.error, 300) || "Could not read this company", bills: 0, ledgers: 0, vch: 0, pur: 0, purOk: false, purErr: "", cust: 0, sup: 0, flip: !!c.flip };
    if (ok) {
      okCos.add(co);
      for (const x of (Array.isArray(c.ledgers) ? c.ledgers : []).slice(0, LIMITS.ledgers)) {
        const name = S(x && x.n); const kind = x && (x.k === "cust" || x.k === "sup") ? x.k : ""; if (!name || !kind) continue;
        const id = "l:" + h(co, name);
        recs.set(id, { id, t: "l", co, name, kind, group: S(x.g, 120), gstin: S(x.gst, 20).toUpperCase(), due: N(x.due), bw: !!x.bw });
        st.ledgers++;
      }
      const bills = new Map();
      for (const x of (Array.isArray(c.bills) ? c.bills : []).slice(0, LIMITS.bills)) {
        const ledger = S(x && x.l); const kind = x && (x.k === "cust" || x.k === "sup") ? x.k : ""; if (!ledger || !kind) continue;
        const bill = S(x.ref, 120), date = D(x.d);
        const id = "b:" + h(co, kind, ledger, bill, date);
        const o = bills.get(id);
        if (o) { o.due = N(o.due + N(x.due)); continue; } // same bill twice in Tally's list: add them up
        bills.set(id, { id, t: "b", co, kind, ledger, bill, date, dueOn: D(x.dueOn), due: N(x.due) });
      }
      for (const [id, o] of bills) { recs.set(id, o); st.bills++; st[o.kind] = N(st[o.kind] + o.due); }
      for (const x of (Array.isArray(c.vch) ? c.vch : []).slice(0, LIMITS.vch)) {
        const g = S(x && x.g, 120), type = x && (x.t === "rcpt" || x.t === "pay") ? x.t : ""; if (!type) continue;
        const date = D(x.d), no = S(x.no, 60), ledger = S(x.l);
        const id = "v:" + h(co, g || [type, date, no, ledger].join("|"));
        recs.set(id, { id, t: "v", co, type, vtype: S(x.vt, 60), date, no, ledger, amt: N(x.amt), narr: S(x.nar, 200) });
        st.vch++;
      }
      if (c.purOk && Array.isArray(c.pur)) {
        purCos.add(co); st.purOk = true;
        for (const x of c.pur.slice(0, LIMITS.pur)) {
          const m = /^\d{4}-\d{2}$/.test(String(x && x.m || "")) ? x.m : "", type = x && (x.t === "pur" || x.t === "dn") ? x.t : ""; if (!m || !type) continue;
          const id = "p:" + h(co, type, m);
          recs.set(id, { id, t: "p", co, type, m, amt: N(x.amt), net: N(x.net), n: Math.max(0, Math.round(+x.n || 0)) });
          if (type === "pur") st.pur = N(st.pur + N(x.amt));
        }
      } else st.purErr = S(c.purErr, 300);
    }
    sum.push(st);
  }
  const status = { id: "status", t: "s", at: now.toISOString(), agentAt: S(b && b.at, 40), pc: S(b && b.pc, 80), user: S(b && b.user, 80), v: S(b && b.v, 20), key: S(keyLabel, 80),
    from: D(b && b.from), purFrom: D(b && b.purFrom), tally: S(b && b.tally, 120), error: S(b && b.error, 300), companies: sum };
  return { status, recs, okCos, purCos };
}

// existing rows [{id,data}] + new records -> rows to write and ids to delete.
// Records of a company that could not be read this time are left as they were; so are its purchase totals when
// its purchases were not read (an older sync program, or Tally refused that part).
export function tallyDiff(existing, recs, okCos, purCos = new Set()) {
  const have = new Map(existing.map((r) => [r.id, r.data]));
  const write = []; const del = [];
  for (const [id, d] of recs) { const o = have.get(id); if (!o || stable(o) !== stable(d)) write.push({ id, data: d }); }
  for (const [id, d] of have) {
    if (id === "status" || recs.has(id)) continue;
    if (d && okCos.has(d.co) && (d.t !== "p" || purCos.has(d.co))) del.push(id);
  }
  return { write, del };
}
