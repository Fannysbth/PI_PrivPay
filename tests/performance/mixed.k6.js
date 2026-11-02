// M7-01 / Metodologi D.4: mixed load through Kong. 70% normal payments, 30% suspicious ones (>= the Fraud threshold of
// 1.000.000, so they reach Fraud; the second large payment from a new place is held). Closed-loop: a fixed number of virtual
// users, each sends its next request when the last answer arrived (a threat to validity named in the Metodologi).
//
// Runs in the pinned grafana/k6 image (scripts/perf/run.cjs); no dependency of the repository. Everything is built at run time:
// the customers are made through POST /register, the tokens come from Keycloak, and every personal-looking value is a fictional
// canary shaped like tests/pii-scan/canary.ts (plainly false: NIK 99995..., e-mail ...@example.test). The one test password is
// read from a mounted file, never from an argument. TLS is verified against the development CA (SSL_CERT_FILE of the container).
//
// Parameters (-e): MODE, VUS, WARMUP, DURATION, THINK_MS, BASE_URL, IDP_URL, RUN_BASE. The payment form carries nik and nama in
// both conditions (the client behaviour of the Tabel IV premise, N-48); the Kong tokenizer removes them in the proposed one.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const MODE = __ENV.MODE;
if (MODE !== 'baseline' && MODE !== 'proposed')
  throw new Error('MODE must be baseline or proposed');
const VUS = Number(__ENV.VUS || '100');
const WARMUP = __ENV.WARMUP || '60s';
const DURATION = __ENV.DURATION || '300s';
const THINK_MS = Number(__ENV.THINK_MS || '0');
const BASE_URL = __ENV.BASE_URL || 'https://kong:8443';
const IDP_URL = __ENV.IDP_URL || 'http://keycloak:8080';
const RUN_BASE = Number(__ENV.RUN_BASE || '0');
const PASSWORD = open('/secret/customer_password').trim();

// The Fraud threshold (FRAUD_AMOUNT_THRESHOLD) is 1.000.000: a suspicious payment must reach it.
const NORMAL_AMOUNT = 35000;
const SUSPICIOUS_AMOUNT = 2000000;
const SUSPICIOUS_PER_TEN = 3; // 30%: iterations 0, 1, 2 of every ten
const GEOHASHES = ['qqgu4', 'qqgu7', 'qqt8h', 'qqgsm', 'qqgv2'];
const REFRESH_AFTER_MS = 240000; // the access token lives 300 s (Keycloak)

const STATUSES = [201, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504];
const outcome = {};
for (const code of STATUSES) outcome[code] = new Counter(`pay_status_${code}`);
const outcomeOther = new Counter('pay_status_other');

http.setResponseCallback(http.expectedStatuses(201));

const scenarios = {
  measure: {
    executor: 'constant-vus',
    vus: VUS,
    duration: DURATION,
    startTime: WARMUP,
    gracefulStop: '30s',
  },
};
if (WARMUP !== '0s') {
  scenarios.warmup = { executor: 'constant-vus', vus: VUS, duration: WARMUP, gracefulStop: '30s' };
}

// A threshold with no limit that can fail exists only to make k6 keep the sub-metric in the summary.
const keep = ['max>=0'];
export const options = {
  scenarios,
  setupTimeout: '600s',
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: {
    'http_req_duration{scenario:measure,target:kong}': keep,
    'http_req_duration{scenario:measure,target:kong,kind:normal}': keep,
    'http_req_duration{scenario:measure,target:kong,kind:suspicious}': keep,
    'http_req_failed{scenario:measure,target:kong}': ['rate>=0'],
    'http_reqs{scenario:measure,target:kong}': ['count>=0'],
    'checks{scenario:measure}': ['rate>=0'],
    'iterations{scenario:measure}': ['count>=0'],
  },
};

const digits = (value, width) => String(value).padStart(width, '0');
function letters(index) {
  let rest = index;
  let out = '';
  for (let place = 0; place < 6; place += 1) {
    out = String.fromCharCode(97 + (rest % 26)) + out;
    rest = Math.floor(rest / 26);
  }
  return out.charAt(0).toUpperCase() + out.slice(1);
}
/** The same shape as buildCanary (tests/pii-scan/canary.ts): valid in format, plainly false. */
function canary(index) {
  return {
    nik: `99995${digits(index, 11)}`,
    hp: `08999${digits(index, 7)}`,
    rekening: `9999${digits(index, 6)}`,
    email: `canary-${index}@example.test`,
    nama: `Kenari ${letters(index)}`,
  };
}
const usernameOf = (index) => `uji.kinerja.${digits(index, 5)}`;

function uuid() {
  const hex = (n) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}

function login(username) {
  const response = http.post(
    `${IDP_URL}/realms/privpay/protocol/openid-connect/token`,
    { grant_type: 'password', client_id: 'customer-app', username, password: PASSWORD },
    { tags: { target: 'idp', name: 'POST token' }, responseCallback: http.expectedStatuses(200) },
  );
  if (response.status !== 200) return undefined;
  return response.json('access_token');
}

/** Makes the customers before the load starts (not measured: no scenario tag). One per virtual user. */
export function setup() {
  const customers = [];
  for (let i = 0; i < VUS; i += 1) {
    const index = RUN_BASE + i;
    const c = canary(index);
    const username = usernameOf(index);
    const response = http.post(
      `${BASE_URL}/register`,
      JSON.stringify({
        nik: c.nik,
        nama: c.nama,
        hp: c.hp,
        email: c.email,
        rekening: c.rekening,
        username,
      }),
      {
        headers: { 'content-type': 'application/json' },
        tags: { target: 'kong', name: 'POST /register' },
      },
    );
    if (response.status !== 201) throw new Error(`registration ${i} answered ${response.status}`);
    customers.push({ username, ...c });
  }
  // One sign-in per customer here (not measured), so the measured VUs do not all sign in at the start of the window.
  const tokens = customers.map((c) => login(c.username));
  return { customers, tokens, at: Date.now() };
}

const state = { token: undefined, loggedAt: 0 };
// Spread the refresh over 40 s per VU so the 100 re-logins do not arrive together.
const refreshAfter = () => REFRESH_AFTER_MS - (__VU % 40) * 1000;

export default function (data) {
  const me = data.customers[(__VU - 1) % data.customers.length];
  if (state.token === undefined && state.loggedAt === 0) {
    state.token = data.tokens[(__VU - 1) % data.tokens.length];
    state.loggedAt = data.at;
  }
  if (state.token === undefined || Date.now() - state.loggedAt > refreshAfter()) {
    state.token = login(me.username);
    state.loggedAt = Date.now();
    if (state.token === undefined) {
      outcomeOther.add(1);
      sleep(1);
      return;
    }
  }
  const suspicious = __ITER % 10 < SUSPICIOUS_PER_TEN;
  const kind = suspicious ? 'suspicious' : 'normal';
  const body = {
    source_account: me.rekening,
    merchant_id: 'MRC-001',
    amount: suspicious
      ? SUSPICIOUS_AMOUNT + (__ITER % 7) * 1000
      : NORMAL_AMOUNT + (__ITER % 9) * 1000,
    geohash: suspicious ? GEOHASHES[1 + (__ITER % (GEOHASHES.length - 1))] : GEOHASHES[0],
    nik: me.nik,
    nama: me.nama,
  };
  const response = http.post(`${BASE_URL}/transaction`, JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${state.token}`,
      'idempotency-key': uuid(),
    },
    tags: { target: 'kong', kind, name: 'POST /transaction' },
  });
  (outcome[response.status] || outcomeOther).add(1);
  check(response, { 'payment created (201)': (r) => r.status === 201 });
  if (THINK_MS > 0) sleep(THINK_MS / 1000);
}

const PICK = [
  'http_req_duration{scenario:measure,target:kong}',
  'http_req_duration{scenario:measure,target:kong,kind:normal}',
  'http_req_duration{scenario:measure,target:kong,kind:suspicious}',
  'http_req_failed{scenario:measure,target:kong}',
  'http_reqs{scenario:measure,target:kong}',
  'checks{scenario:measure}',
  'iterations{scenario:measure}',
];

export function handleSummary(data) {
  const metrics = {};
  for (const key of PICK) if (data.metrics[key]) metrics[key] = data.metrics[key].values;
  const status = {};
  for (const name of Object.keys(data.metrics)) {
    if (name.startsWith('pay_status_') && !name.includes('{'))
      status[name.slice(11)] = data.metrics[name].values.count;
  }
  const out = {
    mode: MODE,
    vus: VUS,
    warmup: WARMUP,
    duration: DURATION,
    thinkMs: THINK_MS,
    metrics,
    payStatusAllPhases: status,
  };
  return { '/out/k6-summary.json': JSON.stringify(out, null, 2) };
}
