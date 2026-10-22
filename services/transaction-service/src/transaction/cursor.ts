import { DomainError } from '@privpay/common';

/** The position of a keyset page: a time with microseconds and the transaction id that breaks a tie. */
export interface PagePosition {
  readonly at: string;
  readonly transactionId: string;
}

/** Position text made by this service only: `<time with microseconds>|<transaction id>` in base64url. */
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|(TX-[0-9]{1,29})$/;

export const encodeCursor = (position: PagePosition): string =>
  Buffer.from(`${position.at}|${position.transactionId}`, 'utf8').toString('base64url');

export function decodeCursor(text: string): PagePosition {
  const match = CURSOR.exec(Buffer.from(text, 'base64url').toString('utf8'));
  // A cursor is only the position this service handed out; anything else is a malformed request, not a search.
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    encodeCursor({ at: match[1], transactionId: match[2] }) !== text
  ) {
    throw new DomainError('VALIDATION_ERROR');
  }
  return { at: match[1], transactionId: match[2] };
}
