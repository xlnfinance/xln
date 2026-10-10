import { describe, expect, test } from 'bun:test';
import { isDisposableLocalTestnet, resolveDeployVersionAction } from '../../../frontend/src/lib/utils/deployVersionPolicy';

describe('deploy version policy', () => {
  test('automatic reset is restricted to development on loopback hosts', () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
      expect(isDisposableLocalTestnet(true, hostname)).toBe(true);
      expect(isDisposableLocalTestnet(false, hostname)).toBe(false);
    }
    expect(isDisposableLocalTestnet(true, 'xln.finance')).toBe(false);
    expect(isDisposableLocalTestnet(true, 'localhost.example.com')).toBe(false);
  });
  test('fresh testnet deploy resets incompatible local state', () => {
    expect(resolveDeployVersionAction('old', 'new', true)).toBe('reset-ephemeral-testnet');
  });

  test('mainnet mismatch remains fail-closed', () => {
    expect(resolveDeployVersionAction('old', 'new', false)).toBe('require-recovery');
  });

  test('matching or missing versions do not reset data', () => {
    expect(resolveDeployVersionAction('same', 'same', true)).toBe('continue');
    expect(resolveDeployVersionAction('', 'new', true)).toBe('persist-current');
  });
});
