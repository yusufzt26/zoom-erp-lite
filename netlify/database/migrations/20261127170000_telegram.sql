-- Telegram alerts (free Telegram bot). The bot token is kept here, never sent back to the browser in full.
CREATE TABLE IF NOT EXISTS tg_settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);
-- one Telegram chat per ERP login, linked when the person taps Start on the bot from their own link
CREATE TABLE IF NOT EXISTS tg_links (
  name TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  tg_name TEXT,
  prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tg_codes (
  code_hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
-- Telegram groups the bot was added to; the Admin picks which alerts each group gets
CREATE TABLE IF NOT EXISTS tg_groups (
  chat_id TEXT PRIMARY KEY,
  title TEXT,
  alerts JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tg_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kind TEXT,
  chat_id TEXT,
  ok BOOLEAN,
  info TEXT
);
-- open supplier bills (balance and due date) as last worked out by the app, for the daily payments alert
CREATE TABLE IF NOT EXISTS tg_dues (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  by_name TEXT
);
