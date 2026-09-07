import { describe, expect, it } from 'vitest';
import {
  computeSignature,
  parseSignatureHeader,
  SignatureError,
  signPayload,
  verifySignature,
} from '../../src/stripe/signature.ts';

const SECRET = 'whsec_test_secret';
const PAYLOAD = '{"id":"evt_1","type":"payment_intent.succeeded"}';
const NOW = 1_700_000_000;

describe('parseSignatureHeader', () => {
  it('reads the timestamp and every signature', () => {
    expect(parseSignatureHeader('t=123,v1=aaa,v1=bbb')).toEqual({
      timestamp: 123,
      // Stripe sends more than one while a secret is rotating; taking only the
      // first fails every event for the duration of the rotation.
      signatures: ['aaa', 'bbb'],
    });
  });

  it('ignores schemes it does not know', () => {
    expect(parseSignatureHeader('t=123,v0=old,v1=new').signatures).toEqual(['new']);
  });

  it.each([
    ['no timestamp', 'v1=aaa'],
    ['no signature', 't=123'],
    ['empty', ''],
    ['nonsense', 'hello'],
  ])('refuses a header with %s', (_name, header) => {
    expect(() => parseSignatureHeader(header)).toThrow(SignatureError);
  });
});

describe('verifySignature', () => {
  it('accepts a correctly signed payload', () => {
    const header = signPayload(PAYLOAD, SECRET, NOW);
    expect(verifySignature(PAYLOAD, header, SECRET, { nowSeconds: NOW }).timestamp).toBe(NOW);
  });

  it('accepts when one of several signatures matches', () => {
    const good = computeSignature(PAYLOAD, NOW, SECRET);
    const header = `t=${String(NOW)},v1=${'0'.repeat(64)},v1=${good}`;
    expect(() => verifySignature(PAYLOAD, header, SECRET, { nowSeconds: NOW })).not.toThrow();
  });

  it('rejects a payload that changed by one byte', () => {
    const header = signPayload(PAYLOAD, SECRET, NOW);
    expect(() => verifySignature(`${PAYLOAD} `, header, SECRET, { nowSeconds: NOW })).toThrow(
      /no signature/,
    );
  });

  it('rejects the wrong secret', () => {
    const header = signPayload(PAYLOAD, SECRET, NOW);
    expect(() => verifySignature(PAYLOAD, header, 'whsec_other', { nowSeconds: NOW })).toThrow(
      SignatureError,
    );
  });

  /**
   * The timestamp is inside the signed string, so moving it invalidates the
   * signature. A scheme that signed the payload alone would let a captured
   * request be replayed forever.
   */
  it('rejects a timestamp that was tampered with', () => {
    const header = signPayload(PAYLOAD, SECRET, NOW);
    const moved = header.replace(`t=${String(NOW)}`, `t=${String(NOW + 5)}`);
    expect(() => verifySignature(PAYLOAD, moved, SECRET, { nowSeconds: NOW })).toThrow(
      /no signature/,
    );
  });

  it('rejects an event older than the tolerance', () => {
    const header = signPayload(PAYLOAD, SECRET, NOW - 3600);
    expect(() => verifySignature(PAYLOAD, header, SECRET, { nowSeconds: NOW })).toThrow(
      /outside the 300s tolerance/,
    );
  });

  it('rejects an event from too far in the future', () => {
    // Symmetric on purpose: a clock ahead of ours is as much a problem as one
    // behind, and only checking one direction accepts a forged future
    // timestamp.
    const header = signPayload(PAYLOAD, SECRET, NOW + 3600);
    expect(() => verifySignature(PAYLOAD, header, SECRET, { nowSeconds: NOW })).toThrow(
      /outside the 300s tolerance/,
    );
  });

  it('accepts an event at the edge of the tolerance', () => {
    const header = signPayload(PAYLOAD, SECRET, NOW - 300);
    expect(() => verifySignature(PAYLOAD, header, SECRET, { nowSeconds: NOW })).not.toThrow();
  });

  it('reports why it refused, so the endpoint can answer correctly', () => {
    const header = signPayload(PAYLOAD, SECRET, NOW - 3600);
    try {
      verifySignature(PAYLOAD, header, SECRET, { nowSeconds: NOW });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as SignatureError).reason).toBe('outside-tolerance');
    }
  });

  it('checks the signature before the tolerance', () => {
    // Both are wrong; the signature failure is the one reported. Checking the
    // timestamp first would let an attacker learn whether a timestamp was
    // acceptable without ever producing a valid signature.
    const header = `t=${String(NOW - 3600)},v1=${'0'.repeat(64)}`;
    try {
      verifySignature(PAYLOAD, header, SECRET, { nowSeconds: NOW });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as SignatureError).reason).toBe('no-matching-signature');
    }
  });
});
