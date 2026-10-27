import type {
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeRecoveryBundleV1,
  TowerModeV1,
  TowerReceiptV1,
} from '../bundle/types';

/**
 * Wallet-independent shapes for finding an encrypted Runtime backup again.
 *
 * Discovery is the read half of the watchtower promise: a device that lost its
 * durable storage asks every configured tower and peer for ciphertext, opens it
 * with the seed, and proves each bundle belongs to this exact Runtime id before
 * anything is applied. None of that depends on which wallet shell is running.
 */

export type RecoveryTowerConfig = {
  id?: string;
  url: string;
  towerMode?: TowerModeV1;
  enabled?: boolean;
};

export type RuntimeRecoveryCandidateSource = 'tower' | 'file' | 'peer';

export type RuntimeRecoveryFailureCategory = 'ExpectedEmpty' | 'TransientRace' | 'Contradiction';

export type RuntimeRecoveryDiscoveryFailure = {
  source: Exclude<RuntimeRecoveryCandidateSource, 'file'>;
  sourceLabel: string;
  category: RuntimeRecoveryFailureCategory;
  code: string;
  message: string;
};

export type RuntimeRecoveryPeerRequest = {
  runtimeId: string;
  lookupKey: string;
};

export type RuntimeRecoveryPeerSource = {
  id?: string;
  label: string;
  fetchBundles: (request: RuntimeRecoveryPeerRequest) => Promise<unknown>;
};

export type RuntimeRecoveryCandidate = {
  id: string;
  source: RuntimeRecoveryCandidateSource;
  sourceLabel: string;
  towerUrl?: string;
  peerId?: string;
  receipt?: TowerReceiptV1;
  encryptedBundles: EncryptedRuntimeRecoveryBundleV1[];
  bundles: RuntimeRecoveryBundleV1[];
  tipBundle: RuntimeRecoveryBundleV1;
  metadataBundle: RuntimeRecoveryBundleV1;
  runtimeId: string;
  runtimeHeight: number;
  createdAt: number;
  signerCount: number;
  checkpointHash: string;
  bundleCount: number;
};

export type RuntimeRecoveryDiscoveryResult = {
  runtimeId: string;
  lookupKey: string;
  candidates: RuntimeRecoveryCandidate[];
  errors: string[];
  failures: RuntimeRecoveryDiscoveryFailure[];
  checkedTowers: number;
  checkedPeers: number;
};

export type TowerServerInfo = {
  ok: boolean;
  service?: string;
  towerId?: string;
  signerAddress?: string;
  maxStoredBytesPerLookupKey?: number;
  maxBundlesPerLookupKey?: number;
};

export type TowerRestorePayload = {
  ok: boolean;
  receipt?: TowerReceiptV1;
  bundles?: EncryptedRuntimeRecoveryBundleV1[];
  error?: string;
};

export type TowerDiscoverPayload = {
  ok: boolean;
  lookupKey?: string;
  available?: boolean;
  latestReceipt?: TowerReceiptV1 | null;
  error?: string;
};

/**
 * The two seed-bound operations discovery performs. A wallet that already holds
 * a loaded Runtime module passes it here so the browser does not instantiate a
 * second copy of the same canonical crypto; omitting it uses that canonical
 * implementation directly. There is no third behaviour.
 */
export type RuntimeRecoveryCryptoPort = {
  decryptRuntimeRecoveryBundle: (
    bundle: EncryptedRuntimeRecoveryBundleV1,
    runtimeSeed: string,
  ) => Promise<RuntimeRecoveryBundleV1>;
  deriveRuntimeRecoveryLookupKey: (runtimeId: string, runtimeSeed: string) => string;
};

export const normalizeTowerBaseUrl = (url: string): string =>
  String(url || '')
    .trim()
    .replace(/\/+$/, '');

export const normalizeRecoveryTowerMode = (mode: unknown): TowerModeV1 =>
  mode === 'delayed_last_resort' ? mode : 'blind_backup';

export const normalizeRecoveryTowerConfigs = (
  towers: readonly RecoveryTowerConfig[] | undefined,
): RecoveryTowerConfig[] => {
  const deduped = new Map<string, RecoveryTowerConfig>();
  for (const tower of towers || []) {
    const url = normalizeTowerBaseUrl(tower.url);
    if (!url || tower.enabled === false) continue;
    deduped.set(url, {
      ...tower,
      id: tower.id || `tower-${deduped.size + 1}`,
      url,
      towerMode: normalizeRecoveryTowerMode(tower.towerMode),
      enabled: true,
    });
  }
  return [...deduped.values()];
};
