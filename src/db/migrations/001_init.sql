-- Money in cents, as bigint. Never a float: 0.1 + 0.2 is not 0.3, and a
-- rounding error in a ledger is a rounding error that compounds.
-- Stripe works in the smallest currency unit for the same reason.

CREATE TABLE IF NOT EXISTS payments (
  id            text PRIMARY KEY,
  customer_id   text        NOT NULL,
  amount        bigint      NOT NULL CHECK (amount > 0),
  currency      text        NOT NULL,
  -- Driven only by webhooks. Nothing the browser reports can change it.
  status        text        NOT NULL DEFAULT 'pending',
  intent_id     text UNIQUE,
  refunded      bigint      NOT NULL DEFAULT 0 CHECK (refunded >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (refunded <= amount)
);

-- Written before the Stripe call, not after. A crash between "called Stripe"
-- and "saved the result" is then recoverable by replaying the same key, which
-- Stripe answers with the original result instead of charging again.
CREATE TABLE IF NOT EXISTS payment_attempts (
  id              bigserial PRIMARY KEY,
  payment_id      text        NOT NULL REFERENCES payments(id),
  attempt         integer     NOT NULL,
  idempotency_key text        NOT NULL UNIQUE,
  status          text        NOT NULL DEFAULT 'started',
  intent_id       text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, attempt)
);

-- Stripe's event id is the unique key, so a redelivery is a conflict rather
-- than a second execution. Stripe redelivers on any non-2xx, and at least
-- once even without one.
CREATE TABLE IF NOT EXISTS stripe_events (
  id           text PRIMARY KEY,
  type         text        NOT NULL,
  payload      jsonb       NOT NULL,
  -- The object's own timestamp, used to reject an event that describes an
  -- older state than the one already applied.
  object_ts    bigint,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error        text
);

CREATE INDEX IF NOT EXISTS stripe_events_unprocessed
  ON stripe_events (received_at) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS subscriptions (
  id                 text PRIMARY KEY,
  customer_id        text        NOT NULL,
  price_id           text        NOT NULL,
  status             text        NOT NULL,
  current_period_end timestamptz,
  -- Set when a renewal fails, cleared when one succeeds.
  dunning_started_at timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- Guards against an out-of-order event describing an older state.
  updated_from_ts    bigint      NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dunning_notices (
  id              bigserial PRIMARY KEY,
  subscription_id text        NOT NULL REFERENCES subscriptions(id),
  invoice_id      text        NOT NULL,
  attempt         integer     NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, attempt)
);

CREATE TABLE IF NOT EXISTS disputes (
  id           text PRIMARY KEY,
  charge_id    text        NOT NULL,
  amount       bigint      NOT NULL,
  status       text        NOT NULL,
  opened_at    timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz
);

-- Double entry. Every event posts a set of rows summing to zero, so the books
-- cannot silently drift: a bug produces an imbalance the invariant check finds,
-- rather than a number that is merely wrong.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id            bigserial PRIMARY KEY,
  -- One posting is several rows sharing this id.
  posting_id    text        NOT NULL,
  account       text        NOT NULL,
  amount        bigint      NOT NULL,
  currency      text        NOT NULL,
  reference     text        NOT NULL,
  -- Stripe's balance transaction id where there is one. The unique index below
  -- is what makes a duplicate event unable to double-post.
  balance_txn   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_btxn_account
  ON ledger_entries (balance_txn, account) WHERE balance_txn IS NOT NULL;

CREATE INDEX IF NOT EXISTS ledger_entries_posting ON ledger_entries (posting_id);
CREATE INDEX IF NOT EXISTS ledger_entries_reference ON ledger_entries (reference);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- Advances only after a clean page, so a crash mid-run re-examines rather
  -- than skipping.
  watermark   bigint      NOT NULL DEFAULT 0,
  findings    integer     NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reconciliation_findings (
  id          bigserial PRIMARY KEY,
  run_id      bigint      NOT NULL REFERENCES reconciliation_runs(id),
  kind        text        NOT NULL,
  balance_txn text,
  detail      jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
