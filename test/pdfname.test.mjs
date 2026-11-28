// node test/pdfname.test.mjs : downloaded PDF file names are "type-number-party-project.pdf", Windows-safe and short
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../app.html", import.meta.url), "utf8");
const a = src.indexOf("const pdfName="), b = src.indexOf("\n", src.indexOf("const rqFile="));
const ctx = { sorders: [{ no: 101, job: "ZT2350" }], dchallans: [{ no: 201, so: 101 }], invoices: [{ id: "Z1647", job: "ZT2401" }], grns: [{ no: 77, job: "ZT2350" }],
  SD: { so: { name: "Sales order" }, dc: { name: "Delivery challan" }, inv: { name: "Tax invoice" } }, NT: { dn: { name: "Debit note" }, cn: { name: "Credit note" } },
  sdNo: (t, x) => ({ so: "SO-" + x.no, dc: "DC-" + x.no, inv: x.no })[t], ntNo: (t, x) => t === "dn" ? "DN-" + x.no : `CN${x.no}/26-27`, ntInvId: (r) => r.id,
  jwoLbl: (c, o) => "JWO-" + c.no + "-" + o.n, rqText: (l) => [l.item, l.desc].filter(Boolean).join(" - ") };
const f = new Function(...Object.keys(ctx), src.slice(a, b) + "\nreturn {pdfName,pdfShort,pdfRef,pdfDoc,poFile,sdFile,ntFile,jwFile,rcFile,rqFile};")(...Object.values(ctx));
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
// long or unsafe parts are cut at a word and cleaned
ok(f.pdfDoc("PO", 1, "A".repeat(90), f.pdfRef("", "x".repeat(90))));
eq(f.pdfDoc("PO", 3, 'Bad: "name" <co>/ltd?', "ZT 1/2"), "PO-3-Bad name co ltd-ZT 1-2.pdf");
eq(f.pdfDoc("PO", 4, "Some Supplier", ""), "PO-4-Some Supplier.pdf");
console.log("pdfname: ok");
