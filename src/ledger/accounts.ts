/**
 * The accounts money moves between.
 *
 * A payment is not one number changing; it is value moving from one place to
 * another, and naming the places is what makes a mistake visible. "Revenue went
 * up by 10 and nothing went down" is caught by the balance check; "the status
 * column says paid" is not.
 */
export const ACCOUNTS = {
  /** What the customer owes, or has paid. Debited when a charge succeeds. */
  CUSTOMER: 'customer',
  /** Money Stripe holds on our behalf before payout. */
  STRIPE_CLEARING: 'stripe_clearing',
  /** What we earned. */
  REVENUE: 'revenue',
  /** Stripe's cut. Not revenue, and easy to forget entirely. */
  FEES: 'fees',
  /** Money given back. */
  REFUNDS: 'refunds',
  /** Held while a dispute is open — not lost yet, and not ours either. */
  DISPUTE_HOLD: 'dispute_hold',
  /** Written off when a dispute is lost. */
  DISPUTE_LOSS: 'dispute_loss',
} as const;

export type Account = (typeof ACCOUNTS)[keyof typeof ACCOUNTS];
