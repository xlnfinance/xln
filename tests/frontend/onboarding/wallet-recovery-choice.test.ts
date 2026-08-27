import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  mergeWalletRecoveryCandidate,
  resolveWalletRecoveryContinuation,
  summarizeWalletRecoveryCandidates,
  type WalletRecoveryCandidateChoice,
} from '../../../frontend/packages/browser/src/wallet-recovery-choice';

type Candidate = WalletRecoveryCandidateChoice & Readonly<{ label: string }>;

const candidate = (
  id: string,
  overrides: Partial<Candidate> = {},
): Candidate => ({
  id,
  source: 'tower',
  runtimeHeight: 1,
  createdAt: 1,
  label: id,
  ...overrides,
});

describe('browser wallet recovery choice', () => {
  test('selects the requested candidate while counting peer backups once', () => {
    const selected = candidate('selected');
    const candidates = [
      candidate('peer-a', { source: 'peer' }),
      selected,
      candidate('peer-b', { source: 'peer' }),
    ];

    expect(summarizeWalletRecoveryCandidates(candidates, selected.id)).toEqual({
      selectedCandidate: selected,
      peerBackupCount: 2,
    });
  });

  test('falls back to the first candidate when selection is empty or stale', () => {
    const first = candidate('first');
    const candidates = [first, candidate('second')];

    expect(summarizeWalletRecoveryCandidates(candidates, '').selectedCandidate).toBe(first);
    expect(summarizeWalletRecoveryCandidates(candidates, 'missing').selectedCandidate).toBe(first);
  });

  test('returns no selection for an empty recovery result', () => {
    expect(summarizeWalletRecoveryCandidates([], 'missing')).toEqual({
      selectedCandidate: null,
      peerBackupCount: 0,
    });
  });

  test('immutably replaces a matching file candidate and sorts newest tip first', () => {
    const replaced = candidate('file', { runtimeHeight: 2, createdAt: 20 });
    const high = candidate('high', { runtimeHeight: 8, createdAt: 80 });
    const input = [high, replaced];
    const imported = candidate('file', { runtimeHeight: 10, createdAt: 100, label: 'imported' });

    const result = mergeWalletRecoveryCandidate(input, imported);

    expect(result).toEqual([imported, high]);
    expect(input).toEqual([high, replaced]);
  });

  test('uses creation time to order candidates at the same Runtime height', () => {
    const older = candidate('older', { runtimeHeight: 5, createdAt: 10 });
    const newer = candidate('newer', { runtimeHeight: 5, createdAt: 20 });

    expect(mergeWalletRecoveryCandidate([older], newer)).toEqual([newer, older]);
  });

  test('preserves inserted-first ordering when height and creation time tie', () => {
    const existing = candidate('existing', { runtimeHeight: 5, createdAt: 20 });
    const imported = candidate('imported', { runtimeHeight: 5, createdAt: 20 });

    expect(mergeWalletRecoveryCandidate([existing], imported)).toEqual([imported, existing]);
  });

  test('chooses backup, local, and fresh continuation in canonical precedence', () => {
    expect(resolveWalletRecoveryContinuation({
      hasCandidates: true,
      localRuntimeAvailable: true,
    })).toBe('choose-backup');
    expect(resolveWalletRecoveryContinuation({
      hasCandidates: false,
      localRuntimeAvailable: true,
    })).toBe('open-local');
    expect(resolveWalletRecoveryContinuation({
      hasCandidates: false,
      localRuntimeAvailable: false,
    })).toBe('create-fresh');
  });

  test('keeps discovery, file parsing, and Runtime actions in the Svelte flow', () => {
    const boundary = readFileSync(
      'frontend/packages/browser/src/wallet-recovery-choice.ts',
      'utf8',
    );
    const view = readFileSync(
      'frontend/src/lib/components/Views/RuntimeCreation.svelte',
      'utf8',
    );

    expect(boundary).not.toContain('svelte');
    expect(boundary).not.toContain('@xln/brainvault');
    expect(boundary).not.toContain('vaultOperations');
    expect(view).toContain('summarizeWalletRecoveryCandidates(');
    expect(view).toContain('resolveWalletRecoveryContinuation({');
    expect(view).toContain('mergeWalletRecoveryCandidate(recoveryCandidates, candidate)');
    expect(view).toContain('await discoverRuntimeRecoveryCandidates(mnemonic24, {');
    expect(view).toContain('await parseRuntimeRecoveryCandidateFile(');
    expect(view).toContain('await openLocalRuntime()');
    expect(view).toContain('await createFreshRuntime()');
    expect(view).not.toContain("recoveryCandidates.filter((candidate) => candidate.source === 'peer')");
  });
});
