PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS listing_snapshots (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'RESERVED', 'COMPLETED')),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listing_snapshots(id),
  community_id TEXT NOT NULL,
  applicant_id TEXT NOT NULL,
  message TEXT NOT NULL,
  available_slots_json TEXT NOT NULL,
  transport_mode TEXT NOT NULL,
  helper_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('APPLIED', 'SELECTED', 'BACKUP', 'REJECTED', 'WITHDRAWN', 'EXPIRED')),
  created_at INTEGER NOT NULL,
  UNIQUE (listing_id, applicant_id)
);

CREATE TABLE IF NOT EXISTS selection_candidates (
  listing_id TEXT NOT NULL REFERENCES listing_snapshots(id),
  application_id TEXT NOT NULL REFERENCES applications(id),
  rank INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'offered', 'accepted', 'skipped')),
  PRIMARY KEY (listing_id, application_id),
  UNIQUE (listing_id, rank)
);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listing_snapshots(id),
  application_id TEXT NOT NULL REFERENCES applications(id),
  giver_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW')),
  confirmation_expires_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_handoff_per_listing
  ON handoffs (listing_id) WHERE status IN ('PROPOSED', 'CONFIRMED');

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

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
