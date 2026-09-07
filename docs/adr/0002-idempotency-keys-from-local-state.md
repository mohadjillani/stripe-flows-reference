# 2. Derive idempotency keys from local state, and write them first

Status: accepted

## Context

An idempotency key lets a request be retried without repeating its effect.
Stripe stores the response against the key for 24 hours and returns the
original on a repeat.

The obvious implementation is `randomUUID()` at the call site. That produces a
fresh key on every retry, so the retry is a new request and the customer is
charged twice. It is not an idempotency key at all — it merely has the shape of
one, and it passes every test that does not include a crash.

## Decision

The key is a function of what is being paid for: `payment:{id}:attempt:{n}`.
The attempt row carrying it is committed **before** Stripe is called.

## Consequences

A crash anywhere after that commit is recoverable. The retry finds the attempt,
reuses the key, and Stripe answers with the original intent.

The attempt number is in the key deliberately. A retry of the _same_ attempt
must reuse the key; a deliberate second attempt — the customer entering a
different card after a decline — is a different charge and must not, or Stripe
would replay the original failure and the customer could never succeed. Those
are two different operations in the code (`retryAttempt` and `startPayment`)
because confusing them is how someone gets billed twice.

The ordering is the part that reviews identically to the broken version. Both
call Stripe and both write a row; only one is safe. The tests assert the order
by failing the Stripe call and checking that a recoverable attempt was left
behind.

The cost is a database write before every payment call, and a key namespace
that has to stay stable: changing the derivation format would make old keys
unfindable, which matters for the 24 hours Stripe remembers them.
