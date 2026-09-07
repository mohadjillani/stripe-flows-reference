import type {
  BalanceTransaction,
  CreateIntent,
  CreateRefund,
  IntentResult,
  RefundResult,
  StripeGateway,
} from './client.ts';

export interface RecordedCall {
  method: 'createIntent' | 'createRefund';
  idempotencyKey: string;
  input: CreateIntent | CreateRefund;
}

export interface FakeOptions {
  /** Fail the next N calls, to exercise the retry path. */
  failCalls?: number;
  balanceTransactions?: BalanceTransaction[];
}

/**
 * An in-process Stripe that remembers what it was asked.
 *
 * It exists to test the half of the integration this service is responsible
 * for: that a retry sends the *same* idempotency key, that a refund larger
 * than the remaining amount is refused before Stripe is called, that a crash
 * between the call and the local write is recoverable.
 *
 * It deliberately does not simulate Stripe. It stores responses against the
 * idempotency key the way Stripe does — which is the one behaviour the
 * calling code depends on — and nothing else. A fake that tried to model
 * Stripe's state machine would be a second implementation with its own bugs,
 * and passing tests against it would prove nothing about the real thing.
 */
export function createFakeStripe(options: FakeOptions = {}) {
  const calls: RecordedCall[] = [];
  const byKey = new Map<string, IntentResult | RefundResult>();
  let remainingFailures = options.failCalls ?? 0;
  let counter = 0;

  const gateway: StripeGateway = {
    createIntent(input: CreateIntent): Promise<IntentResult> {
      calls.push({ method: 'createIntent', idempotencyKey: input.idempotencyKey, input });

      const stored = byKey.get(input.idempotencyKey);
      if (stored) return Promise.resolve(stored as IntentResult);

      if (remainingFailures > 0) {
        remainingFailures -= 1;
        // Rejects *after* recording the call, which is the point: the caller
        // must have written its attempt row before this, or the retry cannot
        // reuse the key.
        return Promise.reject(new Error('stripe unavailable'));
      }

      counter += 1;
      const result: IntentResult = {
        id: `pi_fake_${String(counter)}`,
        status: 'requires_payment_method',
        clientSecret: `pi_fake_${String(counter)}_secret`,
      };
      byKey.set(input.idempotencyKey, result);
      return Promise.resolve(result);
    },

    createRefund(input: CreateRefund): Promise<RefundResult> {
      calls.push({ method: 'createRefund', idempotencyKey: input.idempotencyKey, input });

      const stored = byKey.get(input.idempotencyKey);
      if (stored) return Promise.resolve(stored);

      if (remainingFailures > 0) {
        remainingFailures -= 1;
        return Promise.reject(new Error('stripe unavailable'));
      }

      counter += 1;
      const result: RefundResult = { id: `re_fake_${String(counter)}`, status: 'succeeded' };
      byKey.set(input.idempotencyKey, result);
      return Promise.resolve(result);
    },

    listBalanceTransactions(sinceUnix: number, limit = 100): Promise<BalanceTransaction[]> {
      return Promise.resolve(
        (options.balanceTransactions ?? [])
          .filter((txn) => txn.created > sinceUnix)
          .sort((a, b) => a.created - b.created)
          .slice(0, limit),
      );
    },
  };

  return {
    gateway,
    calls,
    /** Every idempotency key the caller has used, in order. */
    keys: (): string[] => calls.map((call) => call.idempotencyKey),
    keyFor: (index: number): string | undefined => calls[index]?.idempotencyKey,
  };
}
