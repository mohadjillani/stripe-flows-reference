import type { PoolClient } from '../db/pool.ts';

export interface StoredEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  objectTs?: number;
}

/**
 * Records an event, or reports that it has been seen before.
 *
 * Stripe delivers at least once. A retry after a timeout, a redelivery after a
 * non-2xx, and an outright duplicate all arrive with the same event id, so the
 * id is the primary key and a redelivery is a conflict rather than a second
 * execution.
 *
 * Inserting inside the same transaction as the effect is what makes this work.
 * Recorded separately, a crash between the two either applies the effect twice
 * or marks an event handled that never was.
 */
export async function recordEvent(client: PoolClient, event: StoredEvent): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO stripe_events (id, type, payload, object_ts)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [event.id, event.type, JSON.stringify(event.payload), event.objectTs ?? null],
  );
  return result.rowCount === 1;
}

export async function markProcessed(client: PoolClient, id: string): Promise<void> {
  await client.query('UPDATE stripe_events SET processed_at = now() WHERE id = $1', [id]);
}

export async function markFailed(client: PoolClient, id: string, error: string): Promise<void> {
  await client.query('UPDATE stripe_events SET error = $2 WHERE id = $1', [
    id,
    error.slice(0, 2000),
  ]);
}

/**
 * Whether an event describes a state older than the one already applied.
 *
 * The ordering guard. Two events about the same object carry the object's own
 * timestamp; if the one in hand is older than what has been applied, applying
 * it would move the record backwards. The check is `<`, not `<=`, because two
 * events can legitimately share a second.
 */
export function isStale(incomingTs: number | undefined, appliedTs: number): boolean {
  if (incomingTs === undefined) return false;
  return incomingTs < appliedTs;
}
