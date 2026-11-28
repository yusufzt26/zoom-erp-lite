-- Sending documents (PO, invoice, challan, quotation...) by email from each person's own mailbox.
-- One row per mailbox (a person's own address, or a department's such as purchase@): SMTP settings and app password
-- (encrypted, never sent to the browser). Everyone whose email in Users & rights is that address sends from it.
CREATE TABLE IF NOT EXISTS mail_accounts (
  email TEXT PRIMARY KEY,
  set_by TEXT NOT NULL DEFAULT '',
  service TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL,
  port INT NOT NULL,
  secure BOOLEAN NOT NULL,
  login TEXT NOT NULL,
  pass_enc TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- the encryption key, made once (MAIL_SECRET env var overrides it)
CREATE TABLE IF NOT EXISTS mail_settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
-- every email sent from the ERP: who, to whom, which document (no attachment kept)
CREATE TABLE IF NOT EXISTS mail_log (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  to_list TEXT NOT NULL,
  cc_list TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT '',
  doc_no TEXT NOT NULL DEFAULT '',
  party TEXT NOT NULL DEFAULT '',
  ok BOOLEAN NOT NULL,
  error TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mail_log_doc ON mail_log(doc_type, doc_no);
