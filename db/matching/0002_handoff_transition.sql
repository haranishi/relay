CREATE TRIGGER IF NOT EXISTS prevent_closed_handoff_transition
BEFORE UPDATE OF status ON handoffs
WHEN OLD.status NOT IN ('PROPOSED', 'CONFIRMED')
BEGIN
  SELECT RAISE(ABORT, 'relay_handoff_already_closed');
END;
