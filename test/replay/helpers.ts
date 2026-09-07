import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/server.ts';
import { createPool, type Pool } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { signPayload } from '../../src/stripe/signature.ts';

export const WEBHOOK_SECRET = 'whsec_replay_secret';

export function testPool(): Pool {
  return createPool(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/stripedemo');
}

export async function prepare(pool: Pool): Promise<Express> {
  await migrate(pool);
  await truncate(pool);
  return createApp({ pool, webhookSecret: WEBHOOK_SECRET });
}

export async function truncate(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE
    ledger_entries, stripe_events, dunning_notices, disputes,
    payment_attempts, payments, subscriptions,
    reconciliation_findings, reconciliation_runs
    RESTART IDENTITY CASCADE`);
}

/**
 * Posts an event the way Stripe would: the exact bytes, signed.
 *
 * `JSON.stringify` once and send that same string — serialising twice would
 * produce a different byte sequence from the one that was signed, and the
 * endpoint would correctly reject it.
 */
export async function deliver(
  app: Express,
  event: object,
  options: { timestamp?: number; secret?: string } = {},
): Promise<request.Response> {
  const payload = JSON.stringify(event);
  const header = signPayload(payload, options.secret ?? WEBHOOK_SECRET, options.timestamp);

  return (
    request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', header)
      .set('content-type', 'application/json')
      // The string, not a Buffer: superagent serialises a Buffer as
      // `{"type":"Buffer","data":[...]}` when the content type is JSON, and the
      // bytes that arrive are then not the bytes that were signed. The first
      // run of this suite failed every test with `no-matching-signature` for
      // exactly that reason — which is the same trap as verifying against a
      // re-serialised body, arriving from the other side.
      .send(payload)
  );
}

export async function seedPayment(
  pool: Pool,
  input: { id: string; intentId: string; amount: bigint; status?: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO payments (id, customer_id, amount, currency, status, intent_id)
     VALUES ($1, 'cus_test', $2, 'usd', $3, $4)`,
    [input.id, input.amount.toString(), input.status ?? 'pending', input.intentId],
  );
}

export async function seedSubscription(
  pool: Pool,
  input: { id: string; status: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO subscriptions (id, customer_id, price_id, status)
     VALUES ($1, 'cus_test', 'price_test', $2)`,
    [input.id, input.status],
  );
}

export async function paymentStatus(pool: Pool, id: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM payments WHERE id = $1',
    [id],
  );
  return rows[0]?.status;
}

export async function ledgerTotal(pool: Pool, account: string): Promise<bigint> {
  const { rows } = await pool.query<{ total: string | null }>(
    'SELECT sum(amount)::text AS total FROM ledger_entries WHERE account = $1',
    [account],
  );
  return BigInt(rows[0]?.total ?? '0');
}

export interface WebhookResponseBody {
  received?: boolean;
  outcome?: 'processed' | 'duplicate' | 'ignored';
  error?: string;
  reason?: string;
}

/** supertest types `body` as `any`; one named cast beats an unchecked access per assertion. */
export function webhookBody(response: request.Response): WebhookResponseBody {
  return response.body as WebhookResponseBody;
}

export async function countEvents(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>('SELECT count(*)::text FROM stripe_events');
  return Number(rows[0]?.count ?? '0');
}
