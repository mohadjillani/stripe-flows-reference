# stripe-flows-reference

[![CI](https://github.com/mohadjillani/stripe-flows-reference/actions/workflows/ci.yml/badge.svg)](https://github.com/mohadjillani/stripe-flows-reference/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The Stripe quickstart gets you a charge. This is the rest of it: what happens
when the webhook arrives twice, or out of order, or not at all; when the process
dies between calling Stripe and writing the result; when a renewal fails; when a
customer disputes a charge two months later; and how you find out that your
numbers and Stripe's have quietly diverged.

A reference implementation to read and adapt. It has not processed anyone's
money.

## The five things it gets right

**A payment is marked paid by a webhook, never by the redirect.** The customer
can close the tab, lose the network, or type the return URL by hand — none of
which changes whether money moved. The return page polls a status only a
verified webhook can change. This is the most common way a Stripe integration
ships a bug that only appears when it matters.
[ADR 1](docs/adr/0001-webhooks-not-redirects.md)

**Idempotency keys come from local state, and are written before the call.**

```ts
// committed BEFORE Stripe is called
INSERT INTO payment_attempts (payment_id, attempt, idempotency_key)
VALUES ('pay_1', 1, 'payment:pay_1:attempt:1');

await stripe.createIntent({ ..., idempotencyKey: 'payment:pay_1:attempt:1' });
```

`randomUUID()` at the call site is not an idempotency key — it is a fresh key on
every retry, so the retry is a new charge. Writing the attempt _after_ the call
reviews identically to writing it before, and only one of them survives a crash.
[ADR 2](docs/adr/0002-idempotency-keys-from-local-state.md)

**Out-of-order events cannot rewrite history.** `payment_intent.succeeded`
arriving after `charge.refunded` is not exotic — it is what happens when the
first delivery fails and is retried. A transition table refuses it. Subscription
handlers compare the event's own timestamp, so a stale `past_due` cannot put a
paying customer back into dunning.

**A double-entry ledger, not an amount and a status.** Every movement posts rows
summing to zero, keyed by Stripe's balance transaction id:

| account           | amount |
| ----------------- | -----: |
| `stripe_clearing` |   +941 |
| `fees`            |    +59 |
| `revenue`         |  −1000 |

Forgetting the fee — the most common error in this kind of code — produces an
imbalance of exactly 59, caught at the moment it happens rather than at quarter
end. [ADR 3](docs/adr/0003-double-entry-ledger.md)

**Reconciliation, because both sides can be wrong quietly.** A webhook that was
never delivered leaves money in Stripe with no local record. Nothing threw,
nothing logged, and Stripe stopped retrying days ago. `npm run reconcile` diffs
the ledger against Stripe's balance transactions, writes findings, and exits
non-zero. [docs/reconciliation.md](docs/reconciliation.md)

## Quick start

Needs Node 20+ and PostgreSQL. No Stripe account.

```bash
createdb stripedemo
export DATABASE_URL=postgres://postgres@127.0.0.1:5432/stripedemo
export STRIPE_WEBHOOK_SECRET=whsec_anything_for_local

npm install
npm run migrate
npm test          # 122 tests
```

The service refuses to start without `STRIPE_WEBHOOK_SECRET`: an endpoint that
cannot verify signatures must not accept events.

## The flows

| flow                                                       | what it covers                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| [One-off payment](docs/flows/one-off-payment.md)           | idempotent creation, the SCA challenge, the redirect that proves nothing |
| [Dunning](docs/flows/dunning.md)                           | a failed renewal, Smart Retries, notices, recovery or `unpaid`           |
| [Refunds and disputes](docs/flows/refunds-and-disputes.md) | partial refunds, the cumulative-amount trap, holds not losses            |
| [The ledger](docs/ledger.md)                               | accounts, `bigint`, and the four invariants                              |
| [Reconciliation](docs/reconciliation.md)                   | drift, findings, and why the watermark waits                             |

Each flow page has a sequence diagram with the failure paths marked.

## Two traps worth the price of admission

**`amount_refunded` is cumulative.** It is the total refunded so far, not the
size of this refund. Treating it as the latter double-counts the moment a second
partial arrives, and the books then disagree with Stripe by the size of the
first one. The handler posts the delta — which is also the ordering guard, since
a redelivery produces a delta of zero.

**A dispute is a hold, not a loss.** Posting the loss when the dispute opens
understates the balance for weeks and then needs reversing when it is won, and
reversals are exactly the entries nobody can interpret six months later.

## What is verified, and what is not

Everything above is exercised by 122 tests that run on every push:

- **unit**, no I/O — signature verification against the real HMAC scheme,
  transition tables, ledger arithmetic, the reconciliation diff
- **replay**, against real Postgres — Stripe-shaped events, correctly signed,
  posted through the real endpoint: duplicates, out-of-order delivery, a full
  failed-renewal sequence, both dispute outcomes, malformed payloads
- the ledger invariants are tested **by breaking each one on purpose** — a check
  that has only ever run against correct data is a check nobody knows works

**There is no Stripe account behind this repository.** `test/live/` holds the
test-clock scenarios and `live.yml` is written and wired, and **neither has ever
run.** What that leaves unproven, in particular:

- that Stripe returns the original result for a repeated idempotency key, rather
  than the in-process fake's imitation of it
- that the real event sequence for a failed renewal still matches what the
  replay fixtures assume — the assumption most likely to drift as Stripe changes
- anything about SCA, which needs a browser and a real 3DS challenge

Test clocks exist to make Stripe emit a month of events in seconds. What this
service _consumes_ is that sequence, so the dunning scenarios replay the events
directly. That is a weaker test of Stripe and an equal test of the handlers, and
it is the honest description of what CI proves.
[ADR 4](docs/adr/0004-testing-without-a-key.md)

## Limits

**Not a billing system.** No invoicing, tax, metering, multi-currency
settlement, or payouts. Those are products, and Stripe sells most of them.

**One process, one database.** The webhook endpoint does its work inline inside
a transaction. Above a few hundred events a second that wants a queue —
`outbox-pattern-node` is the repository about doing that without losing events.

**Signature verification is inline rather than reusing `webhook-receiver-kit`.**
That package is not published yet, and depending on it would break `npm ci` for
everyone. The scheme here is Stripe-specific anyway.

**No plan-change proration flow.** Previewing an upcoming invoice and comparing
the preview against what Stripe actually charges needs a live account to be
worth anything, so it is documented as absent rather than mocked into looking
complete.

## Decisions

- [1. State changes on a verified webhook, never on a redirect](docs/adr/0001-webhooks-not-redirects.md)
- [2. Derive idempotency keys from local state, and write them first](docs/adr/0002-idempotency-keys-from-local-state.md)
- [3. A double-entry ledger, not an amount and a status](docs/adr/0003-double-entry-ledger.md)
- [4. Test against a fake and recorded shapes, not a live account](docs/adr/0004-testing-without-a-key.md)

## License

MIT
