import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as events from '../../fixtures/events/build.ts';
import { checkInvariants } from '../../src/ledger/invariants.ts';
import type { Pool } from '../../src/db/pool.ts';
import { deliver, ledgerTotal, prepare, seedSubscription, testPool, truncate } from './helpers.ts';

const pool: Pool = testPool();
let app: Express;

beforeAll(async () => {
  app = await prepare(pool);
});

beforeEach(async () => {
  await truncate(pool);
  await seedSubscription(pool, { id: 'sub_1', status: 'active' });
});

afterAll(async () => {
  await pool.end();
});

async function subscription(id: string) {
  const { rows } = await pool.query<{
    status: string;
    dunning_started_at: string | null;
  }>('SELECT status, dunning_started_at FROM subscriptions WHERE id = $1', [id]);
  return rows[0];
}

async function noticeCount(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*)::text FROM dunning_notices',
  );
  return Number(rows[0]?.count ?? '0');
}

/**
 * The failed-renewal sequence, replayed.
 *
 * Stripe test clocks exist to make Stripe emit this sequence over a simulated
 * month. What this service consumes *is* the sequence, so the scenarios are
 * driven by delivering the events directly. That is a weaker test of Stripe
 * and an equal test of the handlers — see `test/live/` for the same scenarios
 * against a real account, which have never run in this repository's CI.
 */
describe('a renewal that fails and then recovers', () => {
  it('moves to past_due and records one notice per attempt', async () => {
    const base = Math.floor(Date.now() / 1000);

    await deliver(app, events.invoicePaymentFailed('sub_1', 'in_1', 1, { created: base }));
    expect(await subscription('sub_1')).toMatchObject({ status: 'past_due' });
    expect((await subscription('sub_1'))?.dunning_started_at).not.toBeNull();
    expect(await noticeCount()).toBe(1);

    // Stripe's Smart Retries, arriving as further failures over two weeks.
    await deliver(app, events.invoicePaymentFailed('sub_1', 'in_1', 2, { created: base + 86_400 }));
    await deliver(
      app,
      events.invoicePaymentFailed('sub_1', 'in_1', 3, { created: base + 259_200 }),
    );

    expect(await noticeCount()).toBe(3);
    expect(await subscription('sub_1')).toMatchObject({ status: 'past_due' });
  });

  it('does not send a second notice for a redelivered failure', async () => {
    const event = events.invoicePaymentFailed('sub_1', 'in_1', 1, { id: 'evt_fail' });
    await deliver(app, event);
    await deliver(app, event);

    // The customer being emailed twice about the same failure reaches support
    // before it reaches a log.
    expect(await noticeCount()).toBe(1);
  });

  it('recovers to active and clears dunning when the retry succeeds', async () => {
    const base = Math.floor(Date.now() / 1000);
    await deliver(app, events.invoicePaymentFailed('sub_1', 'in_1', 1, { created: base }));
    await deliver(app, events.invoicePaid('sub_1', 'in_1', 2000, { created: base + 345_600 }));

    const after = await subscription('sub_1');
    expect(after?.status).toBe('active');
    // Cleared, not merely ignored: a subscription that is paying must not
    // still look like it is in dunning on a dashboard.
    expect(after?.dunning_started_at).toBeNull();
    expect(await ledgerTotal(pool, 'revenue')).toBe(-2000n);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  /**
   * The ordering case that matters here. A retried `past_due` arriving after
   * the `active` that resolved it would put a paying customer back into
   * dunning — and the only thing separating the two is the event's timestamp.
   */
  it('ignores a stale past_due that arrives after recovery', async () => {
    const base = Math.floor(Date.now() / 1000);
    await deliver(app, events.invoicePaymentFailed('sub_1', 'in_1', 1, { created: base }));
    await deliver(app, events.invoicePaid('sub_1', 'in_1', 2000, { created: base + 100 }));

    await deliver(
      app,
      events.invoicePaymentFailed('sub_1', 'in_1', 2, { id: 'evt_stale', created: base + 50 }),
    );

    expect((await subscription('sub_1'))?.status).toBe('active');
  });
});

describe('a renewal that never recovers', () => {
  it('ends at unpaid after Stripe gives up', async () => {
    const base = Math.floor(Date.now() / 1000);

    await deliver(app, events.invoicePaymentFailed('sub_1', 'in_2', 1, { created: base }));
    await deliver(app, events.invoicePaymentFailed('sub_1', 'in_2', 2, { created: base + 86_400 }));
    await deliver(
      app,
      events.invoicePaymentFailed('sub_1', 'in_2', 3, { created: base + 432_000 }),
    );
    // Stripe's final state after exhausting retries.
    await deliver(app, events.subscriptionUpdated('sub_1', 'unpaid', { created: base + 604_800 }));

    expect((await subscription('sub_1'))?.status).toBe('unpaid');
    expect(await noticeCount()).toBe(3);
    // Nothing was ever collected, so nothing was ever posted.
    expect(await ledgerTotal(pool, 'revenue')).toBe(0n);
  });

  it('can be cancelled from unpaid', async () => {
    const base = Math.floor(Date.now() / 1000);
    await deliver(app, events.invoicePaymentFailed('sub_1', 'in_3', 1, { created: base }));
    await deliver(app, events.subscriptionUpdated('sub_1', 'unpaid', { created: base + 100 }));
    await deliver(app, events.subscriptionUpdated('sub_1', 'canceled', { created: base + 200 }));

    expect((await subscription('sub_1'))?.status).toBe('canceled');
  });

  it('refuses to skip past_due and go straight to unpaid', async () => {
    const base = Math.floor(Date.now() / 1000);
    await deliver(app, events.subscriptionUpdated('sub_1', 'unpaid', { created: base }));

    // The transition table refuses it: a subscription that has not been
    // through dunning has not been given the chance to recover.
    expect((await subscription('sub_1'))?.status).toBe('active');
  });
});
