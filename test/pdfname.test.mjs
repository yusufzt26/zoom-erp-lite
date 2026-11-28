// node test/pdfname.test.mjs : downloaded PDF file names are "type-number-party-project.pdf", Windows-safe and short
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../app.html", import.meta.url), "utf8");
const a = src.indexOf("const pdfName="), b = src.indexOf("\n", src.indexOf("const rqFile="));
const ctx = { sorders: [{ no: 101, job: "ZT2350" }], dchallans: [{ no: 201, so: 101 }], invoices: [{ id: "Z1647", job: "ZT2401" }], grns: [{ no: 77, job: "ZT2350" }],
  SD: { so: { name: "Sales order" }, dc: { name: "Delivery challan" }, inv: { name: "Tax invoice" } }, NT: { dn: { name: "Debit note" }, cn: { name: "Credit note" } },
  sdNo: (t, x) => ({ so: "SO-" + x.no, dc: "DC-" + x.no, inv: x.no })[t], ntNo: (t, x) => t === "dn" ? "DN-" + x.no : `CN${x.no}/26-27`, ntInvId: (r) => r.id,
  jwoLbl: (c, o) => "JWO-" + c.no + "-" + o.n, rqText: (l) => [l.item, l.desc].filter(Boolean).join(" - ") };
/* the per-line project helpers (pdfPrj gives "Multiple" when lines carry different projects) */
const k0 = src.indexOf("const key="), h0 = src.indexOf("const hdrJob="), h1 = src.indexOf("const docJob=");
const helpers = "const KEYM=new Map();\n" + src.slice(k0, src.indexOf("\n", k0)) + "\n" + src.slice(h0, h1);
const f = new Function(...Object.keys(ctx), helpers + "\n" + src.slice(a, b) + "\nreturn {pdfName,pdfShort,pdfRef,pdfDoc,poFile,sdFile,ntFile,jwFile,rcFile,rqFile};")(...Object.values(ctx));
const ok = (n) => { assert.ok(n.endsWith(".pdf")); assert.ok(n.length <= 124, n); assert.ok(!/[\\/:*?"<>|]/.test(n), n); assert.ok(!/[-. ]\.pdf$/.test(n), n); return n; };
const eq = (got, want) => { console.log("  " + ok(got)); assert.equal(got, want); };
eq(f.poFile({ no: 2069, sup: "KIRTI ALLOYS", ref: "ZT2350", status: "Approved" }), "PO-2069-KIRTI ALLOYS-ZT2350.pdf");
eq(f.poFile({ no: 2070, sup: "KIRTI ALLOYS", ref: "", status: "Draft", lines: [{ desc: "EN31 round bar dia 60 x 120 long, hardened" }] }), "PO-2070-KIRTI ALLOYS-EN31 round bar dia 60 x 120-draft.pdf");
eq(f.sdFile("inv", { no: "Z1647/26-27", cust: "Jyoti Plastics Pvt. Ltd.", job: "ZT2350" }), "Invoice-Z1647-26-27-Jyoti Plastics Pvt. Ltd.-ZT2350.pdf");
eq(f.sdFile("dc", { no: 201, cust: "Jyoti Plastics", dc: [] , so: 101 }), "Delivery-challan-DC-201-Jyoti Plastics-ZT2350.pdf");
eq(f.sdFile("so", { no: 102, cust: "Jyoti Plastics", lines: [{ desc: "Cap mould 4 cavity" }] }), "Sales-order-SO-102-Jyoti Plastics-Cap mould 4 cavity.pdf");
eq(f.ntFile("dn", { no: 2, party: "Kirti Alloys", grn: 77, reason: "Rate difference" }), "Debit-note-DN-2-Kirti Alloys-ZT2350.pdf");
eq(f.ntFile("cn", { no: 1, party: "Jyoti Plastics", reason: "Short supply" }), "Credit-note-CN1-26-27-Jyoti Plastics-Short supply.pdf");
eq(f.rcFile({ no: 301, party: "Sai Heat Treat", purpose: "hardening" }), "Returnable-challan-RC-301-Sai Heat Treat-hardening.pdf");
eq(f.rqFile({ no: "PR-45", dept: "Design", job: "ZT2350" }), "Purchase-request-PR-45-Design-ZT2350.pdf");
eq(f.pdfDoc("Quotation", "QT-512-R1", "Jyoti Plastics", f.pdfRef("", "Cap mould 4 cavity")), "Quotation-QT-512-R1-Jyoti Plastics-Cap mould 4 cavity.pdf");
// lines with different projects: "Multiple"; lines all on one project: that project
eq(f.poFile({ no: 2071, sup: "KIRTI ALLOYS", ref: "ZT2349", status: "Approved", lines: [{ desc: "a" }, { desc: "b", job: "ZT2350" }] }), "PO-2071-KIRTI ALLOYS-Multiple.pdf");
eq(f.poFile({ no: 2072, sup: "KIRTI ALLOYS", ref: "", status: "Approved", lines: [{ desc: "a", job: "ZT2351" }, { desc: "b", job: "zt2351" }] }), "PO-2072-KIRTI ALLOYS-ZT2351.pdf");
eq(f.sdFile("inv", { no: "Z1650/26-27", cust: "Jyoti Plastics", job: "ZT2350", lines: [{ desc: "a" }, { desc: "b", job: "ZT2352" }] }), "Invoice-Z1650-26-27-Jyoti Plastics-Multiple.pdf");
eq(f.rcFile({ no: 302, party: "Sai Heat Treat", job: "", purpose: "hardening", lines: [{ desc: "a", job: "ZT2350" }, { desc: "b", job: "ZT2351" }] }), "Returnable-challan-RC-302-Sai Heat Treat-Multiple.pdf");
// long or unsafe parts are cut at a word and cleaned
ok(f.pdfDoc("PO", 1, "A".repeat(90), f.pdfRef("", "x".repeat(90))));
eq(f.pdfDoc("PO", 3, 'Bad: "name" <co>/ltd?', "ZT 1/2"), "PO-3-Bad name co ltd-ZT 1-2.pdf");
eq(f.pdfDoc("PO", 4, "Some Supplier", ""), "PO-4-Some Supplier.pdf");
console.log("pdfname: ok");
