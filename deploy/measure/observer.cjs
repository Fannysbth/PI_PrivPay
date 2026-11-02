'use strict';
// M6-02 payload observer (docs/spec/pengujian-dan-pengukuran.md 6, target 1). A forwarding proxy that sits in front of the
// four downstream services of the MEASUREMENT stack only (deploy/measure/compose.measure.yml). It forwards every call
// unchanged and keeps what it saw in memory, never on disk. Canary values that the harness learns late (the customer_id is
// made by the IdP at registration) cannot be listed beforehand, so the scan happens at the end: POST /scan with the list,
// and the answer is attribute, service and place only, never a value. The transcript is not readable from outside.
// Plain JavaScript on purpose: it runs in the existing service image (node), with no dependency and no build.
const http = require('node:http');

const ATTRIBUTES = ['customer_id', 'nik', 'hp', 'rekening', 'email', 'nama'];
const transcript = []; // { service, text } where text is URL + headers + both bodies
let forwarded = 0;
const ZONE = ['transaction', 'fraud', 'notification', 'reconciliation'];

function callerOf(authorization) {
  try {
    const payload = String(authorization || '').split('.')[1];
    const azp = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).azp;
    return typeof azp === 'string' ? azp : undefined;
  } catch {
    return undefined;
  }
}

function parseMap(value) {
  // "transaction=4102>http://transaction-service:4002,fraud=4103>http://fraud-service:4003"
  return String(value || '')
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [name, rest] = entry.split('=');
      const [port, target] = rest.split('>');
      return { name, port: Number(port), target: new URL(target) };
    });
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

const flatten = (headers) =>
  Object.entries(headers)
    .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(',') : (value ?? '')}`)
    .join('\n');

function listen({ name, port, target }) {
  http
    .createServer((incoming, outgoing) => {
      const fail = () => {
        outgoing.statusCode = 502;
        outgoing.end();
      };
      collect(incoming).then((body) => {
        const request = body.toString('latin1');
        const forward = http.request(
          { host: target.hostname, port: target.port, path: incoming.url, method: incoming.method, headers: incoming.headers },
          (answer) => {
            collect(answer)
              .then((reply) => {
                // What a service RECEIVES: its request (the callee) and the answer to its own call (the caller, named by the
                // azp of its service token). The Gateway is not a service of Tabel IV, so its answers are not attributed.
                transcript.push({
                  service: name,
                  text: `${incoming.url}
${flatten(incoming.headers)}
${request}`,
                });
                const caller = callerOf(incoming.headers.authorization);
                if (caller !== undefined && ZONE.includes(caller)) {
                  transcript.push({ service: caller, text: reply.toString('latin1') });
                }
                forwarded += 1;
                outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
                outgoing.end(reply);
              })
              .catch(fail);
          },
        );
        forward.on('error', fail);
        forward.end(body);
      }, fail);
    })
    .listen(port, '0.0.0.0');
}

function decoded(text) {
  try {
    const plain = decodeURIComponent(text.replaceAll('+', ' '));
    return plain === text ? undefined : plain;
  } catch {
    return undefined;
  }
}

/** Same rule as tests/pii-scan/scan.ts: exact match, also in the percent-decoded form. One finding per (service, attribute). */
function scan(canaries) {
  const found = new Map();
  for (const entry of transcript) {
    const views = [entry.text, decoded(entry.text)].filter((view) => view !== undefined);
    for (const attribute of ATTRIBUTES) {
      const key = `${entry.service}|${attribute}`;
      if (found.has(key)) continue;
      if (canaries.some((canary) => views.some((view) => view.includes(canary[attribute])))) {
        found.set(key, { service: entry.service, attribute, place: 'payload' });
      }
    }
  }
  return [...found.values()];
}

const maps = parseMap(process.env.OBSERVE_MAP);
for (const entry of maps) listen(entry);

http
  .createServer((incoming, outgoing) => {
    if (incoming.method === 'GET' && incoming.url === '/health') {
      outgoing.end(JSON.stringify({ status: 'ok', exchanges: forwarded }));
      return;
    }
    if (incoming.method === 'POST' && incoming.url === '/scan') {
      collect(incoming).then((body) => {
        try {
          const { canaries } = JSON.parse(body.toString('utf8'));
          outgoing.setHeader('content-type', 'application/json');
          outgoing.end(JSON.stringify({ exchanges: forwarded, findings: scan(canaries) }));
        } catch {
          outgoing.statusCode = 400;
          outgoing.end();
        }
      });
      return;
    }
    outgoing.statusCode = 404;
    outgoing.end();
  })
  .listen(Number(process.env.CONTROL_PORT || 4199), '0.0.0.0');
