'use strict';
// The one place the local ports and the environment of every process are written down (N-50, docs/panduan/01).
// Pure: it builds the plan from a mode and a directory and touches nothing. A secret is only ever a file path here.
const path = require('node:path');

/** 4000-4005 and 4007 follow .env.example; 4006 (bank-simulator) and 4010 (Gateway) are the repo's own choice. */
const PORTS = Object.freeze({
  idp: 4000,
  privacy: 4001,
  transaction: 4002,
  fraud: 4003,
  notification: 4004,
  reconciliation: 4005,
  bank: 4006,
  sms: 4007,
  gateway: 4010,
});

const MODES = Object.freeze(['proposed', 'baseline']);

/** Where `dev:up` keeps its logs and `pids.json`, and where `dev:down` looks (git-ignored). */
const DEFAULT_LOG_DIR = path.join('.dev-run', 'logs');

/** Baseline runs on databases of its own, `privpay_<service>_test_<suffix>`, so it never meets the proposed schema. */
const BASELINE_DB_SUFFIX = 'devbl';

/** The services that own a database and have a baseline (Privacy has none). */
const BASELINE_DB_SERVICES = Object.freeze(['transaction', 'fraud', 'notification', 'reconciliation']);

/** The three keys of Privacy: K_token, K_index, K_field (FR-30). */
const PRIVACY_KEY_FILES = Object.freeze([
  'pseudonym_hmac_secret',
  'blind_index_secret',
  'field_encryption_key',
]);

/** The service accounts of the dev IdP; a test in tools/dev-idp keeps this in step with its registry. */
const CLIENT_SECRET_FILES = Object.freeze(
  ['api-gateway', 'transaction', 'fraud', 'notification', 'reconciliation'].map(
    (client) => `${client}_client_secret`,
  ),
);

const url = (name) => `http://127.0.0.1:${String(PORTS[name])}`;

/**
 * @param {'proposed' | 'baseline'} mode
 * @param {{ secretsDir: string }} options
 * @returns {{ name: string, port: number, entry: string, env: Record<string, string> }[]}
 */
function buildPlan(mode, options) {
  if (!MODES.includes(mode)) throw new RangeError('mode must be proposed or baseline');
  const secret = (file) => path.join(options.secretsDir, file);
  const proposed = mode === 'proposed';
  // N-47: PRIVACY_SERVICE_URL is required in proposed and forbidden in baseline.
  const privacyUrl = proposed ? { PRIVACY_SERVICE_URL: url('privacy') } : {};
  const ownDb = (name) =>
    !proposed && BASELINE_DB_SERVICES.includes(name) ? { PG_DATABASE_SUFFIX: BASELINE_DB_SUFFIX } : {};
  const processes = [
    {
      name: 'idp',
      entry: 'tools/dev-idp/dist/main.js',
      env: {
        NODE_ENV: 'development',
        DEV_IDP_ENABLED: 'true',
        DEV_IDP_SECRETS_DIR: options.secretsDir,
      },
    },
    ...(proposed
      ? [
          {
            name: 'privacy',
            entry: 'services/privacy-service/dist/main.js',
            env: {
              GRACE_PERIOD_SECONDS: '30',
              PSEUDONYM_KEY_VERSION: '1',
              TTL_PAYMENT_PROCESSING: '900',
              TTL_FRAUD_DETECTION: '2592000',
              TTL_NOTIFICATION: '900',
              TTL_NOTIFICATION_REGISTRATION: '31536000',
              TTL_DAILY_RECONCILIATION: '86400',
              TTL_INTERNAL_AUDIT: '600',
              DISCLOSURE_APPROVAL_TTL_SECONDS: '600',
              RETENTION_DAYS: '90',
              RETENTION_JOB_RUN_UTC: '01:00',
              PSEUDONYM_HMAC_SECRET_FILE: secret('pseudonym_hmac_secret'),
              BLIND_INDEX_SECRET_FILE: secret('blind_index_secret'),
              FIELD_ENCRYPTION_KEY_FILE: secret('field_encryption_key'),
            },
          },
        ]
      : []),
    {
      name: 'transaction',
      entry: 'services/transaction-service/dist/main.js',
      env: {
        FRAUD_AMOUNT_THRESHOLD: '1000000',
        TX_PENDING_TIMEOUT_SECONDS: '300',
        TX_SWEEP_INTERVAL_SECONDS: '30',
        ...privacyUrl,
        FRAUD_SERVICE_URL: url('fraud'),
        NOTIFICATION_SERVICE_URL: url('notification'),
        TRANSACTION_CLIENT_SECRET_FILE: secret('transaction_client_secret'),
      },
    },
    {
      name: 'fraud',
      entry: 'services/fraud-service/dist/main.js',
      env: {
        FRAUD_AMOUNT_THRESHOLD: '1000000',
        FRAUD_ODD_HOUR_START: '22',
        FRAUD_ODD_HOUR_END: '6',
        FRAUD_HOLD_THRESHOLD: '50',
        FRAUD_BLOCK_THRESHOLD: '90',
        FRAUD_HISTORY_DAYS: '30',
      },
    },
    {
      name: 'notification',
      entry: 'services/notification-service/dist/main.js',
      env: {
        ...privacyUrl,
        SMS_SIMULATOR_URL: url('sms'),
        NOTIFICATION_CLIENT_SECRET_FILE: secret('notification_client_secret'),
      },
    },
    {
      name: 'reconciliation',
      entry: 'services/reconciliation-service/dist/main.js',
      env: {
        RECON_DAILY_RUN_UTC: '00:10',
        ...privacyUrl,
        TRANSACTION_SERVICE_URL: url('transaction'),
        RECONCILIATION_CLIENT_SECRET_FILE: secret('reconciliation_client_secret'),
      },
    },
    {
      name: 'bank',
      entry: 'services/bank-simulator/dist/main.js',
      env: {
        GATEWAY_URL: url('gateway'),
        BANK_USERNAME: 'bank.uji.1',
        BANK_SIMULATOR_TEST_ENDPOINTS: 'true',
      },
    },
    {
      name: 'sms',
      entry: 'services/sms-simulator/dist/main.js',
      env: { SMS_SIMULATOR_TEST_ENDPOINTS: 'true' },
    },
    {
      name: 'gateway',
      entry: 'services/gateway/dist/main.js',
      env: {
        ...privacyUrl,
        TRANSACTION_SERVICE_URL: url('transaction'),
        RECONCILIATION_SERVICE_URL: url('reconciliation'),
        NOTIFICATION_SERVICE_URL: url('notification'),
        API_GATEWAY_CLIENT_SECRET_FILE: secret('api-gateway_client_secret'),
      },
    },
  ];
  return processes.map((proc) => ({
    name: proc.name,
    port: PORTS[proc.name],
    entry: proc.entry,
    env: {
      PRIVACY_MODE: mode,
      TZ: 'UTC',
      IDP_URL: url('idp'),
      ...proc.env,
      ...ownDb(proc.name),
      PORT: String(PORTS[proc.name]),
    },
  }));
}

module.exports = {
  PORTS,
  MODES,
  BASELINE_DB_SUFFIX,
  BASELINE_DB_SERVICES,
  DEFAULT_LOG_DIR,
  PRIVACY_KEY_FILES,
  CLIENT_SECRET_FILES,
  buildPlan,
};
