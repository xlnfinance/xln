import { createHmac } from 'crypto';
import { describe, expect, test } from 'bun:test';
import {
  buildMppChallengeHeader,
  buildMppCredentialHeader,
  buildMppReceiptHeader,
  canonicalizeMppJson,
  computeMppChallengeId,
  decodeMppJson,
  encodeMppJson,
  parseMppChallengeHeader,
  parseMppCredentialHeader,
  parseMppReceiptHeader,
  type MppChallenge,
} from '../agent-payments/mpp';

const request = encodeMppJson({
  recipient: 'acct_123',
  currency: 'USD',
  amount: '1000',
});

const challenge = (): MppChallenge => ({
  id: 'x7Tg2pLqR9mKvNwY3hBcZa',
  realm: 'api.example.com',
  method: 'evm',
  intent: 'charge',
  request,
  expires: '2025-01-15T12:05:00Z',
});

describe('mpp core compatibility', () => {
  test('JCS request encoding is stable and base64url without padding', () => {
    const left = encodeMppJson({ b: 2, a: { y: true, x: ['z'] } });
    const right = encodeMppJson({ a: { x: ['z'], y: true }, b: 2 });

    expect(left).toBe(right);
    expect(left).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(left).not.toContain('=');
    expect(canonicalizeMppJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(decodeMppJson(left)).toEqual({ a: { x: ['z'], y: true }, b: 2 });
    expect(request).toBe('eyJhbW91bnQiOiIxMDAwIiwiY3VycmVuY3kiOiJVU0QiLCJyZWNpcGllbnQiOiJhY2N0XzEyMyJ9');
    expect(() => encodeMppJson({ issuedAt: new Date('2025-01-15T12:00:00Z') })).toThrow('MPP_JSON_UNSUPPORTED_VALUE');
  });

  test('builds and parses WWW-Authenticate Payment challenges', () => {
    const header = buildMppChallengeHeader({
      ...challenge(),
      description: 'pay "alpha", now',
      extensions: { priority: 'high' },
    });

    expect(header).toContain('Payment ');
    expect(header).toContain('description="pay \\"alpha\\", now"');
    expect(parseMppChallengeHeader(header)).toEqual({
      ...challenge(),
      description: 'pay "alpha", now',
      extensions: { priority: 'high' },
    });
    expect(parseMppChallengeHeader(header.replace('Payment ', 'payment ')).method).toBe('evm');
  });

  test('rejects malformed challenges instead of accepting ambiguous wire data', () => {
    expect(() =>
      parseMppChallengeHeader(`Payment realm="api.example.com", method="evm", intent="charge", request="${request}"`),
    ).toThrow('MPP_CHALLENGE_ID:MPP_STRING_REQUIRED');
    expect(() => buildMppChallengeHeader({ ...challenge(), method: 'EVM' })).toThrow('MPP_CHALLENGE_INVALID_METHOD');
    expect(() => buildMppChallengeHeader({ ...challenge(), request: `${request}=` })).toThrow('MPP_BASE64URL_NOPAD_INVALID');
  });

  test('encodes and parses Authorization Payment credentials', () => {
    const credential = {
      challenge: challenge(),
      source: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      payload: {
        chainId: 'eip155:1',
        proof: '0xabc123',
      },
    };
    const header = buildMppCredentialHeader(credential);

    expect(header).toMatch(/^Payment [A-Za-z0-9_-]+$/);
    expect(header).not.toContain('=');
    expect(parseMppCredentialHeader(header)).toEqual(credential);
    expect(parseMppCredentialHeader(header.replace('Payment ', 'payment '))).toEqual(credential);
    expect(() => parseMppCredentialHeader(header.replace('Payment ', 'Bearer '))).toThrow('MPP_PAYMENT_SCHEME_REQUIRED');
  });

  test('encodes and parses Payment-Receipt success headers', () => {
    const receipt = {
      status: 'success' as const,
      method: 'evm',
      timestamp: '2025-01-15T12:00:00Z',
      reference: '0xsettlement',
    };
    const header = buildMppReceiptHeader(receipt);

    expect(header).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseMppReceiptHeader(header)).toEqual(receipt);
    expect(() =>
      parseMppReceiptHeader(encodeMppJson({ ...receipt, status: 'pending' })),
    ).toThrow('MPP_RECEIPT_STATUS_INVALID');
  });

  test('computes the spec HMAC challenge id over seven fixed pipe slots', () => {
    const binding = {
      realm: 'api.example.com',
      method: 'evm',
      intent: 'charge',
      request,
      expires: '2025-01-15T12:05:00Z',
      digest: 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:',
      opaque: encodeMppJson({ trace: 'abc' }),
    };
    const input = [
      binding.realm,
      binding.method,
      binding.intent,
      binding.request,
      binding.expires,
      binding.digest,
      binding.opaque,
    ].join('|');
    const expected = createHmac('sha256', 'server-secret').update(input).digest('base64url');

    expect(computeMppChallengeId('server-secret', binding)).toBe(expected);
    expect(computeMppChallengeId('server-secret', { ...binding, digest: undefined })).not.toBe(expected);
    expect(computeMppChallengeId('server-secret', { ...binding, opaque: encodeMppJson({ trace: 'abc' }) })).toBe(expected);
  });
});
