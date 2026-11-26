// Supplier / customer codes. Every code ever given is kept in a register (the party_codes table), so:
// - codes are unique, and a number is never given a second time, even after the party is deleted;
// - a code that came with old data is kept, unless the register already has it for another party;
// - a party without a code gets the next number after the highest code given so far, in the same style
//   (prefix and width) as that code, or S0001 / C0001 when there are none yet.
// The same function runs in the browser (preview mode, copied into app.html) and on the server.
// reg: Map code -> { k, num } (k = party key, num = trailing number of the code). It is updated in place.
// items: [{ k, name, code?, fresh? }]. fresh = do not give back a code the register already has for this key.
// Returns { codes: [{ code, replaced? }] in the order of items, add: rows to add to the register }.
export function allotPartyCodes(reg, items, pre) {
  const norm = (c) => String(c ?? "").trim().toUpperCase().replace(/\s+/g, "").slice(0, 24);
  const num = (c) => { const m = String(c).match(/(\d{1,12})$/); return m ? Number(m[1]) : 0; };
  let top = null;
  for (const [code, r] of reg) if (r.num > 0 && (!top || r.num > top.num)) top = { code, num: r.num };
  const add = [];
  const put = (code, k, name) => { const r = { code, num: num(code), k, name: String(name || "").slice(0, 200) }; reg.set(code, { k, num: r.num }); add.push(r); if (r.num > 0 && (!top || r.num > top.num)) top = { code, num: r.num }; return code; };
  const fmt = (n) => { if (!top) return pre + String(n).padStart(4, "0"); const p = top.code.replace(/\d+$/, ""), w = top.code.length - p.length; return p + String(n).padStart(w, "0"); };
  const next = (k, name) => { let n = (top ? top.num : 0) + 1, c; while (reg.has(c = fmt(n))) n++; return put(c, k, name); };
  const codes = items.map((it) => {
    const k = String(it.k || ""), c = norm(it.code);
    if (c) { const r = reg.get(c); if (!r) return { code: put(c, k, it.name) }; if (r.k === k) return { code: c }; return { code: next(k, it.name), replaced: c }; }
    if (!it.fresh && k) { let best = null; for (const [code, r] of reg) if (r.k === k && (!best || r.num > best.num)) best = { code, num: r.num }; if (best) return { code: best.code }; }
    return { code: next(k, it.name) };
  });
  return { codes, add };
}
