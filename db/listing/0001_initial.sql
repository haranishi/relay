PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  condition TEXT NOT NULL,
  pickup_area TEXT NOT NULL,
  pickup_slots_json TEXT NOT NULL,
  pickup_deadline INTEGER NOT NULL,
  logistics_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'OPEN', 'RESERVED', 'COMPLETED', 'EXPIRED', 'CANCELLED')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listings_feed
  ON listings (community_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS outbox_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL,
  community_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  published_at INTEGER,
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
