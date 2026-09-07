import { createPool, type Pool } from '../db/pool.ts';
import { createStripeGateway, type StripeGateway } from '../stripe/client.ts';
import { isMainModule } from '../db/migrate.ts';
import { diff, type Finding, type LedgerRow } from './diff.ts';

export interface ReconcileResult {
  runId: number;
  findings: Finding[];
  watermark: number;
  examined: number;
}

/**
 * One reconciliation pass.
 *
 * The watermark advances only after a clean page. A run that crashes halfway
 * re-examines what it already looked at, which is wasteful and correct;
 * advancing optimistically would skip a window forever, and the drift it
 * contained would never be found again.
 */
export async function reconcile(
  pool: Pool,
  stripe: StripeGateway,
  options: { pageSize?: number } = {},
): Promise<ReconcileResult> {
  const { rows: watermarkRows } = await pool.query<{ watermark: string }>(
    'SELECT coalesce(max(watermark), 0)::text AS watermark FROM reconciliation_runs WHERE findings = 0',
  );
  const watermark = Number(watermarkRows[0]?.watermark ?? 0);

  const { rows: runRows } = await pool.query<{ id: string }>(
    'INSERT INTO reconciliation_runs (watermark) VALUES ($1) RETURNING id',
    [watermark],
  );
  const runId = Number(runRows[0]?.id);

  const upstream = await stripe.listBalanceTransactions(watermark, options.pageSize ?? 100);

  const { rows: ledgerRows } = await pool.query<{
    balance_txn: string;
    amount: string;
    currency: string;
  }>(
    // Summed per transaction: one balance transaction is several ledger rows,
    // and the amount to compare is the net movement in the clearing account —
    // the account that mirrors Stripe's own balance.
    `SELECT balance_txn, sum(amount)::text AS amount, min(currency) AS currency
       FROM ledger_entries
      WHERE balance_txn IS NOT NULL AND account = 'stripe_clearing'
      GROUP BY balance_txn`,
  );

  const local: LedgerRow[] = ledgerRows.map((row) => ({
    balanceTxn: row.balance_txn,
    amount: BigInt(row.amount),
    currency: row.currency,
  }));

  // Only compare against the window that was fetched. Every local row outside
  // it would otherwise read as `missing_upstream`, which is a page of false
  // findings that trains everyone to ignore the report.
  const upstreamIds = new Set(upstream.map((txn) => txn.id));
  const inWindow = local.filter((row) => upstreamIds.has(row.balanceTxn));

  const findings = diff(upstream, inWindow);

  for (const finding of findings) {
    await pool.query(
      'INSERT INTO reconciliation_findings (run_id, kind, balance_txn, detail) VALUES ($1, $2, $3, $4)',
      [runId, finding.kind, finding.balanceTxn, JSON.stringify(finding.detail)],
    );
  }

  const highest = upstream.reduce((max, txn) => Math.max(max, txn.created), watermark);
  await pool.query(
    'UPDATE reconciliation_runs SET finished_at = now(), findings = $2, watermark = $3 WHERE id = $1',
    [runId, findings.length, findings.length === 0 ? highest : watermark],
  );

  return {
    runId,
    findings,
    watermark: findings.length === 0 ? highest : watermark,
    examined: upstream.length,
  };
}

if (isMainModule(import.meta.url)) {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    console.error('reconciliation needs STRIPE_SECRET_KEY: it compares the ledger against Stripe');
    process.exit(2);
  }

  const pool = createPool();
  try {
    const result = await reconcile(pool, createStripeGateway(apiKey));
    console.log(
      `run ${String(result.runId)}: examined ${String(result.examined)}, ${String(result.findings.length)} findings`,
    );
    for (const finding of result.findings) {
      console.error(`  ${finding.kind} ${finding.balanceTxn} ${JSON.stringify(finding.detail)}`);
    }
    // Non-zero on any finding: this is meant to run on a schedule and page
    // someone, not to write a report nobody opens.
    if (result.findings.length > 0) process.exit(1);
  } finally {
    await pool.end();
  }
}
