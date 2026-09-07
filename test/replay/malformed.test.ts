import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../../src/db/pool.ts';
import { countEvents, deliver, prepare, testPool, truncate, webhookBody } from './helpers.ts';

const pool: Pool = testPool();
let app: Express;

beforeAll(async () => {
  app = await prepare(pool);
});

beforeEach(async () => {
  await truncate(pool);
});

afterAll(async () => {
  await pool.end();
});

function event(type: string, object: Record<string, unknown>, id = 'evt_malformed') {
  return { id, type, created: Math.floor(Date.now() / 1000), data: { object } };
}

/**
 * Events whose payload is not what the handler expects.
 *
 * These are not hypothetical. Stripe adds and deprecates fields, an API version
 * change alters a shape, and an event for an object this service has never seen
 * arrives because someone enabled it in the dashboard. The requirement is that
 * none of them take the endpoint down — because a 500 makes Stripe retry, and a
 * retry loop on a malformed event is an outage that never resolves itself.
 */
describe('an event the handler cannot use', () => {
  it.each([
    ['no id on the object', 'payment_intent.succeeded', {}],
    ['an id of the wrong type', 'payment_intent.succeeded', { id: 12345 }],
    ['no payment intent on a refund', 'charge.refunded', { amount_refunded: 100 }],
    ['no subscription on an invoice', 'invoice.payment_failed', { id: 'in_1' }],
    [
      'an unknown subscription status',
      'customer.subscription.updated',
      { id: 'sub_x', status: 'wat' },
    ],
    ['no charge on a dispute', 'charge.dispute.created', { id: 'dp_1', amount: 100 }],
    ['an empty object', 'invoice.paid', {}],
  ])('is stored and acknowledged: %s', async (name, type, object) => {
    const response = await deliver(app, event(type, object, `evt_${name.replace(/\W/g, '_')}`));

    expect(response.status).toBe(200);
    expect(webhookBody(response).outcome).toBe('processed');
    // Stored either way, so there is a record of what arrived when someone
    // comes to ask why nothing happened.
    expect(await countEvents(pool)).toBe(1);
  });

  it('refuses a body that is not a Stripe event at all', async () => {
    const response = await deliver(app, { hello: 'world' });

    expect(response.status).toBe(400);
    expect(await countEvents(pool)).toBe(0);
  });

  it('refuses an event with no type', async () => {
    const response = await deliver(app, { id: 'evt_1', created: 1, data: { object: {} } });
    expect(response.status).toBe(400);
  });

  it('survives a payload whose data.object is not an object', async () => {
    const response = await deliver(app, {
      id: 'evt_weird',
      type: 'payment_intent.succeeded',
      created: Math.floor(Date.now() / 1000),
      data: { object: 'a string' },
    });

    expect(response.status).toBe(200);
  });

  it('refuses a request with no signature header at all', async () => {
    const response = await deliver(app, event('invoice.paid', {}));
    expect(response.status).toBe(200);

    // And without the header entirely:
    const { default: request } = await import('supertest');
    const bare = await request(app).post('/webhooks/stripe').send('{}');
    expect(bare.status).toBe(400);
  });
});
