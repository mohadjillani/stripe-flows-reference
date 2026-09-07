import { ACCOUNTS } from '../../ledger/accounts.ts';
import { post } from '../../ledger/post.ts';
import { canTransition, isPaymentState } from '../../status/transitions.ts';
import { big, obj, str, type Handler } from './types.ts';

/**
 * A refund, partial or full.
 *
 * `amount_refunded` is cumulative — Stripe reports the total refunded so far,
 * not the size of this refund. Treating it as the latter double-counts the
 * moment a second partial refund arrives, and the books then disagree with
 * Stripe by the size of the first one.
 */
export const chargeRefunded: Handler = async (context) => {
  const intentId = str(context.object, 'payment_intent');
  if (!intentId) return;

  const { rows } = await context.client.query<{
    id: string;
    status: string;
    amount: string;
    currency: string;
    refunded: string;
  }>(
    'SELECT id, status, amount::text, currency, refunded::text FROM payments WHERE intent_id = $1 FOR UPDATE',
    [intentId],
  );
  const payment = rows[0];
  if (!payment) return;

  const cumulative = big(context.object, 'amount_refunded') ?? 0n;
  const alreadyRecorded = BigInt(payment.refunded);
  const delta = cumulative - alreadyRecorded;

  // A redelivery of the same refund reports the same cumulative total, so the
  // delta is zero and there is nothing to post. This is the ordering guard
  // that does not need a timestamp.
  if (delta <= 0n) return;

  const total = BigInt(payment.amount);
  const to = cumulative >= total ? 'refunded' : 'partially_refunded';
  const from = isPaymentState(payment.status) ? payment.status : 'paid';

  if (from !== to && !canTransition(from, to)) return;

  await context.client.query(
    'UPDATE payments SET refunded = $2, status = $3, updated_at = now() WHERE id = $1',
    [payment.id, cumulative.toString(), to],
  );

  const refunds = obj(context.object, 'refunds');
  const latest = Array.isArray(refunds?.data)
    ? (refunds.data[0] as Record<string, unknown>)
    : undefined;
  const balanceTxn = latest ? str(latest, 'balance_transaction') : undefined;

  await post(context.client, {
    postingId: `refund:${context.id}`,
    currency: payment.currency,
    reference: payment.id,
    ...(balanceTxn ? { balanceTxn } : {}),
    entries: [
      { account: ACCOUNTS.REFUNDS, amount: delta },
      { account: ACCOUNTS.STRIPE_CLEARING, amount: -delta },
    ],
  });
};

/**
 * A dispute opens. The money is not gone yet, and it is not ours either.
 *
 * Posting it as a loss immediately understates the balance for weeks and then
 * has to be reversed when the dispute is won. Holding it says what is actually
 * true: this amount is contested.
 */
export const disputeCreated: Handler = async (context) => {
  const disputeId = str(context.object, 'id');
  const chargeId = str(context.object, 'charge');
  const amount = big(context.object, 'amount') ?? 0n;
  const currency = str(context.object, 'currency') ?? 'usd';
  if (!disputeId || !chargeId) return;

  const inserted = await context.client.query(
    `INSERT INTO disputes (id, charge_id, amount, status)
     VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [disputeId, chargeId, amount.toString(), 'open'],
  );
  if (inserted.rowCount === 0) return;

  await context.client.query(
    `UPDATE payments SET status = 'disputed', updated_at = now()
      WHERE intent_id = (SELECT intent_id FROM payments WHERE intent_id = $1)
         OR id = $1`,
    [chargeId],
  );

  await post(context.client, {
    postingId: `dispute_open:${context.id}`,
    currency,
    reference: disputeId,
    entries: [
      { account: ACCOUNTS.DISPUTE_HOLD, amount },
      { account: ACCOUNTS.STRIPE_CLEARING, amount: -amount },
    ],
  });
};

/** A dispute closes: the hold is released, or written off. */
export const disputeClosed: Handler = async (context) => {
  const disputeId = str(context.object, 'id');
  const status = str(context.object, 'status') ?? 'lost';
  const amount = big(context.object, 'amount') ?? 0n;
  const currency = str(context.object, 'currency') ?? 'usd';
  if (!disputeId) return;

  const { rowCount } = await context.client.query(
    `UPDATE disputes SET status = $2, closed_at = now()
      WHERE id = $1 AND closed_at IS NULL`,
    [disputeId, status],
  );
  if (rowCount === 0) return;

  const won = status === 'won' || status === 'warning_closed';

  await post(context.client, {
    postingId: `dispute_closed:${context.id}`,
    currency,
    reference: disputeId,
    entries: won
      ? // Won: the hold goes back to the clearing account.
        [
          { account: ACCOUNTS.DISPUTE_HOLD, amount: -amount },
          { account: ACCOUNTS.STRIPE_CLEARING, amount },
        ]
      : // Lost: the hold becomes a loss. The money is gone, and the fee Stripe
        // charges for the dispute is a separate event.
        [
          { account: ACCOUNTS.DISPUTE_HOLD, amount: -amount },
          { account: ACCOUNTS.DISPUTE_LOSS, amount },
        ],
  });
};
