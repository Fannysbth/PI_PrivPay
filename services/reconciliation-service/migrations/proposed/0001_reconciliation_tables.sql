-- reconciliation-db, mode proposed: PRD 11 with the CHECKs of docs/spec/data-dan-migrasi.md 8 (K-04, K-05).
-- Only tokens, amounts and the bank's references are stored. There is no column for an account number, and none for a
-- result of opening an identity (T-14, FR-32): the CHECK on the token column refuses anything that is not a token.

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
  account_pseudonym VARCHAR(16) NOT NULL,
  amount            NUMERIC(18,2) NOT NULL,
  bank_reference    VARCHAR(32) NOT NULL,
  matched           BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT uq_item_reference UNIQUE (batch_id, bank_reference),
  CONSTRAINT chk_item_token CHECK (account_pseudonym ~ '^PSEU-[0-9A-F]{8}$'),
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
