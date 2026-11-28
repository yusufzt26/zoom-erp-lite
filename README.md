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

## Sending documents (email from each person's own mailbox, or WhatsApp)

Every PDF button (PO, PO list, tax invoice, delivery challan, sales order, quotation, debit/credit note, returnable challan, job work challan, customer statement) has **✉ Send by mail** and **WhatsApp** beside it.

- **Who gets what:** Masters > Suppliers / Customers (and the Sales customer list) > **Contacts**. Each contact has a name, email and mobile, and ticks for the documents they get (supplier: POs, challans, debit notes; customer: quotations, sales orders, challans, invoices, credit notes, statements). A document type nobody is ticked for goes to the party's main email / mobile. A new address typed in the Send window can be remembered for next time.
- **Email goes from the logged-in person's address in Users & rights**, signed with their name; replies come back to that mailbox. The address can be their own or a department's (purchase@, sales@...): a mailbox is set up once and everyone with that address sends from it. The Admin sees every address in **✉ My email** (who uses it, set up or not) and can set any of them up; others set up their own. Setup: paste an app password (Gmail: myaccount.google.com/apppasswords; Microsoft 365: app password and "Authenticated SMTP"; Zoho / Yahoo / company mail also work). The server works out the SMTP server from the address (and the domain's MX for company domains, else mail.<domain> on 465 then 587), checks the password with the mail server, sends a test email, and stores the password encrypted (AES-256-GCM, key from `MAIL_SECRET` if set, else a random key kept in `mail_settings`). It is never sent back to the browser. If the Admin changes a person's email, they send from the new address once that one is set up. Table `mail_accounts` has one row per address. Every email is logged in `mail_log` (no attachment kept). Code: `netlify/mail.mjs`, `/api/mail` in `api.mjs`.
- Not set up yet: **Open in my email app** downloads the PDF and opens the person's own email program with To, CC, subject and message filled in.
- **WhatsApp** saves the PDF and opens WhatsApp (app or web) on the mapped number with the message filled in; the person attaches the PDF and presses send (WhatsApp does not accept a file from a link). On phones, **Share PDF** shares the file itself.
- Sending a signed PO marks it "Sent to vendor".

## Tally sync (accounts PC, read-only)

`tools/tally-sync/` is a small Windows program for the PC where Tally runs. Every 5 minutes it reads party ledgers, unpaid bills, receipts and payments from Tally's XML port (9000) and sends them to `/api/tally/push`. It never writes to Tally.
It signs in with a sync key made by the Admin on the **Tally sync** page (only a hash is stored, table `sync_keys`); the key can only write the read-only `tally` records.
The Tally sync page shows the data, links each Tally ledger to an ERP customer or supplier (same name, or linked by a person; never guessed), and Home / Dashboard use it for To collect / To pay.
Build and details: `tools/tally-sync/README.md`.

## Google Sheet link (sales orders and mould tracking, read only)

The team's "Sales Order" Google Sheet (one row per mould: Proforma Number, ZT Mould Number, customer, value, dates, size, scope, dispatch) is linked from **Masters > Import old data > Google Sheet link**.
The Admin presses *Make sheet key* and pastes the script it shows into the sheet (Extensions > Apps Script, then Run `setupErpLink`). Every 5 minutes the script sends the sheet's visible tabs to `/api/gsheet/push` with the key (`x-sync-key`, `sync_keys.kind='gsheet'`), only when something changed. It never writes to the sheet and the ERP never writes back.
The server keeps each tab as a read-only `gsheet` record (`netlify/gsheet.mjs`, written only when the tab changed). The app reads moulds from tabs with ZT Mould Number and Customer columns (open tabs first, report tabs that only repeat them are skipped) and shows each mould's tracking on its sales order, its job card and the Mould tracker (Sales orders page).
With the link turned on, a mould whose job is not on any ERP sales order and whose sheet SO number (SO-245 = J/SO/0245/26-27, FY from Final Data Date) is not in the ERP becomes a sales order marked "from the Google Sheet", and follows later changes in the sheet. Moulds with no SO number get a *Make SO* button instead.

## Telegram alerts (free) — built, switched off

Telegram is switched off until the owner asks for it: nothing about it shows in the app and nothing is sent. To switch it on, set `TG_ON=true` in `app.html` and the Netlify env var `TELEGRAM_ALERTS=on`. Phone pop-ups below work either way.

A Telegram bot sends alerts to each person's phone and to team groups: purchase request waiting for the department head or director, approved request ready for a PO, PO waiting for approval, your request or PO approved / sent back, and a daily 9:30 AM list of supplier payments overdue or due in 3 days.

- The Admin makes a bot with @BotFather and pastes its token in **Users & rights > Telegram alerts**. The server checks it, sets the webhook (`/api/telegram/hook`, with a secret header) and keeps the token in `tg_settings`; it is never sent back to the browser. `TELEGRAM_BOT_TOKEN` on Netlify can be used instead.
- Each person taps **🔔 Alerts** at the top > **Link my Telegram** > **Start** in Telegram (one-time 30-minute code), and picks which alerts they want.
- Groups: add the bot to a Telegram group; it appears in the Telegram alerts panel, where the Admin ticks the alerts that group gets.
- Alerts are worked out on the server when a request or PO changes status (`netlify/telegram.mjs`). The daily payments alert is the scheduled function `netlify/functions/tg-daily.mjs`, using the open supplier bills the app last sent (refreshed while someone in Accounts has the ERP open).
- Setup guide for people: `Telegram-alerts-setup-guide.pdf` in the project files.

## Phone pop-up alerts (free Web Push)

The same alerts also pop up on the phone like a WhatsApp or SMS message, from the installed app, even when it is closed. No account or service to sign up for.

- Each person opens the ERP on their phone, taps **🔔 Alerts** > **Turn on pop-ups**, allows notifications, and ticks which alerts they want (chosen separately for pop-ups and Telegram, from the one alert list in `netlify/telegram.mjs`). A small bar on phones offers this once.
- iPhone: only from the app added to the home screen (Safari > Share > Add to Home Screen), iOS 16.4 or newer. The app says so.
- Server: `netlify/pushsend.mjs` (sending, with the `web-push` package) and `netlify/push.mjs` (pop-up text, page to open). Devices are in `push_subs`, choices in `push_prefs`. Dead devices are removed automatically.
- VAPID keys are made on first use and kept in `push_settings`. To set your own, add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (and optionally `VAPID_SUBJECT`, a `mailto:` or https address) on Netlify; changing keys means everyone turns pop-ups on again.
- Admin sees who has turned them on in **Users & rights > Phone pop-up alerts**.
- Tapping a pop-up opens the ERP on the page it is about (`/#go=appr` etc., handled in `public/sw.js`).

## Deploy

Netlify: publish directory `public`, functions from `netlify/functions`, no build command. Link the site to this repository; every merge to `main` deploys.

## Local test

`npm i` then run the functions with a local Postgres (`@netlify/database-dev`) or `netlify dev`.
