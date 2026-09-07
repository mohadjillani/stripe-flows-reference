import { z } from 'zod';

/**
 * Validated once, at boot.
 *
 * A missing webhook secret discovered by the first event is an outage; the same
 * mistake discovered by the process refusing to start is a deployment that
 * never went out.
 */
const schema = z.object({
  DATABASE_URL: z.string().default('postgres://postgres@127.0.0.1:5432/stripedemo'),
  STRIPE_WEBHOOK_SECRET: z.string().min(1, 'the webhook secret is required to verify signatures'),
  // Optional: only the live test suite and the bootstrap script need it, and
  // requiring it would stop the service from starting for no reason.
  STRIPE_SECRET_KEY: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`environment is not usable:\n${problems}`);
  }
  return result.data;
}
