/**
 * Stripe-shaped events, constructed rather than recorded.
 *
 * Recording real events needs a key; these are built from Stripe's documented
 * object shapes and the SDK's own types, and carry only the fields the handlers
 * read. That is the honest trade: the shapes are right for the fields under
 * test and absent everywhere else, so a handler that started depending on an
 * undocumented field would fail here rather than in production.
 *
 * `test/live/` is where the same scenarios run against real events, for anyone
 * with a key.
 */
export interface EventOptions {
  id?: string;
  created?: number;
}

let sequence = 0;

function envelope(type: string, object: Record<string, unknown>, options: EventOptions = {}) {
  sequence += 1;
  return {
    id: options.id ?? `evt_test_${String(sequence)}`,
    object: 'event',
    type,
    api_version: '2026-02-25.clover',
    created: options.created ?? Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object },
  };
}

export function paymentIntentSucceeded(
  intentId: string,
  amount: number,
  extra: { balanceTxn?: string; fee?: number } & EventOptions = {},
) {
  return envelope(
    'payment_intent.succeeded',
    {
      id: intentId,
      object: 'payment_intent',
      amount,
      currency: 'usd',
      status: 'succeeded',
      latest_charge: {
        id: `ch_${intentId}`,
        object: 'charge',
        balance_transaction: extra.balanceTxn ?? `txn_${intentId}`,
        application_fee_amount: extra.fee ?? 0,
      },
    },
    extra,
  );
}

export function paymentIntentFailed(intentId: string, options: EventOptions = {}) {
  return envelope(
    'payment_intent.payment_failed',
    {
      id: intentId,
      object: 'payment_intent',
      status: 'requires_payment_method',
      last_payment_error: { code: 'card_declined', message: 'Your card was declined.' },
    },
    options,
  );
}

export function paymentIntentRequiresAction(intentId: string, options: EventOptions = {}) {
  return envelope(
    'payment_intent.requires_action',
    {
      id: intentId,
      object: 'payment_intent',
      status: 'requires_action',
      // The SCA challenge: the customer has to complete a second factor before
      // anything is captured.
      next_action: { type: 'use_stripe_sdk' },
    },
    options,
  );
}

/** `amount_refunded` is cumulative, which is the trap this fixture exists to test. */
export function chargeRefunded(
  intentId: string,
  cumulativeRefunded: number,
  extra: { balanceTxn?: string } & EventOptions = {},
) {
  return envelope(
    'charge.refunded',
    {
      id: `ch_${intentId}`,
      object: 'charge',
      payment_intent: intentId,
      amount_refunded: cumulativeRefunded,
      refunds: {
        object: 'list',
        data: [
          {
            id: `re_${String(cumulativeRefunded)}`,
            object: 'refund',
            amount: cumulativeRefunded,
            balance_transaction:
              extra.balanceTxn ?? `txn_re_${intentId}_${String(cumulativeRefunded)}`,
          },
        ],
      },
    },
    extra,
  );
}

export function invoicePaymentFailed(
  subscriptionId: string,
  invoiceId: string,
  attempt: number,
  options: EventOptions = {},
) {
  return envelope(
    'invoice.payment_failed',
    {
      id: invoiceId,
      object: 'invoice',
      subscription: subscriptionId,
      attempt_count: attempt,
      amount_due: 2000,
      currency: 'usd',
    },
    options,
  );
}

export function invoicePaid(
  subscriptionId: string,
  invoiceId: string,
  amountPaid: number,
  extra: { balanceTxn?: string; periodEnd?: number } & EventOptions = {},
) {
  return envelope(
    'invoice.paid',
    {
      id: invoiceId,
      object: 'invoice',
      subscription: subscriptionId,
      amount_paid: amountPaid,
      currency: 'usd',
      period_end: extra.periodEnd ?? Math.floor(Date.now() / 1000) + 2_592_000,
      charge: {
        id: `ch_${invoiceId}`,
        balance_transaction: extra.balanceTxn ?? `txn_${invoiceId}`,
      },
    },
    extra,
  );
}

export function subscriptionUpdated(
  subscriptionId: string,
  status: string,
  extra: { periodEnd?: number } & EventOptions = {},
) {
  return envelope(
    'customer.subscription.updated',
    {
      id: subscriptionId,
      object: 'subscription',
      status,
      current_period_end: extra.periodEnd ?? Math.floor(Date.now() / 1000) + 2_592_000,
    },
    extra,
  );
}

export function disputeCreated(chargeId: string, amount: number, options: EventOptions = {}) {
  return envelope(
    'charge.dispute.created',
    {
      id: `dp_${chargeId}`,
      object: 'dispute',
      charge: chargeId,
      amount,
      currency: 'usd',
      status: 'warning_needs_response',
    },
    options,
  );
}

export function disputeClosed(
  chargeId: string,
  amount: number,
  status: 'won' | 'lost',
  options: EventOptions = {},
) {
  return envelope(
    'charge.dispute.closed',
    { id: `dp_${chargeId}`, object: 'dispute', charge: chargeId, amount, currency: 'usd', status },
    options,
  );
}

export function resetSequence(): void {
  sequence = 0;
}
