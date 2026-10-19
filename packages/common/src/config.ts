import { readFileSync, statSync } from 'node:fs';
import type { z } from 'zod';

const MAX_SECRET_BYTES = 4096;

export type EnvSource = Readonly<Record<string, string | undefined>>;

export type ConfigProblem =
  'missing' | 'empty' | 'invalid' | 'unknown' | 'unreadable' | 'raw_secret_forbidden';

export interface ConfigIssue {
  readonly name: string;
  readonly problem: ConfigProblem;
}

/** Names the variables that are wrong and why; it never carries a value (E-09, NFR-22). */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(`Invalid configuration: ${issues.map((i) => `${i.name} (${i.problem})`).join(', ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Validates the declared variables of a service at start-up. Only variables named in the schema are read, so
 * unrelated process variables are ignored; `strictPrefixes` additionally rejects undeclared variables that
 * start with a given prefix, which catches typos such as HTTP_TIMEOUT_MSS.
 */
export function loadConfig<S extends z.ZodObject>(
  schema: S,
  env: EnvSource,
  options: { strictPrefixes?: readonly string[] } = {},
): z.output<S> {
  const issues: ConfigIssue[] = [];
  const declared = Object.keys(schema.shape);

  const candidate: Record<string, string | undefined> = {};
  for (const name of declared) {
    const value = env[name];
    if (value === '') issues.push({ name, problem: 'empty' });
    else candidate[name] = value;
  }

  for (const prefix of options.strictPrefixes ?? []) {
    for (const name of Object.keys(env)) {
      if (name.startsWith(prefix) && !declared.includes(name)) {
        issues.push({ name, problem: 'unknown' });
      }
    }
  }

  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      // Only the variable name and whether it was absent are kept: zod messages could quote the value.
      const name = String(issue.path[0] ?? '');
      if (name === '' || issues.some((known) => known.name === name)) continue;
      issues.push({ name, problem: env[name] === undefined ? 'missing' : 'invalid' });
    }
  }

  // A failure with no variable to blame (for example a schema-level refinement) must still stop the service.
  if (!parsed.success && issues.length === 0) issues.push({ name: '(config)', problem: 'invalid' });
  if (issues.length > 0 || !parsed.success) throw new ConfigError(issues);
  return parsed.data;
}

/**
 * Reads a secret from the file named by `<NAME>_FILE` (same loader as Docker secrets, ADR-0004). A raw
 * `<NAME>` value in the environment is rejected so secrets cannot leak through env dumps.
 */
export function readSecret(env: EnvSource, name: string): string {
  const raw = env[name];
  if (raw !== undefined && raw !== '') {
    throw new ConfigError([{ name, problem: 'raw_secret_forbidden' }]);
  }

  const fileVariable = `${name}_FILE`;
  const path = env[fileVariable];
  if (path === undefined) throw new ConfigError([{ name: fileVariable, problem: 'missing' }]);
  if (path === '') throw new ConfigError([{ name: fileVariable, problem: 'empty' }]);

  let content: string;
  try {
    // A secret is a short string; refusing large files avoids reading something that is not a secret.
    if (statSync(path).size > MAX_SECRET_BYTES) {
      throw new ConfigError([{ name: fileVariable, problem: 'invalid' }]);
    }
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError([{ name: fileVariable, problem: 'unreadable' }]);
  }

  const secret = content.trim();
  if (secret === '') throw new ConfigError([{ name: fileVariable, problem: 'empty' }]);
  return secret;
}

/** Reads a hex-encoded key of exactly `bytes` bytes from `<NAME>_FILE`. */
export function readKey(env: EnvSource, name: string, bytes: number): Buffer {
  const hex = readSecret(env, name);
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== bytes * 2) {
    throw new ConfigError([{ name: `${name}_FILE`, problem: 'invalid' }]);
  }
  return Buffer.from(hex, 'hex');
}
