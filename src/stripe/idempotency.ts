/**
 * Derives an idempotency key from local state, never from a random value.
 *
 * A random key is generated fresh on every retry, which means it is not an
 * idempotency key at all — the retry is a new request and the customer is
 * charged twice. The key has to be a function of *what is being paid for*, so
 * that the same intent produces the same key however many times the process
 * dies and restarts.
 *
 * The attempt number is in the key on purpose. A deliberate second attempt —
 * the customer entering a different card after a decline — is a different
 * charge and must have a different key. Stripe would otherwise return the
 * original failure and the customer could never succeed.
 */
export function idempotencyKeyFor(paymentId: string, attempt: number): string {
  if (!paymentId) throw new Error('an idempotency key needs a payment id');
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`attempt must be a positive integer, got ${String(attempt)}`);
  }
  return `payment:${paymentId}:attempt:${String(attempt)}`;
}

/** The same idea for refunds: one key per refund of one payment. */
export function refundKeyFor(paymentId: string, refundSequence: number): string {
  if (!paymentId) throw new Error('an idempotency key needs a payment id');
  if (!Number.isInteger(refundSequence) || refundSequence < 1) {
    throw new Error(`refund sequence must be a positive integer, got ${String(refundSequence)}`);
  }
  return `refund:${paymentId}:${String(refundSequence)}`;
}
