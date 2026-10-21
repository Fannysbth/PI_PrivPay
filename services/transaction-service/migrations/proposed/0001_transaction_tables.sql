-- transaction-db, mode proposed: PRD 11 with the CHECKs of docs/spec/data-dan-migrasi.md 5 (K-04).
-- Only tokens and non-identity attributes are stored (FR-16, S-38). There is no column for fraud_token or notif_token:
-- both are only in transit.

CREATE TABLE merchants (
  merchant_id VARCHAR(16) PRIMARY KEY,
  name        VARCHAR(64) NOT NULL,
  category    VARCHAR(32) NOT NULL,
  qris_id     VARCHAR(32) NOT NULL UNIQUE
);

CREATE TABLE transactions (
  transaction_id     VARCHAR(32) PRIMARY KEY,
  idempotency_key    VARCHAR(64) NOT NULL UNIQUE,
  customer_pseudonym VARCHAR(16) NOT NULL,
  account_pseudonym  VARCHAR(16) NOT NULL,
  merchant_id        VARCHAR(16) NOT NULL REFERENCES merchants (merchant_id),
  amount             NUMERIC(18,2) NOT NULL,
  geohash            VARCHAR(12),
  status             VARCHAR(16) NOT NULL,
  risk_score         NUMERIC(5,2),
  fraud_decision     VARCHAR(24),
  reviewed_by        VARCHAR(64),
  reviewed_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ,
  CONSTRAINT chk_tx_status CHECK (status IN ('PENDING', 'COMPLETED', 'HELD', 'FAILED')),
  CONSTRAINT chk_tx_fraud_decision CHECK (
    fraud_decision IS NULL
    OR fraud_decision IN ('ALLOW', 'HOLD_FOR_VERIFICATION', 'BLOCK', 'FRAUD_UNAVAILABLE'))
);

CREATE INDEX idx_tx_account ON transactions (account_pseudonym, created_at);
CREATE INDEX idx_tx_held ON transactions (status) WHERE status = 'HELD';

-- The only seed besides policy tables (spec data 10): the three merchants of PRD 16, all invented.
INSERT INTO merchants (merchant_id, name, category, qris_id) VALUES
  ('MRC-001', 'Warung Kopi Nusa', 'Kuliner', 'ID.QRIS.0001'),
  ('MRC-002', 'Toko Elektronik Mega', 'Elektronik', 'ID.QRIS.0002'),
  ('MRC-003', 'Toko Gadget Prima', 'Elektronik', 'ID.QRIS.0003');
