import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError, toClientError, toWireError, type Reason } from '../errors';

const statusOf = (error: unknown): number | undefined => {
  if (error instanceof HttpException) return error.getStatus();
  if (typeof error === 'object' && error !== null) {
    // Express middleware such as the body parser reports its status this way.
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
};

/** Nothing about the failure is forwarded: the error's text could hold a SQL fragment or a value (S-42). */
function reasonFor(error: unknown): Reason {
  if (error instanceof DomainError) return error.reason;
  const status = statusOf(error);
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN_ROLE';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'SERVICE_UNAVAILABLE';
  // Malformed body, unknown route, wrong method, too large: the caller sent something we do not accept.
  if (status !== undefined && status >= 400 && status < 500) return 'VALIDATION_ERROR';
  return 'INTERNAL_ERROR';
}

/**
 * Answers with the uniform error body (NFR-25). `external` selects what the caller may see: the gateway's clients get
 * only the code, other services also get the reason (ADR-0008).
 */
export function respond(error: unknown, res: Response, external: boolean): void {
  const requestId =
    typeof res.locals['requestId'] === 'string' ? res.locals['requestId'] : randomUUID();
  const reason = reasonFor(error);
  res.locals['reason'] = reason;
  const { status, body } = (external ? toClientError : toWireError)(
    new DomainError(reason),
    requestId,
  );
  if (res.headersSent) {
    // The status line and part of the body are already out: ending the body would let the client take a truncated
    // answer for a complete one, so the connection is cut instead. The request is logged as the failure it is.
    res.locals['status'] = status;
    res.destroy();
    return;
  }
  res.status(status).json(body);
}
