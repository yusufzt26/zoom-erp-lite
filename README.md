# ZT-ERP LITE

Purchase ERP for Zoom Technologies: purchase request → HOD approval → pre-estimate → PO → approval with signature → GRN (partial inward) → stock and issue → accounts booking → vendor payment. Includes returnable challans, reports, PDFs, Excel-style tables and a daily 6 PM Excel backup on desktop PCs.

## How it runs

- **Front end:** `public/index.html` (one page, works in Chrome on PC and phone; can be added to the phone home screen).
  It is generated from `app.html` by `./build.sh`, which adds the document head. Edit `app.html`, then run `./build.sh`.
- **Back end:** `netlify/functions/api.mjs` (Netlify Function at `/api/*`) with **Netlify Database** (Postgres).
  Schema: `netlify/database/migrations/`. Netlify creates the database and applies migrations on deploy.
- **Shared data:** every record (request, PO, GRN, payment, challan, slip, supplier, rate, masters) is stored in the database.
  Each browser keeps a working copy, saves changes within a second, and pulls other users' changes every 45 s and whenever the tab is opened.
  If two people create a document with the same number at the same moment, the second one is renumbered automatically.
- **Logins:** the first visit asks for an Admin name and password. The Admin adds users on *Users & rights* and sets their passwords in the *Logins* panel.
  Passwords are stored as scrypt hashes; sessions last 30 days.
- **Preview mode:** if `/api` is not available (for example when the file is opened on its own), the app runs on browser storage only, as before.

## E-invoice and e-way bill (automatic)

Tax invoices and credit notes get their IRN and signed QR code straight from the ERP ("Generate IRN now"), goods invoices get an e-way bill from the IRN ("Make e-way bill"), and both can be cancelled within 24 hours.
The browser sends only the invoice data to `/api/gst`; the server (`netlify/gst/gsp.mjs`) talks to the GST Suvidha Provider. Every call is logged in the `gst_log` table.

Netlify environment variables (never put these in code):

| Variable | Value |
| --- | --- |
| `GST_PROVIDER` | `mock` (built-in test, no portal) or `mastergst`. Unset = off (manual JSON upload stays). |
| `GST_MODE` | `sandbox` (default) or `production`. Only production IRNs are valid for GST. |
| `GST_GSTIN` | Our GSTIN (in sandbox: the GSP's test GSTIN). |
| `GST_API_USER` / `GST_API_PASS` | API user made on einvoice1.gst.gov.in (API Registration > Create API User > Through GSP). |
| `GSP_EMAIL` / `GSP_CLIENT_ID` / `GSP_CLIENT_SECRET` | From the GSP account. |
| `GSP_BASE_URL` | Optional, default `https://api.mastergst.com`. |

Test IRNs (sandbox, mock or preview) print "TEST IRN · NOT VALID FOR GST" on the PDF and can be cleared with "Clear test IRN".

## Deploy

Netlify: publish directory `public`, functions from `netlify/functions`, no build command. Link the site to this repository; every merge to `main` deploys.

## Local test

`npm i` then run the functions with a local Postgres (`@netlify/database-dev`) or `netlify dev`.
