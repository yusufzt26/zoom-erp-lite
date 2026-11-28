// Sending documents by email from each person's OWN mailbox (their email in Users & rights).
// Each person saves an app password once ("✉ My email" at the top). It is stored encrypted and never sent back to the browser.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

export const EMAIL_RE = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]{2,}$/;
export const MAX_TO = 20;
export const MAX_FILE_BYTES = 4 * 1024 * 1024; // Netlify functions take about 6 MB per request; base64 adds a third

// known mail services, by the address's domain or by the domain's mail servers (MX)
const SERVICES = {
  google: { label: "Gmail / Google Workspace", host: "smtp.gmail.com", port: 465, savesSent: true },
  microsoft: { label: "Outlook / Microsoft 365", host: "smtp.office365.com", port: 587, savesSent: true },
  zoho: { label: "Zoho Mail", host: "smtp.zoho.in", port: 465, savesSent: true },
  yahoo: { label: "Yahoo Mail", host: "smtp.mail.yahoo.com", port: 465, savesSent: false },
  rediff: { label: "Rediffmail", host: "smtp.rediffmail.com", port: 465, savesSent: false },
};
export const SERVICE_LIST = Object.entries(SERVICES).map(([k, v]) => ({ k, label: v.label, host: v.host, port: v.port }));

// which service an address belongs to. mx = the domain's MX host names (looked up by the caller), for company domains
export function guessService(email, mx = []) {
  const d = String(email || "").split("@")[1]?.toLowerCase() || "";
  if (/^(gmail|googlemail)\.com$/.test(d)) return "google";
  if (/^(outlook|hotmail|live|msn)\.(com|in|co\.uk)$/.test(d)) return "microsoft";
  if (/^zoho(mail)?\.(com|in)$/.test(d)) return "zoho";
  if (/^(yahoo|ymail)\.(com|co\.in|in)$/.test(d)) return "yahoo";
  if (/^rediff(mail)?\.com$/.test(d)) return "rediff";
  const m = mx.map((x) => String(x).toLowerCase()).join(" ");
  if (/google(mail)?\.com|googlemail/.test(m)) return "google";
  if (/outlook\.com|office365|microsoft/.test(m)) return "microsoft";
  if (/zoho/.test(m)) return "zoho";
  if (/rediff/.test(m)) return "rediff";
  if (/yahoo/.test(m)) return "yahoo";
  return "";
}

// SMTP settings to try, in order. `service` "" = company mail on its own server: mail.<domain> on 465, then 587
export function smtpCandidates(email, service, custom = {}) {
  const d = String(email || "").split("@")[1]?.toLowerCase() || "";
  if (custom.host) { const port = +custom.port || 465; return [{ host: String(custom.host).trim().toLowerCase(), port, secure: port === 465 }]; }
  const s = SERVICES[service];
  if (s) return [{ host: s.host, port: s.port, secure: s.port === 465 }];
  return d ? [{ host: "mail." + d, port: 465, secure: true }, { host: "mail." + d, port: 587, secure: false }, { host: "smtp." + d, port: 465, secure: true }] : [];
}
export const savesSent = (host) => Object.values(SERVICES).some((s) => s.host === host && s.savesSent);

// app passwords are kept encrypted (AES-256-GCM). Key: MAIL_SECRET env var, else a random key made once and kept in mail_settings
export function sealer(secret) {
  const key = createHash("sha256").update("zt-erp-mail:" + secret).digest();
  return {
    seal(text) { const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", key, iv); const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]); return "g1." + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64"); },
    open(s) { const b = Buffer.from(String(s).replace(/^g1\./, ""), "base64"); const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"); },
  };
}

// list of addresses from an array or a "a@x, b@y" string: trimmed, de-duplicated (case-insensitive), only valid ones
export function addrList(v) {
  const out = [], seen = new Set();
  for (const a of (Array.isArray(v) ? v : String(v || "").split(/[,;\s]+/)).map((x) => String(x || "").trim()).filter(Boolean)) { const k = a.toLowerCase(); if (!seen.has(k) && EMAIL_RE.test(a)) { seen.add(k); out.push(a); } }
  return out;
}

// check a send request from the browser. Returns { error } or the cleaned message
export function cleanSend(b) {
  const bad = (error) => ({ error });
  const raw = (Array.isArray(b.to) ? b.to : String(b.to || "").split(/[,;\s]+/)).map((x) => String(x || "").trim()).filter(Boolean);
  const to = addrList(raw); const wrong = raw.filter((a) => !EMAIL_RE.test(a));
  if (wrong.length) return bad(`This is not an email address: ${wrong[0].slice(0, 80)}`);
  if (!to.length) return bad("Pick or type at least one email address");
  const cc = addrList(b.cc).filter((a) => !to.some((t) => t.toLowerCase() === a.toLowerCase()));
  if (to.length + cc.length > MAX_TO) return bad(`Too many addresses (${to.length + cc.length}). Up to ${MAX_TO} at a time.`);
  const subject = String(b.subject || "").replace(/[\r\n]+/g, " ").trim().slice(0, 250);
  if (!subject) return bad("Fill in the subject");
  const text = String(b.text || "").slice(0, 20000);
  const files = (Array.isArray(b.files) ? b.files : []).slice(0, 3).map((f) => ({ filename: String(f.name || "document.pdf").replace(/[\\/:*?"<>|\r\n]+/g, "-").slice(0, 150), b64: String(f.b64 || "").replace(/^data:[^,]*,/, "") }));
  let size = 0;
  for (const f of files) { if (!/^[A-Za-z0-9+/=\s]+$/.test(f.b64)) return bad("The PDF could not be read. Try again."); size += Math.floor(f.b64.replace(/\s+/g, "").length * 3 / 4); }
  if (size > MAX_FILE_BYTES) return bad(`The PDF is too big to email (${(size / 1048576).toFixed(1)} MB, up to 4 MB). Download it and attach it in your own email.`);
  const doc = { type: String((b.doc && b.doc.type) || "").slice(0, 20), no: String((b.doc && b.doc.no) || "").slice(0, 60), party: String((b.doc && b.doc.party) || "").slice(0, 200) };
  return { to, cc, subject, text, files, size, doc, copyMe: !!b.copyMe };
}

// the From line: the person's name with their own address
export const fromLine = (name, email) => `"${String(name || "").replace(/["\\\r\n]/g, "").slice(0, 80)}" <${email}>`;

// a plain-words reason when the mail server refuses
export function smtpWhy(e, service) {
  const m = String((e && (e.response || e.message)) || "");
  if (/535|534|auth|credentials|username and password|invalid login/i.test(m)) {
    if (service === "google") return "Gmail did not accept the app password. Make a new app password (Google Account > Security > 2-Step Verification > App passwords) and paste the 16 letters.";
    if (service === "microsoft") return "Outlook did not accept it. Use an app password, and ask your IT person to turn on \"Authenticated SMTP\" for your mailbox in Microsoft 365.";
    return "The mail server did not accept the email and password. Check the app password (or mailbox password) and try again.";
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return "Could not find your mail server. Pick your mail service, or type the SMTP server your IT person gave you.";
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|timeout|Greeting never received/i.test(m)) return "Your mail server did not answer. Type the SMTP server and port your IT person gave you.";
  if (/552|size|too large/i.test(m)) return "The mail server says the email is too big.";
  if (/550|553|554|relay|not permitted|sender/i.test(m)) return "The mail server refused to send from this address. It must be the same mailbox you signed in with.";
  return "Could not send the email: " + m.slice(0, 160);
}
