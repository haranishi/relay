CREATE TRIGGER IF NOT EXISTS require_open_listing_for_application
BEFORE INSERT ON applications
WHEN (SELECT status FROM listing_snapshots WHERE id = NEW.listing_id) <> 'OPEN'
BEGIN
  SELECT RAISE(ABORT, 'relay_listing_not_open');
END;
