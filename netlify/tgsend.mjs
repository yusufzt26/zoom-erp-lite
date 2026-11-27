// Telegram alerts, database side: settings, linked people, groups, sending. Used by the API and by the daily scheduled function.
import { ALERTS, wants, tg, dueDigest, userHas, telegramOn } from "./telegram.mjs";

const GROUP_OK = new Set(ALERTS.filter((a) => a.group).map((a) => a.k));
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

export function tgService(q) {
  const get = async (k) => { const r = await q("SELECT v FROM tg_settings WHERE k=$1", [k]); return r[0] ? r[0].v : ""; };
  const set = async (k, v, by) => {
    if (v == null) await q("DELETE FROM tg_settings WHERE k=$1", [k]);
    else await q("INSERT INTO tg_settings(k,v,updated_by) VALUES($1,$2,$3) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v,updated_at=NOW(),updated_by=EXCLUDED.updated_by", [k, String(v), by || ""]);
  };
  const token = async () => (telegramOn() ? process.env.TELEGRAM_BOT_TOKEN || (await get("token")) : "");
  const log = (kind, chat, ok, info) => q("INSERT INTO tg_log(kind,chat_id,ok,info) VALUES($1,$2,$3,$4)", [kind, chat == null ? null : String(chat), ok, String(info || "").slice(0, 300)]).catch(() => {});

  // one message; a chat that blocked the bot or removed it is unlinked so we stop trying
  async function send(tok, chat, text, kind, site) {
    const p = { chat_id: chat, text: String(text).slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true };
    if (site && /^https:\/\//.test(site)) p.reply_markup = { inline_keyboard: [[{ text: "Open ZT-ERP", url: site }]] };
    try { await tg(tok, "sendMessage", p); await log(kind, chat, true, ""); return true; }
    catch (e) {
      await log(kind, chat, false, e.message);
      if (e.code === 403 || /chat not found|bot was blocked|kicked|deactivated/i.test(e.message)) {
        await q("DELETE FROM tg_links WHERE chat_id=$1", [String(chat)]).catch(() => {});
        await q("UPDATE tg_groups SET active=FALSE WHERE chat_id=$1", [String(chat)]).catch(() => {});
      }
      return false;
    }
  }

  // alerts: [{k, to:[names], text}] from alertsFor(). Sends to each named person who linked Telegram and wants it, and to groups set up for it.
  async function dispatch(alerts, masters) {
    const tok = await token(); if (!tok || !alerts.length) return 0;
    const site = await get("site");
    const users = new Map(((masters && masters.users) || []).filter(Boolean).map((u) => [u.name, u]));
    const links = new Map((await q("SELECT name,chat_id,prefs FROM tg_links")).map((r) => [r.name, r]));
    const groups = await q("SELECT chat_id,alerts FROM tg_groups WHERE active");
    const jobs = []; const seen = new Set();
    for (const a of alerts.slice(0, 40)) {
      for (const n of a.to) { const l = links.get(n), u = users.get(n); if (!l || !u) continue; const key = l.chat_id + "|" + a.text; if (seen.has(key)) continue;
        if (wants(u, l.prefs, a.k)) { seen.add(key); jobs.push([l.chat_id, a.text, a.k]); } }
      if (GROUP_OK.has(a.k)) for (const g of groups) { if (!(Array.isArray(g.alerts) && g.alerts.includes(a.k))) continue; const key = g.chat_id + "|" + a.text; if (seen.has(key)) continue; seen.add(key); jobs.push([g.chat_id, a.text, a.k]); }
    }
    const r = await Promise.allSettled(jobs.slice(0, 60).map(([c, t, k]) => send(tok, c, t, k, site)));
    return r.filter((x) => x.value).length;
  }

  // 9:30 AM India time: overdue and soon-due supplier bills, to accounts people and groups that want it. Once a day.
  // also: other channels (phone pop-ups) given as dispatch functions, so the same digest goes everywhere
  async function daily(masters, force, also = []) {
    const tok = await token(); if (!tok && !also.length) return { sent: 0, why: "no bot" };
    const day = todayIST(); if (!force && (await get("daily_last")) === day) return { sent: 0, why: "already sent today" };
    const d = (await q("SELECT data FROM tg_dues WHERE id='_'"))[0];
    const text = dueDigest(d && d.data && d.data.bills, day);
    await set("daily_last", day, "daily");
    if (!text) return { sent: 0, why: "nothing due" };
    const users = ((masters && masters.users) || []).filter(Boolean);
    const to = users.filter((u) => userHas(u, "acct.view")).map((u) => u.name);
    const al = [{ k: "pay_due", to, text }];
    const n = await Promise.all([tok ? dispatch(al, masters) : 0, ...also.map((f) => f(al, masters).catch(() => 0))]);
    return { sent: n.reduce((a, b) => a + b, 0) };
  }
  return { get, set, token, send, dispatch, daily, log };
}
