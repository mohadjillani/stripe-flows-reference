import type { PoolClient } from '../../db/pool.ts';

export interface EventContext {
  client: PoolClient;
  id: string;
  type: string;
  /** `data.object` from the event. */
  object: Record<string, unknown>;
  /** The event's `created`, seconds since the epoch. */
  created: number;
}

export type Handler = (context: EventContext) => Promise<void>;

/** Reads a field without pretending the payload is typed. */
export function str(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' ? value : undefined;
}

export function num(object: Record<string, unknown>, key: string): number | undefined {
  const value = object[key];
  return typeof value === 'number' ? value : undefined;
}

export function big(object: Record<string, unknown>, key: string): bigint | undefined {
  const value = object[key];
  return typeof value === 'number' ? BigInt(Math.round(value)) : undefined;
}

export function obj(
  object: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = object[key];
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
