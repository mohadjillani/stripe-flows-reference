import { describe, expect, it } from 'vitest';
import { diff, type LedgerRow } from '../../src/reconcile/diff.ts';
import type { BalanceTransaction } from '../../src/stripe/client.ts';

function txn(id: string, amount: bigint, currency = 'usd'): BalanceTransaction {
  return { id, amount, currency, type: 'charge', created: 1_700_000_000 };
}

function row(balanceTxn: string, amount: bigint, currency = 'usd'): LedgerRow {
  return { balanceTxn, amount, currency };
}

describe('diff', () => {
  it('finds nothing when both sides agree', () => {
    expect(diff([txn('txn_1', 1000n)], [row('txn_1', 1000n)])).toEqual([]);
  });

  /**
   * The expensive one: Stripe moved money and nothing here recorded it.
   * Usually a webhook that was never delivered, or an endpoint that was down
   * long enough for Stripe to stop retrying.
   */
  it('reports money Stripe has that the ledger does not', () => {
    const findings = diff([txn('txn_1', 1000n)], []);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'missing_locally', balanceTxn: 'txn_1' });
    expect(findings[0]?.detail.amount).toBe('1000');
  });

  it('reports a ledger entry Stripe does not have', () => {
    expect(diff([], [row('txn_ghost', 500n)])[0]).toMatchObject({
      kind: 'missing_upstream',
      balanceTxn: 'txn_ghost',
    });
  });

  it('reports an amount that does not match', () => {
    const findings = diff([txn('txn_1', 1000n)], [row('txn_1', 970n)]);
    expect(findings[0]).toMatchObject({ kind: 'amount_mismatch' });
    // Both numbers, so whoever reads the finding does not have to go and look
    // one of them up.
    expect(findings[0]?.detail).toEqual({ upstream: '1000', local: '970' });
  });

  it('reports a currency that does not match', () => {
    // Two currencies compared as numbers is how a report adds euros to dollars
    // and nobody notices for a quarter.
    const findings = diff([txn('txn_1', 1000n, 'eur')], [row('txn_1', 1000n, 'usd')]);
    expect(findings[0]).toMatchObject({ kind: 'currency_mismatch' });
  });

  it('reports both when an entry is wrong in two ways', () => {
    const findings = diff([txn('txn_1', 1000n, 'eur')], [row('txn_1', 970n, 'usd')]);
    expect(findings.map((finding) => finding.kind).sort()).toEqual([
      'amount_mismatch',
      'currency_mismatch',
    ]);
  });

  it('handles amounts too large for a JavaScript number', () => {
    const huge = 9_007_199_254_740_993n;
    expect(diff([txn('txn_1', huge)], [row('txn_1', huge)])).toEqual([]);
    expect(diff([txn('txn_1', huge)], [row('txn_1', huge - 1n)])).toHaveLength(1);
  });

  it('finds every discrepancy in a mixed page rather than stopping at the first', () => {
    const findings = diff(
      [txn('ok', 100n), txn('wrong', 200n), txn('absent', 300n)],
      [row('ok', 100n), row('wrong', 250n), row('extra', 400n)],
    );

    expect(findings.map((finding) => finding.kind).sort()).toEqual([
      'amount_mismatch',
      'missing_locally',
      'missing_upstream',
    ]);
  });

  it('treats a negative amount as a value, not as absent', () => {
    // Refunds and dispute holds are negative movements in the clearing
    // account, and a truthiness check on the amount would drop them.
    expect(diff([txn('txn_r', -500n)], [row('txn_r', -500n)])).toEqual([]);
    expect(diff([txn('txn_r', -500n)], [row('txn_r', 500n)])[0]?.kind).toBe('amount_mismatch');
  });

  it('is empty for two empty sides', () => {
    expect(diff([], [])).toEqual([]);
  });
});
