import { ACCOUNTS } from '../../ledger/accounts.ts';
import { post } from '../../ledger/post.ts';
import { canTransition, isPaymentState, type PaymentState } from '../../status/transitions.ts';
import { big, obj, str, type EventContext, type Handler } from './types.ts';

async function currentState(context: EventContext, intentId: string) {
  const { rows } = await context.client.query<{
    id: string;
    status: string;
    amount: string;
    currency: string;
  }>('SELECT id, status, amount::text, currency FROM payments WHERE intent_id = $1 FOR UPDATE', [
    intentId,
  ]);
  return rows[0];
}

/**
 * A payment becomes paid here and nowhere else.
 *
 * The redirect back from the payment page is not evidence. The customer can
 * close the tab, the browser can be killed, the return URL can be typed by
 * hand, and none of that changes whether money moved. Marking a payment paid
 * on the redirect is the single most common way a Stripe integration ships a
 * bug that only appears when it matters.
 */
export const paymentIntentSucceeded: Handler = async (context) => {
  const intentId = str(context.object, 'id');
  if (!intentId) return;

  const payment = await currentState(context, intentId);
  if (!payment) return;

  const from = isPaymentState(payment.status) ? payment.status : 'pending';
  const to: PaymentState = 'paid';

  // Out-of-order delivery is the normal case, not the exception. A succeeded
  // event arriving after a refund must not resurrect a paid state, and the
  // transition table is what says so.
  if (from !== to && !canTransition(from, to)) return;
  if (from === to) return;

  await context.client.query('UPDATE payments SET status = $2, updated_at = now() WHERE id = $1', [
    payment.id,
    to,
  ]);

  const charges = obj(context.object, 'latest_charge');
  const balanceTxn =
    str(context.object, 'balance_transaction') ??
    (charges ? str(charges, 'balance_transaction') : undefined);

  const amount = BigInt(payment.amount);
  // The fee is on the balance transaction. Ignoring it is how a ledger comes
  // to disagree with the bank by exactly Stripe's cut.
  const fee = charges ? (big(charges, 'application_fee_amount') ?? 0n) : 0n;

  await post(context.client, {
    postingId: `pi_succeeded:${context.id}`,
    currency: payment.currency,
    reference: payment.id,
    ...(balanceTxn ? { balanceTxn } : {}),
    entries: [
      // Stripe holds the money; we have earned it, less what Stripe took.
      { account: ACCOUNTS.STRIPE_CLEARING, amount: amount - fee },
      { account: ACCOUNTS.FEES, amount: fee },
      { account: ACCOUNTS.REVENUE, amount: -amount },
    ],
  });
};

export const paymentIntentFailed: Handler = async (context) => {
  const intentId = str(context.object, 'id');
  if (!intentId) return;

  const payment = await currentState(context, intentId);
  if (!payment) return;

  const from = isPaymentState(payment.status) ? payment.status : 'pending';
  if (!canTransition(from, 'failed')) return;

  // No ledger posting: a failed charge moved no money. Writing a zero-value
  // posting would be tidy and would make every report harder to read.
  await context.client.query('UPDATE payments SET status = $2, updated_at = now() WHERE id = $1', [
    payment.id,
    'failed',
  ]);
};

export const paymentIntentRequiresAction: Handler = async (context) => {
  const intentId = str(context.object, 'id');
  if (!intentId) return;

  const payment = await currentState(context, intentId);
  if (!payment) return;

  const from = isPaymentState(payment.status) ? payment.status : 'pending';
  if (!canTransition(from, 'requires_action')) return;

  // The SCA challenge. The customer is being asked for a second factor, and
  // the payment is neither paid nor failed until another event says so.
  await context.client.query('UPDATE payments SET status = $2, updated_at = now() WHERE id = $1', [
    payment.id,
    'requires_action',
  ]);
};
