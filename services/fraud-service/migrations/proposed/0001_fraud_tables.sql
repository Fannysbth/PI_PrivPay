-- fraud-db, mode proposed: PRD 11 as it is. There is no transaction_id and no identity column: the table must not be
-- joinable to transaction-db (FR-18, S-71). The pseudonym is the FRAUD_DETECTION token, which lives 30 days.

CREATE TABLE fraud_assessments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pseudonym         VARCHAR(16)   NOT NULL,
  amount            NUMERIC(18,2) NOT NULL,
  tx_hour           SMALLINT      NOT NULL,
  geohash           VARCHAR(12),
  prior_count       INTEGER       NOT NULL,
  avg_prior_amount  NUMERIC(18,2),
  risk_score        NUMERIC(5,2)  NOT NULL,
  decision          VARCHAR(24)   NOT NULL,
  rules_fired       TEXT[]        NOT NULL DEFAULT '{}',
  assessed_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_fraud_profile ON fraud_assessments (pseudonym, assessed_at DESC);

-- The weights and the multiplier are read from here at run time; `active = false` switches a rule off (K-20). The
-- amount threshold and the hours stay in the environment, so their parameter is only a pointer.
CREATE TABLE risk_rules (
  rule       VARCHAR(32) PRIMARY KEY,
  parameter  VARCHAR(64) NOT NULL,
  weight     SMALLINT    NOT NULL,
  active     BOOLEAN     NOT NULL DEFAULT true
);

INSERT INTO risk_rules (rule, parameter, weight, active) VALUES
  ('AMOUNT_OVER_THRESHOLD', 'env:FRAUD_AMOUNT_THRESHOLD', 10, true),
  ('ODD_HOUR_OUTSIDE_06_22', 'env:FRAUD_ODD_HOUR_START,FRAUD_ODD_HOUR_END', 20, true),
  ('AMOUNT_OVER_3X_AVG', '3.00', 25, true),
  ('NEW_LOCATION_VS_LAST_3', '3', 20, true);
