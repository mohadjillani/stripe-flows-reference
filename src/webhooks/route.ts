import express, { type Request, type Response, type Router } from 'express';
import { withTransaction, type Pool } from '../db/pool.ts';
import { SignatureError, verifySignature } from '../stripe/signature.ts';
import { HANDLERS } from './handlers/index.ts';
import { markProcessed, recordEvent } from './store.ts';

export interface WebhookOptions {
  pool: Pool;
  secret: string;
  toleranceSeconds?: number;
  onEvent?: (event: {
    id: string;
    type: string;
    outcome: 'processed' | 'duplicate' | 'ignored';
  }) => void;
}

interface StripeEnvelope {
  id?: unknown;
  type?: unknown;
  created?: unknown;
  data?: { object?: unknown };
}

export function webhookRouter(options: WebhookOptions): Router {
  const router = express.Router();

  // The raw body, not the parsed one. The signature is over the exact bytes
  // Stripe sent; `JSON.parse` followed by `JSON.stringify` reorders keys and
  // changes whitespace, and every legitimate event then fails verification.
  // This is why the route mounts its own parser instead of using a global
  // `express.json()`.
  router.post(
    '/stripe',
    express.raw({ type: 'application/json' }),
    async (req: Request, res: Response) => {
      const header = req.header('stripe-signature');
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';

      if (!header) {
        res.status(400).json({ error: 'missing signature' });
        return;
      }

      try {
        verifySignature(raw, header, options.secret, {
          ...(options.toleranceSeconds !== undefined
            ? { toleranceSeconds: options.toleranceSeconds }
            : {}),
        });
      } catch (error) {
        if (error instanceof SignatureError) {
          // 400, never 500: a bad signature is not a transient failure, and
          // returning 500 makes Stripe retry a forged request for days.
          res.status(400).json({ error: 'signature', reason: error.reason });
          return;
        }
        throw error;
      }

      const envelope = JSON.parse(raw) as StripeEnvelope;
      const id = typeof envelope.id === 'string' ? envelope.id : undefined;
      const type = typeof envelope.type === 'string' ? envelope.type : undefined;
      const created = typeof envelope.created === 'number' ? envelope.created : 0;
      const object =
        typeof envelope.data?.object === 'object' && envelope.data.object !== null
          ? (envelope.data.object as Record<string, unknown>)
          : {};

      if (!id || !type) {
        res.status(400).json({ error: 'not a Stripe event' });
        return;
      }

      try {
        const outcome = await withTransaction(options.pool, async (client) => {
          // The insert and the effect share one transaction. Recorded
          // separately, a crash between them either applies the effect twice or
          // marks an event handled that never was.
          const fresh = await recordEvent(client, {
            id,
            type,
            payload: envelope as unknown as Record<string, unknown>,
            objectTs: created,
          });
          if (!fresh) return 'duplicate' as const;

          const handler = HANDLERS[type];
          if (handler) {
            await handler({ client, id, type, object, created });
          }

          await markProcessed(client, id);
          return handler ? ('processed' as const) : ('ignored' as const);
        });

        options.onEvent?.({ id, type, outcome });
        // 200 for a duplicate as well. Anything else asks Stripe to keep
        // redelivering an event that has already been handled correctly.
        res.status(200).json({ received: true, outcome });
      } catch (error) {
        // 500 here is right: the effect did not commit, and a retry is what
        // should happen.
        res.status(500).json({
          error: 'handler failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  return router;
}
