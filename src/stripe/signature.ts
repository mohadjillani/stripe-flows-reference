import { createHmac, timingSafeEqual } from 'node:crypto';

export class SignatureError extends Error {
  constructor(
    message: string,
    readonly reason: 'malformed' | 'no-matching-signature' | 'outside-tolerance',
  ) {
    super(message);
    this.name = 'SignatureError';
  }
}

export interface ParsedSignature {
  timestamp: number;
  /** Every `v1=` signature in the header. Stripe sends more than one while a secret is rotating. */
  signatures: string[];
}

/** `t=1700000000,v1=abc...,v1=def...` */
export function parseSignatureHeader(header: string): ParsedSignature {
  let timestamp: number | undefined;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (!key || !value) continue;
    if (key.trim() === 't') timestamp = Number(value);
    if (key.trim() === 'v1') signatures.push(value);
  }

  if (timestamp === undefined || !Number.isFinite(timestamp) || signatures.length === 0) {
    throw new SignatureError('the Stripe-Signature header is malformed', 'malformed');
  }
  return { timestamp, signatures };
}

export function computeSignature(payload: string, timestamp: number, secret: string): string {
  // The signed string is the timestamp and the payload joined by a period.
  // Signing the payload alone would let anyone replay a captured request
  // forever, because nothing in the signature would say when it was made.
  return createHmac('sha256', secret)
    .update(`${String(timestamp)}.${payload}`)
    .digest('hex');
}

export interface VerifyOptions {
  /** How old an event may be, in seconds. Stripe's own default is 300. */
  toleranceSeconds?: number;
  nowSeconds?: number;
}

/**
 * Verifies a Stripe webhook signature.
 *
 * The raw body is required — not the parsed object. `JSON.parse` followed by
 * `JSON.stringify` reorders keys and changes whitespace, and the signature is
 * over bytes. An endpoint that verifies against a re-serialised body rejects
 * every legitimate event, or, if someone "fixes" it by skipping verification,
 * accepts every forged one.
 */
export function verifySignature(
  payload: string,
  header: string,
  secret: string,
  options: VerifyOptions = {},
): ParsedSignature {
  const parsed = parseSignatureHeader(header);
  const expected = computeSignature(payload, parsed.timestamp, secret);

  const matches = parsed.signatures.some((candidate) => {
    const a = Buffer.from(candidate, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    // Length first: timingSafeEqual throws on a length mismatch rather than
    // returning false.
    return a.length === b.length && timingSafeEqual(a, b);
  });

  if (!matches) {
    throw new SignatureError(
      'no signature in the header matches the payload',
      'no-matching-signature',
    );
  }

  // Checked after the signature, so an attacker cannot learn anything from the
  // timing of a rejection that never got as far as the HMAC.
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (Math.abs(now - parsed.timestamp) > tolerance) {
    // A captured request replayed hours later is refused here. The event store
    // catches a redelivery of a *legitimate* event; this catches a replay of a
    // stolen one.
    throw new SignatureError(
      `the event is ${String(Math.abs(now - parsed.timestamp))}s old, outside the ${String(tolerance)}s tolerance`,
      'outside-tolerance',
    );
  }

  return parsed;
}

/** Signs a payload the way Stripe would. Used by the tests and the fixtures. */
export function signPayload(
  payload: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  return `t=${String(timestamp)},v1=${computeSignature(payload, timestamp, secret)}`;
}
