import pino from 'pino';

/**
 * The only fields a service may log (NFR-15, NFR-16): correlation ids, tokens, and operational data.
 * Anything else does not compile, and anything that slips past the type is dropped at run time.
 */
export interface LogFields {
  request_id?: string;
  transaction_id?: string;
  token?: string;
  service?: string;
  route?: string;
  status?: number;
  latency_ms?: number;
  reason?: string;
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

/** Each allowed field must look like what it claims to be, so identity data cannot hide inside it. */
const VALIDATORS: Record<keyof LogFields, (value: unknown) => boolean> = {
  request_id: (v) =>
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  transaction_id: (v) => typeof v === 'string' && /^TX-[0-9]{1,29}$/.test(v),
  token: (v) => typeof v === 'string' && /^PSEU-[0-9A-F]{8}$/.test(v),
  service: (v) => typeof v === 'string' && /^[a-z0-9-]{1,40}$/.test(v),
  // A route template, not a concrete path: long digit runs would be identifiers.
  route: (v) =>
    typeof v === 'string' && /^\/[A-Za-z0-9/_{}.-]{0,127}$/.test(v) && !/[0-9]{8}/.test(v),
  status: (v) => Number.isInteger(v) && (v as number) >= 100 && (v as number) <= 599,
  latency_ms: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
  reason: (v) => typeof v === 'string' && /^[A-Z_]{1,40}$/.test(v),
};

const EVENT_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

/** Second layer behind the whitelist: pino censors these keys wherever they appear. */
const REDACT_PATHS = [
  'authorization',
  'x-actor-token',
  'password',
  'secret',
  'phone',
  'nik',
  'nama',
  'email',
  'rekening',
  'customer_id',
  'subject_id',
];

function sanitize(fields: LogFields | undefined): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(fields ?? {})) {
    const validate = (VALIDATORS as Record<string, ((v: unknown) => boolean) | undefined>)[key];
    if (validate === undefined) dropped.push(key);
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
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
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
