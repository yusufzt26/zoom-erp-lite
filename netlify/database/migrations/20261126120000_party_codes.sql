-- Register of every supplier / customer code ever given. Rows are never deleted, so a code number is never given twice.
CREATE TABLE IF NOT EXISTS party_codes (
  kind TEXT NOT NULL,
  code TEXT NOT NULL,
  num BIGINT NOT NULL DEFAULT 0,
  pkey TEXT,
  name TEXT,
  by_name TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, code)
);
CREATE INDEX IF NOT EXISTS party_codes_key_idx ON party_codes (kind, pkey);
