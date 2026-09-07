# Live tests

These run against a real Stripe test-mode account, using
[test clocks](https://docs.stripe.com/billing/testing/test-clocks) to advance a
subscription through a month in seconds.

**They have never run in this repository's CI.** There is no Stripe account
behind this project, so `live.yml` is written, wired and inert. Everything the
README claims was verified by `test/unit` and `test/replay`, which run on every
push; these are here so that anyone with a key can check the same behaviour
against the real thing.

## Running them

```bash
export STRIPE_SECRET_KEY=sk_test_...
export STRIPE_WEBHOOK_SECRET=whsec_...     # from `stripe listen`
stripe listen --forward-to localhost:3000/webhooks/stripe &
npm run start &
npx vitest run test/live
```

Without `STRIPE_SECRET_KEY` every test in this directory skips, and the suite
passes — deliberately, so `npm test` works on a fresh clone. A skipped suite
that reports success is a real hazard, which is why the skip prints a line
saying it skipped rather than passing quietly.

## What they cover that the replay suite cannot

- That Stripe returns the **original** result for a repeated idempotency key,
  rather than the fake's imitation of that behaviour.
- That the real event sequence for a failed renewal matches the one the replay
  fixtures assume — the assumption most likely to drift as Stripe changes.
- Smart Retries actually retrying, on Stripe's own schedule.
- SCA: that a 3DS-required card produces `requires_action` and completes only
  after the challenge.
