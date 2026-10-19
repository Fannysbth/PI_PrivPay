// THROWAWAY experiment: does buat_token exactly as written in PRD 7.1 (strategy A) survive parallel first issuance?
import { readFileSync } from 'node:fs';
import { Clock, createTestDb, newKeys } from './lib/db.mjs';
import { buatToken } from './lib/buat-token.mjs';
import { loadKeys } from './lib/crypto.mjs';

const CONC = Number(process.env.P2_CONCURRENCY ?? 50);
const ROUNDS = Number(process.env.P2_ROUNDS ?? 20);
const db = await createTestDb('privpay_privacy_test_p2x', readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const keys = loadKeys(newKeys());
const clock = new Clock();
try {
  for (const strategy of ['A', 'B', 'C']) {
    const errors = {};
    for (let r = 0; r < ROUNDS; r++) {
      const subjectId = `CUST-X${strategy}${r}`;
      const settled = await Promise.allSettled(Array.from({ length: CONC }, () =>
        buatToken(db.app, keys, { subjectType: 'CUSTOMER', subjectId, serviceId: 'TRANSACTION', purpose: 'PAYMENT_PROCESSING', ttlSeconds: 900 }, { strategy, clock })));
      for (const s of settled) if (s.status === 'rejected') { const k = `${s.reason.code ?? ''} ${s.reason.constraint ?? s.reason.message}`; errors[k] = (errors[k] ?? 0) + 1; }
    }
    console.log(`strategy ${strategy}: ${ROUNDS} rounds x ${CONC} parallel; rejected requests by cause:`, JSON.stringify(errors));
  }
} finally { await db.close(); }
