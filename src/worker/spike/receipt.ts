import { type SpikeReceiptPayload, spikeReceiptPayloadSchema } from '@shared/schemas/spike';
import { SignJWT, jwtVerify } from 'jose';

export const SPIKE_RECEIPT_ISSUER = 'danran-spike';
export const SPIKE_RECEIPT_AUDIENCE = 'danran-spike-ops';
export const SPIKE_RECEIPT_TTL = '24h';

export class ReceiptVerificationError extends Error {
  constructor(message = 'Invalid or expired receipt') {
    super(message);
    this.name = 'ReceiptVerificationError';
  }
}

export interface IssueReceiptParams {
  sessionSecret: string;
  userId: string;
  kind: 'calendar' | 'event';
  calendarId: string;
  eventId?: string;
}

export interface VerifyReceiptParams {
  token: string;
  sessionSecret: string;
  expectedUserId: string;
  expectedKind: 'calendar' | 'event';
  expectedCalendarId: string;
  expectedEventId?: string;
}

/**
 * Issues a purpose-specific 24-hour HS256 signed receipt for a created calendar or event.
 */
export async function issueSpikeReceipt(params: IssueReceiptParams): Promise<string> {
  const { sessionSecret, userId, kind, calendarId, eventId } = params;
  const key = new TextEncoder().encode(sessionSecret);

  const payload: Record<string, unknown> = {
    kind,
    calendarId,
  };
  if (eventId) {
    payload.eventId = eventId;
  }

  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(SPIKE_RECEIPT_ISSUER)
    .setAudience(SPIKE_RECEIPT_AUDIENCE)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(SPIKE_RECEIPT_TTL)
    .sign(key);
}

/**
 * Cryptographically verifies and validates a spike receipt token against expected kind, user, and resource IDs.
 * Throws ReceiptVerificationError on any signature, alg, expiration, user, kind, or ID mismatch.
 */
export async function verifySpikeReceipt(
  params: VerifyReceiptParams,
): Promise<SpikeReceiptPayload> {
  const {
    token,
    sessionSecret,
    expectedUserId,
    expectedKind,
    expectedCalendarId,
    expectedEventId,
  } = params;

  const key = new TextEncoder().encode(sessionSecret);

  let rawPayload: unknown;
  try {
    const verified = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      issuer: SPIKE_RECEIPT_ISSUER,
      audience: SPIKE_RECEIPT_AUDIENCE,
      subject: expectedUserId,
    });
    rawPayload = verified.payload;
  } catch {
    throw new ReceiptVerificationError('Cryptographic receipt verification failed');
  }

  const parsed = spikeReceiptPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new ReceiptVerificationError('Receipt schema validation failed');
  }

  const payload = parsed.data;

  if (payload.kind !== expectedKind) {
    throw new ReceiptVerificationError(
      `Receipt kind mismatch: expected ${expectedKind}, got ${payload.kind}`,
    );
  }

  if (payload.calendarId !== expectedCalendarId) {
    throw new ReceiptVerificationError('Receipt calendar ID mismatch');
  }

  if (expectedKind === 'event') {
    if (!payload.eventId || payload.eventId !== expectedEventId) {
      throw new ReceiptVerificationError('Receipt event ID mismatch');
    }
  }

  return payload;
}
