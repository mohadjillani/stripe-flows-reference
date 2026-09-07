export const PAYMENT_STATES = [
  'pending',
  'requires_action',
  'paid',
  'failed',
  'partially_refunded',
  'refunded',
  'disputed',
  'charged_back',
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

/**
 * Which payment states may follow which.
 *
 * The table exists because webhooks arrive out of order. Stripe makes no
 * ordering guarantee, and `payment_intent.succeeded` arriving after
 * `charge.refunded` is not rare — it is what happens when the first delivery
 * fails and is retried. Without a table, that sequence quietly marks a refunded
 * payment as paid, and nothing anywhere records that it happened.
 *
 * `payment-state-machine` is the property-tested generalisation of this.
 */
export const PAYMENT_TRANSITIONS: Record<PaymentState, PaymentState[]> = {
  pending: ['requires_action', 'paid', 'failed'],
  requires_action: ['paid', 'failed'],
  // A paid payment can be refunded or disputed. It cannot go back to pending.
  paid: ['partially_refunded', 'refunded', 'disputed'],
  failed: ['pending'],
  partially_refunded: ['partially_refunded', 'refunded', 'disputed'],
  refunded: ['disputed'],
  disputed: ['charged_back', 'paid', 'refunded'],
  // Terminal. A chargeback is the end of the story for this payment.
  charged_back: [],
};

export function canTransition(from: PaymentState, to: PaymentState): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export const SUBSCRIPTION_STATES = [
  'incomplete',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
] as const;

export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

export const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionState, SubscriptionState[]> = {
  incomplete: ['active', 'trialing', 'canceled'],
  trialing: ['active', 'past_due', 'canceled'],
  active: ['past_due', 'canceled'],
  // Stripe's Smart Retries run here. Recovery back to active is the common
  // outcome and the reason a failed payment must not cancel immediately.
  past_due: ['active', 'unpaid', 'canceled'],
  unpaid: ['active', 'canceled'],
  canceled: [],
};

export function canTransitionSubscription(from: SubscriptionState, to: SubscriptionState): boolean {
  return SUBSCRIPTION_TRANSITIONS[from].includes(to);
}

export function isPaymentState(value: string): value is PaymentState {
  return (PAYMENT_STATES as readonly string[]).includes(value);
}

export function isSubscriptionState(value: string): value is SubscriptionState {
  return (SUBSCRIPTION_STATES as readonly string[]).includes(value);
}
