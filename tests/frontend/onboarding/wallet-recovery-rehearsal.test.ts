import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  WALLET_RECOVERY_REHEARSAL_MISMATCH,
  evaluateWalletRecoveryRehearsal,
  resetWalletRecoveryRehearsal,
  type WalletRecoveryRehearsalState,
} from '../../../frontend/packages/browser/src/wallet-recovery-rehearsal';

const pendingRehearsal = (
  overrides: Partial<WalletRecoveryRehearsalState> = {},
): WalletRecoveryRehearsalState => ({
  enabled: true,
  mode: 'mnemonic',
  expectedAddress: '0xabc123',
  ...overrides,
});

describe('browser wallet recovery rehearsal', () => {
  test('skips rehearsal when it was not requested', () => {
    const state = resetWalletRecoveryRehearsal();

    expect(evaluateWalletRecoveryRehearsal({
      state,
      mode: 'mnemonic',
      address: '0xABC123',
    })).toEqual({ status: 'skipped', state });
  });

  test('begins rehearsal with a normalized public address', () => {
    const state = pendingRehearsal({ mode: null, expectedAddress: '' });

    expect(evaluateWalletRecoveryRehearsal({
      state,
      mode: 'mnemonic',
      address: '0xABC123',
    })).toEqual({
      status: 'begin',
      state: {
        enabled: true,
        mode: 'mnemonic',
        expectedAddress: '0xabc123',
      },
    });
  });

  test('rejects a different recovered wallet without clearing the rehearsal', () => {
    const state = pendingRehearsal();

    expect(evaluateWalletRecoveryRehearsal({
      state,
      mode: 'mnemonic',
      address: '0xDEF456',
    })).toEqual({
      status: 'mismatch',
      state,
      message: WALLET_RECOVERY_REHEARSAL_MISMATCH,
    });
  });

  test('matches the expected address without case sensitivity', () => {
    const result = evaluateWalletRecoveryRehearsal({
      state: pendingRehearsal(),
      mode: 'mnemonic',
      address: '0xABC123',
    });

    expect(result).toEqual({
      status: 'matched',
      state: { enabled: false, mode: null, expectedAddress: '' },
    });
  });

  test('finishes an active rehearsal even if its option was toggled off', () => {
    expect(evaluateWalletRecoveryRehearsal({
      state: pendingRehearsal({ enabled: false }),
      mode: 'mnemonic',
      address: '0xabc123',
    })).toEqual({
      status: 'matched',
      state: { enabled: false, mode: null, expectedAddress: '' },
    });
  });

  test('returns a fresh idle state for cancellation and reset', () => {
    const first = resetWalletRecoveryRehearsal();
    const second = resetWalletRecoveryRehearsal();

    expect(first).toEqual({ enabled: false, mode: null, expectedAddress: '' });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  test('keeps sensitive cleanup and UI publication in the Svelte event flow', () => {
    const boundary = readFileSync(
      'frontend/packages/browser/src/wallet-recovery-rehearsal.ts',
      'utf8',
    );
    const view = readFileSync(
      'frontend/src/lib/components/Views/RuntimeCreation.svelte',
      'utf8',
    );
    const acceptStart = view.indexOf('function acceptRecoveryRehearsal');
    const cancelStart = view.indexOf('function cancelRecoveryRehearsal', acceptStart);
    const nextFunction = view.indexOf('function selectPresetFactor', cancelStart);
    const acceptSource = view.slice(acceptStart, cancelStart);
    const cancelSource = view.slice(cancelStart, nextFunction);

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('@xln/brainvault');
    expect(view).not.toContain('function beginRecoveryRehearsal');
    expect(acceptSource).toContain('evaluateWalletRecoveryRehearsal({');
    expect(acceptSource).toContain("result.status === 'begin'");
    expect(acceptSource).toContain("result.status === 'mismatch'");
    expect(acceptSource).toContain('clearDerivedWalletMaterial()');
    expect(acceptSource).toContain('derivationError = result.message');
    expect(cancelSource.indexOf('clearSensitiveWalletMaterial()')).toBeLessThan(
      cancelSource.indexOf('publishRecoveryRehearsalState(resetWalletRecoveryRehearsal())'),
    );
  });
});
