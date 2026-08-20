PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS communities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('campus', 'company')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'moderator', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'left')),
  version INTEGER NOT NULL DEFAULT 1,
  joined_at INTEGER NOT NULL,
  UNIQUE (community_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_resolve
  ON memberships (user_id, community_id, status);
