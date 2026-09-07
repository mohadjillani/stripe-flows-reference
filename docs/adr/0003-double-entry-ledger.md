# 3. A double-entry ledger, not an amount and a status

Status: accepted

## Context

The minimum a payment integration needs is an amount and a status. It is enough
to render a receipt, and it is what most integrations have.

It cannot answer the questions that get asked later: what did we actually earn
this month, net of fees and refunds; why does the Stripe dashboard say a
different number; where did the 59 cents go. And it has no way to be _checked_ —
a status column that is wrong looks exactly like one that is right.

## Decision

Every money movement writes a balanced set of ledger entries, keyed by Stripe's
balance transaction id. Postings must sum to zero, and `post()` refuses one
that does not, before it reaches the database.

## Consequences

Mistakes become visible instead of silent. Forgetting Stripe's fee — the most
common error in this kind of code — produces an imbalance of exactly the fee,
caught at the moment it happens with a stack trace pointing at the handler,
rather than as a discrepancy someone notices at quarter end with a week of
history to search.

The unique index on `(balance_txn, account)` is what makes a redelivered event
unable to double-post, which matters because Stripe delivers at least once and
a duplicate is normal traffic rather than an error. `post()` returns `false`
for one instead of throwing.

Amounts are `bigint` throughout. `Number.MAX_SAFE_INTEGER` is about 9
quadrillion, floating point cannot represent 0.1 + 0.2, and a rounding error in
a ledger compounds. Postgres returns `bigint` as a string for the same reason
and the pool converts explicitly at the boundary.

The cost is more code per handler and an account model to keep in your head.
For a service that takes a hundred payments a month it is more than is needed.
The threshold where it starts paying for itself is the first time someone asks
why the numbers do not match.
