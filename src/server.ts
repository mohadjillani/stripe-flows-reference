import express from 'express';
import { parseEnv } from './env.ts';
import { createPool, type Pool } from './db/pool.ts';
import { isMainModule } from './db/migrate.ts';
import { webhookRouter } from './webhooks/route.ts';
import { checkInvariants } from './ledger/invariants.ts';

export interface AppOptions {
  pool: Pool;
  webhookSecret: string;
  toleranceSeconds?: number;
}

export function createApp(options: AppOptions) {
  const app = express();

  // Mounted before the JSON parser, because the webhook route needs the raw
  // body and a global parser would have consumed it.
  app.use(
    '/webhooks',
    webhookRouter({
      pool: options.pool,
      secret: options.webhookSecret,
      ...(options.toleranceSeconds !== undefined
        ? { toleranceSeconds: options.toleranceSeconds }
        : {}),
    }),
  );

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/payments/:id', async (req, res) => {
    const { rows } = await options.pool.query<{ id: string; status: string; amount: string }>(
      'SELECT id, status, amount::text FROM payments WHERE id = $1',
      [req.params.id],
    );
    const payment = rows[0];
    if (!payment) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    // What the return page polls. It reports the state the webhooks put the
    // payment in — never a state the browser reported.
    res.json(payment);
  });

  app.get('/ledger/invariants', async (_req, res) => {
    const violations = await checkInvariants(options.pool);
    res.status(violations.length === 0 ? 200 : 500).json({ violations });
  });

  return app;
}

if (isMainModule(import.meta.url)) {
  const env = parseEnv();
  const pool = createPool(env.DATABASE_URL);

  createApp({ pool, webhookSecret: env.STRIPE_WEBHOOK_SECRET }).listen(env.PORT, () => {
    console.log(`listening on http://127.0.0.1:${String(env.PORT)}`);
  });
}
