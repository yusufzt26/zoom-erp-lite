// Daily Telegram alert at 9:30 AM India time (04:00 UTC): supplier payments overdue or due in the next 3 days.
import { getDatabase } from "@netlify/database";
import { tgService } from "../tgsend.mjs";

let db;
const q = async (text, params = []) => (await (db = db || getDatabase(process.env.ZPO_DB_URL ? { connectionString: process.env.ZPO_DB_URL } : {})).pool.query(text, params)).rows;

export default async () => {
  try {
    const m = (await q("SELECT data FROM records WHERE coll='masters' AND id='_' AND NOT deleted"))[0];
    const r = await tgService(q).daily(m ? m.data : null, false);
    console.log("tg-daily", JSON.stringify(r));
  } catch (e) { console.error("tg-daily", e && e.message); }
};

export const config = { schedule: "0 4 * * *" };
