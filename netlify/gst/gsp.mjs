// E-invoice (IRN + signed QR) and e-way bill through a GST Suvidha Provider (GSP).
// Credentials live only in Netlify environment variables, never in code or in the browser:
//   GST_PROVIDER      "mock" (built-in test, no GSP) or "mastergst". Unset = feature off (manual JSON upload only).
//   GST_MODE          "sandbox" (default) or "production". Only production IRNs are valid for GST.
//   GST_GSTIN         Seller GSTIN the API user belongs to. In sandbox this is the GSP's test GSTIN.
//   GST_API_USER      API username created on einvoice1.gst.gov.in (API Registration > Create API User > through GSP).
//   GST_API_PASS      Its password.
//   GSP_EMAIL         Login email of the GSP account.
//   GSP_CLIENT_ID     GSP client id.
//   GSP_CLIENT_SECRET GSP client secret.
//   GSP_BASE_URL      Optional. GSP API base (default https://api.mastergst.com).
//   GSP_IP            Optional. Value for the ip_address header some GSPs ask for.
import { createHash, createHmac, randomInt } from "node:crypto";

const env = (k, d = "") => String(process.env[k] ?? d).trim();
export const gstMode = () => (env("GST_MODE", "sandbox").toLowerCase() === "production" ? "production" : "sandbox");
export const gstProvider = () => env("GST_PROVIDER").toLowerCase();

export function gstStatus() {
  const p = gstProvider(), mode = p === "mock" ? "mock" : gstMode();
  const need = p === "mastergst" ? ["GST_GSTIN", "GST_API_USER", "GST_API_PASS", "GSP_EMAIL", "GSP_CLIENT_ID", "GSP_CLIENT_SECRET"] : [];
  const missing = need.filter((k) => !env(k));
  return { provider: p || "", mode, ready: (p === "mock" || p === "mastergst") && !missing.length, missing, gstin: env("GST_GSTIN") };
}

// IST date-time "YYYY-MM-DD HH:mm:ss", the format the IRP uses for AckDt / EwbDt
export const istNow = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().replace("T", " ").slice(0, 19);
export const istParse = (s) => { const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?/.exec(String(s || "")) || /^(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d)(?::(\d\d))?/.exec(String(s || ""));
  if (!m) return NaN; const [y, mo, da] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]];
  return Date.UTC(+y, +mo - 1, +da, +m[4], +m[5], +(m[6] || 0)) - 5.5 * 3600e3; };
const within24h = (ackDt) => { const t = istParse(ackDt); return isFinite(t) && Date.now() - t < 24 * 3600e3; };

class GspError extends Error { constructor(msg, extra = {}) { super(msg); Object.assign(this, extra); } }
export { GspError };

/* ---------- built-in mock: same shapes as the IRP, numbers are fake ---------- */
const b64u = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const fyOf = (dt) => { const [d, m, y] = String(dt).split("/").map(Number); const s = m >= 4 ? y : y - 1; return `${s}-${String(s + 1).slice(2)}`; };
const mockIrn = (gstin, typ, no, dt) => createHash("sha256").update(`${gstin}${fyOf(dt)}${typ}${String(no).toUpperCase()}`).digest("hex");
function mockQR(p, irn, ackNo, ackDt) {
  const items = p.ItemList || [];
  const data = { SellerGstin: p.SellerDtls?.Gstin, BuyerGstin: p.BuyerDtls?.Gstin, DocNo: p.DocDtls?.No, DocTyp: p.DocDtls?.Typ, DocDt: p.DocDtls?.Dt, TotInvVal: p.ValDtls?.TotInvVal,
    ItemCnt: items.length, MainHsnCode: items[0]?.HsnCd || "", Irn: irn, IrnDt: ackDt };
  const h = b64u({ alg: "HS256", typ: "JWT", note: "TEST ONLY - not a valid e-invoice" }), b = b64u({ data: JSON.stringify(data), iss: "ZT-ERP MOCK IRP" });
  return `${h}.${b}.${createHmac("sha256", "zt-erp-mock").update(h + "." + b).digest("base64url")}`;
}
const mockStore = new Map(); // irn -> { ackNo, ackDt, cancelled, ewb }  (per warm function; the gst_log table is the lasting record)
const digits = (n) => Array.from({ length: n }, (_, i) => (i ? randomInt(0, 10) : randomInt(1, 10))).join("");
const mock = {
  async irn(p) {
    const irn = mockIrn(p.SellerDtls?.Gstin, p.DocDtls?.Typ, p.DocDtls?.No, p.DocDtls?.Dt), old = mockStore.get(irn);
    if (old && !old.cancelled) throw new GspError("Duplicate IRN", { code: "2150", dup: { Irn: irn, AckNo: old.ackNo, AckDt: old.ackDt } });
    const ackNo = digits(15), ackDt = istNow(); mockStore.set(irn, { ackNo, ackDt });
    const out = { Irn: irn, AckNo: ackNo, AckDt: ackDt, SignedQRCode: mockQR(p, irn, ackNo, ackDt), Status: "ACT" };
    if (p.EwbDtls && p.EwbDtls.Distance != null) Object.assign(out, mockEwb(+p.EwbDtls.Distance));
    return out;
  },
  async cancelIrn({ Irn }) { const r = mockStore.get(Irn); if (r) { if (r.cancelled) throw new GspError("IRN is already cancelled", { code: "9999" }); r.cancelled = true; } return { Irn, CancelDate: istNow() }; },
  async ewb(b) { return mockEwb(+b.Distance || 0); },
  async cancelEwb({ ewbNo }) { return { ewayBillNo: ewbNo, cancelDate: istNow() }; },
  async byDoc() { throw new GspError("Not found in the test store", { code: "2283" }); },
};
function mockEwb(km) { const now = Date.now(), days = Math.max(1, Math.ceil((km || 1) / 200));
  return { EwbNo: digits(12), EwbDt: istNow(new Date(now)), EwbValidTill: istNow(new Date(now + days * 86400e3)).slice(0, 10) + " 23:59:00" }; }

/* ---------- MasterGST (NIC schema pass-through). Paths follow MasterGST's e-invoice API; confirm in their sandbox. ---------- */
let tok = null; // { token, until }
function mgHeaders(extra = {}) {
  return { "content-type": "application/json", accept: "application/json", ip_address: env("GSP_IP", "127.0.0.1"), client_id: env("GSP_CLIENT_ID"), client_secret: env("GSP_CLIENT_SECRET"),
    username: env("GST_API_USER"), gstin: env("GST_GSTIN"), ...extra };
}
const mgBase = () => env("GSP_BASE_URL", "https://api.mastergst.com").replace(/\/$/, "");
const mgEmail = () => encodeURIComponent(env("GSP_EMAIL"));
function mgErr(j) {
  let list = []; try { list = JSON.parse(j.status_desc); } catch { list = [{ ErrorMessage: j.status_desc || j.message || "Unknown error" }]; }
  if (!Array.isArray(list)) list = [list];
  const first = list[0] || {}; const msg = list.map((e) => (e.ErrorCode ? e.ErrorCode + ": " : "") + (e.ErrorMessage || "")).join("; ") || "GSP error";
  let dup = null; const info = j.InfoDtls || j.data?.InfoDtls || j.info_dtls;
  if (Array.isArray(info)) { const d = info.find((x) => x.InfCd === "DUPIRN"); if (d) dup = d.Desc; }
  return new GspError(msg, { code: String(first.ErrorCode || ""), dup });
}
async function mgFetch(path, opts = {}, retry = true) {
  if (!tok || Date.now() > tok.until) await mgAuth();
  const r = await fetch(mgBase() + path, { method: opts.method || "POST", headers: mgHeaders({ "auth-token": tok.token, ...(opts.headers || {}) }), body: opts.body ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(25000) });
  const j = await r.json().catch(() => ({}));
  if (String(j.status_cd) === "1" || String(j.status_cd).toLowerCase() === "sucess" || String(j.status_cd).toLowerCase() === "success") return j.data || {};
  const e = mgErr(j); if (retry && /1005|token|auth/i.test(e.message)) { tok = null; return mgFetch(path, opts, false); } throw e;
}
async function mgAuth() {
  const r = await fetch(`${mgBase()}/einvoice/authenticate?email=${mgEmail()}`, { headers: mgHeaders({ password: env("GST_API_PASS") }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({})); const d = j.data || {};
  if (!d.AuthToken) throw new GspError("GSP login failed: " + (mgErr(j).message || r.status), { auth: true });
  const exp = istParse(d.TokenExpiry); tok = { token: d.AuthToken, until: isFinite(exp) ? exp - 10 * 60e3 : Date.now() + 5 * 3600e3 };
}
// E-way bill API (separate auth on the same GSP account)
let etok = null;
async function mgEwbFetch(path, body) {
  if (!etok || Date.now() > etok.until) {
    const r = await fetch(`${mgBase()}/ewaybillapi/v1.03/authenticate?email=${mgEmail()}&username=${encodeURIComponent(env("GST_API_USER"))}&password=${encodeURIComponent(env("GST_API_PASS"))}`, { headers: mgHeaders(), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({})); if (String(j.status_cd) !== "1") throw new GspError("E-way bill login failed: " + mgErr(j).message, { auth: true });
    etok = { until: Date.now() + 5 * 3600e3 };
  }
  const r = await fetch(`${mgBase()}${path}?email=${mgEmail()}`, { method: "POST", headers: mgHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  const j = await r.json().catch(() => ({})); if (String(j.status_cd) === "1") return j.data || {}; throw mgErr(j);
}
const mastergst = {
  irn: (p) => mgFetch(`/einvoice/type/GENERATE/version/V1_03?email=${mgEmail()}`, { body: p }),
  cancelIrn: (b) => mgFetch(`/einvoice/type/CANCEL/version/V1_03?email=${mgEmail()}`, { body: b }),
  ewb: (b) => mgFetch(`/einvoice/type/GENERATE_EWAYBILL/version/V1_03?email=${mgEmail()}`, { body: b }),
  cancelEwb: (b) => mgEwbFetch("/ewaybillapi/v1.03/ewayapi/canewb", b),
  byDoc: ({ typ, no, dt }) => mgFetch(`/einvoice/type/GETIRNBYDOCDETAILS/version/V1_03?param1=${encodeURIComponent(typ)}&email=${mgEmail()}`, { method: "GET", headers: { docnum: no, docdate: dt } }),
};

const PROVIDERS = { mock, mastergst };

/* ---------- checks shared by every provider ---------- */
const S = (v, n) => String(v ?? "").slice(0, n);
const okDocNo = (s) => /^[A-Z1-9][A-Z0-9/-]{0,15}$/.test(String(s || ""));
const okDate = (s) => /^\d\d\/\d\d\/\d{4}$/.test(String(s || ""));

// payload: the NIC e-invoice JSON v1.1 built by the app (einvJSON). Returns the normalised result.
export async function gstCall(action, b) {
  const st = gstStatus(); if (!st.ready) throw new GspError("E-invoice API is not set up yet" + (st.missing.length ? " (missing on Netlify: " + st.missing.join(", ") + ")" : ""), { status: 501, noSetup: true });
  const P = PROVIDERS[st.provider];
  if (action === "irn") {
    const p = b && b.payload; if (!p || typeof p !== "object" || !p.DocDtls || !p.SellerDtls || !p.BuyerDtls || !Array.isArray(p.ItemList) || !p.ItemList.length) throw new GspError("Bad e-invoice data", { status: 400 });
    if (!["INV", "CRN", "DBN"].includes(p.DocDtls.Typ) || !okDocNo(p.DocDtls.No) || !okDate(p.DocDtls.Dt)) throw new GspError("Document type, number or date is not allowed", { status: 400 });
    if (JSON.stringify(p).length > 400_000) throw new GspError("Invoice is too large", { status: 400 });
    const q = JSON.parse(JSON.stringify(p));
    if (st.provider !== "mock") {
      if (st.mode === "production" && String(q.SellerDtls.Gstin).toUpperCase() !== st.gstin.toUpperCase()) throw new GspError(`Seller GSTIN ${q.SellerDtls.Gstin} does not match the API user's GSTIN`, { status: 400 });
      if (st.mode === "sandbox") q.SellerDtls.Gstin = st.gstin; // sandbox only accepts the GSP's test GSTIN
    }
    try { return norm(await P.irn(q)); }
    catch (e) {
      if (e.dup && e.dup.Irn) return { ...norm(e.dup), duplicate: true }; // already registered earlier (e.g. the app closed before saving)
      throw e;
    }
  }
  if (action === "byDoc") { const typ = S(b.typ, 3), no = S(b.no, 16), dt = S(b.dt, 10); if (!okDocNo(no) || !okDate(dt)) throw new GspError("Bad document number or date", { status: 400 }); return norm(await P.byDoc({ typ, no, dt })); }
  if (action === "cancelIrn") {
    const irn = S(b.irn, 64); if (!/^[0-9a-f]{64}$/i.test(irn)) throw new GspError("Bad IRN", { status: 400 });
    if (b.ackDt && !within24h(b.ackDt)) throw new GspError("An IRN can be cancelled only within 24 hours. Raise a credit note instead.", { status: 400 });
    const rsn = String(+b.reason || 0); if (!["1", "2", "3", "4"].includes(rsn)) throw new GspError("Pick a reason", { status: 400 });
    const r = await P.cancelIrn({ Irn: irn, CnlRsn: rsn, CnlRem: S(b.remark || "Cancelled", 100) }); return { irn, cancelDate: r.CancelDate || istNow() };
  }
  if (action === "ewb") {
    const irn = S(b.irn, 64); if (!/^[0-9a-f]{64}$/i.test(irn)) throw new GspError("Bad IRN", { status: 400 });
    const veh = S(b.vehNo, 20).replace(/[^A-Za-z0-9]/g, "").toUpperCase(), tid = S(b.transId, 15).toUpperCase();
    if (!veh && !tid) throw new GspError("Enter the vehicle No. or the transporter ID", { status: 400 });
    if (tid && !/^\d\d[A-Z0-9]{13}$/.test(tid)) throw new GspError("Transporter ID must be a 15-character GSTIN / TRANSIN", { status: 400 });
    const km = Math.max(0, Math.min(4000, Math.round(+b.distance || 0)));
    const body = { Irn: irn, Distance: km, ...(veh ? { TransMode: "1", VehNo: veh, VehType: b.vehType === "O" ? "O" : "R" } : {}), ...(tid ? { TransId: tid } : {}), ...(b.transName ? { TransName: S(b.transName, 100) } : {}),
      ...(b.transDocNo ? { TransDocNo: S(b.transDocNo, 15), TransDocDt: okDate(b.transDocDt) ? b.transDocDt : undefined } : {}) };
    const r = await P.ewb(body); if (!r.EwbNo) throw new GspError("No e-way bill number came back");
    return { ewbNo: String(r.EwbNo), ewbDt: r.EwbDt || "", ewbValidTill: r.EwbValidTill || "", distance: km };
  }
  if (action === "cancelEwb") {
    const no = S(b.ewbNo, 12).replace(/\D/g, ""); if (no.length !== 12) throw new GspError("Bad e-way bill number", { status: 400 });
    if (b.ewbDt && !within24h(b.ewbDt)) throw new GspError("An e-way bill can be cancelled only within 24 hours", { status: 400 });
    const rsn = String(+b.reason || 0); if (!["1", "2", "3", "4"].includes(rsn)) throw new GspError("Pick a reason", { status: 400 });
    const r = await P.cancelEwb({ ewbNo: +no, cancelRsnCode: +rsn, cancelRmrk: S(b.remark || "Cancelled", 50) }); return { ewbNo: no, cancelDate: r.cancelDate || istNow() };
  }
  throw new GspError("Unknown action", { status: 400 });
}
function norm(d) {
  return { irn: String(d.Irn || ""), ackNo: String(d.AckNo || ""), ackDt: String(d.AckDt || ""), qr: String(d.SignedQRCode || ""), status: d.Status || "ACT",
    ...(d.EwbNo ? { ewbNo: String(d.EwbNo), ewbDt: d.EwbDt || "", ewbValidTill: d.EwbValidTill || "" } : {}) };
}
