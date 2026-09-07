# 4. Test against a fake and recorded shapes, not a live account

Status: accepted

## Context

The interesting behaviour here — idempotency under retry, out-of-order events,
dunning over a month — is exactly the behaviour that is awkward to test against
a real Stripe account. Test clocks make the time part possible, but they need a
key, they cost network round trips, and a suite that cannot run without
credentials is a suite most readers never run.

There is also no Stripe account behind this repository at all.

## Decision

Three layers:

1. **Unit**, with no I/O: signature verification, transition tables, ledger
   arithmetic, idempotency-key derivation, the reconciliation diff.
2. **Replay**, against real Postgres: Stripe-shaped events, signed with
   Stripe's actual HMAC scheme, posted through the real HTTP endpoint.
3. **Live**, in `test/live/`, skipped without `STRIPE_SECRET_KEY`.

Outbound calls go through one narrow interface with a real implementation and
an in-process fake. The fake stores responses against the idempotency key — the
one Stripe behaviour the calling code depends on — and models nothing else.

## Consequences

`npm test` works on a fresh clone with a local Postgres and no account. The
things the README claims are things CI actually ran.

Signature verification is tested for real, not mocked: the events are signed
with HMAC-SHA256 over `${timestamp}.${payload}`, so the replay window, the
multi-signature rotation case and rejection of a tampered payload are all
exercised against the real algorithm.

**What this cannot prove**, stated plainly:

- that Stripe returns the original result for a repeated key, rather than the
  fake's imitation of it
- that the real event sequence for a failed renewal still matches what the
  fixtures assume — the assumption most likely to drift as Stripe changes
- anything about SCA, which needs a browser and a real 3DS challenge

The fake deliberately does not simulate Stripe's state machine. A fake that
tried would be a second implementation with its own bugs, and passing tests
against it would prove nothing about the real thing. Keeping it dumb is what
makes it trustworthy — and is why `test/live/` exists rather than being
declared unnecessary.

The `live.yml` workflow is written and wired and **has never run**. The README
says so in those words.
