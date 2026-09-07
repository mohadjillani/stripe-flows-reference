import { withTransaction, type Pool } from '../db/pool.ts';
import { idempotencyKeyFor, refundKeyFor } from '../stripe/idempotency.ts';
import type { StripeGateway } from '../stripe/client.ts';

export interface StartPayment {
  paymentId: string;
  customerId: string;
  amount: bigint;
  currency: string;
}

export class RefundTooLargeError extends Error {
  constructor(requested: bigint, remaining: bigint) {
    super(`cannot refund ${String(requested)}; only ${String(remaining)} remains`);
    this.name = 'RefundTooLargeError';
  }
}

/**
 * Creates a payment and its first Stripe intent.
 *
 * The order is the whole point. The attempt row — with its idempotency key —
 * is committed *before* Stripe is called, so a crash anywhere after that is
 * recoverable: the retry finds the attempt, reuses the key, and Stripe returns
 * the original intent rather than creating a second one.
 *
 * Writing the attempt after the call is the version that double-charges, and
 * it looks identical in a code review.
 */
export async function startPayment(
  pool: Pool,
  stripe: StripeGateway,
  input: StartPayment,
): Promise<{ intentId: string; clientSecret?: string; attempt: number }> {
  const attempt = await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO payments (id, customer_id, amount, currency)
       VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [input.paymentId, input.customerId, input.amount.toString(), input.currency],
    );

    const { rows } = await client.query<{ next: string }>(
      'SELECT coalesce(max(attempt), 0) + 1 AS next FROM payment_attempts WHERE payment_id = $1',
      [input.paymentId],
    );
    const next = Number(rows[0]?.next ?? 1);

    await client.query(
      `INSERT INTO payment_attempts (payment_id, attempt, idempotency_key)
       VALUES ($1, $2, $3)`,
      [input.paymentId, next, idempotencyKeyFor(input.paymentId, next)],
    );
    return next;
  });

  const key = idempotencyKeyFor(input.paymentId, attempt);

  try {
    const intent = await stripe.createIntent({
      paymentId: input.paymentId,
      amount: input.amount,
      currency: input.currency,
      customerId: input.customerId,
      idempotencyKey: key,
    });

    await pool.query(
      `UPDATE payment_attempts SET status = 'created', intent_id = $2 WHERE idempotency_key = $1`,
      [key, intent.id],
    );
    await pool.query('UPDATE payments SET intent_id = $2 WHERE id = $1', [
      input.paymentId,
      intent.id,
    ]);

    return {
      intentId: intent.id,
      ...(intent.clientSecret ? { clientSecret: intent.clientSecret } : {}),
      attempt,
    };
  } catch (error) {
    await pool.query(
      `UPDATE payment_attempts SET status = 'errored', error = $2 WHERE idempotency_key = $1`,
      [key, error instanceof Error ? error.message : String(error)],
    );
    throw error;
  }
}

/**
 * Retries the *same* attempt.
 *
 * The distinction that matters: this reuses the key, so Stripe returns whatever
 * the first call produced. `startPayment` called again would allocate attempt
 * two and a new key, which is a second charge. Both are legitimate operations
 * and confusing them is how a customer gets billed twice.
 */
export async function retryAttempt(
  pool: Pool,
  stripe: StripeGateway,
  paymentId: string,
  attempt: number,
): Promise<{ intentId: string }> {
  const key = idempotencyKeyFor(paymentId, attempt);
  const { rows } = await pool.query<{
    id: string;
    amount: string;
    currency: string;
    customer_id: string;
  }>('SELECT id, amount::text, currency, customer_id FROM payments WHERE id = $1', [paymentId]);
  const payment = rows[0];
  if (!payment) throw new Error(`no payment ${paymentId}`);

  const intent = await stripe.createIntent({
    paymentId,
    amount: BigInt(payment.amount),
    currency: payment.currency,
    customerId: payment.customer_id,
    idempotencyKey: key,
  });

  await pool.query(
    `UPDATE payment_attempts SET status = 'created', intent_id = $2, error = NULL WHERE idempotency_key = $1`,
    [key, intent.id],
  );
  await pool.query('UPDATE payments SET intent_id = $2 WHERE id = $1', [paymentId, intent.id]);
  return { intentId: intent.id };
}

/**
 * Refunds, validated locally first.
 *
 * Stripe would reject an over-refund too, and waiting for it to do so means a
 * network round trip to learn something already known, an error whose message
 * has to be translated, and — if the check is only Stripe's — a race where two
 * concurrent refunds each look valid. `FOR UPDATE` closes that race.
 */
export async function refund(
  pool: Pool,
  stripe: StripeGateway,
  paymentId: string,
  amount: bigint,
): Promise<{ refundId: string }> {
  const { key, intentId } = await withTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      intent_id: string | null;
      amount: string;
      refunded: string;
    }>('SELECT intent_id, amount::text, refunded::text FROM payments WHERE id = $1 FOR UPDATE', [
      paymentId,
    ]);
    const payment = rows[0];
    if (!payment?.intent_id) throw new Error(`no payment ${paymentId}`);

    const remaining = BigInt(payment.amount) - BigInt(payment.refunded);
    if (amount > remaining) throw new RefundTooLargeError(amount, remaining);

    const { rows: sequenceRows } = await client.query<{ next: string }>(
      `SELECT count(*) + 1 AS next FROM ledger_entries
        WHERE reference = $1 AND account = 'refunds'`,
      [paymentId],
    );

    return {
      key: refundKeyFor(paymentId, Number(sequenceRows[0]?.next ?? 1)),
      intentId: payment.intent_id,
    };
  });

  const result = await stripe.createRefund({ intentId, amount, idempotencyKey: key });
  // The ledger is not touched here. `charge.refunded` posts it, so the books
  // record what Stripe confirmed rather than what was requested.
  return { refundId: result.id };
}
