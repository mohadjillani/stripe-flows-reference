import type { BalanceTransaction } from '../stripe/client.ts';

export interface LedgerRow {
  balanceTxn: string;
  amount: bigint;
  currency: string;
}

export type FindingKind =
  'missing_locally' | 'missing_upstream' | 'amount_mismatch' | 'currency_mismatch';

export interface Finding {
  kind: FindingKind;
  balanceTxn: string;
  detail: Record<string, string>;
}

/**
 * Compares what Stripe says happened with what the ledger recorded.
 *
 * The point of reconciliation is that both sides can be wrong in ways neither
 * notices alone. A dropped webhook leaves money in Stripe with no local record;
 * a handler bug posts an amount that does not match; a duplicate that slipped
 * past the unique index posts twice. None of these throw an error at the time,
 * and all of them are found here.
 *
 * Pure and synchronous on purpose: this is the part with the interesting edge
 * cases, and it should be testable without a database or a network.
 */
export function diff(upstream: BalanceTransaction[], local: LedgerRow[]): Finding[] {
  const findings: Finding[] = [];
  const localByTxn = new Map(local.map((row) => [row.balanceTxn, row]));
  const upstreamIds = new Set(upstream.map((txn) => txn.id));

  for (const txn of upstream) {
    const row = localByTxn.get(txn.id);

    if (!row) {
      // The common one, and the expensive one: Stripe moved money and nothing
      // here recorded it. Usually a webhook that was never delivered or an
      // endpoint that was down long enough for Stripe to give up.
      findings.push({
        kind: 'missing_locally',
        balanceTxn: txn.id,
        detail: { amount: txn.amount.toString(), currency: txn.currency, type: txn.type },
      });
      continue;
    }

    if (row.amount !== txn.amount) {
      findings.push({
        kind: 'amount_mismatch',
        balanceTxn: txn.id,
        detail: { upstream: txn.amount.toString(), local: row.amount.toString() },
      });
    }

    if (row.currency !== txn.currency) {
      // Rare and serious: two currencies compared as numbers is how a report
      // adds euros to dollars and nobody notices for a quarter.
      findings.push({
        kind: 'currency_mismatch',
        balanceTxn: txn.id,
        detail: { upstream: txn.currency, local: row.currency },
      });
    }
  }

  for (const row of local) {
    if (!upstreamIds.has(row.balanceTxn)) {
      // A local entry claiming a balance transaction Stripe does not have.
      // Either the window is wrong, or something wrote a transaction id that
      // was never real.
      findings.push({
        kind: 'missing_upstream',
        balanceTxn: row.balanceTxn,
        detail: { amount: row.amount.toString(), currency: row.currency },
      });
    }
  }

  return findings;
}
