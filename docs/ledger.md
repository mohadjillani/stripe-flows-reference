# The ledger

Double entry, in the smallest currency unit, as `bigint`.

## Why not a status column and an amount

A status column records a conclusion. A ledger records what happened, and the
difference shows up the first time the two disagree — which they will, because
a status column can be wrong in ways nothing detects.

"Revenue went up by 1000 and nothing went down" is caught by the zero-sum
check. "The payment says paid" is not evidence of anything.

## The accounts

| account           | what it holds                                           |
| ----------------- | ------------------------------------------------------- |
| `stripe_clearing` | money Stripe holds on our behalf before payout          |
| `revenue`         | what was earned                                         |
| `fees`            | Stripe's cut — not revenue, and easy to forget entirely |
| `refunds`         | money given back                                        |
| `dispute_hold`    | contested: not lost yet, and not ours either            |
| `dispute_loss`    | written off when a dispute is lost                      |
| `customer`        | what a customer owes or has paid                        |

## Amounts are bigint, never number

`Number.MAX_SAFE_INTEGER` is about 9 quadrillion. A currency with two decimal
places uses those digits faster than it looks, and floating point cannot
represent 0.1 + 0.2 exactly. Postgres returns `bigint` as a string for the same
reason, and the pool converts through `BigInt` at the boundary so the choice is
explicit rather than a silent precision loss in the middle of a ledger.

## Duplicates cannot double-post

```sql
CREATE UNIQUE INDEX ledger_entries_btxn_account
  ON ledger_entries (balance_txn, account) WHERE balance_txn IS NOT NULL;
```

Stripe's balance transaction id is the natural key for "this movement of
money". A redelivered event carries the same one, so the insert conflicts and
`post` reports `false` rather than throwing — a duplicate is expected traffic,
not an error.

Entries without a balance transaction — a dispute hold, say — are not
deduplicated by the index, so their handlers guard differently: the dispute
insert is `ON CONFLICT DO NOTHING`, and the close updates
`WHERE closed_at IS NULL`.

## The invariants

`GET /ledger/invariants` and `checkInvariants()` run four checks against real
data:

1. every posting sums to zero
2. the whole ledger sums to zero, per currency — catches an entry written
   outside a posting, which (1) cannot see
3. no balance transaction is posted twice to the same account — asserts the
   unique index is still there, which is the kind of thing a migration quietly
   drops
4. refunds never exceed what was captured

Each of these is tested by **breaking it on purpose**: the tests write the
damage directly, bypassing `post`, and assert the report names it. A check that
has only ever run against correct data is a check nobody knows works.
