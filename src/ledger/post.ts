import type { PoolClient } from '../db/pool.ts';
import type { Account } from './accounts.ts';

export interface Entry {
  account: Account;
  /** Positive is a debit, negative a credit. In the smallest currency unit. */
  amount: bigint;
}

export interface Posting {
  postingId: string;
  currency: string;
  /** What this posting is about — a payment id, a dispute id. */
  reference: string;
  /** Stripe's balance transaction id, where the event carries one. */
  balanceTxn?: string;
  entries: Entry[];
}

export class UnbalancedPostingError extends Error {
  constructor(readonly total: bigint) {
    super(`a posting must sum to zero; this one sums to ${String(total)}`);
    this.name = 'UnbalancedPostingError';
  }
}

export function sumOf(entries: Entry[]): bigint {
  return entries.reduce((total, entry) => total + entry.amount, 0n);
}

/**
 * Writes one balanced posting.
 *
 * The zero-sum check runs before the insert rather than as a periodic audit.
 * An imbalance is always a bug in the caller, and catching it at the moment it
 * happens gives a stack trace pointing at the handler; catching it in a nightly
 * report gives a number and a week of history to search.
 *
 * Returns false when the posting was already applied — a duplicate webhook —
 * rather than throwing, because a duplicate is expected traffic, not an error.
 */
export async function post(client: PoolClient, posting: Posting): Promise<boolean> {
  const total = sumOf(posting.entries);
  if (total !== 0n) throw new UnbalancedPostingError(total);
  if (posting.entries.length === 0) throw new Error('a posting needs entries');

  for (const entry of posting.entries) {
    const result = await client.query(
      `INSERT INTO ledger_entries (posting_id, account, amount, currency, reference, balance_txn)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (balance_txn, account) WHERE balance_txn IS NOT NULL DO NOTHING`,
      [
        posting.postingId,
        entry.account,
        entry.amount.toString(),
        posting.currency,
        posting.reference,
        posting.balanceTxn ?? null,
      ],
    );

    // The first row deciding the whole posting is deliberate: the unique index
    // is on (balance_txn, account), so if one row of a posting was already
    // written, all of them were — they are written together in one
    // transaction.
    if (result.rowCount === 0) return false;
  }

  return true;
}

export async function balanceOf(
  client: PoolClient,
  account: Account,
  currency = 'usd',
): Promise<bigint> {
  const { rows } = await client.query<{ total: string | null }>(
    'SELECT sum(amount)::text AS total FROM ledger_entries WHERE account = $1 AND currency = $2',
    [account, currency],
  );
  return BigInt(rows[0]?.total ?? '0');
}
