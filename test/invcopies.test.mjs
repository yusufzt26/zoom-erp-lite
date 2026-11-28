// node test/invcopies.test.mjs : a tax invoice PDF holds Original, Duplicate and Triplicate copies, each with the e-invoice block
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app.html", import.meta.url), "utf8");
const copies = app.match(/const INV_COPIES=(\[[^\]]*\]);/);
assert.ok(copies, "INV_COPIES missing");
assert.deepEqual(JSON.parse(copies[1]), ["ORIGINAL FOR RECIPIENT", "DUPLICATE FOR TRANSPORTER", "TRIPLICATE FOR SUPPLIER"]);
// every sales tax invoice (job work invoices included) goes through sdDoc("inv"), which must return all three copies
assert.ok(app.includes('function sdDoc(t,x){if(t==="inv")return INV_COPIES.map(c=>docTaxInvoice(x,c));'));
// the copy label is printed in the heading, not a fixed "ORIGINAL"
assert.ok(app.includes('<div class="tihead"><b>${esc(copy)}</b>'));
assert.ok(!app.includes("<b>ORIGINAL FOR RECIPIENT</b>"));
// the e-invoice block (IRN + QR) is built inside docTaxInvoice, so each copy carries it
const body = app.slice(app.indexOf("function docTaxInvoice(x,copy"), app.indexOf("\nfunction ", app.indexOf("function docTaxInvoice(x,copy") + 10));
assert.ok(body.includes("einvRow(x"), "docTaxInvoice must include the e-invoice row");
// savePDF takes a list of documents, each starting on a new page
const sp = app.slice(app.indexOf("async function savePDF"), app.indexOf("/* delete purchase requests"));
assert.ok(sp.includes("Array.isArray(html)") && sp.includes("pdf.addPage(\"a4\",ori)"));
console.log("invcopies ok");
