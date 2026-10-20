import { describe, expect, test } from 'bun:test';
import { isHubAccountReady } from '../../../../tests/utils/e2e-connect';

const committed = {
  success: true,
  hasAccount: true,
  ready: true,
  tokens: [{ tokenId: 1, hasDelta: true, hubOutCapacity: '0' }],
};

describe('hub connect commitment before credit', () => {
  test('zero-credit committed Account permits extendCredit, but is not funded', () => {
    expect(isHubAccountReady(committed, [1], 'committed')).toBe(true);
    expect(isHubAccountReady(committed, [1], 'funded')).toBe(false);
    expect(isHubAccountReady({ ...committed, ready: false }, [1], 'committed')).toBe(false);
  });

  test('both stages require successful commitment and each requested delta', () => {
    for (const stage of ['committed', 'funded'] as const) {
      expect(isHubAccountReady({ ...committed, success: false }, [1], stage)).toBe(false);
      expect(isHubAccountReady({ ...committed, hasAccount: false }, [1], stage)).toBe(false);
      expect(isHubAccountReady({ ...committed, tokens: [] }, [1], stage)).toBe(false);
      expect(isHubAccountReady(committed, [2], stage)).toBe(false);
    }
  });

  test('funded stage retains positive capacity for every requested token', () => {
    const funded = { ...committed, tokens: [{ tokenId: 1, hasDelta: true, hubOutCapacity: '1' }] };
    expect(isHubAccountReady(funded, [1], 'funded')).toBe(true);
    expect(isHubAccountReady(funded, [1, 2], 'funded')).toBe(false);
    expect(isHubAccountReady({ ...funded, ready: false }, [1], 'funded')).toBe(false);
    expect(
      isHubAccountReady({ ...funded, tokens: [{ tokenId: 1, hasDelta: false, hubOutCapacity: '1' }] }, [1], 'funded'),
    ).toBe(false);
  });
});
