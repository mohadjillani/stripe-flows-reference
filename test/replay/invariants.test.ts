import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.ts';
import type { Pool } from '../../src/db/pool.ts';
import { withTransaction } from '../../src/db/pool.ts';
import { checkInvariants } from '../../src/ledger/invariants.ts';
import { ACCOUNTS } from '../../src/ledger/accounts.ts';
import { balanceOf, post, UnbalancedPostingError } from '../../src/ledger/post.ts';
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

describe('posting', () => {
  it('writes a balanced posting and reports the balances', async () => {
    await withTransaction(pool, async (client) => {
      const written = await post(client, {
        postingId: 'p1',
        currency: 'usd',
        reference: 'pay_1',
        balanceTxn: 'txn_1',
        entries: [
          { account: ACCOUNTS.STRIPE_CLEARING, amount: 1000n },
          { account: ACCOUNTS.REVENUE, amount: -1000n },
        ],
      });

      expect(written).toBe(true);
      expect(await balanceOf(client, ACCOUNTS.REVENUE)).toBe(-1000n);
      expect(await balanceOf(client, ACCOUNTS.STRIPE_CLEARING)).toBe(1000n);
    });
  });

  it('refuses an unbalanced posting before it reaches the database', async () => {
    await withTransaction(pool, async (client) => {
      await expect(
        post(client, {
          postingId: 'p2',
          currency: 'usd',
          reference: 'pay_2',
          // The fee forgotten — the most common ledger bug in a Stripe
          // integration.
          entries: [
            { account: ACCOUNTS.STRIPE_CLEARING, amount: 970n },
            { account: ACCOUNTS.REVENUE, amount: -1000n },
          ],
        }),
      ).rejects.toThrow(UnbalancedPostingError);
    });
  });

  it('refuses a posting with no entries', async () => {
    await withTransaction(pool, async (client) => {
      await expect(
        post(client, { postingId: 'p3', currency: 'usd', reference: 'x', entries: [] }),
      ).rejects.toThrow(/needs entries/);
    });
  });

  /**
   * Duplicate delivery is expected traffic, not an error, so the second
   * posting reports false rather than throwing.
   */
  it('reports a duplicate rather than double-posting', async () => {
    const posting = {
      postingId: 'p4',
      currency: 'usd',
      reference: 'pay_4',
      balanceTxn: 'txn_4',
      entries: [
        { account: ACCOUNTS.STRIPE_CLEARING, amount: 500n },
        { account: ACCOUNTS.REVENUE, amount: -500n },
      ],
    };

    await withTransaction(pool, (client) => post(client, posting));
    const second = await withTransaction(pool, (client) => post(client, posting));

    expect(second).toBe(false);
    expect(await checkInvariants(pool)).toEqual([]);
  });

  it('allows two postings with no balance transaction between them', async () => {
    // Only entries carrying a balance transaction are deduplicated; a posting
    // without one — a dispute hold, say — must not be blocked by an earlier
    // one.
    await withTransaction(pool, async (client) => {
      await post(client, {
        postingId: 'p5',
        currency: 'usd',
        reference: 'd1',
        entries: [
          { account: ACCOUNTS.DISPUTE_HOLD, amount: 100n },
          { account: ACCOUNTS.STRIPE_CLEARING, amount: -100n },
        ],
      });
      await post(client, {
        postingId: 'p6',
        currency: 'usd',
        reference: 'd2',
        entries: [
          { account: ACCOUNTS.DISPUTE_HOLD, amount: 200n },
          { account: ACCOUNTS.STRIPE_CLEARING, amount: -200n },
        ],
      });
    });

    expect(await checkInvariants(pool)).toEqual([]);
  });
});

/**
 * The invariants are checked by breaking them on purpose.
 *
 * A check that has only ever been run against correct data is a check nobody
 * knows works. Each of these writes the damage directly, bypassing `post`,
 * and asserts the report names it.
 */
describe('invariants catch damage written behind the API', () => {
  it('finds a posting that does not balance', async () => {
    await pool.query(
      `INSERT INTO ledger_entries (posting_id, account, amount, currency, reference)
       VALUES ('bad', 'revenue', -1000, 'usd', 'pay_x'),
              ('bad', 'stripe_clearing', 900, 'usd', 'pay_x')`,
    );

    const violations = await checkInvariants(pool);
    expect(violations.map((violation) => violation.invariant)).toContain('postings balance');
    expect(
      violations.find((violation) => violation.invariant === 'postings balance')?.detail,
    ).toContain('-100');
  });

  it('finds a ledger that does not sum to zero for a currency', async () => {
    await pool.query(
      `INSERT INTO ledger_entries (posting_id, account, amount, currency, reference)
       VALUES ('stray', 'revenue', -50, 'eur', 'pay_y')`,
    );

    const violations = await checkInvariants(pool);
    expect(violations.map((violation) => violation.invariant)).toContain('the ledger balances');
  });

  it('finds refunds exceeding what was captured', async () => {
    await pool.query(
      `INSERT INTO ledger_entries (posting_id, account, amount, currency, reference)
       VALUES ('c', 'revenue', -100, 'usd', 'pay_z'),
              ('c', 'stripe_clearing', 100, 'usd', 'pay_z'),
              ('r', 'refunds', 500, 'usd', 'pay_z'),
              ('r', 'stripe_clearing', -500, 'usd', 'pay_z')`,
    );

    const violations = await checkInvariants(pool);
    expect(violations.map((violation) => violation.invariant)).toContain(
      'refunds do not exceed capture',
    );
  });

  it('is silent on a healthy ledger', async () => {
    await withTransaction(pool, (client) =>
      post(client, {
        postingId: 'ok',
        currency: 'usd',
        reference: 'pay_ok',
        entries: [
          { account: ACCOUNTS.STRIPE_CLEARING, amount: 300n },
          { account: ACCOUNTS.REVENUE, amount: -300n },
        ],
      }),
    );

    expect(await checkInvariants(pool)).toEqual([]);
  });
});
