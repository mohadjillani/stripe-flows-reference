import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.ts';
import type { Pool } from '../../src/db/pool.ts';
import { createFakeStripe } from '../../src/stripe/fake.ts';
import {
  RefundTooLargeError,
  refund,
  retryAttempt,
  startPayment,
} from '../../src/flows/payment.ts';
import { idempotencyKeyFor } from '../../src/stripe/idempotency.ts';
import { testPool, truncate } from './helpers.ts';

const pool: Pool = testPool();

beforeAll(async () => {
  await migrate(pool);
});

beforeEach(async () => {
  await truncate(pool);
});

afterAll(async () => {
  await pool.end();
});

const input = {
  paymentId: 'pay_flow',
  customerId: 'cus_1',
  amount: 5000n,
  currency: 'usd',
};

describe('starting a payment', () => {
  it('records the attempt and creates an intent', async () => {
    const stripe = createFakeStripe();
    const result = await startPayment(pool, stripe.gateway, input);

    expect(result.attempt).toBe(1);
    expect(stripe.keys()).toEqual([idempotencyKeyFor('pay_flow', 1)]);

    const { rows } = await pool.query<{ status: string; intent_id: string }>(
      'SELECT status, intent_id FROM payment_attempts WHERE payment_id = $1',
      ['pay_flow'],
    );
    expect(rows[0]).toMatchObject({ status: 'created', intent_id: result.intentId });
  });

  /**
   * The order that prevents a double charge. The attempt row — and its key —
   * is committed before Stripe is called, so a crash anywhere after that is
   * recoverable. Writing the attempt afterwards is the version that charges
   * twice, and it reviews identically.
   */
  it('leaves a recoverable attempt when Stripe fails', async () => {
    const stripe = createFakeStripe({ failCalls: 1 });

    await expect(startPayment(pool, stripe.gateway, input)).rejects.toThrow('stripe unavailable');

    const { rows } = await pool.query<{ status: string; idempotency_key: string; error: string }>(
      'SELECT status, idempotency_key, error FROM payment_attempts WHERE payment_id = $1',
      ['pay_flow'],
    );
    expect(rows[0]).toMatchObject({
      status: 'errored',
      idempotency_key: idempotencyKeyFor('pay_flow', 1),
    });
  });

  it('retries with the same key, so Stripe returns the original intent', async () => {
    const stripe = createFakeStripe({ failCalls: 1 });
    await expect(startPayment(pool, stripe.gateway, input)).rejects.toThrow();

    const retried = await retryAttempt(pool, stripe.gateway, 'pay_flow', 1);

    // Both calls carried the same key. That is what makes the retry safe.
    expect(stripe.keys()).toEqual([
      idempotencyKeyFor('pay_flow', 1),
      idempotencyKeyFor('pay_flow', 1),
    ]);
    expect(retried.intentId).toBeDefined();
  });

  it('returns the first intent when the same key is sent again', async () => {
    const stripe = createFakeStripe();
    const first = await startPayment(pool, stripe.gateway, input);
    const again = await retryAttempt(pool, stripe.gateway, 'pay_flow', 1);

    // Stripe stores the response against the key for 24 hours; the fake does
    // the same, because it is the one behaviour the calling code depends on.
    expect(again.intentId).toBe(first.intentId);
  });

  /**
   * A deliberate second attempt — a different card after a decline — is a
   * different charge and must have a different key, or Stripe would replay the
   * original failure forever.
   */
  it('allocates a new key for a deliberate second attempt', async () => {
    const stripe = createFakeStripe();
    await startPayment(pool, stripe.gateway, input);
    const second = await startPayment(pool, stripe.gateway, input);

    expect(second.attempt).toBe(2);
    expect(stripe.keys()).toEqual([
      idempotencyKeyFor('pay_flow', 1),
      idempotencyKeyFor('pay_flow', 2),
    ]);
  });

  it('does not create a second payment row for a second attempt', async () => {
    const stripe = createFakeStripe();
    await startPayment(pool, stripe.gateway, input);
    await startPayment(pool, stripe.gateway, input);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM payments WHERE id = $1',
      ['pay_flow'],
    );
    expect(rows[0]?.count).toBe('1');
  });
});

describe('refunding', () => {
  beforeEach(async () => {
    const stripe = createFakeStripe();
    await startPayment(pool, stripe.gateway, input);
    await pool.query(`UPDATE payments SET status = 'paid' WHERE id = 'pay_flow'`);
  });

  it('refunds part of a payment', async () => {
    const stripe = createFakeStripe();
    const result = await refund(pool, stripe.gateway, 'pay_flow', 2000n);

    expect(result.refundId).toBeDefined();
    expect(stripe.calls[0]?.method).toBe('createRefund');
  });

  /**
   * Refused locally, before the network. Waiting for Stripe to reject it means
   * a round trip to learn something already known — and, if the check exists
   * only at Stripe, a race where two concurrent refunds each look valid.
   */
  it('refuses a refund larger than the payment without calling Stripe', async () => {
    const stripe = createFakeStripe();

    await expect(refund(pool, stripe.gateway, 'pay_flow', 9000n)).rejects.toThrow(
      RefundTooLargeError,
    );
    expect(stripe.calls).toHaveLength(0);
  });

  it('refuses a refund larger than what remains after an earlier one', async () => {
    const stripe = createFakeStripe();
    // The webhook is what records a refund, so simulate its effect.
    await pool.query(`UPDATE payments SET refunded = 4000 WHERE id = 'pay_flow'`);

    await expect(refund(pool, stripe.gateway, 'pay_flow', 2000n)).rejects.toThrow(
      /only 1000 remains/,
    );
    expect(stripe.calls).toHaveLength(0);
  });

  it('allows a refund of exactly what remains', async () => {
    const stripe = createFakeStripe();
    await pool.query(`UPDATE payments SET refunded = 4000 WHERE id = 'pay_flow'`);

    await expect(refund(pool, stripe.gateway, 'pay_flow', 1000n)).resolves.toBeDefined();
  });

  it('refuses to refund a payment that does not exist', async () => {
    const stripe = createFakeStripe();
    await expect(refund(pool, stripe.gateway, 'pay_missing', 100n)).rejects.toThrow(/no payment/);
  });
});
