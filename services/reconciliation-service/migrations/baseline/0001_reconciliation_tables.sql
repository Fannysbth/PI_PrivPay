-- reconciliation-db, mode baseline (M5-01, FR-23, spec data 9): the schema of proposed with the account token replaced
-- by the account number. It holds real account numbers by design, so it is only ever run when PRIVACY_MODE=baseline.
-- There is still no column for a result of opening an identity (T-14, FR-32).

CREATE TABLE settlement_batches (
  batch_id     VARCHAR(20) PRIMARY KEY,
  batch_date   DATE        NOT NULL UNIQUE,
  tx_count     INTEGER     NOT NULL,
  total_amount NUMERIC(18,2) NOT NULL,
  status       VARCHAR(16) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_batch_status CHECK (status IN ('MATCHED', 'PARTIAL', 'MISMATCHED')),
  CONSTRAINT chk_batch_id CHECK (batch_id = 'B-' || to_char(batch_date, 'YYYYMMDD'))
);

CREATE TABLE settlement_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          VARCHAR(20) NOT NULL REFERENCES settlement_batches (batch_id),
  account_number    VARCHAR(20) NOT NULL,
  amount            NUMERIC(18,2) NOT NULL,
  bank_reference    VARCHAR(32) NOT NULL,
  matched           BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT uq_item_reference UNIQUE (batch_id, bank_reference),
  CONSTRAINT chk_item_account CHECK (account_number ~ '^[0-9]{8,20}$'),
  CONSTRAINT chk_item_amount CHECK (amount >= 1)
);

-- Without free text (E1): a coded reason and the actor, never a message that could carry a name.
CREATE TABLE audit_requests (
  request_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id VARCHAR(32) NOT NULL,
  reason_code    VARCHAR(24) NOT NULL,
  actor_id       VARCHAR(64) NOT NULL,
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_audit_reason CHECK (reason_code IN ('AMOUNT_MISMATCH', 'DISPUTE', 'OTHER'))
);
