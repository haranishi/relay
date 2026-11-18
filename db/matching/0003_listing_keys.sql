BEGIN IMMEDIATE;

ALTER TABLE idempotency_keys RENAME TO old_idempotency_keys;
CREATE TABLE idempotency_keys (
  listing_id TEXT NOT NULL REFERENCES listing_snapshots(id),
  key TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (listing_id, key)
);

INSERT INTO idempotency_keys (listing_id, key, resource_id, response_json, created_at)
SELECT (SELECT listing_id FROM handoffs WHERE id = old.resource_id),
       old.key, old.resource_id, old.response_json, old.created_at
FROM old_idempotency_keys AS old;
DROP TABLE old_idempotency_keys;

COMMIT;
