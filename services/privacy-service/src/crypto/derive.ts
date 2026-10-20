import { createHmac } from 'node:crypto';
import { CryptoError } from './errors';
import { keyMaterial, type PrivacyKeys } from './keys';
import { encodeParts, isSubjectType, isUuid } from './parts';

function assertSubjectType(subjectType: string): void {
  if (!isSubjectType(subjectType)) throw new CryptoError('malformed', 'unknown subject type');
}

/**
 * subject_lookup = HMAC-SHA256(K_index, enc(subject_type, subject_id)): the same subject always gives the same value,
 * so its rows can be found. It is a static pseudonym of the subject and must never leave the Privacy database (PRD 6.2).
 */
export class BlindIndex {
  constructor(private readonly keys: PrivacyKeys) {}

  lookup(subjectType: string, subjectId: string): Buffer {
    assertSubjectType(subjectType);
    return createHmac('sha256', keyMaterial(this.keys).index)
      .update(encodeParts(subjectType, subjectId))
      .digest();
  }
}

export interface MintInput {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly serviceId: string;
  readonly purpose: string;
  /** A fresh UUID v4 for each issue, so a collision is retried with another value (spec privacy 7.2 step 6). */
  readonly nonce: string;
}

/** pseudonym = "PSEU-" + upper(first 8 hex of HMAC-SHA256(K_token, enc(type, id, service, purpose, nonce))). */
export class TokenMint {
  constructor(private readonly keys: PrivacyKeys) {}

  mint(input: MintInput): string {
    assertSubjectType(input.subjectType);
    if (!isUuid(input.nonce)) throw new CryptoError('malformed', 'the nonce is not a UUID');
    const digest = createHmac('sha256', keyMaterial(this.keys).token)
      .update(
        encodeParts(
          input.subjectType,
          input.subjectId,
          input.serviceId,
          input.purpose,
          input.nonce,
        ),
      )
      .digest('hex');
    return `PSEU-${digest.slice(0, 8).toUpperCase()}`;
  }
}
