# Reconciliation

Both sides can be wrong in ways neither notices alone.

- A webhook that was never delivered leaves money in Stripe with no local
  record. Nothing threw. Nothing logged. Stripe gave up retrying after a few
  days and the event is gone.
- A handler bug posts an amount that does not match.
- A duplicate that slipped past the unique index posts twice.

None of these produce an error at the time. Reconciliation is how they are
found.

## The job

```bash
STRIPE_SECRET_KEY=sk_test_... npm run reconcile
```

It pages balance transactions since a watermark, compares them against the sum
per balance transaction in the `stripe_clearing` account, writes findings, and
**exits non-zero if there are any** — because it is meant to run on a schedule
and page someone, not to write a report nobody opens.

## Four kinds of finding

| kind                | meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `missing_locally`   | Stripe moved money and nothing here recorded it                      |
| `missing_upstream`  | a ledger entry claims a balance transaction Stripe does not have     |
| `amount_mismatch`   | both sides have it, and disagree                                     |
| `currency_mismatch` | rare and serious — adding euros to dollars is a quarter-long mistake |

## The watermark only moves after a clean pass

A run that finds nothing advances the watermark to the newest transaction it
examined. A run with findings leaves it where it was, so the next run
re-examines the same window.

Advancing optimistically would skip the window that contained the drift, and it
would never be looked at again. Re-examining is wasteful and correct.

## Only the fetched window is compared

Every local row outside the page would otherwise read as `missing_upstream` —
a page of false findings that trains everyone to ignore the report, which is a
worse outcome than not running it at all.
