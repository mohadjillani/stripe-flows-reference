import { ACCOUNTS } from '../../ledger/accounts.ts';
import { post } from '../../ledger/post.ts';
import {
  canTransitionSubscription,
  isSubscriptionState,
  type SubscriptionState,
} from '../../status/transitions.ts';
import { big, num, obj, str, type EventContext, type Handler } from './types.ts';

async function applyState(
  context: EventContext,
  subscriptionId: string,
  to: SubscriptionState,
  extra: { periodEnd?: number; dunning?: 'start' | 'clear' } = {},
): Promise<boolean> {
  const { rows } = await context.client.query<{ status: string; updated_from_ts: string }>(
    'SELECT status, updated_from_ts::text FROM subscriptions WHERE id = $1 FOR UPDATE',
    [subscriptionId],
  );
  const existing = rows[0];
  if (!existing) return false;

  // The ordering guard. Stripe makes no ordering promise, and a retried
  // `past_due` arriving after the `active` that resolved it would otherwise
  // put a paying customer back into dunning.
  if (context.created < Number(existing.updated_from_ts)) return false;

  const from = isSubscriptionState(existing.status) ? existing.status : 'incomplete';
  if (from !== to && !canTransitionSubscription(from, to)) return false;

  await context.client.query(
    `UPDATE subscriptions
        SET status = $2,
            current_period_end = coalesce($3, current_period_end),
            dunning_started_at = CASE
              WHEN $4 = 'start' THEN coalesce(dunning_started_at, now())
              WHEN $4 = 'clear' THEN NULL
              ELSE dunning_started_at END,
            updated_from_ts = $5,
            updated_at = now()
      WHERE id = $1`,
    [
      subscriptionId,
      to,
      extra.periodEnd ? new Date(extra.periodEnd * 1000).toISOString() : null,
      extra.dunning ?? null,
      context.created,
    ],
  );
  return true;
}

export const subscriptionUpdated: Handler = async (context) => {
  const id = str(context.object, 'id');
  const status = str(context.object, 'status');
  if (!id || !status || !isSubscriptionState(status)) return;

  const periodEnd = num(context.object, 'current_period_end');
  await applyState(context, id, status, {
    ...(periodEnd ? { periodEnd } : {}),
    ...(status === 'active' ? { dunning: 'clear' as const } : {}),
  });
};

export const subscriptionDeleted: Handler = async (context) => {
  const id = str(context.object, 'id');
  if (!id) return;
  await applyState(context, id, 'canceled');
};

/**
 * A renewal failed. This is where dunning starts.
 *
 * Cancelling here would be wrong: Stripe's Smart Retries will try the card
 * again over the next couple of weeks and most of these recover. `past_due`
 * says "we have not been paid and we have not given up", which is the state
 * the business actually wants.
 */
export const invoicePaymentFailed: Handler = async (context) => {
  const subscriptionId = str(context.object, 'subscription');
  const invoiceId = str(context.object, 'id');
  if (!subscriptionId || !invoiceId) return;

  const attempt = num(context.object, 'attempt_count') ?? 1;
  const moved = await applyState(context, subscriptionId, 'past_due', { dunning: 'start' });
  if (!moved) return;

  // One notice per invoice per attempt. The unique key is what stops a
  // redelivered event from emailing the customer twice about the same failure
  // — which is the kind of bug that reaches support before it reaches a log.
  await context.client.query(
    `INSERT INTO dunning_notices (subscription_id, invoice_id, attempt)
     VALUES ($1, $2, $3) ON CONFLICT (invoice_id, attempt) DO NOTHING`,
    [subscriptionId, invoiceId, attempt],
  );
};

/** A renewal succeeded: dunning clears and the money is posted. */
export const invoicePaid: Handler = async (context) => {
  const subscriptionId = str(context.object, 'subscription');
  const invoiceId = str(context.object, 'id');
  if (!invoiceId) return;

  if (subscriptionId) {
    const periodEnd = num(context.object, 'period_end');
    await applyState(context, subscriptionId, 'active', {
      dunning: 'clear',
      ...(periodEnd ? { periodEnd } : {}),
    });
  }

  const amount = big(context.object, 'amount_paid') ?? 0n;
  if (amount === 0n) return;

  const currency = str(context.object, 'currency') ?? 'usd';
  const charge = obj(context.object, 'charge');
  const balanceTxn = charge ? str(charge, 'balance_transaction') : undefined;

  await post(context.client, {
    postingId: `invoice_paid:${context.id}`,
    currency,
    reference: invoiceId,
    ...(balanceTxn ? { balanceTxn } : {}),
    entries: [
      { account: ACCOUNTS.STRIPE_CLEARING, amount },
      { account: ACCOUNTS.REVENUE, amount: -amount },
    ],
  });
};
