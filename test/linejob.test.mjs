// node test/linejob.test.mjs : a project / job No. on each document line, blank = the project at the top
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../app.html", import.meta.url), "utf8");
const k0 = src.indexOf("const key="), h0 = src.indexOf("const hdrJob="), h1 = src.indexOf("const jobMatch=");
const f = new Function("esc", src.slice(k0, src.indexOf("\n", k0)) + "\n" + src.slice(h0, h1) + "\nreturn {hdrJob,lnJob,docJobs,docJob,lnMulti,byLineJob,ljCell};")(s => String(s ?? ""));
const po = { ref: "ZT2349", sup: "S", lines: [{ qty: 2, rate: 100 }, { qty: 1, rate: 500, job: "ZT2350" }, { qty: 3, rate: 10, job: " zt2349 " }] };
assert.equal(f.hdrJob(po), "ZT2349");
assert.deepEqual(po.lines.map(l => f.lnJob(l, po)), ["ZT2349", "ZT2350", "zt2349"]);
assert.deepEqual(f.docJobs(po), ["ZT2349", "ZT2350"]);
assert.equal(f.docJob(po), "ZT2349, ZT2350");
assert.equal(f.lnMulti(po), true);
assert.deepEqual(f.byLineJob(po, l => l.qty * l.rate), [{ job: "ZT2349", amt: 230 }, { job: "ZT2350", amt: 500 }]);
// no line projects: the document project as before
const inv = { job: "ZT2401", lines: [{ qty: 1, rate: 5 }] };
assert.equal(f.lnMulti(inv), false); assert.equal(f.docJob(inv), "ZT2401");
// every line has its own project: the header is not counted
const dc = { job: "ZT1000", lines: [{ job: "ZT2001" }, { job: "ZT2002" }] };
assert.deepEqual(f.docJobs(dc), ["ZT2001", "ZT2002"]);
// all lines on one project that differs from an empty header: not "multiple"
assert.equal(f.lnMulti({ job: "", lines: [{ job: "ZT5" }, { job: "zt5" }] }), false);
assert.ok(f.ljCell({ job: "ZT2350" }, po, 'data-lk="job"').includes('placeholder="ZT2349"'));
console.log("linejob: ok");
