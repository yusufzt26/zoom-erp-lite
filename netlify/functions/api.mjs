// Zoom PO Desk API: login, shared data sync and user logins.
import { getDatabase } from "@netlify/database";
import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";

const COLLS = new Set(["reqs", "saved", "grns", "pays", "rgps", "slips", "deletedPOs", "suppliers", "rates", "bins", "masters", "items"]);
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

async function auth(req) {
  const h = req.headers.get("authorization") || ""; const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!t) return null;
  const r = await q("SELECT s.name FROM sessions s JOIN logins l ON l.name=s.name WHERE s.token_hash=$1 AND s.expires_at>NOW() AND l.active", [sha(t)]);
  return r[0] ? r[0].name : null;
}
async function newSession(name) { const t = randomBytes(32).toString("base64url"); await q("INSERT INTO sessions(token_hash,name,expires_at) VALUES($1,$2,NOW()+($3||' days')::interval)", [sha(t), name, String(SESSION_DAYS)]); return t; }

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
      for (const c of changes.slice(0, 500)) {
        const coll = String(c.coll || ""), id = String(c.id || "");
        if (!COLLS.has(coll) || !id || id.length > 200) { results.push({ coll, id, error: "bad" }); continue; }
        if (coll === "masters" && !admin) { results.push({ coll, id, error: "Only the admin can change masters and users" }); continue; }
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
