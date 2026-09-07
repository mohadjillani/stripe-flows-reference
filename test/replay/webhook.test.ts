import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as events from '../../fixtures/events/build.ts';
import { checkInvariants } from '../../src/ledger/invariants.ts';
import type { Pool } from '../../src/db/pool.ts';
import {
  countEvents,
  deliver,
  ledgerTotal,
  paymentStatus,
  prepare,
  seedPayment,
  testPool,
  truncate,
  webhookBody,
} from './helpers.ts';

const pool: Pool = testPool();
let app: Express;

beforeAll(async () => {
  app = await prepare(pool);
});

beforeEach(async () => {
  await truncate(pool);
});

// File scope, not inside the first describe: teardown in one block would close
// the pool the later blocks still use.
afterAll(async () => {
  await pool.end();
});

describe('the endpoint', () => {
  it('refuses an unsigned request', async () => {
    const response = await deliver(app, events.paymentIntentSucceeded('pi_1', 1000), {
      secret: 'whsec_wrong',
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ reason: 'no-matching-signature' });
  });

  /**
   * 400, never 500. A bad signature is not transient, and a 500 makes Stripe
   * retry a forged request for days.
   */
  it('refuses a replayed old event with a 400', async () => {
    const response = await deliver(app, events.paymentIntentSucceeded('pi_1', 1000), {
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ reason: 'outside-tolerance' });
  });

  it('stores an event type it has no handler for, and returns 200', async () => {
    const response = await deliver(app, {
      id: 'evt_unknown',
      type: 'radar.early_fraud_warning.created',
      created: Math.floor(Date.now() / 1000),
      data: { object: {} },
    });

    // Returning a non-2xx would make Stripe retry forever, so an event type
    // someone enabled in the dashboard would become an outage nobody
    // configured.
    expect(response.status).toBe(200);
    expect(webhookBody(response).outcome).toBe('ignored');
    expect(await countEvents(pool)).toBe(1);
  });
});

describe('a successful payment', () => {
  beforeEach(async () => {
    await seedPayment(pool, { id: 'pay_1', intentId: 'pi_1', amount: 1000n });
  });

  it('is marked paid only by the webhook', async () => {
    expect(await paymentStatus(pool, 'pay_1')).toBe('pending');
    await deliver(app, events.paymentIntentSucceeded('pi_1', 1000));
    expect(await paymentStatus(pool, 'pay_1')).toBe('paid');
  });

  it('posts a balanced ledger entry including the fee', async () => {
    await deliver(app, events.paymentIntentSucceeded('pi_1', 1000, { fee: 59 }));

    expect(await ledgerTotal(pool, 'revenue')).toBe(-1000n);
    expect(await ledgerTotal(pool, 'fees')).toBe(59n);
    // Ignoring the fee is how a ledger comes to disagree with the bank by
    // exactly Stripe's cut.
    expect(await ledgerTotal(pool, 'stripe_clearing')).toBe(941n);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  /**
   * Stripe delivers at least once. The same event arriving twice must move the
   * money once.
   */
  it('applies a duplicate delivery exactly once', async () => {
    const event = events.paymentIntentSucceeded('pi_1', 1000, { id: 'evt_dup' });

    const first = await deliver(app, event);
    const second = await deliver(app, event);

    expect(webhookBody(first).outcome).toBe('processed');
    expect(webhookBody(second).outcome).toBe('duplicate');
    expect(second.status).toBe(200);
    expect(await ledgerTotal(pool, 'revenue')).toBe(-1000n);
    expect(await countEvents(pool)).toBe(1);
  });
});

describe('events arriving out of order', () => {
  beforeEach(async () => {
    await seedPayment(pool, { id: 'pay_2', intentId: 'pi_2', amount: 1000n });
  });

  /**
   * The sequence that breaks naive integrations. The refund is delivered
   * first; the retried success arrives afterwards and must not resurrect a
   * paid state.
   */
  it('does not resurrect a refunded payment as paid', async () => {
    await deliver(app, events.paymentIntentSucceeded('pi_2', 1000));
    await deliver(app, events.chargeRefunded('pi_2', 1000));
    expect(await paymentStatus(pool, 'pay_2')).toBe('refunded');

    await deliver(app, events.paymentIntentSucceeded('pi_2', 1000, { id: 'evt_retry' }));

    expect(await paymentStatus(pool, 'pay_2')).toBe('refunded');
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('ignores a failure that arrives after a success', async () => {
    await deliver(app, events.paymentIntentSucceeded('pi_2', 1000));
    await deliver(app, events.paymentIntentFailed('pi_2'));

    expect(await paymentStatus(pool, 'pay_2')).toBe('paid');
  });

  it('ignores a requires_action that arrives after a success', async () => {
    await deliver(app, events.paymentIntentSucceeded('pi_2', 1000));
    await deliver(app, events.paymentIntentRequiresAction('pi_2'));

    expect(await paymentStatus(pool, 'pay_2')).toBe('paid');
  });
});

describe('refunds', () => {
  beforeEach(async () => {
    // Seeded as pending, then paid by the event. Seeding it as `paid` would
    // make the success handler correctly skip — a duplicate — and no revenue
    // would ever be posted, which the ledger invariants then report.
    await seedPayment(pool, { id: 'pay_3', intentId: 'pi_3', amount: 1000n });
    await deliver(app, events.paymentIntentSucceeded('pi_3', 1000));
  });

  /**
   * `amount_refunded` is cumulative. Treating it as the size of this refund
   * double-counts the moment a second partial arrives.
   */
  it('posts the delta of two partial refunds, not the totals', async () => {
    await deliver(app, events.chargeRefunded('pi_3', 300, { balanceTxn: 'txn_r1' }));
    expect(await paymentStatus(pool, 'pay_3')).toBe('partially_refunded');
    expect(await ledgerTotal(pool, 'refunds')).toBe(300n);

    await deliver(app, events.chargeRefunded('pi_3', 800, { balanceTxn: 'txn_r2' }));

    // 800 cumulative, not 300 + 800.
    expect(await ledgerTotal(pool, 'refunds')).toBe(800n);
    expect(await paymentStatus(pool, 'pay_3')).toBe('partially_refunded');
  });

  it('marks the payment refunded once the whole amount is back', async () => {
    await deliver(app, events.chargeRefunded('pi_3', 1000, { balanceTxn: 'txn_full' }));
    expect(await paymentStatus(pool, 'pay_3')).toBe('refunded');
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('posts nothing for a redelivered refund', async () => {
    const event = events.chargeRefunded('pi_3', 400, { id: 'evt_r', balanceTxn: 'txn_r' });
    await deliver(app, event);
    await deliver(app, event);

    expect(await ledgerTotal(pool, 'refunds')).toBe(400n);
  });
});

describe('disputes', () => {
  beforeEach(async () => {
    await seedPayment(pool, { id: 'pay_4', intentId: 'pi_4', amount: 2000n });
    await deliver(app, events.paymentIntentSucceeded('pi_4', 2000));
  });

  /**
   * A hold, not a loss. Posting a loss immediately understates the balance for
   * weeks and then has to be reversed when the dispute is won.
   */
  it('holds the amount when a dispute opens', async () => {
    await deliver(app, events.disputeCreated('ch_pi_4', 2000));

    expect(await ledgerTotal(pool, 'dispute_hold')).toBe(2000n);
    expect(await ledgerTotal(pool, 'dispute_loss')).toBe(0n);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('releases the hold when the dispute is won', async () => {
    await deliver(app, events.disputeCreated('ch_pi_4', 2000));
    await deliver(app, events.disputeClosed('ch_pi_4', 2000, 'won'));

    expect(await ledgerTotal(pool, 'dispute_hold')).toBe(0n);
    expect(await ledgerTotal(pool, 'dispute_loss')).toBe(0n);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('writes the hold off when the dispute is lost', async () => {
    await deliver(app, events.disputeCreated('ch_pi_4', 2000));
    await deliver(app, events.disputeClosed('ch_pi_4', 2000, 'lost'));

    expect(await ledgerTotal(pool, 'dispute_hold')).toBe(0n);
    expect(await ledgerTotal(pool, 'dispute_loss')).toBe(2000n);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('ignores a redelivered close', async () => {
    await deliver(app, events.disputeCreated('ch_pi_4', 2000));
    const closed = events.disputeClosed('ch_pi_4', 2000, 'lost', { id: 'evt_closed' });
    await deliver(app, closed);
    await deliver(app, closed);

    expect(await ledgerTotal(pool, 'dispute_loss')).toBe(2000n);
  });
});
