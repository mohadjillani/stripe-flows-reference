import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/env.ts';

const valid = { STRIPE_WEBHOOK_SECRET: 'whsec_x' };

describe('parseEnv', () => {
  it('accepts the minimum and fills in defaults', () => {
    const env = parseEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_URL).toContain('postgres://');
  });

  /**
   * A missing webhook secret discovered by the first event is an outage; the
   * same mistake discovered by the process refusing to start is a deployment
   * that never went out.
   */
  it('refuses to start without a webhook secret', () => {
    expect(() => parseEnv({})).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it('refuses an empty webhook secret, not just a missing one', () => {
    expect(() => parseEnv({ STRIPE_WEBHOOK_SECRET: '' })).toThrow(/required/);
  });

  it('does not require an API key, so the service starts without one', () => {
    // Only the live suite and the bootstrap script need it; requiring it would
    // stop the service booting for no reason.
    expect(() => parseEnv(valid)).not.toThrow();
    expect(parseEnv(valid).STRIPE_SECRET_KEY).toBeUndefined();
  });

  it('coerces the port and refuses a nonsensical one', () => {
    expect(parseEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080);
    expect(() => parseEnv({ ...valid, PORT: 'http' })).toThrow();
    expect(() => parseEnv({ ...valid, PORT: '-1' })).toThrow();
  });

  it('names every problem at once rather than one per restart', () => {
    try {
      parseEnv({ PORT: 'nope' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('STRIPE_WEBHOOK_SECRET');
      expect(message).toContain('PORT');
    }
  });
});
