-- Every e-invoice / e-way bill API call, so an IRN or EWB number is never lost even if the browser closes before saving.
CREATE TABLE IF NOT EXISTS gst_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  by_name TEXT,
  action TEXT NOT NULL,
  mode TEXT NOT NULL,
  doc_no TEXT,
  irn TEXT,
  ewb_no TEXT,
  ok BOOLEAN NOT NULL,
  result JSONB
);
CREATE INDEX IF NOT EXISTS gst_log_doc_idx ON gst_log (doc_no);
