const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;

/** What a request that matched no route is counted under: the real path might carry an identifier or a token. */
export const UNMATCHED_ROUTE = '/unmatched';

/**
 * The label for a route: its template (`/orders/{id}`), never a concrete path. Anything that does not look like a
 * template, or that contains a long digit run, becomes `/other` (NFR-14, NFR-15).
 */
export function routeLabel(template: unknown): string {
  if (typeof template !== 'string') return UNMATCHED_ROUTE;
  const label = template.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return /^\/[A-Za-z0-9/_{}.-]{0,127}$/.test(label) && !/[0-9]{8}/.test(label) ? label : '/other';
}

interface Histogram {
  readonly buckets: number[];
  sum: number;
  count: number;
}

/** Request count and latency per method, route template and status, in the Prometheus text format. */
export class HttpMetrics {
  private readonly requests = new Map<string, number>();
  private readonly durations = new Map<string, Histogram>();

  record(method: string, route: string, status: number, seconds: number): void {
    const verb = METHODS.has(method) ? method : 'OTHER';
    const requestKey = `${verb}\u0000${route}\u0000${String(status)}`;
    this.requests.set(requestKey, (this.requests.get(requestKey) ?? 0) + 1);

    const durationKey = `${verb}\u0000${route}`;
    let histogram = this.durations.get(durationKey);
    if (histogram === undefined) {
      histogram = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
      this.durations.set(durationKey, histogram);
    }
    BUCKETS.forEach((bound, index) => {
      if (seconds <= bound) histogram.buckets[index] = (histogram.buckets[index] ?? 0) + 1;
    });
    histogram.sum += seconds;
    histogram.count += 1;
  }

  render(): string {
    const lines = [
      '# HELP privpay_http_requests_total Requests by method, route template and status.',
      '# TYPE privpay_http_requests_total counter',
    ];
    for (const [key, value] of this.requests) {
      const [method = '', route = '', status = ''] = key.split('\u0000');
      lines.push(
        `privpay_http_requests_total{method="${method}",route="${route}",status="${status}"} ${String(value)}`,
      );
    }
    lines.push(
      '# HELP privpay_http_request_duration_seconds Request latency by method and route template.',
      '# TYPE privpay_http_request_duration_seconds histogram',
    );
    for (const [key, histogram] of this.durations) {
      const [method = '', route = ''] = key.split('\u0000');
      const labels = `method="${method}",route="${route}"`;
      BUCKETS.forEach((bound, index) => {
        lines.push(
          `privpay_http_request_duration_seconds_bucket{${labels},le="${String(bound)}"} ${String(histogram.buckets[index])}`,
        );
      });
      lines.push(
        `privpay_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${String(histogram.count)}`,
        `privpay_http_request_duration_seconds_sum{${labels}} ${String(histogram.sum)}`,
        `privpay_http_request_duration_seconds_count{${labels}} ${String(histogram.count)}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }
}
