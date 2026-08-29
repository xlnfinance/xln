import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { WalletNodeMnemonicRevealCoordinator } from '../../../frontend/packages/browser/src/wallet-node-mnemonic-reveal';

type Recovery = Readonly<{ mnemonic24: string }>;

const deferred = <Value>() => {
  let resolvePromise: ((value: Value) => void) | null = null;
  let rejectPromise: ((error: unknown) => void) | null = null;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value: Value): void => {
      if (!resolvePromise) throw new Error('DEFERRED_RESOLVE_UNAVAILABLE');
      resolvePromise(value);
    },
    reject: (error: unknown): void => {
      if (!rejectPromise) throw new Error('DEFERRED_REJECT_UNAVAILABLE');
      rejectPromise(error);
    },
  };
};

describe('browser wallet node mnemonic reveal', () => {
  test('returns the current recovery result', async () => {
    let currentChecks = 0;
    const coordinator = new WalletNodeMnemonicRevealCoordinator<Recovery>();

    expect(await coordinator.run({
      reveal: async () => ({ mnemonic24: 'alpha beta gamma' }),
      isCurrent: () => {
        currentChecks += 1;
        return true;
      },
    })).toEqual({
      status: 'completed',
      recovery: { mnemonic24: 'alpha beta gamma' },
    });
    expect(currentChecks).toBe(1);
  });

  test('normalizes current Error and non-Error failures', async () => {
    const errorCoordinator = new WalletNodeMnemonicRevealCoordinator<Recovery>();
    const stringCoordinator = new WalletNodeMnemonicRevealCoordinator<Recovery>();

    expect(await errorCoordinator.run({
      reveal: async () => { throw new Error('REVEAL_FAILED'); },
      isCurrent: () => true,
    })).toEqual({ status: 'failed', message: 'REVEAL_FAILED' });
    expect(await stringCoordinator.run({
      reveal: async () => { throw 'STRING_FAILURE'; },
      isCurrent: () => true,
    })).toEqual({ status: 'failed', message: 'STRING_FAILURE' });
  });

  test('cancels a settled reveal after its external ownership changes', async () => {
    let isCurrent = true;
    const pending = deferred<Recovery>();
    const coordinator = new WalletNodeMnemonicRevealCoordinator<Recovery>();
    const run = coordinator.run({
      reveal: async () => pending.promise,
      isCurrent: () => isCurrent,
    });

    isCurrent = false;
    pending.resolve({ mnemonic24: 'stale mnemonic' });

    expect(await run).toEqual({ status: 'cancelled', latest: true });
  });

  test('accepts only the newest overlapping reveal', async () => {
    const first = deferred<Recovery>();
    const second = deferred<Recovery>();
    const coordinator = new WalletNodeMnemonicRevealCoordinator<Recovery>();
    const firstRun = coordinator.run({
      reveal: async () => first.promise,
      isCurrent: () => true,
    });
    const secondRun = coordinator.run({
      reveal: async () => second.promise,
      isCurrent: () => true,
    });

    second.resolve({ mnemonic24: 'current mnemonic' });
    first.resolve({ mnemonic24: 'stale mnemonic' });

    expect(await secondRun).toEqual({
      status: 'completed',
      recovery: { mnemonic24: 'current mnemonic' },
    });
    expect(await firstRun).toEqual({ status: 'cancelled', latest: false });
  });

  test('suppresses a stale failure after a newer reveal starts', async () => {
    const first = deferred<Recovery>();
    const second = deferred<Recovery>();
    const coordinator = new WalletNodeMnemonicRevealCoordinator<Recovery>();
    const firstRun = coordinator.run({
      reveal: async () => first.promise,
      isCurrent: () => true,
    });
    const secondRun = coordinator.run({
      reveal: async () => second.promise,
      isCurrent: () => true,
    });

    first.reject(new Error('STALE_FAILURE'));
    second.resolve({ mnemonic24: 'current mnemonic' });

    expect(await firstRun).toEqual({ status: 'cancelled', latest: false });
    expect((await secondRun).status).toBe('completed');
  });

  test('explicit invalidation cancels an in-flight reveal', async () => {
    const pending = deferred<Recovery>();
    const coordinator = new WalletNodeMnemonicRevealCoordinator<Recovery>();
    const run = coordinator.run({
      reveal: async () => pending.promise,
      isCurrent: () => true,
    });

    coordinator.invalidate();
    pending.resolve({ mnemonic24: 'invalidated mnemonic' });

    expect(await run).toEqual({ status: 'cancelled', latest: false });
  });

  test('keeps adapter access and secret publication in the Svelte event flow', () => {
    const boundary = readFileSync(
      'frontend/packages/browser/src/wallet-node-mnemonic-reveal.ts',
      'utf8',
    );
    const view = readFileSync(
      'frontend/src/lib/components/Views/RuntimeCreation.svelte',
      'utf8',
    );
    const guardIndex = view.indexOf("phase !== 'node-ready'");
    const runIndex = view.indexOf('const outcome = await walletNodeMnemonicReveal.run({');

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('getRuntimeControllerAdapter');
    expect(boundary).not.toContain('mnemonic24');
    expect(view).toContain('new WalletNodeMnemonicRevealCoordinator<RuntimeAdapterBrainVaultRecovery>()');
    expect(view).toContain('reveal: () => adapter.revealBrainVaultMnemonic()');
    expect(view).toContain("phase === 'node-ready'");
    expect(view).toContain('nodeDerivationResult === expectedResult');
    expect(view).toContain('getRuntimeControllerAdapter() === adapter');
    expect(view).toContain('revealedNodeMnemonic = outcome.recovery.mnemonic24');
    expect(view).toContain('if (outcome.latest) revealingNodeMnemonic = false');
    expect(view).toContain('walletNodeMnemonicReveal.invalidate()');
    expect(view).not.toContain('nodeRevealRunToken');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(runIndex).toBeGreaterThan(guardIndex);
  });
});
