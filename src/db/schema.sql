-- Schema D1 di concorsi-radar.
-- Applicare con: npm run db:init  (oppure db:init:local per i test in locale)

CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  url           TEXT NOT NULL,
  category      TEXT NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  cadence_min   INTEGER NOT NULL DEFAULT 15,
  enabled       INTEGER NOT NULL DEFAULT 1,
  etag          TEXT,
  last_modified TEXT,
  last_run_at   TEXT,
  last_ok_at    TEXT,
  fail_streak   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id         TEXT NOT NULL,
  url               TEXT NOT NULL,
  url_key           TEXT NOT NULL UNIQUE,
  simhash           TEXT NOT NULL,
  title             TEXT NOT NULL,
  summary           TEXT NOT NULL DEFAULT '',
  published_at      TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  deadline          TEXT,
  prize             TEXT,
  participation     TEXT,
  prize_value       REAL NOT NULL DEFAULT 0,
  effort            REAL NOT NULL DEFAULT 0.5,
  requires_purchase INTEGER NOT NULL DEFAULT 0,
  tags              TEXT NOT NULL DEFAULT '[]',
  score             INTEGER NOT NULL DEFAULT 0,
  cluster_id        INTEGER,
  status            TEXT NOT NULL DEFAULT 'new',
  ai_used           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_items_first_seen ON items (first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_deadline   ON items (deadline);
CREATE INDEX IF NOT EXISTS idx_items_status     ON items (status);
CREATE INDEX IF NOT EXISTS idx_items_score      ON items (score DESC);

CREATE TABLE IF NOT EXISTS deliveries (
  chat_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, item_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_deliveries_sent ON deliveries (chat_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS prefs (
  chat_id           INTEGER PRIMARY KEY,
  active            INTEGER NOT NULL DEFAULT 1,
  weights           TEXT NOT NULL DEFAULT '{}',
  min_score_instant INTEGER NOT NULL DEFAULT 80,
  quiet_hours       TEXT NOT NULL DEFAULT '23-7',
  digest_hours      TEXT NOT NULL DEFAULT '[8,19]',
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  trigger      TEXT NOT NULL,
  sources_ok   INTEGER NOT NULL DEFAULT 0,
  sources_fail INTEGER NOT NULL DEFAULT 0,
  items_new    INTEGER NOT NULL DEFAULT 0,
  ms           INTEGER NOT NULL DEFAULT 0,
  note         TEXT
);

-- Idempotenza del webhook Telegram: Telegram ritenta gli update non-2xx.
CREATE TABLE IF NOT EXISTS updates (
  update_id    INTEGER PRIMARY KEY,
  processed_at TEXT NOT NULL
);

-- Tetto giornaliero Workers AI (10.000 Neurons/giorno sul piano Free).
CREATE TABLE IF NOT EXISTS ai_usage (
  day     TEXT PRIMARY KEY,
  calls   INTEGER NOT NULL DEFAULT 0,
  neurons INTEGER NOT NULL DEFAULT 0
);

-- Cache di robots.txt per origine.
CREATE TABLE IF NOT EXISTS robots (
  origin     TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
