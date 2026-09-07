import Stripe from 'stripe';

export interface CreateIntent {
  paymentId: string;
  amount: bigint;
  currency: string;
  customerId: string;
  idempotencyKey: string;
}

export interface IntentResult {
  id: string;
  status: string;
  clientSecret?: string;
}

export interface CreateRefund {
  intentId: string;
  amount: bigint;
  idempotencyKey: string;
}

export interface RefundResult {
  id: string;
  status: string;
}

export interface BalanceTransaction {
  id: string;
  amount: bigint;
  currency: string;
  type: string;
  created: number;
  source?: string;
}

/**
 * Everything this service asks Stripe to do.
 *
 * Narrow on purpose. Behind it sits either the real SDK or an in-process fake,
 * and the narrower it is the less the fake has to pretend — which is what makes
 * the fake trustworthy enough to test against.
 *
 * It also puts every outbound call in one place, so "does this carry an
 * idempotency key" is a question with one place to look.
 */
export interface StripeGateway {
  createIntent(input: CreateIntent): Promise<IntentResult>;
  createRefund(input: CreateRefund): Promise<RefundResult>;
  /** Pages balance transactions since a watermark, for reconciliation. */
  listBalanceTransactions(sinceUnix: number, limit?: number): Promise<BalanceTransaction[]>;
}

export function createStripeGateway(apiKey: string): StripeGateway {
  // Pinned to the version this code was written against. Letting the SDK pick
  // means an API version change arrives with a dependency bump rather than
  // with a deliberate migration — and Stripe's object shapes do change.
  const stripe = new Stripe(apiKey, { apiVersion: '2026-02-25.clover' });

  return {
    async createIntent(input) {
      const intent = await stripe.paymentIntents.create(
        {
          amount: Number(input.amount),
          currency: input.currency,
          customer: input.customerId,
          // Not `automatic`: the point of this repository is the flow where the
          // customer has to complete a challenge, and letting Stripe confirm
          // automatically would skip it.
          automatic_payment_methods: { enabled: true },
          metadata: { paymentId: input.paymentId },
        },
        // The key goes on the request, not in the body. Stripe stores the
        // response against it for 24 hours and returns the original on a
        // retry, which is what makes a crash-and-retry safe.
        { idempotencyKey: input.idempotencyKey },
      );

      return {
        id: intent.id,
        status: intent.status,
        ...(intent.client_secret ? { clientSecret: intent.client_secret } : {}),
      };
    },

    async createRefund(input) {
      const refund = await stripe.refunds.create(
        { payment_intent: input.intentId, amount: Number(input.amount) },
        { idempotencyKey: input.idempotencyKey },
      );
      return { id: refund.id, status: refund.status ?? 'unknown' };
    },

    async listBalanceTransactions(sinceUnix, limit = 100) {
      const page = await stripe.balanceTransactions.list({
        created: { gt: sinceUnix },
        limit,
      });

      return page.data.map((txn) => ({
        id: txn.id,
        amount: BigInt(txn.amount),
        currency: txn.currency,
        type: txn.type,
        created: txn.created,
        ...(typeof txn.source === 'string' ? { source: txn.source } : {}),
      }));
    },
  };
}
