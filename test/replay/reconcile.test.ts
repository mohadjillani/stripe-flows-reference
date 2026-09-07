import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import * as events from '../../fixtures/events/build.ts';
import { migrate } from '../../src/db/migrate.ts';
import type { Pool } from '../../src/db/pool.ts';
import { createFakeStripe } from '../../src/stripe/fake.ts';
import { reconcile } from '../../src/reconcile/job.ts';
import { deliver, prepare, seedPayment, testPool, truncate } from './helpers.ts';

const pool: Pool = testPool();
let app: Express;

beforeAll(async () => {
  await migrate(pool);
  app = await prepare(pool);
});

beforeEach(async () => {
  await truncate(pool);
});

afterAll(async () => {
  await pool.end();
});

const CREATED = 1_700_000_000;

async function paidPayment(id: string, intentId: string, amount: number, balanceTxn: string) {
  await seedPayment(pool, { id, intentId, amount: BigInt(amount) });
  await deliver(app, events.paymentIntentSucceeded(intentId, amount, { balanceTxn }));
}

describe('reconciliation', () => {
  it('finds nothing when the ledger matches Stripe', async () => {
    await paidPayment('pay_r1', 'pi_r1', 1000, 'txn_r1');

    const stripe = createFakeStripe({
      balanceTransactions: [
        { id: 'txn_r1', amount: 1000n, currency: 'usd', type: 'charge', created: CREATED },
      ],
    });

    const result = await reconcile(pool, stripe.gateway);
    expect(result.findings).toEqual([]);
    expect(result.examined).toBe(1);
  });

  /**
   * The failure reconciliation exists for: a webhook that was never delivered.
   * Nothing threw, nothing logged, and the money is in Stripe with no local
   * record of it.
   */
  it('finds money Stripe has that never reached the ledger', async () => {
    const stripe = createFakeStripe({
      balanceTransactions: [
        { id: 'txn_lost', amount: 4200n, currency: 'usd', type: 'charge', created: CREATED },
      ],
    });

    const result = await reconcile(pool, stripe.gateway);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: 'missing_locally', balanceTxn: 'txn_lost' });
  });

  it('finds an amount that does not match', async () => {
    await paidPayment('pay_r2', 'pi_r2', 1000, 'txn_r2');

    const stripe = createFakeStripe({
      balanceTransactions: [
        { id: 'txn_r2', amount: 1500n, currency: 'usd', type: 'charge', created: CREATED },
      ],
    });

    expect((await reconcile(pool, stripe.gateway)).findings[0]).toMatchObject({
      kind: 'amount_mismatch',
    });
  });

  it('finds drift introduced by a deleted ledger row', async () => {
    await paidPayment('pay_r3', 'pi_r3', 1000, 'txn_r3');
    await pool.query(`DELETE FROM ledger_entries WHERE balance_txn = 'txn_r3'`);

    const stripe = createFakeStripe({
      balanceTransactions: [
        { id: 'txn_r3', amount: 1000n, currency: 'usd', type: 'charge', created: CREATED },
      ],
    });

    expect((await reconcile(pool, stripe.gateway)).findings[0]?.kind).toBe('missing_locally');
  });

  it('writes every finding so someone can look at them later', async () => {
    const stripe = createFakeStripe({
      balanceTransactions: [
        { id: 'txn_a', amount: 100n, currency: 'usd', type: 'charge', created: CREATED },
        { id: 'txn_b', amount: 200n, currency: 'usd', type: 'charge', created: CREATED + 1 },
      ],
    });

    const result = await reconcile(pool, stripe.gateway);
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM reconciliation_findings WHERE run_id = $1',
      [result.runId],
    );
    expect(rows[0]?.count).toBe('2');
  });

  /**
   * The watermark only moves after a clean pass. Advancing it optimistically
   * would skip the window that contained the drift, and it would never be
   * looked at again.
   */
  it('does not advance the watermark past a run with findings', async () => {
    const dirty = createFakeStripe({
      balanceTransactions: [
        { id: 'txn_bad', amount: 100n, currency: 'usd', type: 'charge', created: CREATED },
      ],
    });

    const first = await reconcile(pool, dirty.gateway);
    expect(first.findings).toHaveLength(1);
    expect(first.watermark).toBe(0);

    // The same window is examined again on the next run, rather than skipped.
    const second = await reconcile(pool, dirty.gateway);
    expect(second.examined).toBe(1);
  });

  it('advances the watermark after a clean pass', async () => {
    await paidPayment('pay_r4', 'pi_r4', 700, 'txn_r4');
    const stripe = createFakeStripe({
      balanceTransactions: [
        { id: 'txn_r4', amount: 700n, currency: 'usd', type: 'charge', created: CREATED },
      ],
    });

    const first = await reconcile(pool, stripe.gateway);
    expect(first.watermark).toBe(CREATED);

    // Nothing new since the watermark, so the second run has nothing to do.
    const second = await reconcile(pool, stripe.gateway);
    expect(second.examined).toBe(0);
    expect(second.findings).toEqual([]);
  });

  /**
   * Every ledger row outside the fetched window would otherwise read as
   * `missing_upstream` — a page of false findings that trains everyone to
   * ignore the report.
   */
  it('does not report local rows from outside the fetched window', async () => {
    await paidPayment('pay_old', 'pi_old', 300, 'txn_old');
    await paidPayment('pay_new', 'pi_new', 400, 'txn_new');

    const stripe = createFakeStripe({
      balanceTransactions: [
        { id: 'txn_new', amount: 400n, currency: 'usd', type: 'charge', created: CREATED },
      ],
    });

    expect((await reconcile(pool, stripe.gateway)).findings).toEqual([]);
  });
});
