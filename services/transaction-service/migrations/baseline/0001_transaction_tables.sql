-- transaction-db, mode baseline (M5-01, FR-23, spec data 9): the schema of proposed with the two pseudonym columns
-- replaced by the identity itself. It holds real identities by design, so it is only ever run when PRIVACY_MODE=baseline.
-- The privacy_* columns are kept as they are in proposed so that the domain code is one for both modes; in baseline
-- Privacy is not called, and the no-op status client marks every row as heard.

CREATE TABLE merchants (
  merchant_id VARCHAR(16) PRIMARY KEY,
  name        VARCHAR(64) NOT NULL,
  category    VARCHAR(32) NOT NULL,
  qris_id     VARCHAR(32) NOT NULL UNIQUE
);

CREATE TABLE transactions (
  transaction_id      VARCHAR(32) PRIMARY KEY,
  idempotency_key     VARCHAR(64) NOT NULL UNIQUE,
  customer_id         VARCHAR(16) NOT NULL,
  account_number      VARCHAR(20) NOT NULL,
  merchant_id         VARCHAR(16) NOT NULL REFERENCES merchants (merchant_id),
  amount              NUMERIC(18,2) NOT NULL,
  geohash             VARCHAR(12),
  status              VARCHAR(16) NOT NULL,
  risk_score          NUMERIC(5,2),
  fraud_decision      VARCHAR(24),
  reviewed_by         VARCHAR(64),
  reviewed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  privacy_synced_at   TIMESTAMPTZ,
  privacy_rejected_at TIMESTAMPTZ,
  CONSTRAINT chk_tx_status CHECK (status IN ('PENDING', 'COMPLETED', 'HELD', 'FAILED')),
  CONSTRAINT chk_tx_fraud_decision CHECK (
    fraud_decision IS NULL
    OR fraud_decision IN ('ALLOW', 'HOLD_FOR_VERIFICATION', 'BLOCK', 'FRAUD_UNAVAILABLE'))
);

CREATE INDEX idx_tx_account ON transactions (account_number, created_at);
CREATE INDEX idx_tx_held ON transactions (status) WHERE status = 'HELD';
CREATE INDEX idx_tx_unsynced ON transactions (created_at)
  WHERE privacy_synced_at IS NULL AND privacy_rejected_at IS NULL AND status <> 'PENDING';

-- Policy table seed, the same three invented merchants as proposed (spec data 10).
INSERT INTO merchants (merchant_id, name, category, qris_id) VALUES
  ('MRC-001', 'Warung Kopi Nusa', 'Kuliner', 'ID.QRIS.0001'),
  ('MRC-002', 'Toko Elektronik Mega', 'Elektronik', 'ID.QRIS.0002'),
  ('MRC-003', 'Toko Gadget Prima', 'Elektronik', 'ID.QRIS.0003');
