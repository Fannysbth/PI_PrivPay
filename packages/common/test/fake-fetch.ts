export interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

export type Step = Response | Error | 'hang';

export const json = (status: number, body: unknown = { ok: true }): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * A scripted `fetch`: each call consumes the next step. `'hang'` never answers and only ends when the request's
 * abort signal fires, which is how a downstream service that stops responding behaves.
 */
export function fakeFetch(script: Step[]): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const remaining = [...script];
  const fetchImpl = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const step = remaining.shift();
    if (step === undefined) return Promise.reject(new Error('script exhausted'));
    if (step === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    }
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  };
  return { fetch: fetchImpl, calls };
}
