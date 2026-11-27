-- Keys for the Tally sync program on the accounts PC. Only a hash of each key is kept; the key is shown once when it is made.
CREATE TABLE IF NOT EXISTS sync_keys (
  id BIGSERIAL PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  last_pc TEXT,
  revoked BOOLEAN NOT NULL DEFAULT FALSE
);
