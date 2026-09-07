import type { Pool } from '../db/pool.ts';

export interface Violation {
  invariant: string;
  detail: string;
}

/**
 * The checks that must hold over the whole ledger, at any moment.
 *
 * These are not tests — they run against real data, in CI and on demand,
 * because the failure they catch is one no unit test can: a handler that
 * balances in isolation and double-posts under a redelivery, or two handlers
 * that each look right and disagree about which account a fee comes out of.
 */
export async function checkInvariants(pool: Pool): Promise<Violation[]> {
  const violations: Violation[] = [];

  // 1. Every posting sums to zero. If this fails, some handler wrote entries
  //    that do not balance, and the books are wrong from that moment on.
  const unbalanced = await pool.query<{ posting_id: string; total: string }>(
    `SELECT posting_id, sum(amount)::text AS total
       FROM ledger_entries GROUP BY posting_id HAVING sum(amount) <> 0`,
  );
  for (const row of unbalanced.rows) {
    violations.push({
      invariant: 'postings balance',
      detail: `posting ${row.posting_id} sums to ${row.total}`,
    });
  }

  // 2. The whole ledger sums to zero, per currency. Implied by (1), and cheap
  //    enough to check separately: it catches an entry written outside a
  //    posting, which (1) cannot see.
  const perCurrency = await pool.query<{ currency: string; total: string }>(
    `SELECT currency, sum(amount)::text AS total
       FROM ledger_entries GROUP BY currency HAVING sum(amount) <> 0`,
  );
  for (const row of perCurrency.rows) {
    violations.push({
      invariant: 'the ledger balances',
      detail: `${row.currency} sums to ${row.total}`,
    });
  }

  // 3. No balance transaction is posted twice to the same account. The unique
  //    index enforces it; this asserts the index is still there, which is the
  //    kind of thing a migration quietly drops.
  const doubled = await pool.query<{ balance_txn: string; account: string; count: string }>(
    `SELECT balance_txn, account, count(*)::text AS count
       FROM ledger_entries WHERE balance_txn IS NOT NULL
      GROUP BY balance_txn, account HAVING count(*) > 1`,
  );
  for (const row of doubled.rows) {
    violations.push({
      invariant: 'no double posting',
      detail: `${row.balance_txn} posted ${row.count} times to ${row.account}`,
    });
  }

  // 4. Refunds never exceed what was captured for a payment. The database
  //    constraint covers `payments`; this catches a ledger that disagrees
  //    with it.
  const overRefunded = await pool.query<{ reference: string; refunded: string; captured: string }>(
    `SELECT reference,
            abs(sum(amount) FILTER (WHERE account = 'refunds'))::text AS refunded,
            coalesce(abs(sum(amount) FILTER (WHERE account = 'revenue')), 0)::text AS captured
       FROM ledger_entries GROUP BY reference
      HAVING abs(sum(amount) FILTER (WHERE account = 'refunds'))
             > abs(coalesce(sum(amount) FILTER (WHERE account = 'revenue'), 0))`,
  );
  for (const row of overRefunded.rows) {
    violations.push({
      invariant: 'refunds do not exceed capture',
      detail: `${row.reference}: refunded ${row.refunded} against ${row.captured}`,
    });
  }

  return violations;
}
