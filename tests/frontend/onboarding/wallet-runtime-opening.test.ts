import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  resolveWalletRuntimeOpeningPlan,
  walletRuntimeOpeningNeedsLocalLookup,
  type WalletRuntimeOpeningInput,
} from '../../../frontend/packages/browser/src/wallet-runtime-opening';

type Candidate = Readonly<{ id: string }>;
type OpeningInput = WalletRuntimeOpeningInput<Candidate, number | null>;

const openingInput = (
  overrides: Partial<OpeningInput> = {},
): OpeningInput => ({
  runtimeId: '0x1234567890',
  name: 'Primary Runtime',
  labelOverride: undefined,
  seed: 'canonical seed',
  mnemonic12: '',
  devicePassphrase: '',
  loginType: 'manual',
  unlockDurationMs: 600_000,
  recoveryCandidate: undefined,
  forceFresh: false,
  openLocal: false,
  localRuntimeExists: false,
  ...overrides,
});

describe('browser wallet Runtime opening', () => {
  test('reads local Runtime state only for the default no-override path', () => {
    expect(walletRuntimeOpeningNeedsLocalLookup({
      openLocal: false,
      forceFresh: false,
      hasRecoveryCandidate: false,
    })).toBe(true);
    expect(walletRuntimeOpeningNeedsLocalLookup({
      openLocal: true,
      forceFresh: false,
      hasRecoveryCandidate: false,
    })).toBe(false);
    expect(walletRuntimeOpeningNeedsLocalLookup({
      openLocal: false,
      forceFresh: true,
      hasRecoveryCandidate: false,
    })).toBe(false);
    expect(walletRuntimeOpeningNeedsLocalLookup({
      openLocal: false,
      forceFresh: false,
      hasRecoveryCandidate: true,
    })).toBe(false);
  });

  test('explicit local opening wins without depending on discovery state', () => {
    expect(resolveWalletRuntimeOpeningPlan(openingInput({
      openLocal: true,
      forceFresh: true,
      recoveryCandidate: { id: 'backup' },
    }))).toEqual({
      action: 'unlock-local',
      runtimeId: '0x1234567890',
      seed: 'canonical seed',
      unlockDurationMs: 600_000,
    });
  });

  test('opens an existing local Runtime on the default path', () => {
    expect(resolveWalletRuntimeOpeningPlan(openingInput({
      localRuntimeExists: true,
      unlockDurationMs: null,
    }))).toEqual({
      action: 'unlock-local',
      runtimeId: '0x1234567890',
      seed: 'canonical seed',
      unlockDurationMs: null,
    });
  });

  test('force-fresh bypasses an existing local Runtime', () => {
    expect(resolveWalletRuntimeOpeningPlan(openingInput({
      forceFresh: true,
      localRuntimeExists: true,
    })).action).toBe('create-runtime');
  });

  test('builds normalized manual Runtime creation inputs', () => {
    expect(resolveWalletRuntimeOpeningPlan(openingInput({
      labelOverride: '  Restored Runtime  ',
      mnemonic12: '  one   two\nthree  ',
      devicePassphrase: 'device secret',
      unlockDurationMs: 86_400_000,
    }))).toEqual({
      action: 'create-runtime',
      label: 'Restored Runtime',
      seed: 'canonical seed',
      options: {
        loginType: 'manual',
        requiresOnboarding: true,
        mnemonic12: 'one two three',
        devicePassphrase: 'device secret',
        recoveryCandidate: undefined,
        skipRecoveryRestore: true,
        unlockDurationMs: 86_400_000,
      },
    });
  });

  test('uses the canonical fallback label and skips onboarding for demo login', () => {
    expect(resolveWalletRuntimeOpeningPlan(openingInput({
      name: '',
      labelOverride: '   ',
      loginType: 'demo',
    }))).toEqual({
      action: 'create-runtime',
      label: 'Runtime 0x1234',
      seed: 'canonical seed',
      options: {
        loginType: 'demo',
        requiresOnboarding: false,
        mnemonic12: undefined,
        devicePassphrase: undefined,
        recoveryCandidate: undefined,
        skipRecoveryRestore: true,
        unlockDurationMs: 600_000,
      },
    });
  });

  test('creates from a selected backup even when a local Runtime exists', () => {
    const recoveryCandidate = { id: 'backup' };
    const plan = resolveWalletRuntimeOpeningPlan(openingInput({
      recoveryCandidate,
      localRuntimeExists: true,
    }));

    expect(plan.action).toBe('create-runtime');
    if (plan.action === 'create-runtime') {
      expect(plan.options.recoveryCandidate).toBe(recoveryCandidate);
      expect(plan.options.skipRecoveryRestore).toBe(false);
    }
  });

  test('keeps vault mutation and sensitive cleanup in the Svelte event flow', () => {
    const boundary = readFileSync(
      'frontend/packages/browser/src/wallet-runtime-opening.ts',
      'utf8',
    );
    const view = readFileSync(
      'frontend/src/lib/components/Views/RuntimeCreation.svelte',
      'utf8',
    );

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('vaultOperations');
    expect(boundary).not.toContain('../../../../core');
    expect(view).toContain('walletRuntimeOpeningNeedsLocalLookup(openingChoice)');
    expect(view).toContain('resolveWalletRuntimeOpeningPlan({');
    expect(view).toContain('await vaultOperations.unlockRuntime(');
    expect(view).toContain('await vaultOperations.createRuntime(');
    expect(view).toContain('clearSensitiveWalletMaterial();');
    expect(view).toContain("openingPlan.action === 'unlock-local'");
  });
});
