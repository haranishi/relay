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

-- 対応する受渡しが無い古い記録は、出品が分からず再送の判定に使えないので、引き継がずに捨てる。
-- （出品の列が空のままの挿入が失敗すると、後ろの DROP と COMMIT だけが走り、全記録を失うため）
INSERT INTO idempotency_keys (listing_id, key, resource_id, response_json, created_at)
SELECT h.listing_id, old.key, old.resource_id, old.response_json, old.created_at
FROM old_idempotency_keys AS old
JOIN handoffs AS h ON h.id = old.resource_id;
DROP TABLE old_idempotency_keys;

COMMIT;
