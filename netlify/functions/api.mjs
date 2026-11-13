// Zoom PO Desk API: login, shared data sync and user logins.
import { getDatabase } from "@netlify/database";
import { scryptSync, randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";
import nodemailer from "nodemailer";
import Anthropic from "@anthropic-ai/sdk";

const COLLS = new Set(["reqs", "saved", "grns", "pays", "rgps", "slips", "deletedPOs", "suppliers", "rates", "bins", "masters", "items", "customers", "deals", "fups", "sorders", "dchallans", "invoices", "jobs", "dnotes", "cnotes", "obills", "bank", "jwins"]);
const SESSION_DAYS = 30;
let db;
const q = async (text, params = []) => {
  db = db || getDatabase(process.env.ZPO_DB_URL ? { connectionString: process.env.ZPO_DB_URL } : {});
  return (await db.pool.query(text, params)).rows;
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const hashPass = (p) => { const salt = randomBytes(16); return "s1$" + salt.toString("hex") + "$" + scryptSync(p, salt, 32).toString("hex"); };
const checkPass = (p, h) => { const [, s, k] = String(h).split("$"); if (!s || !k) return false; const a = scryptSync(p, Buffer.from(s, "hex"), 32), b = Buffer.from(k, "hex"); return a.length === b.length && timingSafeEqual(a, b); };
const sha = (t) => createHash("sha256").update(t).digest("hex");
const normName = (n) => String(n || "").trim().replace(/\s+/g, " ");

async function mastersDoc() { const r = await q("SELECT data FROM records WHERE coll='masters' AND id='_' AND NOT deleted"); return r[0] ? r[0].data : null; }
async function profile(name) { const m = await mastersDoc(); const u = m && (m.users || []).find((x) => x.name === name); return u || null; }
const ADMIN_RIGHT = "page.users";
async function isAdmin(name) { const u = await profile(name); if (!u) return false; return u.role === "Admin" || (Array.isArray(u.rights) && u.rights.includes(ADMIN_RIGHT)); }

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
- lines: one per item row with the full item description (include drawing / part numbers and sizes printed with it), HSN/SAC, ordered quantity, unit, and rate per unit before tax.` },
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

export default async (req) => {
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
      await q("INSERT INTO records(coll,id,data,rev,created_rev,updated_by) VALUES('masters','_',$1,nextval('rev_seq'),currval('rev_seq'),$2) ON CONFLICT (coll,id) DO UPDATE SET data=EXCLUDED.data,deleted=FALSE,rev=EXCLUDED.rev,updated_at=NOW(),updated_by=EXCLUDED.updated_by", [JSON.stringify(md), n]);
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

    const me = await auth(req);
    if (!me) return json({ error: "Please log in" }, 401);

    if (path === "logout" && m === "POST") { const t = (req.headers.get("authorization") || "").slice(7); await q("DELETE FROM sessions WHERE token_hash=$1", [sha(t)]); return json({ ok: true }); }

    if (path === "sync" && m === "GET") {
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
      // fast path: plain saves (not new-numbered docs, not masters) go in one statement, so a 1,000-row import takes one round trip
      const plain = list.filter((c) => COLLS.has(String(c.coll || "")) && c.id && String(c.id).length <= 200 && !c.isNew && c.coll !== "masters");
      const done = new Map();
      if (plain.length) {
        const seen = new Set(); const rows = [];
        for (const c of plain) { const k = c.coll + "\u0001" + c.id; if (seen.has(k)) continue; seen.add(k); rows.push({ coll: String(c.coll), id: String(c.id), data: c.deleted ? null : (c.data ?? null), deleted: !!c.deleted }); }
        const r = await q(`INSERT INTO records(coll,id,data,deleted,rev,created_rev,updated_by)
          SELECT x.coll,x.id,x.data,x.deleted,nextval('rev_seq'),currval('rev_seq'),$2 FROM jsonb_to_recordset($1::jsonb) AS x(coll text,id text,data jsonb,deleted boolean)
          ON CONFLICT (coll,id) DO UPDATE SET data=EXCLUDED.data,deleted=EXCLUDED.deleted,rev=EXCLUDED.rev,updated_at=NOW(),updated_by=EXCLUDED.updated_by RETURNING coll,id,rev,created_rev`, [JSON.stringify(rows), me]);
        r.forEach((x) => done.set(x.coll + "\u0001" + x.id, { coll: x.coll, id: x.id, rev: Number(x.rev), created_rev: Number(x.created_rev) }));
      }
      for (const c of list) {
        const dk = String(c.coll || "") + "\u0001" + String(c.id || "");
        if (done.has(dk)) { results.push(done.get(dk)); continue; }
        const coll = String(c.coll || ""), id = String(c.id || "");
        if (!COLLS.has(coll) || !id || id.length > 200) { results.push({ coll, id, error: "bad" }); continue; }
        if (coll === "masters" && !admin) {
          // Non-admins with project rights may change only the projects (Job Nos.) list; everything else is kept as stored.
          const u = await profile(me); const cur = await mastersDoc();
          if (!u || !cur || c.deleted || id !== "_" || !canProjects(u) || !Array.isArray(c.data?.projects)) { results.push({ coll, id, error: "Only the admin can change masters and users" }); continue; }
          c.data = { ...cur, projects: c.data.projects.slice(0, 5000) }; c.isNew = false;
        }
        if (c.isNew) {
          const ex = await q("SELECT rev FROM records WHERE coll=$1 AND id=$2 AND NOT deleted", [coll, id]);
          if (ex[0]) { results.push({ coll, id, conflict: true }); continue; }
        }
        const r = await q(`INSERT INTO records(coll,id,data,deleted,rev,created_rev,updated_by) VALUES($1,$2,$3,$4,nextval('rev_seq'),currval('rev_seq'),$5)
          ON CONFLICT (coll,id) DO UPDATE SET data=EXCLUDED.data,deleted=EXCLUDED.deleted,rev=EXCLUDED.rev,updated_at=NOW(),updated_by=EXCLUDED.updated_by RETURNING rev,created_rev`,
          [coll, id, c.deleted ? null : JSON.stringify(c.data ?? null), !!c.deleted, me]);
        results.push({ coll, id, rev: Number(r[0].rev), created_rev: Number(r[0].created_rev) });
      }
      return json({ results });
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
      if (action === "rename") { const nn = normName(newName); if (!nn) return json({ error: "New name missing" }, 400); await q("UPDATE logins SET name=$2 WHERE name=$1", [n, nn]); await q("UPDATE sessions SET name=$2 WHERE name=$1", [n, nn]); return json({ ok: true }); }
      return json({ error: "Unknown action" }, 400);
    }
    if (path === "scan-doc" && m === "POST") {
      try { const r = await scanDoc(await body(req)); return json(r.body, r.status); }
      catch (e) { console.error("scan-doc", e && e.status, e && e.message); return json({ error: e && e.status === 429 ? "Document reader is busy. Try again in a minute." : "Could not read the document right now. Fill the form by hand or try again." }, 502); }
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
