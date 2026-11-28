// Google Sheet link (read-only copy of the owner's sheet, sent by a small Apps Script inside the sheet).
// The script sends every tab as rows of cells; the server keeps one record per tab (coll 'gsheet') and writes only what changed.
import { createHash } from "node:crypto";

export const GS_MAX = { tabs: 30, rows: 20000, cols: 60, cell: 600, bytes: 5_500_000 };
const cell = (v) => (v == null ? "" : typeof v === "number" || typeof v === "boolean" ? v : String(v).slice(0, GS_MAX.cell));
const blank = (r) => r.every((c) => c === "" || c == null);
export const gsHash = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 24);

// clean what the script sent: trim each tab to its used part, drop empty rows at the end and empty columns on the right
export function gsRecords(b, label) {
  const sheet = b && typeof b.sheet === "object" && b.sheet ? b.sheet : {};
  const tabs = (Array.isArray(b && b.tabs) ? b.tabs : []).slice(0, GS_MAX.tabs);
  const recs = new Map(), names = [];
  for (const t of tabs) {
    const name = String((t && t.name) || "").trim().slice(0, 100); if (!name || names.includes(name)) continue;
    let rows = (Array.isArray(t.rows) ? t.rows : []).slice(0, GS_MAX.rows).map((r) => (Array.isArray(r) ? r.slice(0, GS_MAX.cols).map(cell) : []));
    while (rows.length && blank(rows[rows.length - 1])) rows.pop();
    let w = 0; rows.forEach((r) => { for (let j = r.length - 1; j >= 0; j--) if (r[j] !== "" && r[j] != null) { w = Math.max(w, j + 1); break; } });
    rows = rows.map((r) => { const x = r.slice(0, w); while (x.length < w) x.push(""); return x; });
    names.push(name);
    recs.set("tab:" + name, { id: "tab:" + name, t: "tab", name, n: names.length, rows, h: gsHash(rows) });
  }
  const status = { id: "status", t: "status", by: label || "", at: new Date().toISOString(), sheetId: String(sheet.id || "").slice(0, 120), title: String(sheet.title || "").slice(0, 200),
    url: /^https:\/\/docs\.google\.com\//.test(String(sheet.url || "")) ? String(sheet.url).slice(0, 300) : "", tz: String(b && b.tz || "").slice(0, 60),
    tabs: names.map((n) => ({ name: n, rows: recs.get("tab:" + n).rows.length })) };
  return { recs, status };
}

// what to write: changed or new tabs, and tabs no longer in the sheet to delete. The status record is written only when something changed or once an hour.
export function gsDiff(existing, recs, prevStatus, now = Date.now()) {
  const ex = new Map(existing.map((r) => [r.id, r.data]));
  const write = [], del = [];
  for (const [id, data] of recs) { const o = ex.get(id); if (!o || o.h !== data.h || o.n !== data.n) write.push({ id, data }); }
  for (const [id] of ex) if (id.startsWith("tab:") && !recs.has(id)) del.push(id);
  const stale = !prevStatus || !prevStatus.at || now - Date.parse(prevStatus.at) > 3600e3;
  return { write, del, status: write.length || del.length || stale };
}

// the Apps Script the Admin pastes into the sheet (Extensions > Apps Script). It only reads the sheet.
export function gsScript(site, key) {
  return `// ZT-ERP LITE: send this Google Sheet to the ERP (read only, nothing in the sheet is changed)
// 1. Save (Ctrl+S)  2. Pick "setupErpLink" at the top and press Run  3. Allow access. Done: it sends every 5 minutes.
const ERP_URL = ${JSON.stringify(site.replace(/\/$/, "") + "/api/gsheet/push")};
const ERP_KEY = ${JSON.stringify(key)};

function sendToErp() {
  const ss = SpreadsheetApp.getActiveSpreadsheet(), tz = ss.getSpreadsheetTimeZone();
  const tabs = ss.getSheets().filter(function (sh) { return !sh.isSheetHidden(); }).map(function (sh) {
    const r = sh.getDataRange(), v = r.getValues(), d = r.getDisplayValues();
    return { name: sh.getName(), rows: v.map(function (row, i) { return row.map(function (c, j) {
      if (c instanceof Date) return isNaN(c) ? "" : Utilities.formatDate(c, tz, "yyyy-MM-dd");
      if (typeof c === "number" || typeof c === "boolean") return c;
      return String(d[i][j] || c || ""); }); }) };
  }).map(function (t) { // leave out empty rows at the end and empty columns on the right
    const full = function (c) { return c !== "" && c !== null; };
    while (t.rows.length && !t.rows[t.rows.length - 1].some(full)) t.rows.pop();
    let w = 0; t.rows.forEach(function (r) { for (let j = r.length - 1; j >= w; j--) if (full(r[j])) { w = j + 1; break; } });
    t.rows = t.rows.map(function (r) { return r.slice(0, w); }); return t;
  });
  const body = JSON.stringify({ sheet: { id: ss.getId(), title: ss.getName(), url: ss.getUrl() }, tz: tz, tabs: tabs });
  const p = PropertiesService.getScriptProperties(), h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, body));
  const last = Number(p.getProperty("erpAt") || 0);
  if (p.getProperty("erpHash") === h && Date.now() - last < 3600e3) return "No change";
  const res = UrlFetchApp.fetch(ERP_URL, { method: "post", contentType: "application/json", headers: { "x-sync-key": ERP_KEY }, payload: body, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error("ZT-ERP did not take it: " + res.getContentText().slice(0, 300));
  p.setProperty("erpHash", h); p.setProperty("erpAt", String(Date.now()));
  return "Sent";
}

function setupErpLink() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "sendToErp") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("sendToErp").timeBased().everyMinutes(5).create();
  PropertiesService.getScriptProperties().deleteProperty("erpHash");
  Logger.log(sendToErp() + ". The sheet now goes to ZT-ERP LITE every 5 minutes.");
}

function onOpen() { SpreadsheetApp.getUi().createMenu("ZT-ERP").addItem("Send to ERP now", "sendNow").addToUi(); }
function sendNow() { PropertiesService.getScriptProperties().deleteProperty("erpHash"); SpreadsheetApp.getActive().toast(sendToErp() + " to ZT-ERP LITE"); }
`;
}
