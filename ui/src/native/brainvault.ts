import { FACTOR_PRESETS, customWork, deriveBrainvaultMnemonic } from '../runtime/brainvault';
import { bootHostedVault, detectStack } from '../runtime/hosted';
import { runtimeIdForSeed } from '../runtime/keys';
import { discoverTowerRestore } from '../runtime/restore';
import { saveRecovery } from '../runtime/recovery';
import { nativeBackup, nativeBackupAddress } from './backup';
import { getXLN } from '../runtime/xln-loader';
import { recoveryDiscoveryError } from '../runtime/recovery-failure';
import { hasLocalWalletData } from '../runtime/local-wallet-data';

declare const __XLN_STACK_ORIGIN__: string;
let derivation: AbortController | null = null;

export function cancelNativeBrainvault(): boolean {
  if (!derivation) return false;
  derivation.abort();
  return true;
}

export async function openNativeBrainvault(command: Record<string, unknown>, publish: (value: unknown) => void) {
  const { name, password, factor, shards } = command;
  if (typeof name !== 'string' || typeof password !== 'string') throw new Error('Enter your BrainVault name and password.');
  const creating = command['intent'] === 'create';
  if (command['intent'] !== undefined && !creating) throw new Error('Unknown BrainVault action.');
  if (creating && command['confirmation'] !== password) throw new Error('Passwords do not match.');
  if (creating && command['backupConsent'] !== true) throw new Error('Allow sending an encrypted copy first.');
  const work = typeof shards === 'number' ? customWork(shards) : FACTOR_PRESETS.find(item => item.factor === factor);
  if (!work) throw new Error('Select your original BrainVault work settings.');
  const controller = new AbortController();
  derivation = controller;
  try {
    publish({ kind: 'progress', message: 'Deriving your BrainVault on this iPhone…' });
    const result = await deriveBrainvaultMnemonic(name.trim(), password, work,
      progress => publish({ kind: 'brainvaultProgress', completed: progress.completed, total: progress.total }), controller.signal);
    if (controller.signal.aborted) throw new Error('BRAINVAULT_ABORTED');
    const vaultId = runtimeIdForSeed(result.mnemonic).toLowerCase();
    // Only the public identity crosses the presentation bridge. A password typo
    // derives another identity; absent verified recovery must never create a fresh account.
    publish({ kind: 'brainvaultIdentity', runtimeId: vaultId });
    const local = await hasLocalWalletData(vaultId);
    const address = nativeBackupAddress();
    if (creating) {
      if (local) throw new Error('This BrainVault already exists. Choose Open BrainVault.');
      const xln = await getXLN();
      const found = await xln.discoverRuntimeRecoveryCandidates(result.mnemonic, {
        towers: [{ url: address }], crypto: xln, pageUrl: window.location.href, signal: controller.signal,
      });
      if (found.candidates.length) throw new Error('This BrainVault already exists. Choose Open BrainVault.');
      // Creation is explicit. Missing recovery never authorizes an ordinary
      // open to start empty, and an unavailable/corrupt tower cannot prove absence.
      if (!found.checkedTowers || !found.failures.length || found.failures.some(f => f.category !== 'ExpectedEmpty'))
        throw recoveryDiscoveryError(found);
    }
    publish({ kind: 'progress', message: creating ? 'Creating your BrainVault…' : local ? 'Opening your saved BrainVault…' : 'Finding and verifying your encrypted backup…' });
    const recovery = local || creating ? undefined : await discoverTowerRestore(result.mnemonic, address, controller.signal);
    if (controller.signal.aborted) throw new Error('BRAINVAULT_ABORTED');
    const stack = await detectStack(__XLN_STACK_ORIGIN__);
    if (!stack) throw new Error('The xln network is unavailable. Your wallet remains on this iPhone.');
    if (controller.signal.aborted) throw new Error('BRAINVAULT_ABORTED');
    // From here boot may persist recovered state. Revoke cancellation before
    // publishing the phase so a queued Cancel cannot hide a storage failure
    // or claim rollback while the canonical boot continues writing.
    derivation = null;
    publish({ kind: 'brainvaultFinalizing' });
    await bootHostedVault(result.mnemonic, { vaultId, vaultName: name.trim(), kind: 'brainvault',
      selfLabel: name.trim(), stack,
      ...(recovery ? { recovery } : {}), onStep: message => publish({ kind: 'progress', message }) });
    if (recovery) saveRecovery(vaultId, { mode: 'tower', towers: [address] });
    if (creating) {
      publish({ kind: 'progress', message: 'Verifying your encrypted recovery copy…' });
      await nativeBackup(true, command['backupConsent']);
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('BRAINVAULT_ABORTED', { cause: error });
    throw error;
  } finally { derivation = null; }
}
