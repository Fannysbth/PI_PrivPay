import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { Canary } from './canary';
import { scanText, type Finding } from './scan';

export interface ObservingProxyOptions {
  /** The service behind the proxy, as it is named in a finding. */
  readonly service: string;
  /** Where the traffic goes on: `http://host:port` of the real service. */
  readonly target: string;
  readonly canaries: readonly Canary[];
}

const flatten = (headers: IncomingHttpHeaders): string =>
  Object.entries(headers)
    .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(',') : (value ?? '')}`)
    .join('\n');

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', reject);
  });
}

/**
 * The observer of docs/spec/pengujian-dan-pengukuran.md 6, target 1: forwards the traffic to the real service and scans
 * the URL, the headers and both bodies in memory. A payload is not kept after the answer is sent (nothing here touches
 * the disk), and the only output is `findings()`: attribute, location and service, never a value.
 */
export class ObservingProxy {
  private server: Server | undefined;
  private readonly seen = new Map<string, Finding>();

  constructor(private readonly options: ObservingProxyOptions) {}

  get port(): number {
    const address = this.server?.address();
    if (address === null || address === undefined || typeof address === 'string') {
      throw new Error('the proxy is not listening');
    }
    return address.port;
  }

  findings(): Finding[] {
    return [...this.seen.values()];
  }

  private observe(text: string, location: string): void {
    const found = scanText(text, this.options.canaries, {
      service: this.options.service,
      location,
    });
    for (const finding of found) this.seen.set(`${finding.attribute}|${finding.location}`, finding);
  }

  start(): Promise<void> {
    const target = new URL(this.options.target);
    this.server = createServer((incoming, outgoing) => {
      void collect(incoming).then((body) => {
        this.observe(incoming.url ?? '', 'url');
        this.observe(flatten(incoming.headers), 'request-header');
        this.observe(body.toString('latin1'), 'request-body');
        const forward = request(
          {
            host: target.hostname,
            port: target.port,
            path: incoming.url,
            method: incoming.method,
            headers: incoming.headers,
          },
          (answer) => {
            void collect(answer).then((reply) => {
              this.observe(reply.toString('latin1'), 'response-body');
              outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
              outgoing.end(reply);
            });
          },
        );
        // A service that is away is the answer 502, so a test sees it instead of waiting for a timeout.
        forward.on('error', () => {
          outgoing.statusCode = 502;
          outgoing.end();
        });
        forward.end(body);
      });
    });
    return new Promise((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
  }

  stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  }
}
