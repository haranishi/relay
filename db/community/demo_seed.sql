INSERT OR IGNORE INTO communities (id, name, slug, type, created_at)
VALUES ('community-campus-demo', 'Relay Demo Campus', 'relay-demo-campus', 'campus', unixepoch() * 1000);

INSERT OR IGNORE INTO memberships (id, community_id, user_id, role, status, version, joined_at)
VALUES
  ('membership-giver', 'community-campus-demo', 'giver', 'member', 'active', 1, unixepoch() * 1000),
  ('membership-receiver-a', 'community-campus-demo', 'receiver-a', 'member', 'active', 1, unixepoch() * 1000),
  ('membership-receiver-b', 'community-campus-demo', 'receiver-b', 'member', 'active', 1, unixepoch() * 1000);
