-- [Δ PRD 11, N-40] When Privacy has refused the status of the row for good (a 4xx about the row itself). Without it the
-- cleaner asks again on every run, and enough such rows at the head of the queue keep the newer ones from being heard.
-- A moment in time only: no identity, no token. A new status clears it (the transition sets it back to NULL).

ALTER TABLE transactions ADD COLUMN privacy_rejected_at TIMESTAMPTZ;

DROP INDEX idx_tx_unsynced;
CREATE INDEX idx_tx_unsynced ON transactions (created_at)
  WHERE privacy_synced_at IS NULL AND privacy_rejected_at IS NULL AND status <> 'PENDING';
