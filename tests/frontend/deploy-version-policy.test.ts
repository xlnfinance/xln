import { describe, expect, test } from 'bun:test';
import { resolveDeployVersionAction } from '../../frontend/src/lib/utils/deployVersionPolicy';

describe('deploy version policy', () => {
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
