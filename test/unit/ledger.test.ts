import { describe, expect, it } from 'vitest';
import { sumOf, UnbalancedPostingError } from '../../src/ledger/post.ts';
import { ACCOUNTS } from '../../src/ledger/accounts.ts';
import {
  canTransition,
  canTransitionSubscription,
  PAYMENT_STATES,
  PAYMENT_TRANSITIONS,
  SUBSCRIPTION_STATES,
} from '../../src/status/transitions.ts';
import { idempotencyKeyFor, refundKeyFor } from '../../src/stripe/idempotency.ts';

describe('postings', () => {
  it('sums a balanced posting to zero', () => {
    expect(
      sumOf([
        { account: ACCOUNTS.STRIPE_CLEARING, amount: 970n },
        { account: ACCOUNTS.FEES, amount: 30n },
        { account: ACCOUNTS.REVENUE, amount: -1000n },
      ]),
    ).toBe(0n);
  });

  it('sums an unbalanced posting to what is missing', () => {
    // The fee forgotten. This is the most common ledger bug in a Stripe
    // integration and it is exactly what the zero-sum check catches.
    expect(
      sumOf([
        { account: ACCOUNTS.STRIPE_CLEARING, amount: 970n },
        { account: ACCOUNTS.REVENUE, amount: -1000n },
      ]),
    ).toBe(-30n);
  });

  it('names the imbalance in the error', () => {
    expect(new UnbalancedPostingError(-30n).message).toContain('-30');
  });

  it('handles amounts past Number.MAX_SAFE_INTEGER', () => {
    const huge = 9_007_199_254_740_993n;
    expect(
      sumOf([
        { account: ACCOUNTS.REVENUE, amount: huge },
        { account: ACCOUNTS.STRIPE_CLEARING, amount: -huge },
      ]),
    ).toBe(0n);
  });
});

describe('payment transitions', () => {
  it('lets a pending payment be paid', () => {
    expect(canTransition('pending', 'paid')).toBe(true);
  });

  /**
   * The out-of-order case this table exists for. Stripe makes no ordering
   * promise, and a retried `payment_intent.succeeded` arriving after
   * `charge.refunded` would otherwise mark a refunded payment as paid.
   */
  it('refuses to resurrect a refunded payment as paid', () => {
    expect(canTransition('refunded', 'paid')).toBe(false);
    expect(canTransition('partially_refunded', 'paid')).toBe(false);
  });

  it('refuses to un-fail a payment directly into paid', () => {
    expect(canTransition('failed', 'paid')).toBe(false);
    // A retry goes back to pending first, which allocates a new attempt.
    expect(canTransition('failed', 'pending')).toBe(true);
  });

  it('treats charged_back as terminal', () => {
    expect(PAYMENT_TRANSITIONS.charged_back).toEqual([]);
    for (const state of PAYMENT_STATES) expect(canTransition('charged_back', state)).toBe(false);
  });

  it('names only real states as targets', () => {
    for (const [, targets] of Object.entries(PAYMENT_TRANSITIONS)) {
      for (const target of targets) expect(PAYMENT_STATES).toContain(target);
    }
  });

  it('has no state that can reach itself', () => {
    // Self-transitions would make the guard useless: every duplicate event
    // would be allowed through.
    for (const state of PAYMENT_STATES) {
      if (state === 'partially_refunded') continue; // a second partial refund is real
      expect(canTransition(state, state)).toBe(false);
    }
  });
});

describe('subscription transitions', () => {
  it('recovers from past_due back to active', () => {
    // Smart Retries. Cancelling on the first failure throws away most of the
    // subscriptions that would have recovered on their own.
    expect(canTransitionSubscription('past_due', 'active')).toBe(true);
  });

  it('does not skip past_due on a failed renewal', () => {
    expect(canTransitionSubscription('active', 'unpaid')).toBe(false);
  });

  it('treats canceled as terminal', () => {
    for (const state of SUBSCRIPTION_STATES) {
      expect(canTransitionSubscription('canceled', state)).toBe(false);
    }
  });
});

describe('idempotency keys', () => {
  it('is the same key for the same attempt', () => {
    expect(idempotencyKeyFor('pay_1', 1)).toBe(idempotencyKeyFor('pay_1', 1));
  });

  /**
   * A deliberate second attempt — a different card after a decline — is a
   * different charge. Reusing the key would make Stripe replay the original
   * failure and the customer could never succeed.
   */
  it('is a different key for a different attempt', () => {
    expect(idempotencyKeyFor('pay_1', 1)).not.toBe(idempotencyKeyFor('pay_1', 2));
  });

  it('is a different key for a different payment', () => {
    expect(idempotencyKeyFor('pay_1', 1)).not.toBe(idempotencyKeyFor('pay_2', 1));
  });

  it('refuses an attempt number that is not a positive integer', () => {
    expect(() => idempotencyKeyFor('pay_1', 0)).toThrow(/positive integer/);
    expect(() => idempotencyKeyFor('pay_1', 1.5)).toThrow(/positive integer/);
    expect(() => refundKeyFor('pay_1', -1)).toThrow(/positive integer/);
  });

  it('refuses an empty payment id', () => {
    expect(() => idempotencyKeyFor('', 1)).toThrow(/payment id/);
  });

  it('does not collide between a payment and a refund', () => {
    expect(idempotencyKeyFor('pay_1', 1)).not.toBe(refundKeyFor('pay_1', 1));
  });
});
