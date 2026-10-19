import { DomainError, isReason, toClientError, type ErrorResponse } from '@privpay/common';
import { z } from 'zod';

const downstreamBody = z.object({ error: z.object({ reason: z.unknown() }) });

/**
 * What a client may learn about a failure (NFR-10, NFR-25). Every reason a service reports becomes one of the eight
 * client codes and the reason itself is dropped, so a token that exists and one that does not look the same
 * (TK-12). The answer is built from the reason alone: no text a service wrote is repeated.
 */
export class ErrorMasker {
  /** The body and status to send a client for any error. */
  toClient(error: unknown, requestId: string): ErrorResponse {
    return toClientError(error, requestId);
  }

  /**
   * Reads a service's error answer. Only a reason from the known list is believed; anything else (an unknown reason,
   * text, a missing body) falls back to the status, and finally to INTERNAL_ERROR.
   */
  fromDownstream(status: number, body: unknown): DomainError {
    const parsed = downstreamBody.safeParse(body);
    const reason = parsed.success ? parsed.data.error.reason : undefined;
    if (isReason(reason)) return new DomainError(reason, 'downstream');
    if (status === 401) return new DomainError('UNAUTHENTICATED', 'downstream_status');
    if (status === 429) return new DomainError('RATE_LIMITED', 'downstream_status');
    if (status === 503) return new DomainError('SERVICE_UNAVAILABLE', 'downstream_status');
    return new DomainError('INTERNAL_ERROR', 'downstream_unknown');
  }
}
