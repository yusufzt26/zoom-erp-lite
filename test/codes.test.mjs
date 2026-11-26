// node test/codes.test.mjs : party code rules (server module and the copy inside app.html must match)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allotPartyCodes } from "../netlify/codes.mjs";

const src = readFileSync(new URL("../netlify/codes.mjs", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.html", import.meta.url), "utf8");
const body = src.slice(src.indexOf("export function allotPartyCodes")).replace("export function", "function").trim();
assert.ok(app.includes(body), "app.html copy of allotPartyCodes is out of step with netlify/codes.mjs");

const reg = new Map();
let r = allotPartyCodes(reg, [{ k: "A", name: "A" }, { k: "B", name: "B" }], "S");
assert.deepEqual(r.codes.map((c) => c.code), ["S0001", "S0002"]);
// same party asks again (two browsers at once): gets its own code back, no new number used
r = allotPartyCodes(reg, [{ k: "A", name: "A" }], "S");
assert.equal(r.codes[0].code, "S0001"); assert.equal(r.add.length, 0);
// deleted party: number stays in the register, next party gets S0003, never S0002 again
r = allotPartyCodes(reg, [{ k: "C", name: "C" }], "S");
assert.equal(r.codes[0].code, "S0003");
// imported code kept, and numbering continues after the highest, in its style
r = allotPartyCodes(reg, [{ k: "D", name: "D", code: "v0120" }, { k: "E", name: "E" }], "S");
assert.deepEqual(r.codes.map((c) => c.code), ["V0120", "V0121"]);
// imported code already given to another party: replaced by the next free code
r = allotPartyCodes(reg, [{ k: "F", name: "F", code: "S0001" }], "S");
assert.equal(r.codes[0].code, "V0122"); assert.equal(r.codes[0].replaced, "S0001");
// fresh: do not hand back the key's old code
r = allotPartyCodes(reg, [{ k: "A", name: "A", fresh: true }], "S");
assert.equal(r.codes[0].code, "V0123");
// all codes unique
const all = [...reg.keys()]; assert.equal(new Set(all).size, all.length);
// customers start at C0001
assert.equal(allotPartyCodes(new Map(), [{ k: "X" }], "C").codes[0].code, "C0001");
console.log("codes: all tests passed");
