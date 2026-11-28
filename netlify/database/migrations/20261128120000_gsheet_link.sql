-- Google Sheet link keys share the sync_keys table with the Tally sync program; kind tells them apart.
ALTER TABLE sync_keys ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'tally';
