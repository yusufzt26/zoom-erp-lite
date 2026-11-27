// Phone pop-up notifications (Web Push): turning a Telegram alert text into a notification.
// The alert list and who gets what are shared with Telegram (netlify/telegram.mjs).

// the ERP page each alert opens when tapped
export const ALERT_VIEW = { req_check: "appr", req_approve: "appr", req_ready: "buy", po_approval: "appr", my_req: "req", my_po: "saved", pay_due: "acct", test: "home" };

const unesc = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const plain = (s) => unesc(String(s || "").replace(/<[^>]*>/g, ""));

// Telegram HTML text -> { title, body, tag, url }. First line is the title, the rest the body.
export function pushPayload(k, text, extra = {}) {
  const lines = plain(text).split("\n").map((l) => l.trim()).filter(Boolean);
  const title = (lines.shift() || "ZT-ERP").slice(0, 80);
  const body = lines.join("\n").slice(0, 400);
  const view = ALERT_VIEW[k] || "home";
  // one pop-up per document: a newer alert for the same PO replaces the old one instead of piling up
  const doc = (String(text).match(/<b>([^<]{1,60})<\/b>/) || [])[1] || "";
  return { title, body, tag: (k + ":" + doc).slice(0, 100), url: "/#go=" + view, k, ...extra };
}

// a short device name from the browser's user agent, so people can tell their devices apart
export function deviceName(ua) {
  const s = String(ua || "");
  const os = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android phone" : /Windows/.test(s) ? "Windows PC" : /Macintosh/.test(s) ? "Mac" : /Linux/.test(s) ? "Linux PC" : "Device";
  const br = /Edg\//.test(s) ? "Edge" : /SamsungBrowser/.test(s) ? "Samsung Internet" : /Firefox\//.test(s) ? "Firefox" : /CriOS|Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : "";
  return br ? `${os} · ${br}` : os;
}

// a subscription from the browser is only accepted from the real push services, with both keys
export function subOk(sub) {
  if (!sub || typeof sub !== "object") return false;
  const e = String(sub.endpoint || ""), k = sub.keys || {};
  if (e.length > 1000 || !/^https:\/\/[a-z0-9.-]+(:\d+)?\//i.test(e)) return false;
  if (!/(^|\.)(googleapis\.com|mozilla\.com|mozaws\.net|push\.apple\.com|notify\.windows\.com|microsoft\.com)$/i.test(new URL(e).hostname)) return false;
  return /^[A-Za-z0-9_-]{80,100}={0,2}$/.test(String(k.p256dh || "")) && /^[A-Za-z0-9_-]{16,30}={0,2}$/.test(String(k.auth || ""));
}
