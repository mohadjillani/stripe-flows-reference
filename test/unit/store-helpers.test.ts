import { describe, expect, it } from 'vitest';
import { isStale } from '../../src/webhooks/store.ts';
import { big, num, obj, str } from '../../src/webhooks/handlers/types.ts';

describe('isStale', () => {
  it('is stale when the incoming event is older than what was applied', () => {
    expect(isStale(100, 200)).toBe(true);
  });

  it('is not stale when it is newer', () => {
    expect(isStale(300, 200)).toBe(false);
  });

  /**
   * `<`, not `<=`. Two events can legitimately share a second, and treating
   * equal timestamps as stale would drop the second of a pair that arrived
   * together.
   */
  it('is not stale at the same second', () => {
    expect(isStale(200, 200)).toBe(false);
  });

  it('is not stale when the event carries no timestamp', () => {
    // Nothing to compare, so the ordering guard abstains rather than guessing.
    expect(isStale(undefined, 200)).toBe(false);
  });
});

describe('payload readers', () => {
  const payload = { id: 'pi_1', amount: 1000, nested: { a: 1 }, nothing: null, wrong: [] };

  it('reads a string only when it is a string', () => {
    expect(str(payload, 'id')).toBe('pi_1');
    expect(str(payload, 'amount')).toBeUndefined();
    expect(str(payload, 'absent')).toBeUndefined();
  });

  it('reads a number only when it is a number', () => {
    expect(num(payload, 'amount')).toBe(1000);
    expect(num(payload, 'id')).toBeUndefined();
  });

  it('converts a number to a bigint without losing the value', () => {
    expect(big(payload, 'amount')).toBe(1000n);
    expect(big(payload, 'id')).toBeUndefined();
  });

  it('reads an object, and does not mistake null for one', () => {
    expect(obj(payload, 'nested')).toEqual({ a: 1 });
    // `typeof null === 'object'` is the trap these readers exist to avoid.
    expect(obj(payload, 'nothing')).toBeUndefined();
  });
});
