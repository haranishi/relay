CREATE TABLE IF NOT EXISTS listing_feed (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  condition TEXT NOT NULL,
  pickup_area TEXT NOT NULL,
  pickup_deadline INTEGER NOT NULL,
  status TEXT NOT NULL,
  applicant_count INTEGER NOT NULL DEFAULT 0,
  active_receiver_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listing_feed_community_status
  ON listing_feed (community_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
