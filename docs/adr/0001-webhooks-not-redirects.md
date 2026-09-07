# 1. State changes on a verified webhook, never on a redirect

Status: accepted

## Context

After a customer pays, Stripe.js redirects the browser back to a return URL.
The obvious place to mark the payment paid is that return handler: the customer
is right there, the page needs to say something, and the redirect carries the
payment intent id.

It is also wrong, and it works in every test anyone runs by hand.

The redirect is a client-side navigation. The customer can close the tab, lose
the network, or be on a phone that backgrounds the browser. The URL can be
typed by hand or replayed from history. None of that changes whether money
moved, and none of it is authenticated.

## Decision

`payments.status` is written only by a webhook handler, after signature
verification. The return page polls `GET /payments/:id` and shows "processing"
until a webhook has said otherwise.

## Consequences

A payment is marked paid when it was paid, and only then. A customer who closes
the tab still gets what they bought.

The customer sees a brief "processing" state, which is a real product cost —
webhook delivery is usually under a second and occasionally is not. Polling for
a few seconds is the price of not being wrong.

It also means the webhook endpoint is load-bearing rather than a background
detail: if it is down, nothing is ever marked paid. That is the right failure —
it is loud, it is visible in the queue Stripe retries from, and it does not
silently produce wrong data.

The transition table exists for the same reason. Stripe makes no ordering
promise, so `payment_intent.succeeded` can arrive after `charge.refunded` —
which happens whenever the first delivery of the success failed and was
retried. Without the table, that sequence marks a refunded payment as paid and
nothing anywhere records that it happened.
