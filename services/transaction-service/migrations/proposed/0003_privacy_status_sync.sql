-- [Δ PRD 11, gate 2 decision 1] Whether Privacy has heard the status the row has now. A PATCH that failed (or a process
-- that stopped before it) leaves NULL, and the cleaner repairs those rows; without the column it could not tell which
-- rows to repeat. A moment in time only: no identity, no token. The runtime role already has UPDATE on the table.

ALTER TABLE transactions ADD COLUMN privacy_synced_at TIMESTAMPTZ;

-- Rows that exist now were settled before this column did: they count as heard, so the first run of the cleaner does
-- not repeat every old PATCH. A PENDING row has nothing to tell yet.
UPDATE transactions SET privacy_synced_at = COALESCE(reviewed_at, completed_at, created_at)
  WHERE status <> 'PENDING';

CREATE INDEX idx_tx_unsynced ON transactions (created_at)
  WHERE privacy_synced_at IS NULL AND status <> 'PENDING';
