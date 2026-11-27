// Phone pop-up notifications, database side: keys, subscriptions, sending. Used by the API and the daily scheduled function.
import webpush from "web-push";
import { wants } from "./telegram.mjs";
import { pushPayload } from "./push.mjs";

export function pushService(q) {
  const get = async (k) => { const r = await q("SELECT v FROM push_settings WHERE k=$1", [k]); return r[0] ? r[0].v : ""; };
  const set = (k, v) => q("INSERT INTO push_settings(k,v) VALUES($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v,updated_at=NOW()", [k, String(v)]);
  // VAPID keys: from Netlify env vars if set, otherwise made once and kept in the database (free, nothing to sign up for)
  async function keys() {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    let pub = await get("public"), pri = await get("private");
    if (!pub || !pri) {
      const k = webpush.generateVAPIDKeys();
      await q("INSERT INTO push_settings(k,v) VALUES('public',$1),('private',$2) ON CONFLICT (k) DO NOTHING", [k.publicKey, k.privateKey]);
      pub = await get("public"); pri = await get("private");
    }
    return { publicKey: pub, privateKey: pri };
  }
  const subject = async () => process.env.VAPID_SUBJECT || ((await get("site")) || "https://zt-erp.netlify.app");

  // one notification to one device; a device that is gone (uninstalled, notifications blocked) is removed
  async function send(row, payload, K, subj) {
    try {
      await webpush.sendNotification({ endpoint: row.endpoint, keys: row.keys }, JSON.stringify(payload),
        { vapidDetails: { subject: subj, publicKey: K.publicKey, privateKey: K.privateKey }, TTL: 24 * 3600, urgency: "high", timeout: 8000 });
      await q("UPDATE push_subs SET last_ok_at=NOW(),fails=0 WHERE endpoint=$1", [row.endpoint]).catch(() => {});
      return true;
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410 || code === 403) await q("DELETE FROM push_subs WHERE endpoint=$1", [row.endpoint]).catch(() => {});
      else await q("UPDATE push_subs SET fails=fails+1 WHERE endpoint=$1", [row.endpoint]).catch(() => {});
      await q("DELETE FROM push_subs WHERE fails>=20").catch(() => {});
      console.error("push", code || "", e && e.message);
      return false;
    }
  }

  // alerts: [{k, to:[names], text}] from alertsFor() / the daily digest. Each named person, on every device they turned on, if they want that alert.
  async function dispatch(alerts, masters) {
    if (!alerts.length) return 0;
    const subs = await q("SELECT s.endpoint,s.name,s.keys,p.prefs FROM push_subs s LEFT JOIN push_prefs p ON p.name=s.name");
    if (!subs.length) return 0;
    const K = await keys(), subj = await subject();
    const users = new Map(((masters && masters.users) || []).filter(Boolean).map((u) => [u.name, u]));
    const jobs = [], seen = new Set();
    for (const a of alerts.slice(0, 40)) for (const s of subs) {
      if (!a.to.includes(s.name)) continue; const u = users.get(s.name); if (!u || !wants(u, s.prefs, a.k)) continue;
      const key = s.endpoint + "|" + a.text; if (seen.has(key)) continue; seen.add(key);
      jobs.push(send(s, pushPayload(a.k, a.text), K, subj));
    }
    const r = await Promise.allSettled(jobs.slice(0, 100));
    return r.filter((x) => x.value).length;
  }
  return { get, set, keys, subject, send, dispatch };
}
