-- Every saved version of every record, so Admin / Director can put the data back the way it was at an earlier date and time.
CREATE TABLE IF NOT EXISTS record_history (
  hid BIGSERIAL PRIMARY KEY,
  coll TEXT NOT NULL,
  id TEXT NOT NULL,
  data JSONB,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  rev BIGINT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  changed_by TEXT
);
CREATE INDEX IF NOT EXISTS record_history_rev_idx ON record_history (rev);
CREATE INDEX IF NOT EXISTS record_history_key_idx ON record_history (coll, id, rev);
CREATE INDEX IF NOT EXISTS record_history_at_idx ON record_history (changed_at);

-- Named restore points: start of history, before big imports / bulk deletes, made by hand, and before every restore (so a restore can be undone).
CREATE TABLE IF NOT EXISTS restore_points (
  pid BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  rev BIGINT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  by_name TEXT
);
CREATE INDEX IF NOT EXISTS restore_points_at_idx ON restore_points (at);

-- Starting state: today's data is the first version of every record.
INSERT INTO record_history (coll, id, data, deleted, rev, changed_at, changed_by)
  SELECT coll, id, data, deleted, rev, updated_at, updated_by FROM records
  WHERE NOT EXISTS (SELECT 1 FROM record_history);
INSERT INTO restore_points (rev, kind, label, by_name)
  SELECT COALESCE((SELECT MAX(rev) FROM records), 0), 'start', 'Restore history starts', 'system'
  WHERE NOT EXISTS (SELECT 1 FROM restore_points WHERE kind = 'start');
