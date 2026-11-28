// Zoom PO Desk API: login, shared data sync and user logins.
import { getDatabase } from "@netlify/database";
import { scryptSync, randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";
import nodemailer from "nodemailer";
import Anthropic from "@anthropic-ai/sdk";
import { gstCall, gstStatus } from "../gst/gsp.mjs";
import { allotPartyCodes } from "../codes.mjs";
import { tallyRecords, tallyDiff } from "../tally.mjs";
import { gsRecords, gsDiff, gsScript, GS_MAX } from "../gsheet.mjs";
import { ALERTS, eligible, wants, alertsFor, linkCode, maskToken, tokenOk, tg, userHas, telegramOn } from "../telegram.mjs";
import { tgService } from "../tgsend.mjs";
import { pushService } from "../pushsend.mjs";
import { subOk, deviceName, pushPayload } from "../push.mjs";
import { guessService, smtpCandidates, savesSent, sealer, cleanSend, fromLine, smtpWhy, EMAIL_RE, SERVICE_LIST } from "../mail.mjs";
import { promises as dns } from "node:dns";

const COLLS = new Set(["reqs", "saved", "grns", "pays", "rgps", "slips", "deletedPOs", "suppliers", "rates", "bins", "masters", "costing", "items", "customers", "deals", "fups", "sorders", "dchallans", "invoices", "jobs", "dnotes", "cnotes", "obills", "bank", "jwins", "tallymap"]);
const SESSION_DAYS = 30;
let db;
const pool = () => (db = db || getDatabase(process.env.ZPO_DB_URL ? { connectionString: process.env.ZPO_DB_URL } : {})).pool;
const q = async (text, params = []) => (await pool().query(text, params)).rows;
// every write to records also goes into record_history, so the data can be put back to any earlier date and time
const HIST = (sql) => `WITH w AS (${sql} RETURNING coll,id,data,deleted,rev,created_rev,updated_by), h AS (INSERT INTO record_history(coll,id,data,deleted,rev,changed_by) SELECT coll,id,data,deleted,rev,updated_by FROM w) SELECT coll,id,rev,created_rev FROM w`;
const CODE_PRE = { sup: "S", cust: "C" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const hashPass = (p) => { const salt = randomBytes(16); return "s1$" + salt.toString("hex") + "$" + scryptSync(p, salt, 32).toString("hex"); };
const checkPass = (p, h) => { const [, s, k] = String(h).split("$"); if (!s || !k) return false; const a = scryptSync(p, Buffer.from(s, "hex"), 32), b = Buffer.from(k, "hex"); return a.length === b.length && timingSafeEqual(a, b); };
const sha = (t) => createHash("sha256").update(t).digest("hex");
const normName = (n) => String(n || "").trim().replace(/\s+/g, " ");

async function mastersDoc() { const r = await q("SELECT data FROM records WHERE coll='masters' AND id='_' AND NOT deleted"); return r[0] ? r[0].data : null; }
// a purchase request may be deleted by its requester or their department head while no PO has been made from it (the admin may delete any time)
async function canDelReq(me, id) {
  const r = await q("SELECT data FROM records WHERE coll='reqs' AND id=$1 AND NOT deleted", [id]); const d = r[0] && r[0].data;
  if (!d) return true;
  const m = await mastersDoc(); const dept = ((m && m.depts) || []).find((x) => x && x.name === d.dept); const u = ((m && m.users) || []).find((x) => x && x.name === me);
  const head = d.checker === me || (dept && dept.hod === me) || (!(dept && dept.hod) && u && ["Department head", "Checker", "HOD"].includes(u.role) && u.dept === d.dept);
  if (d.by !== me && !head) return false;
  if (d.poNo) return false;
  const no = String(d.no ?? id);
  const p = await q("SELECT 1 FROM records WHERE coll='saved' AND NOT deleted AND COALESCE(data->>'status','')<>'Rejected' AND (data->>'reqNo'=$1 OR (jsonb_typeof(data->'reqNos')='array' AND data->'reqNos' @> jsonb_build_array($1::text))) LIMIT 1", [no]);
  return !p.length;
}
async function profile(name) { const m = await mastersDoc(); const u = m && (m.users || []).find((x) => x.name === name); return u || null; }
const ADMIN_RIGHT = "page.users";
async function isAdmin(name) { const u = await profile(name); if (u && (u.role === "Admin" || (Array.isArray(u.rights) && u.rights.includes(ADMIN_RIGHT)))) return true; return (await ownerName()) === name && !(await hasAdmin()); }
// The person who did first-time setup (the oldest login) is the owner. If the users list ever has no Admin left, the owner gets Admin back.
async function ownerName() { const r = await q("SELECT name FROM logins WHERE active ORDER BY created_at, name LIMIT 1"); return r[0] ? r[0].name : null; }
const anyAdmin = (m) => !!m && Array.isArray(m.users) && m.users.some((x) => x && (x.role === "Admin" || (Array.isArray(x.rights) && x.rights.includes(ADMIN_RIGHT))));
async function hasAdmin() { return anyAdmin(await mastersDoc()); }
function withAdmin(m, name) { const md = m && typeof m === "object" ? { ...m } : { users: [], depts: [], projects: [] }; const users = Array.isArray(md.users) ? md.users.filter(Boolean) : []; const i = users.findIndex((x) => x.name === name);
  if (i >= 0) users[i] = { ...users[i], role: "Admin" }; else users.unshift({ name, dept: "", role: "Admin" }); md.users = users; return md; }
async function repairAdmin(me) { const cur = await mastersDoc(); if (anyAdmin(cur) || (await ownerName()) !== me) return;
  await q(HIST("INSERT INTO records(coll,id,data,rev,created_rev,updated_by) VALUES('masters','_',$1,nextval('rev_seq'),currval('rev_seq'),$2) ON CONFLICT (coll,id) DO UPDATE SET data=EXCLUDED.data,deleted=FALSE,rev=EXCLUDED.rev,updated_at=NOW(),updated_by=EXCLUDED.updated_by"), [JSON.stringify(withAdmin(cur, me)), me]); }

const MOULD_ROLES = ["Sales", "Approver", "Purchaser", "Admin"];
function canMould(u) { const r = Array.isArray(u.rights) ? u.rights : null; if (r && r.includes("v2")) return ["sales.view", "sales.create", "sales.edit"].some((k) => r.includes(k)); return MOULD_ROLES.includes(u.role) || (!!r && r.includes("page.sales")); }
// e-invoice / e-way bill API: people who may create or edit tax invoices or credit notes
const GST_KEYS = ["inv.create", "inv.edit", "cn.create", "cn.edit"];
function canGst(u) { const r = Array.isArray(u.rights) ? u.rights : null; if (r && r.includes("v2")) return GST_KEYS.some((k) => r.includes(k)); return ["Sales", "Accounts", "Admin"].includes(u.role) || (!!r && r.includes("sales.edit")); }
const PROJ_ROLES = ["Sales", "Admin"];
function canProjects(u) { const r = Array.isArray(u.rights) ? u.rights : null; if (r && r.includes("v2")) return ["proj.create", "proj.edit", "proj.delete", "mast.edit"].some((k) => r.includes(k)); return PROJ_ROLES.includes(u.role) || (!!r && (r.includes("page.mast") || r.includes("sales.edit"))); }

async function auth(req) {
  const h = req.headers.get("authorization") || ""; const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!t) return null;
  const r = await q("SELECT s.name FROM sessions s JOIN logins l ON l.name=s.name WHERE s.token_hash=$1 AND s.expires_at>NOW() AND l.active", [sha(t)]);
  return r[0] ? r[0].name : null;
}
async function newSession(name) { const t = randomBytes(32).toString("base64url"); await q("INSERT INTO sessions(token_hash,name,expires_at) VALUES($1,$2,NOW()+($3||' days')::interval)", [sha(t), name, String(SESSION_DAYS)]); return t; }

// Document reader: fills a GRN from a supplier invoice, or a sales order from a customer PO. Needs the Netlify env var ANTHROPIC_API_KEY.
const S = { type: "string" }, N = { type: "number" };
const obj = (props) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });
const SCAN = {
  grn: {
    schema: obj({ supplier_name: S, supplier_gstin: S, invoice_no: S, invoice_date: S, challan_no: S, challan_date: S, po_no: S, vehicle_no: S, transporter: S, eway_bill_no: S, grand_total: N,
      lines: { type: "array", items: obj({ description: S, hsn: S, qty: N, unit: S, rate: N, po_line: { type: "integer" } }) } }),
    prompt: (b, list) => `This is a supplier's tax invoice or delivery challan for material we (the buyer) are receiving against our purchase order ${b.ref} from ${b.party}.
Read it and fill every field you can find. Use an empty string for text you cannot find and 0 for numbers you cannot find; never guess.
- Dates as YYYY-MM-DD (Indian documents are day/month/year).
- supplier_gstin is the seller's GSTIN, not ours (ours: ${b.own}).
- challan_no is the seller's delivery challan / DC number if printed; po_no is our PO number as printed on the invoice.
- vehicle_no is the vehicle registration (e.g. MH14AB1234); transporter is the transport name or mode.
- lines: one per item row with the quantity shipped (not the amount), unit as printed, and rate per unit before tax.
- po_line: the number of the matching line from our PO below, or -1 if none matches. Match on what the item is, even if worded differently. Use each PO line at most once.
Our PO lines (number: description | ordered qty unit):
${list}` },
  so: {
    schema: obj({ customer_name: S, customer_gstin: S, po_no: S, po_date: S, delivery_date: S, gst_percent: N, payment_terms: S, contact_person: S, grand_total: N,
      lines: { type: "array", items: obj({ description: S, hsn: S, qty: N, unit: S, rate: N }) } }),
    prompt: (b) => `This is a purchase order that a customer sent to us (${b.us}, the supplier). We will make a sales order from it.
Read it and fill every field you can find. Use an empty string for text you cannot find and 0 for numbers you cannot find; never guess.
- customer_name / customer_gstin are the BUYER who issued the PO, not us (our GSTINs: ${b.own}).
- Dates as YYYY-MM-DD (Indian documents are day/month/year). delivery_date is the required delivery / schedule date if one is given.
- gst_percent is the total GST rate on the items (CGST+SGST, or IGST), e.g. 18.
- lines: one per item row with the full item description (include drawing / part numbers and sizes printed with it), HSN/SAC, ordered quantity, unit, and rate per unit before tax.` },  jw: {
    schema: obj({ customer_name: S, customer_gstin: S, challan_no: S, challan_date: S, po_no: S, vehicle_no: S,
      lines: { type: "array", items: obj({ description: S, qty: N, unit: S, process: S }) } }),
    prompt: (b) => `This is a delivery challan that a customer sent to us (${b.us}) with their own material for job work. We will record it as job work inward.
Read it and fill every field you can find. Use an empty string for text you cannot find and 0 for numbers you cannot find; never guess.
- customer_name / customer_gstin are the SENDER of the material (the customer), not us (our GSTINs: ${b.own}).
- challan_no / challan_date are the customer's own challan number and date. Dates as YYYY-MM-DD (Indian documents are day/month/year).
- po_no is the customer's purchase order or work order number if printed. vehicle_no is the vehicle registration if printed.
- lines: one per item row with the full description (include part / drawing numbers and sizes), quantity, unit, and process: the job work asked for on that line (wire cut, EDM, grinding, hardening...) if written, else an empty string.` },
};
// Old-data import: any printed report (party list, item list, outstanding, bank statement) read as a table with the columns the app asks for.
function tableKind(b) {
  const cols = (Array.isArray(b.cols) ? b.cols : []).slice(0, 12).map((c) => String(c ?? "").replace(/[^\w %./()&-]/g, "").slice(0, 40)).filter(Boolean);
  if (!cols.length) return null;
  const row = {}; cols.forEach((_, i) => { row["c" + i] = S; });
  return {
    schema: obj({ rows: { type: "array", items: obj(row) } }),
    prompt: () => `This is a report printed from an old accounting / ERP system. Read the table in it and return every data row (all pages), with these columns:
${cols.map((c, i) => `c${i} = ${c}`).join("\n")}
Rules: copy values exactly as printed (numbers without currency symbols, dates as printed). Use an empty string when a column is not in the report. Skip headings, page headers, subtotals and grand totals. Never invent rows.`,
  };
}
async function scanDoc(b) {
  if (!process.env.ANTHROPIC_API_KEY) return { status: 501, body: { error: "Document reading is not set up yet (ANTHROPIC_API_KEY missing on Netlify)", noKey: true } };
  const K = b.kind === "table" ? tableKind(b) : SCAN[b.kind]; if (!K) return { status: 400, body: { error: "Bad request" } };
  const media = String(b.media || ""), data = b.data, isPdf = media === "application/pdf";
  if (!isPdf && !/^image\/(jpeg|png|webp|gif)$/.test(media)) return { status: 400, body: { error: "Use a PDF or a photo (JPG/PNG)" } };
  if (typeof data !== "string" || !data || data.length > 5_500_000) return { status: 400, body: { error: "File is too large. Use a PDF under 4 MB or a photo." } };
  const clip = (v, n) => String(v ?? "").slice(0, n);
  const list = (Array.isArray(b.poLines) ? b.poLines : []).slice(0, 200).map((l, i) => `${i}: ${clip(l.desc, 200)} | ${clip(l.qty, 20)} ${clip(l.unit, 20)}`).join("\n") || "(none)";
  const ctx = { ref: clip(b.ref, 40), party: clip(b.party, 120), us: clip(b.us, 120), own: (Array.isArray(b.ownGstins) ? b.ownGstins : []).map((g) => clip(g, 15)).join(", ") || "unknown" };
  const client = new Anthropic();
  const res = await client.beta.messages.create({
    model: "claude-opus-5-5", max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: K.schema } },
    messages: [{ role: "user", content: [
      isPdf ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } } : { type: "image", source: { type: "base64", media_type: media, data } },
      { type: "text", text: K.prompt(ctx, list) }] }],
  });
  const t = res.stop_reason !== "refusal" && res.content.find((x) => x.type === "text");
  try { return { status: 200, body: { ok: true, via: "ai", fields: JSON.parse(t ? t.text : "") } }; }
  catch { return { status: 422, body: { error: "Could not read this document. Fill the form by hand." } }; }
}

async function body(req) { try { return await req.json(); } catch { return {}; } }

// ---------- Restore to an earlier date (Admin and Director) ----------
const COLL_WORDS = { reqs: "purchase requests", saved: "POs", grns: "GRNs", pays: "payments", rgps: "returnable challans", slips: "issue slips", deletedPOs: "deleted-PO log", suppliers: "suppliers", rates: "rates", bins: "stock bins", masters: "masters and settings", costing: "rates and costing", items: "items", customers: "customers", deals: "RFQs and quotations", fups: "follow-ups", sorders: "sales orders", dchallans: "delivery challans", invoices: "sales invoices", jobs: "jobs", dnotes: "debit notes", cnotes: "credit notes", obills: "opening bills", bank: "bank statement lines", jwins: "job work inward" , tallymap: "Tally ledger links"};
async function canRestore(me) { if (await isAdmin(me)) return true; const u = await profile(me); return !!u && ["Director", "Approver"].includes(u.role); }
const topRev = async (c = { query: (t, p) => pool().query(t, p) }) => Number((await c.query("SELECT COALESCE(MAX(rev),0)::bigint AS r FROM records")).rows[0].r);
async function startRev() { const r = await q("SELECT rev FROM restore_points WHERE kind='start' ORDER BY pid LIMIT 1"); return r[0] ? Number(r[0].rev) : 0; }
// a big save (an import, a bulk delete, a backup restore) gets a restore point just before it, at most one per person every 3 minutes
async function autoPoint(me, list) {
  const dels = list.filter((c) => c.deleted).length; if (list.length < 20 && dels < 3) return;
  const recent = await q("SELECT 1 FROM restore_points WHERE kind='auto' AND by_name=$1 AND at>NOW()-interval '3 minutes' LIMIT 1", [me]); if (recent[0]) return;
  const cnt = {}; list.forEach((c) => { const w = COLL_WORDS[c.coll]; if (w) cnt[w] = (cnt[w] || 0) + 1; });
  const what = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => n + " " + w).join(", ");
  await q("INSERT INTO restore_points(rev,kind,label,by_name) VALUES($1,'auto',$2,$3)", [await topRev(), `Before ${me} ${dels >= list.length / 2 ? "deleted" : "saved"} ${what}${list.length >= 500 ? " (and more)" : ""}`.slice(0, 300), me]);
}
// state as of rev R compared with today: one row per record that would change
const DIFF = `WITH past AS (SELECT DISTINCT ON (coll,id) coll,id,data,deleted FROM record_history WHERE rev<=$1 AND coll=ANY($2) ORDER BY coll,id,rev DESC)
  SELECT r.coll, r.id, p.data AS pdata, COALESCE(p.deleted, TRUE) AS pdel, r.deleted AS cdel
  FROM records r LEFT JOIN past p ON p.coll=r.coll AND p.id=r.id
  WHERE r.coll=ANY($2) AND ((p.coll IS NULL AND NOT r.deleted) OR (p.coll IS NOT NULL AND (p.deleted<>r.deleted OR (NOT p.deleted AND p.data IS DISTINCT FROM r.data))))`;
function diffCounts(rows) { const by = {}; rows.forEach((x) => { const o = by[x.coll] || (by[x.coll] = { coll: x.coll, words: COLL_WORDS[x.coll] || x.coll, back: 0, removed: 0, changed: 0 }); if (x.cdel && !x.pdel) o.back++; else if (x.pdel && !x.cdel) o.removed++; else o.changed++; }); return Object.values(by).sort((a, b) => (b.back + b.removed + b.changed) - (a.back + a.removed + a.changed)); }
async function resolveRev(b) {
  if (b.point != null) { const r = await q("SELECT rev,at,label FROM restore_points WHERE pid=$1", [Number(b.point) || 0]); if (!r[0]) throw Object.assign(new Error("That restore point is not there any more"), { status: 404 }); return { rev: Number(r[0].rev), at: r[0].at, label: r[0].label }; }
  const t = new Date(String(b.at || "")); if (isNaN(t)) throw Object.assign(new Error("Pick a date and time"), { status: 400 });
  if (t > new Date()) throw Object.assign(new Error("That time is in the future"), { status: 400 });
  const r = await q("SELECT COALESCE(MAX(rev),0)::bigint AS r FROM record_history WHERE changed_at<=$1", [t.toISOString()]); return { rev: Number(r[0].r), at: t.toISOString(), label: "" };
}
async function restoreApi(me, m, url, req) {
  if (!(await canRestore(me))) return json({ error: "Only Admin and Director can restore data to an earlier date" }, 403);
  if (m === "GET") {
    const points = await q("SELECT pid,at,rev,kind,label,by_name FROM restore_points ORDER BY at DESC LIMIT 300");
    // end of each day (India time), last 120 days
    const days = await q(`SELECT to_char(changed_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS day, MAX(rev)::bigint AS rev, MAX(changed_at) AS last, COUNT(*)::int AS n
      FROM record_history WHERE changed_at>NOW()-interval '120 days' AND rev>=$1 GROUP BY 1 ORDER BY 1 DESC`, [await startRev()]);
    const st = await q("SELECT at,rev FROM restore_points WHERE kind='start' ORDER BY pid LIMIT 1");
    return json({ points: points.map((p) => ({ ...p, rev: Number(p.rev), pid: Number(p.pid) })), days: days.map((d) => ({ ...d, rev: Number(d.rev) })), start: st[0] ? st[0].at : null, colls: COLL_WORDS });
  }
  const b = await body(req); const action = String(b.action || "");
  if (action === "point") {
    const label = String(b.label || "").trim().slice(0, 200) || "Restore point made by hand";
    const r = await q("INSERT INTO restore_points(rev,kind,label,by_name) VALUES($1,'manual',$2,$3) RETURNING pid,at", [await topRev(), label, me]);
    return json({ ok: true, pid: Number(r[0].pid), at: r[0].at });
  }
  if (action !== "preview" && action !== "run") return json({ error: "Unknown action" }, 400);
  const target = await resolveRev(b); const sr = await startRev();
  if (target.rev < sr) return json({ error: "Restore history starts on " + new Date((await q("SELECT at FROM restore_points WHERE kind='start' ORDER BY pid LIMIT 1"))[0].at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + ". Pick a later time." }, 400);
  const colls = (Array.isArray(b.colls) && b.colls.length ? b.colls.map(String) : Object.keys(COLL_WORDS)).filter((c) => COLL_WORDS[c]);
  if (!colls.length) return json({ error: "Pick at least one area to restore" }, 400);
  if (action === "preview") {
    const rows = await q(DIFF.replace("SELECT r.coll, r.id, p.data AS pdata,", "SELECT r.coll, r.id,"), [target.rev, colls]);
    return json({ rev: target.rev, at: target.at, changes: diffCounts(rows), total: rows.length });
  }
  // run: one transaction under a lock. First a restore point of today's data (so this restore can be undone), then put back the old versions.
  const c = await pool().connect();
  try {
    await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(hashtext('restore'))");
    const when = new Date(target.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const undo = (await c.query("INSERT INTO restore_points(rev,kind,label,by_name) VALUES($1,'before-restore',$2,$3) RETURNING pid", [await topRev(c), `Before ${me} restored data to ${when}`.slice(0, 300), me])).rows[0];
    const rows = (await c.query(DIFF, [target.rev, colls])).rows;
    const plain = rows.filter((x) => x.coll !== "masters"); const ms = rows.find((x) => x.coll === "masters");
    if (plain.length) await c.query(`WITH d AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(coll text,id text,pdata jsonb,pdel boolean)),
      u AS (UPDATE records r SET data=CASE WHEN d.pdel THEN NULL ELSE d.pdata END, deleted=d.pdel, rev=nextval('rev_seq'), updated_at=NOW(), updated_by=$2 FROM d WHERE r.coll=d.coll AND r.id=d.id RETURNING r.coll,r.id,r.data,r.deleted,r.rev,r.updated_by)
      INSERT INTO record_history(coll,id,data,deleted,rev,changed_by) SELECT coll,id,data,deleted,rev,updated_by FROM u`, [JSON.stringify(plain.map((x) => ({ coll: x.coll, id: x.id, pdata: x.pdata, pdel: x.pdel }))), me + " (restore)"]);
    if (ms && !ms.pdel && ms.id === "_") {
      // masters and settings go back, but users, rights and logins stay as they are today, so nobody is locked out
      const cur = (await c.query("SELECT data FROM records WHERE coll='masters' AND id='_'")).rows[0]; const now = cur && cur.data ? cur.data : {};
      let md = { ...(ms.pdata || {}), users: Array.isArray(now.users) ? now.users : (ms.pdata || {}).users || [] }; if (!anyAdmin(md)) md = withAdmin(md, me);
      await c.query(HIST("UPDATE records SET data=$1, deleted=FALSE, rev=nextval('rev_seq'), updated_at=NOW(), updated_by=$2 WHERE coll='masters' AND id='_'"), [JSON.stringify(md), me + " (restore)"]);
    }
    await c.query("COMMIT");
    return json({ ok: true, undo: Number(undo.pid), changes: diffCounts(rows), total: rows.length });
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}


// ---------- Tally sync (read-only copy of Tally, sent by the sync program on the accounts PC) ----------
async function syncKey(req, kind = "tally") {
  const k = String(req.headers.get("x-sync-key") || "").trim(); if (!k || k.length > 200) return null;
  const r = await q("UPDATE sync_keys SET last_used_at=NOW(), last_pc=$2 WHERE key_hash=$1 AND NOT revoked AND kind=$3 RETURNING id,label", [sha(k), String(req.headers.get("x-sync-pc") || "").slice(0, 80), kind]);
  return r[0] || null;
}
async function tallyPush(b, label) {
  const { status, recs, okCos, purCos } = tallyRecords(b, label);
  const c = await pool().connect();
  try {
    await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(hashtext('tally'))");
    const ex = (await c.query("SELECT id,data FROM records WHERE coll='tally' AND NOT deleted")).rows;
    const { write, del } = tallyDiff(ex, recs, okCos, purCos);
    const by = "Tally sync" + (status.pc ? " (" + status.pc + ")" : "");
    for (let i = 0; i < write.length; i += 2000) {
      await c.query(HIST(`INSERT INTO records(coll,id,data,deleted,rev,created_rev,updated_by)
        SELECT 'tally',x.id,x.data,FALSE,nextval('rev_seq'),currval('rev_seq'),$2 FROM jsonb_to_recordset($1::jsonb) AS x(id text,data jsonb)
        ON CONFLICT (coll,id) DO UPDATE SET data=EXCLUDED.data,deleted=FALSE,rev=EXCLUDED.rev,updated_at=NOW(),updated_by=EXCLUDED.updated_by`), [JSON.stringify(write.slice(i, i + 2000)), by]);
    }
    for (let i = 0; i < del.length; i += 2000) {
      await c.query(HIST("UPDATE records SET data=NULL,deleted=TRUE,rev=nextval('rev_seq'),updated_at=NOW(),updated_by=$2 WHERE coll='tally' AND id=ANY($1::text[])"), [del.slice(i, i + 2000), by]);
    }
    status.changed = write.length; status.removed = del.length;
    await c.query(HIST(`INSERT INTO records(coll,id,data,deleted,rev,created_rev,updated_by) VALUES('tally','status',$1,FALSE,nextval('rev_seq'),currval('rev_seq'),$2)
      ON CONFLICT (coll,id) DO UPDATE SET data=EXCLUDED.data,deleted=FALSE,rev=EXCLUDED.rev,updated_at=NOW(),updated_by=EXCLUDED.updated_by`), [JSON.stringify(status), by]);
    await c.query("COMMIT");
    return { ok: true, changed: write.length, removed: del.length, at: status.at };
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}
async function tallyKeyApi(me, m, req) {
  if (!(await isAdmin(me))) return json({ error: "Only the Admin can make or stop Tally sync keys" }, 403);
  const list = async () => (await q("SELECT id,label,created_by,created_at,last_used_at,last_pc,revoked FROM sync_keys WHERE kind='tally' ORDER BY id DESC LIMIT 50")).map((r) => ({ ...r, id: Number(r.id) }));
  if (m === "GET") return json({ keys: await list() });
  const b = await body(req); const action = String(b.action || "");
  if (action === "new") {
    const n = await q("SELECT COUNT(*)::int AS n FROM sync_keys WHERE NOT revoked AND kind='tally'"); if (n[0].n >= 5) return json({ error: "There are already 5 working keys. Stop one you do not use first." }, 400);
    const label = String(b.label || "").trim().slice(0, 80) || "Accounts PC";
    const secret = randomBytes(24).toString("base64url");
    await q("INSERT INTO sync_keys(key_hash,label,created_by) VALUES($1,$2,$3)", [sha(secret), label, me]);
    return json({ ok: true, secret, keys: await list() });
  }
  if (action === "revoke") { await q("UPDATE sync_keys SET revoked=TRUE WHERE id=$1 AND kind='tally'", [Number(b.id) || 0]); return json({ ok: true, keys: await list() }); }
  return json({ error: "Unknown action" }, 400);
}

// ---------- Google Sheet link (read-only copy of a Google Sheet, sent by an Apps Script inside the sheet with a link key) ----------
async function gsheetPush(b, label) {
  const { recs, status } = gsRecords(b, label);
  if (!status.tabs.length) return json({ error: "No tabs were sent" }, 400);
  const c = await pool().connect();
  try {
    await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(hashtext('gsheet'))");
    const ex = (await c.query("SELECT id,data FROM records WHERE coll='gsheet' AND NOT deleted")).rows;
    const prev = (ex.find((r) => r.id === "status") || {}).data;
    const d = gsDiff(ex.filter((r) => r.id !== "status"), recs, prev);
    const by = "Google Sheet link";
    if (d.write.length) await c.query(HIST(`INSERT INTO records(coll,id,data,deleted,rev,created_rev,updated_by)
      SELECT 'gsheet',x.id,x.data,FALSE,nextval('rev_seq'),currval('rev_seq'),$2 FROM jsonb_to_recordset($1::jsonb) AS x(id text,data jsonb)
      ON CONFLICT (coll,id) DO UPDATE SET data=EXCLUDED.data,deleted=FALSE,rev=EXCLUDED.rev,updated_at=NOW(),updated_by=EXCLUDED.updated_by`), [JSON.stringify(d.write), by]);
    if (d.del.length) await c.query(HIST("UPDATE records SET data=NULL,deleted=TRUE,rev=nextval('rev_seq'),updated_at=NOW(),updated_by=$2 WHERE coll='gsheet' AND id=ANY($1::text[])"), [d.del, by]);
    if (d.status) { status.changedAt = d.write.length || d.del.length || !prev ? status.at : prev.changedAt || status.at;
      await c.query(HIST(`INSERT INTO records(coll,id,data,deleted,rev,created_rev,updated_by) VALUES('gsheet','status',$1,FALSE,nextval('rev_seq'),currval('rev_seq'),$2)
      ON CONFLICT (coll,id) DO UPDATE SET data=EXCLUDED.data,deleted=FALSE,rev=EXCLUDED.rev,updated_at=NOW(),updated_by=EXCLUDED.updated_by`), [JSON.stringify(status), by]); }
    await c.query("COMMIT");
    return json({ ok: true, changed: d.write.length, removed: d.del.length });
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}
async function gsheetKeyApi(me, m, req, url) {
  if (!(await isAdmin(me))) return json({ error: "Only the Admin can link a Google Sheet" }, 403);
  const list = async () => (await q("SELECT id,label,created_by,created_at,last_used_at,revoked FROM sync_keys WHERE kind='gsheet' ORDER BY id DESC LIMIT 20")).map((r) => ({ ...r, id: Number(r.id) }));
  if (m === "GET") return json({ keys: await list() });
  const b = await body(req); const action = String(b.action || "");
  if (action === "new") {
    const n = await q("SELECT COUNT(*)::int AS n FROM sync_keys WHERE NOT revoked AND kind='gsheet'"); if (n[0].n >= 3) return json({ error: "There are already 3 working sheet keys. Stop one you do not use first." }, 400);
    const label = String(b.label || "").trim().slice(0, 80) || "Sales order sheet";
    const secret = randomBytes(24).toString("base64url");
    await q("INSERT INTO sync_keys(key_hash,label,created_by,kind) VALUES($1,$2,$3,'gsheet')", [sha(secret), label, me]);
    const site = (process.env.URL || url.origin).replace(/\/$/, "");
    return json({ ok: true, secret, script: gsScript(site, secret), keys: await list() });
  }
  if (action === "revoke") { await q("UPDATE sync_keys SET revoked=TRUE WHERE id=$1 AND kind='gsheet'", [Number(b.id) || 0]); return json({ ok: true, keys: await list() }); }
  return json({ error: "Unknown action" }, 400);
}

// ---------- Telegram alerts (free bot made by the Admin with @BotFather) ----------
const TG = () => tgService(q);
const ALERT_INFO = ALERTS.map(({ k, label, group }) => ({ k, label, group }));
async function tgReply(tok, chat, text) { try { await tg(tok, "sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }); } catch (e) { console.error("tg reply", e && e.message); } }
// updates from Telegram (webhook): people tapping Start with their link code, and the bot being added to or removed from groups
async function tgHook(req) {
  const T = TG(); const secret = await T.get("hook_secret"); const tok = await T.token();
  if (!secret || !tok || req.headers.get("x-telegram-bot-api-secret-token") !== secret) return json({ ok: false }, 401);
  const u = await body(req);
  const mc = u.my_chat_member;
  if (mc && mc.chat && mc.chat.type !== "private") {
    const st = mc.new_chat_member && mc.new_chat_member.status, id = String(mc.chat.id), title = String(mc.chat.title || "Group").slice(0, 120);
    if (st === "member" || st === "administrator") {
      await q("INSERT INTO tg_groups(chat_id,title,active) VALUES($1,$2,TRUE) ON CONFLICT (chat_id) DO UPDATE SET title=EXCLUDED.title,active=TRUE", [id, title]);
      await tgReply(tok, id, "👋 ZT-ERP alerts bot added to <b>" + title.replace(/[<>&]/g, "") + "</b>.\nThe ERP Admin now picks which alerts this group gets: ZT-ERP > Users &amp; rights > Telegram alerts.");
    } else if (st === "left" || st === "kicked") await q("UPDATE tg_groups SET active=FALSE WHERE chat_id=$1", [id]);
    return json({ ok: true });
  }
  const msg = u.message; if (!msg || !msg.chat) return json({ ok: true });
  const chat = String(msg.chat.id);
  if (msg.migrate_to_chat_id) { await q("UPDATE tg_groups SET chat_id=$2 WHERE chat_id=$1", [chat, String(msg.migrate_to_chat_id)]).catch(() => {}); return json({ ok: true }); }
  const text = String(msg.text || "").trim(); const cmd = text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();
  if (msg.chat.type !== "private") { if (cmd === "/id") await tgReply(tok, chat, "This group's chat ID: <code>" + chat + "</code>"); return json({ ok: true }); }
  if (cmd === "/start") {
    const code = text.split(/\s+/)[1] || "";
    if (!code) { const l = (await q("SELECT name FROM tg_links WHERE chat_id=$1", [chat]))[0];
      await tgReply(tok, chat, l ? `You are linked to ZT-ERP as <b>${l.name.replace(/[<>&]/g, "")}</b>. Send /stop to unlink.` : "To get ZT-ERP alerts here, open ZT-ERP, tap <b>Telegram</b> at the top, then <b>Link my Telegram</b>. It opens this chat with your own code."); return json({ ok: true }); }
    const r = (await q("DELETE FROM tg_codes WHERE code_hash=$1 RETURNING name, expires_at>NOW() AS live", [sha(code.toUpperCase())]))[0];
    if (!r || !r.live) { await tgReply(tok, chat, "This link has expired or was already used. In ZT-ERP tap <b>Telegram</b> > <b>Link my Telegram</b> again."); return json({ ok: true }); }
    const who = [msg.from && msg.from.first_name, msg.from && msg.from.last_name].filter(Boolean).join(" ") + (msg.from && msg.from.username ? " (@" + msg.from.username + ")" : "");
    await q("DELETE FROM tg_links WHERE chat_id=$1 AND name<>$2", [chat, r.name]);
    await q("INSERT INTO tg_links(name,chat_id,tg_name) VALUES($1,$2,$3) ON CONFLICT (name) DO UPDATE SET chat_id=EXCLUDED.chat_id,tg_name=EXCLUDED.tg_name,linked_at=NOW()", [r.name, chat, who.slice(0, 120)]);
    await tgReply(tok, chat, `✅ Linked to ZT-ERP as <b>${r.name.replace(/[<>&]/g, "")}</b>.\nYou will get alerts here for the work that needs you. Pick which ones in ZT-ERP > Telegram. Send /stop to unlink.`);
    return json({ ok: true });
  }
  if (cmd === "/stop") { const d = await q("DELETE FROM tg_links WHERE chat_id=$1 RETURNING name", [chat]); await tgReply(tok, chat, d[0] ? "Unlinked. You will not get ZT-ERP alerts here any more." : "This chat is not linked to ZT-ERP."); return json({ ok: true }); }
  if (cmd === "/id") { await tgReply(tok, chat, "Your chat ID: <code>" + chat + "</code>"); return json({ ok: true }); }
  await tgReply(tok, chat, "This bot only sends ZT-ERP alerts. Open ZT-ERP to approve or reply.");
  return json({ ok: true });
}
async function telegramApi(me, m, req, url) {
  const T = TG(); const admin = await isAdmin(me); const ms = await mastersDoc(); const u = ((ms && ms.users) || []).find((x) => x && x.name === me) || { name: me, role: admin ? "Admin" : "" };
  const envTok = !!process.env.TELEGRAM_BOT_TOKEN;
  const state = async () => {
    const tok = await T.token(); const bot = await T.get("bot"); const l = (await q("SELECT tg_name,prefs,linked_at FROM tg_links WHERE name=$1", [me]))[0];
    const el = eligible(u);
    const out = { configured: !!tok && !!bot, bot, admin, link: l ? { tg_name: l.tg_name, at: l.linked_at } : null,
      alerts: ALERT_INFO.filter((a) => el.includes(a.k)).map((a) => ({ ...a, on: wants(u, l && l.prefs, a.k) })), allAlerts: ALERT_INFO };
    if (admin) {
      out.masked = envTok ? "Set on Netlify (TELEGRAM_BOT_TOKEN)" : maskToken(await T.get("token")); out.envToken = envTok; out.site = await T.get("site");
      out.links = (await q("SELECT name,tg_name,linked_at FROM tg_links ORDER BY name")).map((r) => ({ name: r.name, tg_name: r.tg_name, at: r.linked_at }));
      out.groups = (await q("SELECT chat_id,title,alerts,active,added_at FROM tg_groups ORDER BY active DESC, added_at DESC LIMIT 50"));
      out.log = await q("SELECT at,kind,ok,info FROM tg_log ORDER BY id DESC LIMIT 15");
      const d = (await q("SELECT at,by_name,jsonb_array_length(COALESCE(data->'bills','[]'::jsonb))::int AS n FROM tg_dues WHERE id='_'"))[0]; out.dues = d || null;
    }
    return out;
  };
  if (m === "GET") return json(telegramOn() ? await state() : { configured: false, off: true });
  const b = await body(req); const action = String(b.action || "");
  // while Telegram is off, only the open-bills upload and the payments digest (for phone pop-ups) are served here
  if (!telegramOn() && action !== "dues" && action !== "daily-now") return json({ error: "Telegram alerts are not switched on" }, 404);
  const needAdmin = () => json({ error: "Only the Admin can change the Telegram bot and groups" }, 403);
  if (action === "token") {
    if (!admin) return needAdmin();
    const t = String(b.token || "").trim(); if (!tokenOk(t)) return json({ error: "That does not look like a bot token. It looks like 1234567890:AAH... (numbers, a colon, then about 35 letters). Copy it again from @BotFather." }, 400);
    let bot; try { bot = await tg(t, "getMe"); } catch (e) { return json({ error: "Telegram did not accept this token: " + e.message + ". Copy it again from @BotFather." }, 400); }
    const site = (process.env.URL || url.origin).replace(/\/$/, ""); const secret = randomBytes(24).toString("hex");
    if (!/^https:\/\//.test(site)) return json({ error: "Telegram needs the ERP on an https address. Open the ERP from its Netlify address and try again." }, 400);
    try { await tg(t, "setWebhook", { url: site + "/api/telegram/hook", secret_token: secret, allowed_updates: ["message", "my_chat_member"], drop_pending_updates: true }); }
    catch (e) { return json({ error: "Telegram could not connect to the ERP: " + e.message }, 502); }
    await T.set("token", t, me); await T.set("bot", bot.username, me); await T.set("hook_secret", secret, me); await T.set("site", site, me);
    return json({ ok: true, ...(await state()) });
  }
  if (action === "remove") {
    if (!admin) return needAdmin();
    const t = await T.get("token"); if (t) await tg(t, "deleteWebhook", {}).catch(() => {});
    for (const k of ["token", "bot", "hook_secret"]) await T.set(k, null);
    return json({ ok: true, ...(await state()) });
  }
  if (action === "link") {
    const bot = await T.get("bot"); if (!bot || !(await T.token())) return json({ error: "Telegram alerts are not set up yet. Ask the Admin to add the bot token in Users & rights > Telegram alerts." }, 400);
    const code = linkCode((n) => randomInt(0, n));
    await q("DELETE FROM tg_codes WHERE name=$1 OR expires_at<NOW()", [me]);
    await q("INSERT INTO tg_codes(code_hash,name,expires_at) VALUES($1,$2,NOW()+interval '30 minutes')", [sha(code), me]);
    return json({ ok: true, url: `https://t.me/${bot}?start=${code}`, code, bot });
  }
  if (action === "unlink") { await q("DELETE FROM tg_links WHERE name=$1", [me]); return json({ ok: true, ...(await state()) }); }
  if (action === "prefs") {
    const p = {}; const el = eligible(u); Object.entries(b.prefs || {}).forEach(([k, v]) => { if (el.includes(k)) p[k] = !!v; });
    await q("UPDATE tg_links SET prefs=$2 WHERE name=$1", [me, JSON.stringify(p)]); return json({ ok: true, ...(await state()) });
  }
  if (action === "test") {
    const tok = await T.token(); const l = (await q("SELECT chat_id FROM tg_links WHERE name=$1", [me]))[0];
    if (!tok || !l) return json({ error: "Link your Telegram first" }, 400);
    const ok = await T.send(tok, l.chat_id, `🔔 Test from ZT-ERP for <b>${me.replace(/[<>&]/g, "")}</b>. Alerts are working.`, "test", await T.get("site"));
    return ok ? json({ ok: true }) : json({ error: "Telegram did not deliver it. Open the bot and tap Start, then link again." }, 502);
  }
  if (action === "group" || action === "group-test" || action === "group-remove") {
    if (!admin) return needAdmin();
    const id = String(b.chat_id || ""); const g = (await q("SELECT chat_id,title FROM tg_groups WHERE chat_id=$1", [id]))[0]; if (!g) return json({ error: "Group not found" }, 404);
    if (action === "group") { const al = (Array.isArray(b.alerts) ? b.alerts : []).map(String).filter((k) => ALERTS.some((a) => a.k === k && a.group)); await q("UPDATE tg_groups SET alerts=$2 WHERE chat_id=$1", [id, JSON.stringify(al)]); }
    if (action === "group-remove") { await q("DELETE FROM tg_groups WHERE chat_id=$1", [id]); const tok = await T.token(); if (tok) await tg(tok, "leaveChat", { chat_id: id }).catch(() => {}); }
    if (action === "group-test") { const tok = await T.token(); const ok = tok && (await T.send(tok, id, "🔔 Test from ZT-ERP. Alerts for this group are working.", "test", await T.get("site"))); if (!ok) return json({ error: "Telegram did not deliver it. Check that the bot is still in the group." }, 502); }
    return json({ ok: true, ...(await state()) });
  }
  if (action === "daily-now") { if (!admin) return needAdmin(); return json({ ok: true, ...(await T.daily(ms, true, [PUSH().dispatch])) }); }
  if (action === "dues") {
    if (!(admin || userHas(u, "acct.view"))) return json({ ok: true, skipped: true });
    const S = (v, n) => String(v ?? "").slice(0, n);
    const bills = (Array.isArray(b.bills) ? b.bills : []).slice(0, 5000).map((x) => ({ sup: S(x.sup, 120), ref: S(x.ref, 60), due: S(x.due, 10), bal: Math.round((+x.bal || 0) * 100) / 100, plant: S(x.plant, 40) })).filter((x) => x.bal > 0);
    await q("INSERT INTO tg_dues(id,data,at,by_name) VALUES('_',$1,NOW(),$2) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data,at=NOW(),by_name=EXCLUDED.by_name", [JSON.stringify({ bills }), me]);
    return json({ ok: true, n: bills.length });
  }
  return json({ error: "Unknown action" }, 400);
}

// ---------- Phone pop-up notifications (free Web Push from the installed app; same alerts as Telegram) ----------
const PUSH = () => pushService(q);
// ---------- email from each person's own mailbox (Users & rights email). One-time setup: their app password ----------
let mailSeal = null;
async function mailSealer() {
  if (mailSeal) return mailSeal;
  let sec = process.env.MAIL_SECRET || "";
  if (!sec) {
    const r = await q("SELECT v FROM mail_settings WHERE k='key'");
    if (r[0]) sec = r[0].v; else { const k = randomBytes(32).toString("hex"); await q("INSERT INTO mail_settings(k,v) VALUES('key',$1) ON CONFLICT (k) DO NOTHING", [k]); sec = (await q("SELECT v FROM mail_settings WHERE k='key'"))[0].v; }
  }
  return (mailSeal = sealer(sec));
}
const mxOf = async (email) => { const d = String(email).split("@")[1]; if (!d) return []; try { return (await Promise.race([dns.resolveMx(d), new Promise((_, j) => setTimeout(() => j(new Error("timeout")), 3000))])).map((x) => x.exchange); } catch { return []; } };
const smtpOf = (a, pass) => nodemailer.createTransport({ host: a.host, port: a.port, secure: a.secure, requireTLS: !a.secure, auth: { user: a.login, pass }, connectionTimeout: 9000, greetingTimeout: 9000, socketTimeout: 20000 });
async function mailApi(me, m, req) {
  const u = (await profile(me)) || {}; const myEmail = String(u.email || "").trim();
  const row = async () => (await q("SELECT email,service,host,port,secure,login,pass_enc,verified_at,last_sent_at FROM mail_accounts WHERE name=$1", [me]))[0] || null;
  const state = async () => { const a = await row(); const ok = !!a && !!myEmail && a.email.toLowerCase() === myEmail.toLowerCase();
    return { email: myEmail, ready: ok, account: a ? { email: a.email, service: a.service, host: a.host, port: a.port, at: a.verified_at, lastSent: a.last_sent_at, savesSent: savesSent(a.host) } : null,
      changed: !!a && !ok && !!myEmail, guess: myEmail ? guessService(myEmail, await mxOf(myEmail)) : "", services: SERVICE_LIST }; };
  if (m === "GET") return json(await state());
  const b = await body(req); const action = String(b.action || "");
  if (action === "remove") { await q("DELETE FROM mail_accounts WHERE name=$1", [me]); return json(await state()); }
  if (action === "save") {
    if (!EMAIL_RE.test(myEmail)) return json({ error: "Your email is not in Users & rights yet. Ask the Admin to add it, then set up again." }, 400);
    const pass = String(b.pass || "").replace(/\s+/g, b.keepSpaces ? " " : ""); if (pass.length < 4) return json({ error: "Paste your app password" }, 400);
    const service = String(b.service ?? (guessService(myEmail, await mxOf(myEmail)))).slice(0, 20);
    const custom = b.host ? { host: String(b.host).slice(0, 120), port: +b.port || 465 } : {};
    if (custom.host && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(custom.host)) return json({ error: "The SMTP server should look like mail.yourcompany.com" }, 400);
    if (custom.port && ![25, 465, 587, 2525].includes(custom.port)) return json({ error: "The port is usually 465 or 587" }, 400);
    const login = String(b.login || myEmail).trim().slice(0, 200);
    let last = null;
    for (const c of smtpCandidates(myEmail, service, custom)) {
      const a = { ...c, login };
      try { await smtpOf(a, pass).verify(); const enc = (await mailSealer()).seal(pass);
        await q("INSERT INTO mail_accounts(name,email,service,host,port,secure,login,pass_enc,verified_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW()) ON CONFLICT (name) DO UPDATE SET email=EXCLUDED.email,service=EXCLUDED.service,host=EXCLUDED.host,port=EXCLUDED.port,secure=EXCLUDED.secure,login=EXCLUDED.login,pass_enc=EXCLUDED.pass_enc,verified_at=NOW(),updated_at=NOW()", [me, myEmail, service, a.host, a.port, a.secure, login, enc]);
        if (b.test !== false) { try { await smtpOf(a, pass).sendMail({ from: fromLine(me, myEmail), to: myEmail, subject: "ZT-ERP LITE: your email is set up", text: `Hello ${me},\n\nDocuments you send from ZT-ERP LITE (POs, invoices, challans, quotations) will now go from ${myEmail}.\n\nZT-ERP LITE` }); } catch (e) { console.error("mail test", e && e.message); } }
        return json({ ok: true, ...(await state()) });
      } catch (e) { last = e; if (/535|534|auth|credentials|password/i.test(String(e && (e.response || e.message)))) break; }
    }
    return json({ error: smtpWhy(last, service) }, 400);
  }
  if (action === "send") {
    const a = await row();
    if (!a) return json({ error: "Set up your email first (✉ My email at the top)", setup: true }, 400);
    if (!myEmail || a.email.toLowerCase() !== myEmail.toLowerCase()) return json({ error: `Your email in Users & rights is now ${myEmail || "empty"}. Set up your email again.`, setup: true }, 400);
    const c = cleanSend(b); if (c.error) return json({ error: c.error }, 400);
    let pass; try { pass = (await mailSealer()).open(a.pass_enc); } catch { return json({ error: "Your saved email password can no longer be read. Set up your email again.", setup: true }, 400); }
    const bcc = c.copyMe && !savesSent(a.host) ? [myEmail] : [];
    const log = (ok, err) => q("INSERT INTO mail_log(name,from_email,to_list,cc_list,subject,doc_type,doc_no,party,ok,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [me, myEmail, c.to.join(", "), c.cc.join(", "), c.subject, c.doc.type, c.doc.no, c.doc.party, ok, err || null]).catch(() => {});
    try {
      const info = await smtpOf(a, pass).sendMail({ from: fromLine(me, myEmail), replyTo: myEmail, to: c.to, cc: c.cc.length ? c.cc : undefined, bcc: bcc.length ? bcc : undefined, subject: c.subject, text: c.text,
        attachments: c.files.map((f) => ({ filename: f.filename, content: Buffer.from(f.b64, "base64"), contentType: "application/pdf" })) });
      await q("UPDATE mail_accounts SET last_sent_at=NOW() WHERE name=$1", [me]); await log(true);
      return json({ ok: true, from: myEmail, to: c.to, cc: c.cc, id: info && info.messageId });
    } catch (e) { const why = smtpWhy(e, a.service); console.error("mail send", e && e.message); await log(false, why); return json({ error: why }, 502); }
  }
  if (action === "log") {
    const t = String(b.type || "").slice(0, 20), n = String(b.no || "").slice(0, 60);
    return json({ sent: await q("SELECT name,from_email,to_list,cc_list,ok,at FROM mail_log WHERE doc_type=$1 AND doc_no=$2 ORDER BY at DESC LIMIT 20", [t, n]) });
  }
  return json({ error: "Unknown action" }, 400);
}

async function pushApi(me, m, req, url) {
  const P = PUSH(); const admin = await isAdmin(me); const ms = await mastersDoc(); const u = ((ms && ms.users) || []).find((x) => x && x.name === me) || { name: me, role: admin ? "Admin" : "" };
  const state = async () => {
    const K = await P.keys(); const p = (await q("SELECT prefs FROM push_prefs WHERE name=$1", [me]))[0]; const el = eligible(u);
    const devices = (await q("SELECT endpoint,device,created_at,last_ok_at FROM push_subs WHERE name=$1 ORDER BY created_at", [me])).map((r) => ({ id: sha(r.endpoint).slice(0, 16), device: r.device, at: r.created_at, ok: r.last_ok_at }));
    const out = { publicKey: K.publicKey, devices, alerts: ALERT_INFO.filter((a) => el.includes(a.k)).map((a) => ({ ...a, on: wants(u, p && p.prefs, a.k) })),
      any: (await q("SELECT COUNT(*)::int AS n FROM push_subs"))[0].n > 0 };
    if (admin) out.people = await q("SELECT name,COUNT(*)::int AS n,MAX(created_at) AS at FROM push_subs GROUP BY name ORDER BY name");
    return out;
  };
  if (m === "GET") return json(await state());
  const b = await body(req); const action = String(b.action || "");
  if (action === "subscribe") {
    if (!subOk(b.sub)) return json({ error: "This browser gave a notification address the ERP does not accept. Use Chrome, Safari, Edge or Firefox." }, 400);
    const site = (process.env.URL || url.origin).replace(/\/$/, ""); if (/^https:\/\//.test(site)) await P.set("site", site);
    const dev = deviceName(req.headers.get("user-agent")).slice(0, 60);
    await q("INSERT INTO push_subs(endpoint,name,keys,device) VALUES($1,$2,$3,$4) ON CONFLICT (endpoint) DO UPDATE SET name=EXCLUDED.name,keys=EXCLUDED.keys,device=EXCLUDED.device,fails=0",
      [b.sub.endpoint, me, JSON.stringify({ p256dh: b.sub.keys.p256dh, auth: b.sub.keys.auth }), dev]);
    await q("DELETE FROM push_subs WHERE name=$1 AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE name=$1 ORDER BY created_at DESC LIMIT 8)", [me]);
    return json({ ok: true, ...(await state()) });
  }
  if (action === "unsubscribe") {
    if (b.endpoint) await q("DELETE FROM push_subs WHERE name=$1 AND endpoint=$2", [me, String(b.endpoint)]);
    else if (b.id) { const rows = await q("SELECT endpoint FROM push_subs WHERE name=$1", [me]); for (const r of rows) if (sha(r.endpoint).slice(0, 16) === String(b.id)) await q("DELETE FROM push_subs WHERE endpoint=$1", [r.endpoint]); }
    return json({ ok: true, ...(await state()) });
  }
  if (action === "prefs") {
    const p = {}; const el = eligible(u); Object.entries(b.prefs || {}).forEach(([k, v]) => { if (el.includes(k)) p[k] = !!v; });
    await q("INSERT INTO push_prefs(name,prefs) VALUES($1,$2) ON CONFLICT (name) DO UPDATE SET prefs=EXCLUDED.prefs", [me, JSON.stringify(p)]); return json({ ok: true, ...(await state()) });
  }
  if (action === "test") {
    const rows = await q("SELECT endpoint,keys FROM push_subs WHERE name=$1" + (b.endpoint ? " AND endpoint=$2" : ""), b.endpoint ? [me, String(b.endpoint)] : [me]);
    if (!rows.length) return json({ error: "Turn on notifications on this phone first" }, 400);
    const K = await P.keys(), subj = await P.subject();
    const pl = pushPayload("test", `🔔 <b>Test from ZT-ERP</b>\nPop-up alerts are working for ${me}.`, { tag: "test" });
    const ok = (await Promise.all(rows.map((r) => P.send(r, pl, K, subj)))).filter(Boolean).length;
    return ok ? json({ ok: true, sent: ok }) : json({ error: "The phone's notification service did not accept it. Turn notifications off and on again on this phone." }, 502);
  }
  return json({ error: "Unknown action" }, 400);
}

export default async (req, context) => {
  const url = new URL(req.url); const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, ""); const m = req.method;
  try {
    if (path === "status" && m === "GET") { const r = await q("SELECT COUNT(*)::int AS n FROM logins"); return json({ ok: true, needsSetup: r[0].n === 0 }); }

    if (path === "setup" && m === "POST") {
      const { name, password, masters } = await body(req); const n = normName(name);
      if (!n || String(password || "").length < 6) return json({ error: "Enter a name and a password of at least 6 characters" }, 400);
      const c = await q("SELECT COUNT(*)::int AS n FROM logins"); if (c[0].n > 0) return json({ error: "Setup is already done. Log in instead." }, 409);
      await q("INSERT INTO logins(name,pass_hash) VALUES($1,$2)", [n, hashPass(password)]);
      const md = masters && typeof masters === "object" ? masters : { users: [], depts: [], projects: [] };
      md.users = (md.users || []).filter((u) => u.name !== n); md.users.unshift({ name: n, dept: "", role: "Admin" });
      await q(HIST("INSERT INTO records(coll,id,data,rev,created_rev,updated_by) VALUES('masters','_',$1,nextval('rev_seq'),currval('rev_seq'),$2) ON CONFLICT (coll,id) DO UPDATE SET data=EXCLUDED.data,deleted=FALSE,rev=EXCLUDED.rev,updated_at=NOW(),updated_by=EXCLUDED.updated_by"), [JSON.stringify(md), n]);
      return json({ token: await newSession(n), name: n });
    }

    // forgot password: email a 6-digit code (Gmail app password in ZPO_SMTP_USER / ZPO_SMTP_PASS)
    if (path === "forgot" && m === "POST") {
      const generic = { ok: true, message: "If this name has an email on file, a code has been sent. Check your inbox (and spam)." };
      const { name } = await body(req); const n = normName(name); if (!n) return json({ error: "Enter your name" }, 400);
      if (!process.env.ZPO_SMTP_USER || !process.env.ZPO_SMTP_PASS) return json({ error: "Email is not set up yet. Ask the Admin to reset your password." }, 503);
      const lg = await q("SELECT name FROM logins WHERE lower(name)=lower($1) AND active", [n]); if (!lg[0]) return json(generic);
      const u = await profile(lg[0].name); const to = u && String(u.email || "").trim();
      if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json(generic);
      const last = await q("SELECT 1 FROM reset_codes WHERE name=$1 AND sent_at>NOW()-interval '60 seconds'", [lg[0].name]);
      if (last[0]) return json({ error: "A code was just sent. Wait a minute before asking again." }, 429);
      const code = String(randomInt(0, 1000000)).padStart(6, "0");
      await q("INSERT INTO reset_codes(name,code_hash,expires_at,tries,sent_at) VALUES($1,$2,NOW()+interval '10 minutes',0,NOW()) ON CONFLICT (name) DO UPDATE SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,tries=0,sent_at=NOW()", [lg[0].name, sha(code)]);
      try {
        const tr = nodemailer.createTransport({ host: process.env.ZPO_SMTP_HOST || "smtp.gmail.com", port: +(process.env.ZPO_SMTP_PORT || 465), secure: +(process.env.ZPO_SMTP_PORT || 465) === 465, ignoreTLS: !!process.env.ZPO_SMTP_PLAIN, auth: { user: process.env.ZPO_SMTP_USER, pass: process.env.ZPO_SMTP_PASS } });
        await tr.sendMail({ from: `"ZT-ERP LITE" <${process.env.ZPO_SMTP_USER}>`, to, subject: `ZT-ERP LITE password code: ${code}`,
          text: `Hello ${lg[0].name},\n\nYour code to reset your ZT-ERP LITE password is ${code}.\nIt works for 10 minutes. If you did not ask for this, ignore this email.\n\nZoom Technologies` });
      } catch (e) { console.error("mail", e && e.message); return json({ error: "Could not send the email. Ask the Admin to reset your password." }, 502); }
      return json(generic);
    }

    if (path === "reset" && m === "POST") {
      const { name, code, password } = await body(req); const n = normName(name);
      if (String(password || "").length < 6) return json({ error: "Password must be at least 6 characters" }, 400);
      const r = await q("SELECT r.name,r.code_hash,r.tries,r.expires_at>NOW() AS live FROM reset_codes r WHERE lower(r.name)=lower($1)", [n]);
      const row = r[0]; const bad = () => json({ error: "That code is wrong or has expired. Ask for a new code." }, 400);
      if (!row || !row.live || row.tries >= 5) return bad();
      if (sha(String(code || "").trim()) !== row.code_hash) { await q("UPDATE reset_codes SET tries=tries+1 WHERE name=$1", [row.name]); await new Promise((s) => setTimeout(s, 600)); return bad(); }
      await q("UPDATE logins SET pass_hash=$2 WHERE name=$1", [row.name, hashPass(password)]);
      await q("DELETE FROM sessions WHERE name=$1", [row.name]); await q("DELETE FROM reset_codes WHERE name=$1", [row.name]);
      return json({ ok: true });
    }

    if (path === "login" && m === "POST") {
      const { name, password } = await body(req); const n = normName(name);
      const r = await q("SELECT name,pass_hash,active FROM logins WHERE lower(name)=lower($1)", [n]);
      if (!r[0] || !r[0].active || !checkPass(String(password || ""), r[0].pass_hash)) { await new Promise((s) => setTimeout(s, 600)); return json({ error: "Wrong name or password" }, 401); }
      return json({ token: await newSession(r[0].name), name: r[0].name });
    }

    // Tally sync program (accounts PC): signs in with its own sync key, not a user login. It can only write the read-only Tally copy.
    if ((path === "tally/push" || path === "tally/ping") && m === "POST") {
      const k = await syncKey(req);
      if (!k) { await new Promise((s) => setTimeout(s, 600)); return json({ error: "This sync key is not valid (wrong, or stopped by the Admin). Make a new key in ZT-ERP LITE > Tally sync > Setup." }, 401); }
      if (path === "tally/ping") return json({ ok: true, label: k.label });
      const b = await body(req); if (!b || !Array.isArray(b.companies)) return json({ error: "Bad request" }, 400);
      return json(await tallyPush(b, k.label));
    }

    if (path === "gsheet/push" && m === "POST") {
      if (Number(req.headers.get("content-length") || 0) > GS_MAX.bytes) return json({ error: "The sheet is too big to send (over 5 MB). Hide tabs the ERP does not need." }, 413);
      const k = await syncKey(req, "gsheet");
      if (!k) { await new Promise((s) => setTimeout(s, 600)); return json({ error: "This sheet key is not valid (wrong, or stopped by the Admin). Make a new one in ZT-ERP LITE > Import old data > Google Sheet link." }, 401); }
      const b = await body(req); if (!b || !Array.isArray(b.tabs)) return json({ error: "Bad request" }, 400);
      return await gsheetPush(b, k.label);
    }

    // Telegram calls this with its own secret header (set when the Admin saved the bot token)
    if (path === "telegram/hook" && m === "POST" && telegramOn()) { try { return await tgHook(req); } catch (e) { console.error("tg hook", e && e.message); return json({ ok: true }); } }

    const me = await auth(req);
    if (!me) return json({ error: "Please log in" }, 401);

    if (path === "logout" && m === "POST") { const t = (req.headers.get("authorization") || "").slice(7); await q("DELETE FROM sessions WHERE token_hash=$1", [sha(t)]); return json({ ok: true }); }

    if (path === "sync" && m === "GET") {
      await repairAdmin(me);
      const since = Math.max(0, parseInt(url.searchParams.get("since") || "0", 10) || 0);
      const rows = await q("SELECT coll,id,data,deleted,rev,created_rev FROM records WHERE rev>$1 ORDER BY rev", [since]);
      const top = await q("SELECT COALESCE(MAX(rev),0)::bigint AS r FROM records");
      const logins = await q("SELECT name,active FROM logins");
      return json({ me, rev: Number(top[0].r), records: rows.map((r) => ({ ...r, rev: Number(r.rev), created_rev: Number(r.created_rev) })), logins });
    }

    if (path === "sync" && m === "POST") {
      const { changes } = await body(req); if (!Array.isArray(changes)) return json({ error: "Bad request" }, 400);
      const admin = await isAdmin(me); const results = [];
      const list = changes.slice(0, 500);
      await autoPoint(me, list).catch((e) => console.error("restore point", e && e.message));
      // fast path: plain saves (not new-numbered docs, not masters) go in one statement, so a 1,000-row import takes one round trip
      // a purchase request may be deleted by the admin, or by its requester or department head before any PO is made from it
      const reqDelOK = new Set();
      if (!admin) for (const c of list) if (c && c.coll === "reqs" && c.deleted && c.id && (await canDelReq(me, String(c.id)))) reqDelOK.add(String(c.id));
      const reqDelBlocked = (c) => !admin && c.coll === "reqs" && c.deleted && !reqDelOK.has(String(c.id));
      const plain = list.filter((c) => COLLS.has(String(c.coll || "")) && c.id && String(c.id).length <= 200 && !c.isNew && c.coll !== "masters" && !reqDelBlocked(c));
      // Telegram alerts: note the status of requests and POs before this save, to see what changed
      const watch = list.filter((c) => c && (c.coll === "reqs" || c.coll === "saved") && c.id && !c.deleted && c.data && typeof c.data === "object");
      const before = new Map();
      if (watch.length && watch.length <= 100) (await q("SELECT coll,id,data FROM records WHERE coll IN ('reqs','saved') AND id=ANY($1) AND NOT deleted", [watch.map((c) => String(c.id))])).forEach((x) => before.set(x.coll + "\u0001" + x.id, x.data));
      const done = new Map();
      if (plain.length) {
        const seen = new Set(); const rows = [];
        for (const c of plain) { const k = c.coll + "\u0001" + c.id; if (seen.has(k)) continue; seen.add(k); rows.push({ coll: String(c.coll), id: String(c.id), data: c.deleted ? null : (c.data ?? null), deleted: !!c.deleted }); }
        const r = await q(HIST(`INSERT INTO records(coll,id,data,deleted,rev,created_rev,updated_by)
          SELECT x.coll,x.id,x.data,x.deleted,nextval('rev_seq'),currval('rev_seq'),$2 FROM jsonb_to_recordset($1::jsonb) AS x(coll text,id text,data jsonb,deleted boolean)
          ON CONFLICT (coll,id) DO UPDATE SET data=EXCLUDED.data,deleted=EXCLUDED.deleted,rev=EXCLUDED.rev,updated_at=NOW(),updated_by=EXCLUDED.updated_by`), [JSON.stringify(rows), me]);
        r.forEach((x) => done.set(x.coll + "\u0001" + x.id, { coll: x.coll, id: x.id, rev: Number(x.rev), created_rev: Number(x.created_rev) }));
      }
      for (const c of list) {
        const dk = String(c.coll || "") + "\u0001" + String(c.id || "");
        if (done.has(dk)) { results.push(done.get(dk)); continue; }
        const coll = String(c.coll || ""), id = String(c.id || "");
        if (!COLLS.has(coll) || !id || id.length > 200) { results.push({ coll, id, error: "bad" }); continue; }
        if (reqDelBlocked(c)) { results.push({ coll, id, error: "Only the requester or department head (before a PO is made) or the admin can delete a purchase request" }); continue; }
        if (coll === "masters" && !admin) {
          // Non-admins with project rights may change only the projects (Job Nos.) list; everything else is kept as stored.
          const u = await profile(me); const cur = await mastersDoc();
          if (!u || !cur || c.deleted || id !== "_" || !canProjects(u) || !Array.isArray(c.data?.projects)) { results.push({ coll, id, error: "Only the admin can change masters and users" }); continue; }
          c.data = { ...cur, projects: c.data.projects.slice(0, 5000) }; c.isNew = false;
        }
        // a users list with no Admin would lock everyone out of Users & rights: keep the person saving it as Admin
        if (coll === "masters" && admin && !c.deleted && c.data && typeof c.data === "object" && !anyAdmin(c.data)) c.data = withAdmin(c.data, me);
        if (c.isNew) {
          const ex = await q("SELECT rev FROM records WHERE coll=$1 AND id=$2 AND NOT deleted", [coll, id]);
          if (ex[0]) { results.push({ coll, id, conflict: true }); continue; }
        }
        const r = await q(HIST(`INSERT INTO records(coll,id,data,deleted,rev,created_rev,updated_by) VALUES($1,$2,$3,$4,nextval('rev_seq'),currval('rev_seq'),$5)
          ON CONFLICT (coll,id) DO UPDATE SET data=EXCLUDED.data,deleted=EXCLUDED.deleted,rev=EXCLUDED.rev,updated_at=NOW(),updated_by=EXCLUDED.updated_by`),
          [coll, id, c.deleted ? null : JSON.stringify(c.data ?? null), !!c.deleted, me]);
        results.push({ coll, id, rev: Number(r[0].rev), created_rev: Number(r[0].created_rev) });
      }
      if (watch.length && watch.length <= 100) {
        const saved = new Set(results.filter((x) => x && x.rev).map((x) => x.coll + "\u0001" + x.id));
        const send = (async () => { const md = await mastersDoc();
          const al = watch.filter((c) => saved.has(c.coll + "\u0001" + c.id)).flatMap((c) => alertsFor(c.coll, before.get(c.coll + "\u0001" + c.id) || null, c.data, md, me));
          if (al.length) await Promise.all([TG().dispatch(al, md).catch((e) => console.error("telegram", e && e.message)), PUSH().dispatch(al, md).catch((e) => console.error("push", e && e.message))]); })().catch((e) => console.error("telegram", e && e.message));
        if (context && typeof context.waitUntil === "function") context.waitUntil(send); else await send;
      }
      return json({ results });
    }

    // Supplier / customer codes: given from the party_codes register under a lock, so two people never get the same code and no number is given twice
    if (path === "codes" && m === "POST") {
      const b = await body(req); const kind = String(b.kind || ""), pre = CODE_PRE[kind];
      if (!pre || !Array.isArray(b.items) || b.items.length > 3000) return json({ error: "Bad request" }, 400);
      const items = b.items.map((x) => ({ k: String(x?.k || "").slice(0, 200), name: String(x?.name || ""), code: String(x?.code || ""), fresh: !!x?.fresh }));
      const c = await pool().connect();
      try {
        await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(hashtext('party_codes:' || $1))", [kind]);
        const rows = (await c.query("SELECT code,num,pkey FROM party_codes WHERE kind=$1", [kind])).rows;
        const reg = new Map(rows.map((r) => [r.code, { k: r.pkey || "", num: Number(r.num) }]));
        const { codes, add } = allotPartyCodes(reg, items, pre);
        if (add.length) await c.query("INSERT INTO party_codes(kind,code,num,pkey,name,by_name) SELECT $1,x.code,x.num,x.k,x.name,$3 FROM jsonb_to_recordset($2::jsonb) AS x(code text,num bigint,k text,name text) ON CONFLICT DO NOTHING", [kind, JSON.stringify(add), me]);
        await c.query("COMMIT"); return json({ codes });
      } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
    }

    // Mould Estimator (separate Netlify site): read-only list of estimates, selected fields only; the shared key never reaches the browser
    if (path === "mould/estimates" && m === "GET") {
      const u = await profile(me);
      if (!u || !((await isAdmin(me)) || canMould(u))) return json({ error: "You do not have rights to fetch mould estimates" }, 403);
      const key = process.env.MOULD_LINK_KEY || "";
      if (!key) return json({ error: "The Mould Estimator link is not set up yet. Add MOULD_LINK_KEY on Netlify (same value as ERP_LINK_KEY on the estimator site)." }, 503);
      const base = (process.env.MOULD_URL || "https://mould-estimator.netlify.app").replace(/\/$/, "");
      let r; try { r = await fetch(base + "/api/erp-feed", { headers: { "x-link-key": key }, signal: AbortSignal.timeout(15000) }); } catch { return json({ error: "Could not reach the Mould Estimator. Try again in a minute." }, 502); }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: "Mould Estimator: " + (j.error || "error " + r.status) }, 502);
      const S = (v) => String(v ?? "").slice(0, 200), N = (v) => (v === null || v === undefined || v === "" || !isFinite(+v) ? null : +v);
      const estimates = (Array.isArray(j.estimates) ? j.estimates : []).map((e) => ({ id: S(e.id), no: S(e.no), customer: S(e.customer), part: S(e.part), mouldNo: S(e.mouldNo), status: S(e.status), date: S(e.date), updatedAt: N(e.updatedAt) || 0, price: N(e.price), gstPct: N(e.gstPct) }));
      return json({ estimates, at: j.at || Date.now() });
    }

    if (path === "logins" && m === "POST") {
      if (!(await isAdmin(me))) return json({ error: "Only the admin can manage logins" }, 403);
      const { action, name, password, newName } = await body(req); const n = normName(name);
      if (!n) return json({ error: "Name missing" }, 400);
      if (action === "password") {
        if (String(password || "").length < 6) return json({ error: "Password must be at least 6 characters" }, 400);
        await q("INSERT INTO logins(name,pass_hash,active) VALUES($1,$2,TRUE) ON CONFLICT (name) DO UPDATE SET pass_hash=EXCLUDED.pass_hash,active=TRUE", [n, hashPass(password)]);
        await q("DELETE FROM sessions WHERE name=$1 AND name<>$2", [n, me]);
        return json({ ok: true });
      }
      if (action === "disable") { if (n === me) return json({ error: "You cannot disable your own login" }, 400); await q("UPDATE logins SET active=FALSE WHERE name=$1", [n]); await q("DELETE FROM sessions WHERE name=$1", [n]); return json({ ok: true }); }
      if (action === "rename") { const nn = normName(newName); if (!nn) return json({ error: "New name missing" }, 400); await q("UPDATE logins SET name=$2 WHERE name=$1", [n, nn]); await q("UPDATE sessions SET name=$2 WHERE name=$1", [n, nn]); await q("UPDATE tg_links SET name=$2 WHERE name=$1", [n, nn]).catch(() => {}); await q("UPDATE push_subs SET name=$2 WHERE name=$1", [n, nn]).catch(() => {}); await q("UPDATE push_prefs SET name=$2 WHERE name=$1", [n, nn]).catch(() => {}); await q("UPDATE mail_accounts SET name=$2 WHERE name=$1", [n, nn]).catch(() => {}); return json({ ok: true }); }
      return json({ error: "Unknown action" }, 400);
    }
    if (path === "scan-doc" && m === "POST") {
      try { const r = await scanDoc(await body(req)); return json(r.body, r.status); }
      catch (e) { console.error("scan-doc", e && e.status, e && e.message); return json({ error: e && e.status === 429 ? "Document reader is busy. Try again in a minute." : "Could not read the document right now. Fill the form by hand or try again." }, 502); }
    }

    // e-invoice (IRN, QR) and e-way bill through the GSP. Keys stay in Netlify env vars; the browser only sends invoice data.
    if (path === "gst/status" && m === "GET") { const st = gstStatus(); return json({ provider: st.provider, mode: st.mode, ready: st.ready, missing: st.missing }); }
    if (path === "gst" && m === "POST") {
      const u = await profile(me);
      if (!u || !((await isAdmin(me)) || canGst(u))) return json({ error: "You do not have rights to make e-invoices" }, 403);
      const b = await body(req); const action = String(b.action || ""); const mode = gstStatus().mode;
      const docNo = String(b.payload?.DocDtls?.No || b.no || b.docNo || "").slice(0, 40);
      const log = (ok, r) => q("INSERT INTO gst_log(by_name,action,mode,doc_no,irn,ewb_no,ok,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [me, action, mode, docNo, String(r.irn || b.irn || "").slice(0, 64), String(r.ewbNo || b.ewbNo || "").slice(0, 12), ok, JSON.stringify(r)]).catch((e) => console.error("gst_log", e && e.message));
      try { const r = await gstCall(action, b); await log(true, r); return json({ ok: true, mode, ...r }); }
      catch (e) {
        const st = e.status || (e.name === "TimeoutError" ? 504 : 502);
        if (st >= 500) console.error("gst", action, e && e.message);
        await log(false, { error: String(e.message || e), code: e.code || "" });
        return json({ error: e.status ? e.message : "GST portal: " + (e.name === "TimeoutError" ? "no answer in time. Try again in a minute." : e.message), code: e.code || "", noSetup: !!e.noSetup }, st);
      }
    }

    if (path === "tally/key" && (m === "GET" || m === "POST")) return await tallyKeyApi(me, m, req);
    if (path === "gsheet/key" && (m === "GET" || m === "POST")) return await gsheetKeyApi(me, m, req, url);
    if (path === "telegram" && (m === "GET" || m === "POST")) return await telegramApi(me, m, req, url);
    if (path === "push" && (m === "GET" || m === "POST")) return await pushApi(me, m, req, url);
    if (path === "mail" && (m === "GET" || m === "POST")) return await mailApi(me, m, req);

    if (path === "restore" && (m === "GET" || m === "POST")) {
      try { return await restoreApi(me, m, url, req); } catch (e) { if (e.status) return json({ error: e.message }, e.status); throw e; }
    }

    if (path === "password" && m === "POST") {
      const { current, password } = await body(req); const r = await q("SELECT pass_hash FROM logins WHERE name=$1", [me]);
      if (!r[0] || !checkPass(String(current || ""), r[0].pass_hash)) return json({ error: "Current password is wrong" }, 400);
      if (String(password || "").length < 6) return json({ error: "Password must be at least 6 characters" }, 400);
      await q("UPDATE logins SET pass_hash=$2 WHERE name=$1", [me, hashPass(password)]); return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "Server error. Try again." }, 500);
  }
};

export const config = { path: "/api/*" };
