import { connect as netConnect } from 'node:net';

/** What a TCP connection to an address does. */
export type ProbeOutcome = 'connected' | 'refused' | 'no answer' | `error ${string}`;

/** The part of a socket the probe uses; tests replace the connection to script what happens. */
export interface ProbeSocket {
  on(event: 'connect', listener: () => void): unknown;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
  destroy(): unknown;
}
export type Connect = (options: { host: string; port: number }) => ProbeSocket;

export interface ProbeOptions {
  /** How long to wait for an answer. Windows reports a refusal on a non-loopback address only after about 2 s. */
  readonly timeoutMs: number;
  readonly connect?: Connect;
}

/**
 * Opens a TCP connection and reports what came of it. The socket is destroyed and the timer cleared whichever way it
 * ends; the HTTP client's `timeout` option is not used because it never ends a connection that does not answer.
 */
export function probe(host: string, port: number, options: ProbeOptions): Promise<ProbeOutcome> {
  const connect =
    options.connect ?? ((target: { host: string; port: number }) => netConnect(target));
  return new Promise<ProbeOutcome>((resolve) => {
    const socket = connect({ host, port });
    let done = false;
    const finish = (outcome: ProbeOutcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish('no answer');
    }, options.timeoutMs);
    socket.on('connect', () => {
      finish('connected');
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED' ? 'refused' : `error ${error.code ?? 'unknown'}`);
    });
  });
}

/**
 * Probes all addresses at once. A refusal on a non-loopback address can take seconds on Windows, so one after the
 * other would add up; together they cost the time of the slowest.
 */
export async function probeAll(
  hosts: readonly string[],
  port: number,
  options: ProbeOptions,
): Promise<Record<string, ProbeOutcome>> {
  const outcomes = await Promise.all(hosts.map((host) => probe(host, port, options)));
  return Object.fromEntries(hosts.map((host, index) => [host, outcomes[index] as ProbeOutcome]));
}
