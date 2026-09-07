import {
  paymentIntentFailed,
  paymentIntentRequiresAction,
  paymentIntentSucceeded,
} from './payment-intent.ts';
import { chargeRefunded, disputeClosed, disputeCreated } from './charge.ts';
import {
  invoicePaid,
  invoicePaymentFailed,
  subscriptionDeleted,
  subscriptionUpdated,
} from './subscription.ts';
import type { Handler } from './types.ts';

/**
 * The events this service acts on.
 *
 * An event with no handler is stored and marked processed rather than
 * rejected: returning a non-2xx makes Stripe retry it forever, and an endpoint
 * that 500s on an event type someone enabled in the dashboard is an outage
 * nobody configured.
 */
export const HANDLERS: Record<string, Handler> = {
  'payment_intent.succeeded': paymentIntentSucceeded,
  'payment_intent.payment_failed': paymentIntentFailed,
  'payment_intent.requires_action': paymentIntentRequiresAction,
  'charge.refunded': chargeRefunded,
  'charge.dispute.created': disputeCreated,
  'charge.dispute.closed': disputeClosed,
  'invoice.payment_failed': invoicePaymentFailed,
  'invoice.paid': invoicePaid,
  'invoice.payment_succeeded': invoicePaid,
  'customer.subscription.updated': subscriptionUpdated,
  'customer.subscription.deleted': subscriptionDeleted,
};

export type { EventContext, Handler } from './types.ts';
