import pino from 'pino';
import { isReason } from './errors';

/**
 * The only fields a service may log (NFR-15, NFR-16): correlation ids, tokens, and operational data.
 * Anything else does not compile, and anything that slips past the type is dropped at run time.
 * The service name is not a field: it is fixed when the logger is created.
 */
export interface LogFields {
  readonly request_id?: string;
  readonly transaction_id?: string;
  readonly token?: string;
  readonly route?: string;
  readonly status?: number;
  readonly latency_ms?: number;
  readonly reason?: string;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  service: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  /** Defaults to standard output; tests pass a capturing destination. */
  destination?: { write(line: string): void };
}

const INVALID = '[INVALID]';
const ONE_HOUR_MS = 3_600_000;

/** Each allowed field must look like what it claims to be, so identity data cannot hide inside it. */
const VALIDATORS = new Map<string, (value: unknown) => boolean>([
  [
    'request_id',
    (v) =>
      typeof v === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  ],
  ['transaction_id', (v) => typeof v === 'string' && /^TX-[0-9]{1,20}$/.test(v)],
  ['token', (v) => typeof v === 'string' && /^PSEU-[0-9A-F]{8}$/.test(v)],
  // A route template, not a concrete path: long digit runs would be identifiers.
  [
    'route',
    (v) => typeof v === 'string' && /^\/[A-Za-z0-9/_{}.-]{0,127}$/.test(v) && !/[0-9]{8}/.test(v),
  ],
  ['status', (v) => typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599],
  // Capped at an hour: a larger number is not a latency and could be an identifier.
  ['latency_ms', (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= ONE_HOUR_MS],
  ['reason', isReason],
]);

const EVENT_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
/** Dropped key names are only repeated when they look like a field name, never when they look like data. */
const KEY_NAME_PATTERN = /^[a-z_-]{1,32}$/;

function entriesOf(fields: LogFields | undefined): [string, unknown][] {
  try {
    return Object.entries(fields ?? {});
  } catch {
    // A hostile object (throwing getter) must not take down the request path; its content is not logged.
    return [['[unreadable]', undefined]];
  }
}

function sanitize(fields: LogFields | undefined): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of entriesOf(fields)) {
    const validate = VALIDATORS.get(key);
    if (validate === undefined) dropped.push(KEY_NAME_PATTERN.test(key) ? key : '[invalid_key]');
    else clean[key] = validate(value) ? value : INVALID;
  }
  if (dropped.length > 0) clean.dropped_fields = dropped;
  return clean;
}

export function createLogger(options: LoggerOptions): Logger {
  const instance = pino(
    {
      level: options.level ?? 'info',
      base: { service: options.service },
      messageKey: 'event',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    options.destination ?? pino.destination(1),
  );

  const emit =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (event: string, fields?: LogFields): void => {
      instance[level](sanitize(fields), EVENT_PATTERN.test(event) ? event : '[invalid_event]');
    };

  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
