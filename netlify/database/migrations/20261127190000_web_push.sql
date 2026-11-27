-- Phone pop-up notifications (free Web Push from the installed app). Same alert list as Telegram.
-- push_settings keeps the VAPID key pair made on first use (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars override it).
CREATE TABLE IF NOT EXISTS push_settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- one row per phone or browser that turned notifications on
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  keys JSONB NOT NULL,
  device TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_ok_at TIMESTAMPTZ,
  fails INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subs_name ON push_subs(name);
-- which alerts each person wants as pop-ups (same keys as Telegram, chosen separately)
CREATE TABLE IF NOT EXISTS push_prefs (
  name TEXT PRIMARY KEY,
  prefs JSONB NOT NULL DEFAULT '{}'::jsonb
);
