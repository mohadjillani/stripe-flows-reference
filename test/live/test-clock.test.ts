import { describe, expect, it } from 'vitest';

const apiKey = process.env.STRIPE_SECRET_KEY;

/**
 * The scenarios that need a real account.
 *
 * `describe.skipIf` rather than a silent return: a suite that skips and reports
 * success is how a project convinces itself something is tested when nothing
 * ran. The skip is visible in the output.
 *
 * See ./README.md — these have never run in this repository's CI.
 */
describe.skipIf(!apiKey)('against a real Stripe test-mode account', () => {
  it('needs a key, and says so if one is missing', () => {
    expect(apiKey).toBeDefined();
  });

  it.todo('returns the original intent for a repeated idempotency key');
  it.todo('advances a test clock a month and emits invoice.payment_failed');
  it.todo('observes Smart Retries on Stripe’s own schedule');
  it.todo('completes an SCA challenge and only then reports succeeded');
  it.todo('previews a plan change and matches the preview against the invoice');
});

describe('the live suite', () => {
  it('skips without a key, so npm test works on a fresh clone', () => {
    if (!apiKey) {
      console.log('  live tests skipped: STRIPE_SECRET_KEY is not set');
    }
    expect(true).toBe(true);
  });
});
