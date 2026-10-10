import type {
  ConsensusConfig,
  RuntimeReplica,
  JurisdictionConfig,
  RuntimeRecoveryBundleV1,
  RuntimeRecoveryMetaV1,
  RuntimeRecoverySignerV1,
  TowerModeV1,
  TowerReceiptV1,
  XLNModule,
} from '@xln/core/api/public/runtime-module';
import {
  buildTowerRequestUrl as buildCoreTowerRequestUrl,
  discoverRuntimeRecoveryCandidates as discoverCoreRuntimeRecoveryCandidates,
  fetchTowerServerInfo as fetchCoreTowerServerInfo,
  normalizeRecoveryTowerConfigs,
  normalizeRecoveryTowerMode,
  normalizeTowerBaseUrl,
  parseRuntimeRecoveryCandidateFile as parseCoreRuntimeRecoveryCandidateFile,
} from '@xln/core/storage/recovery/discovery';
import {
  deriveRuntimeSignerAddress,
  deriveRuntimeSignerPrivateKey,
  normalizeRuntimeId,
} from '@xln/core/storage/recovery/bundle/seed-identity';
import { isUnknownRecord as isRecord, parseJsonUnknown } from '#lib/utils/boundary/index.ts';
export { isRecord };
import { getAddress } from 'ethers';
import {
  redactVaultRuntimeForPersistence,
  type ProtectedVaultSecrets,
  type VaultUnlockDurationMs,
} from '../../security/vaultProtection';
import { unwrapLiveRuntimeEnv } from '../../utils/runtime/liveRuntimeEnv';
import { installRuntimeCommandJournalKeys } from '../commands/runtimeCommandJournalKeyring';

/**
 * Vault-shaped wrappers over the canonical recovery implementation in
 * `core/storage/recovery/discovery`. Everything that is engine-independent —
 * asking towers and peers, opening bundles, proving the Runtime id, ranking
 * candidates — lives in core so both wallets run the same code. What stays here
 * is the vault's own shape: which towers this browser defaults to, the persisted
 * Runtime/Signer records, and the page context the local-tower proxy needs.
 */

export {
  normalizeRecoveryTowerConfigs,
  normalizeRecoveryTowerMode,
  normalizeRuntimeId,
  normalizeTowerBaseUrl,
};

export type {
  RecoveryTowerConfig,
  RuntimeRecoveryCandidate,
  RuntimeRecoveryCandidateSource,
  RuntimeRecoveryDiscoveryFailure,
  RuntimeRecoveryDiscoveryResult,
  RuntimeRecoveryFailureCategory,
  RuntimeRecoveryPeerRequest,
  RuntimeRecoveryPeerSource,
  TowerServerInfo,
} from '@xln/core/storage/recovery/discovery';
export { classifyRuntimeRecoveryDiscoveryFailure } from '@xln/core/storage/recovery/discovery';

import type {
  RecoveryTowerConfig,
  RuntimeRecoveryCandidate,
  RuntimeRecoveryDiscoveryResult,
  RuntimeRecoveryPeerSource,
  TowerServerInfo,
} from '@xln/core/storage/recovery/discovery';

/** The page asking, when there is one; enables the local-tower proxy path. */
const currentPageUrl = (): string | undefined =>
  typeof window === 'undefined' ? undefined : window.location.href;

// Persisted signer metadata intentionally excludes private key material.
export interface Signer {
  index: number; // signer list index
  derivationIndex?: number; // HD account index; defaults to the visible signer index when absent
  address: string;
  name: string;
  entityId?: string; // Auto-created entity for this signer
  jurisdiction?: string; // Preferred jurisdiction for this signer/runtime lane
}

export interface RuntimeRecoveryTowerReceiptSummary {
  towerUrl: string;
  towerMode: TowerModeV1;
  height: number;
  bundleHash: string;
  sequence: number;
  receivedAt: number;
  slot?: number;
  storedBytes?: number;
  maxStoredBytes?: number;
  expiresAt?: number;
  appointmentSequence?: number | null;
}

export interface RuntimeRecoveryTowerFailureSummary {
  towerUrl: string;
  towerMode: TowerModeV1;
  checkedAt: number;
  error: string;
}

export interface RuntimeRecoveryConfig {
  towers?: RecoveryTowerConfig[];
  useDefaultTowers?: boolean;
  waitForTowerReceipts?: boolean;
  minSuccessfulTowers?: number;
  maxStoredBytes?: number;
  lastKnownStoredBytes?: number;
  lastQuotaWarningAt?: number;
  lastTowerUploadAttemptAt?: number;
  lastTowerUploadAttemptHeight?: number;
  lastTowerReceipts?: RuntimeRecoveryTowerReceiptSummary[];
  lastTowerFailures?: RuntimeRecoveryTowerFailureSummary[];
}

export interface Runtime {
  id: string; // signer EOA (0xABCD...)
  label: string; // user-chosen name ("MyWallet")
  seed: string; // canonical 24-word mnemonic
  mnemonic12?: string; // optional derived 12-word interoperability mnemonic
  devicePassphrase?: string; // optional BrainVault device passphrase (if available)
  protectedSecrets?: ProtectedVaultSecrets;
  signers: Signer[];
  activeSignerIndex: number;
  loginType?: 'manual' | 'demo';
  requiresOnboarding?: boolean;
  recovery?: RuntimeRecoveryConfig;
  createdAt: number;
  env?: RuntimeReplica | null;
}

export const runtimeCreationInFlight = new Map<string, Promise<void>>();

export const signerCreationInFlight = new Map<string, Promise<Signer | null>>();

export const schemaMismatchRecoveryRuntimeIds = new Set<string>();

export type CreateRuntimeOptions = {
  loginType?: 'manual' | 'demo' | undefined;
  requiresOnboarding?: boolean | undefined;
  devicePassphrase?: string | undefined;
  mnemonic12?: string | undefined;
  recovery?: RuntimeRecoveryConfig | undefined;
  skipRecoveryRestore?: boolean | undefined;
  recoveryCandidate?: RuntimeRecoveryCandidate | undefined;
  unlockDurationMs?: VaultUnlockDurationMs | undefined;
};

export type RecoveryTowerSetupMode = 'official' | 'backup_only' | 'local_only';

export type ImportedJMachineConfig = {
  name: string;
  mode: 'browservm' | 'rpc';
  chainId: number;
  ticker: string;
  rpcs: string[];
  blockTimeMs: number;
  entityProviderDeploymentBlock?: number;
  contracts?: {
    depository?: string;
    entityProvider?: string;
    account?: string;
    deltaTransformer?: string;
  };
};

export type ApiJurisdictionConfig = JurisdictionConfig & {
  rpc?: string;
  rpcs?: string[];
  primary?: boolean;
  contracts: {
    depository: string;
    entityProvider: string;
    account: string;
    deltaTransformer: string;
  };
};

export const requireContractAddress = (value: string | null | undefined, label: string): string => {
  const raw = String(value || '').trim();
  if (!raw) {
    throw new Error(`MISSING_${label.toUpperCase()}_ADDRESS`);
  }
  try {
    return getAddress(raw);
  } catch {
    throw new Error(`INVALID_${label.toUpperCase()}_ADDRESS: ${raw}`);
  }
};

export const requireEntityProviderDeploymentBlock = (value: unknown, context: string): number => {
  const block = Number(value);
  if (!Number.isSafeInteger(block) || block < 1) {
    throw new Error(`[${context}] ENTITY_PROVIDER_DEPLOYMENT_BLOCK_INVALID: ${String(value)}`);
  }
  return block;
};

export const requireJurisdictionBlockTimeMs = (value: unknown, context: string): number => {
  const blockTimeMs = Number(value);
  if (!Number.isSafeInteger(blockTimeMs) || blockTimeMs <= 0) {
    throw new Error(`[${context}] JURISDICTION_BLOCK_TIME_INVALID: ${String(value)}`);
  }
  return blockTimeMs;
};

export interface RuntimesState {
  runtimes: Record<string, Runtime>;
  activeRuntimeId: string | null;
}

export const normalizeEntityId = (value: string | null | undefined): string =>
  String(value || '')
    .trim()
    .toLowerCase();

export const serializeVaultState = (state: RuntimesState): string =>
  JSON.stringify({
    activeRuntimeId: state.activeRuntimeId,
    runtimes: Object.fromEntries(
      Object.entries(state.runtimes).map(([runtimeId, runtime]) => [
        runtimeId,
        redactVaultRuntimeForPersistence(runtime),
      ]),
    ),
  });

export const RECOVERY_UPLOAD_DEBOUNCE_MS = 1_500;

export const RUNTIME_P2P_SHUTDOWN_TIMEOUT_MS = 10_000;

export const RECOVERY_TOWER_STATUS_LIMIT = 16;

export const shouldSkipRuntimeRecoveryUploadAtHeight = (
  previous: { lastUploadedHeight: number; lastBundleHash: string | null } | undefined,
  height: unknown,
): boolean => {
  const currentHeight = Math.max(0, Math.floor(Number(height || 0)));
  const previousHeight = Math.max(0, Math.floor(Number(previous?.lastUploadedHeight || 0)));
  return Boolean(previous?.lastBundleHash && currentHeight <= previousHeight);
};

export type HealthMachine = { name?: string; status?: string; chainId?: number; lastBlock?: unknown };

export type HealthPayload = {
  timestamp?: number;
  reset?: { inProgress?: boolean; lastError?: unknown };
  system?: { runtime?: boolean } | null;
  jMachines?: HealthMachine[];
};

export type JurisdictionsPayload = { version?: string; jurisdictions: Record<string, ApiJurisdictionConfig> };

export type RuntimeP2PHandle = {
  isConnected?: () => boolean;
  isConnecting?: () => boolean;
  connect?: () => void;
  refreshGossip?: () => void;
  getReconnectState?: () => { attempt: number; nextAt: number } | null;
};

export const getRuntimeP2PHandle = (xln: XLNModule, env: RuntimeReplica): RuntimeP2PHandle | null => {
  const candidate = xln.getP2P(unwrapLiveRuntimeEnv(env) ?? env);
  return isRecord(candidate) ? (candidate as RuntimeP2PHandle) : null;
};

export const getReplayMeta = (env: RuntimeReplica): unknown | null => {
  const value = Reflect.get(env as object, '__replayMeta');
  return value === undefined ? null : value;
};

export const deriveAddress = deriveRuntimeSignerAddress;

export const derivePrivateKey = deriveRuntimeSignerPrivateKey;

export const installVaultRuntimeCommandJournalKeys = async (runtimeIdValue: string, seed: string): Promise<void> => {
  const runtimeId = normalizeRuntimeId(runtimeIdValue);
  if (!runtimeId || normalizeRuntimeId(deriveAddress(seed, 0)) !== runtimeId) {
    throw new Error('RUNTIME_COMMAND_JOURNAL_VAULT_ID_MISMATCH');
  }
  await installRuntimeCommandJournalKeys(runtimeId, seed);
};

export const normalizeJurisdictionKey = (value: string | null | undefined): string =>
  String(value || '')
    .trim()
    .toLowerCase();

export type RuntimeJReplica = RuntimeReplica['state']['jReplicas'] extends Map<string, infer T> ? T : never;

export type RuntimeEntityReplica = RuntimeReplica['state']['eReplicas'] extends Map<string, infer T> ? T : never;

export const getJReplicaJurisdictionName = (replica: RuntimeJReplica | null | undefined, defaultName = ''): string =>
  String(replica?.name || defaultName || '').trim();

export const findJReplicaByName = (env: RuntimeReplica, name: string): RuntimeJReplica | undefined => {
  const normalized = normalizeJurisdictionKey(name);
  if (!normalized) return undefined;
  const direct = env.state.jReplicas?.get(name);
  if (direct) return direct;
  for (const replica of env.state.jReplicas?.values?.() || []) {
    if (normalizeJurisdictionKey(replica?.name) === normalized) return replica;
  }
  return undefined;
};

export const getEntityReplicaJurisdictionName = (replica: RuntimeEntityReplica | null | undefined): string =>
  String(replica?.state?.config?.jurisdiction?.name || '').trim();

export const getEntityReplicaEntityId = (key: string, replica: RuntimeEntityReplica | null | undefined): string =>
  String(replica?.entityId || replica?.state?.entityId || String(key || '').split(':')[0] || '')
    .trim()
    .toLowerCase();

export const findEntityReplicaByEntityId = (env: RuntimeReplica, entityId: string): RuntimeEntityReplica | undefined => {
  const target = normalizeEntityId(entityId);
  if (!target) return undefined;
  for (const [key, replica] of env.state.eReplicas?.entries?.() || []) {
    if (getEntityReplicaEntityId(String(key), replica) === target) return replica;
  }
  return undefined;
};

export const findEntityReplicaByEntityAndSigner = (
  env: RuntimeReplica,
  entityId: string,
  signerId: string,
): RuntimeEntityReplica | undefined => {
  const targetEntity = normalizeEntityId(entityId);
  const targetSigner = normalizeRuntimeId(signerId);
  if (!targetEntity || !targetSigner) return undefined;
  for (const [key, replica] of env.state.eReplicas?.entries?.() || []) {
    const [keyEntityId, keySignerId] = String(key || '').split(':');
    const replicaEntity = getEntityReplicaEntityId(String(key), replica);
    const replicaSigner = normalizeRuntimeId(replica?.signerId || keySignerId || '');
    if ((replicaEntity || normalizeEntityId(keyEntityId)) === targetEntity && replicaSigner === targetSigner) {
      return replica;
    }
  }
  return undefined;
};

export const getJReplicaContractAddress = (
  replica: RuntimeJReplica,
  label: 'depository' | 'entity_provider',
): string => {
  const contractKey = label === 'entity_provider' ? 'entityProvider' : 'depository';
  return requireContractAddress(
    (replica[`${contractKey}Address` as keyof RuntimeJReplica] as string | undefined) ||
      replica.contracts?.[contractKey],
    label,
  );
};

export const buildSignerEntityConfig = (
  signerAddress: string,
  jReplica: RuntimeJReplica,
  preferredJurisdictionName: string,
  defaultChainId: number,
): ConsensusConfig => {
  const jurisdictionName = getJReplicaJurisdictionName(jReplica, preferredJurisdictionName);
  if (!jurisdictionName) throw new Error('ENTITY_JURISDICTION_MISSING');
  const depositoryAddress = getJReplicaContractAddress(jReplica, 'depository');
  const entityProviderAddress = getJReplicaContractAddress(jReplica, 'entity_provider');
  const rpcAddress = String(jReplica.rpcs?.[0] || '').trim();
  const chainId = Number(jReplica.chainId ?? defaultChainId);
  const blockTimeMs = Number(jReplica.blockTimeMs);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new Error(`ENTITY_JURISDICTION_CHAIN_ID_MISSING: ${jurisdictionName}`);
  }
  if (!Number.isSafeInteger(blockTimeMs) || blockTimeMs <= 0) {
    throw new Error(`ENTITY_JURISDICTION_BLOCK_TIME_MISSING: ${jurisdictionName}`);
  }
  return {
    mode: 'proposer-based',
    threshold: 1n,
    validators: [signerAddress],
    shares: { [signerAddress]: 1n },
    jurisdiction: {
      address: rpcAddress || `jreplica://${jurisdictionName}`,
      name: jurisdictionName,
      chainId,
      blockTimeMs,
      entityProviderAddress,
      depositoryAddress,
    },
  };
};

export function getSignerDerivationIndex(signer: Signer | null | undefined): number {
  return Number.isInteger(signer?.derivationIndex) ? Number(signer!.derivationIndex) : Number(signer?.index ?? 0);
}

export const parseRecoveryTowerUrls = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map(entry => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && typeof (entry as { url?: unknown }).url === 'string') {
          return String((entry as { url: string }).url);
        }
        return '';
      })
      .map(url => String(url || '').trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      return parseRecoveryTowerUrls(parseJsonUnknown(trimmed, 'RECOVERY_TOWER_URLS_JSON_INVALID'));
    } catch {
      return trimmed
        .split(',')
        .map(entry => entry.trim())
        .filter(Boolean);
    }
  }
  return [];
};

export const resolveDefaultRecoveryTowerUrls = (options: {
  hostname: string;
  globalUrls?: unknown;
  localUrls?: unknown;
  envUrls?: unknown;
}): string[] => {
  const globalTowerUrls = parseRecoveryTowerUrls(options.globalUrls);
  if (globalTowerUrls.length > 0) return globalTowerUrls;
  const localTowerUrls = parseRecoveryTowerUrls(options.localUrls);
  if (localTowerUrls.length > 0) return localTowerUrls;
  const envTowerUrls = parseRecoveryTowerUrls(options.envUrls);
  if (envTowerUrls.length > 0) return envTowerUrls;
  const hostname = String(options.hostname || '')
    .trim()
    .toLowerCase();
  // Local/dev environments should not assume an always-on watchtower. Recovery towers
  // there must be configured explicitly, otherwise fresh wallet creation gets blocked by
  // an unrelated localhost dependency.
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return [];
  }
  return ['https://xln.finance'];
};

export const defaultRecoveryTowerUrls = (): string[] => {
  if (typeof window === 'undefined') return ['https://xln.finance'];
  const w = window as Window & { __XLN_WATCHTOWERS__?: unknown };
  let localUrls: string | null = null;
  try {
    localUrls = localStorage.getItem('xln-watchtower-urls');
  } catch {
    // Recovery should not fail because local tower preferences are unreadable.
  }
  return resolveDefaultRecoveryTowerUrls({
    hostname: window.location.hostname,
    globalUrls: w.__XLN_WATCHTOWERS__,
    localUrls,
    envUrls: import.meta.env?.['VITE_XLN_WATCHTOWER_URL'],
  });
};

export const nonNegativeInteger = (value: unknown): number => {
  const parsed = Math.floor(Number(value ?? 0));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

export const optionalNonNegativeInteger = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  return nonNegativeInteger(value);
};

export const compactRecoveryError = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error || 'unknown');
  return text.replace(/\s+/g, ' ').trim().slice(0, 240) || 'unknown';
};

export const summarizeRuntimeRecoveryTowerReceipt = (
  tower: RecoveryTowerConfig,
  receipt: TowerReceiptV1,
): RuntimeRecoveryTowerReceiptSummary => {
  const towerUrl = normalizeTowerBaseUrl(tower.url || receipt.towerId || '');
  const storedBytes = optionalNonNegativeInteger(receipt.storedBytes);
  const maxStoredBytes = optionalNonNegativeInteger(receipt.maxStoredBytes);
  const expiresAt = optionalNonNegativeInteger(receipt.expiresAt);
  return {
    towerUrl,
    towerMode: normalizeRecoveryTowerMode(receipt.towerMode || tower.towerMode),
    height: nonNegativeInteger(receipt.height),
    bundleHash: String(receipt.bundleHash || '')
      .trim()
      .toLowerCase(),
    sequence: nonNegativeInteger(receipt.sequence),
    receivedAt: nonNegativeInteger(receipt.receivedAt),
    ...(receipt.slot !== undefined ? { slot: nonNegativeInteger(receipt.slot) } : {}),
    ...(storedBytes !== undefined ? { storedBytes } : {}),
    ...(maxStoredBytes !== undefined ? { maxStoredBytes } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(receipt.appointmentSequence !== undefined ? { appointmentSequence: receipt.appointmentSequence } : {}),
  };
};

export const summarizeRuntimeRecoveryTowerFailure = (
  tower: RecoveryTowerConfig,
  error: unknown,
  checkedAt: number,
): RuntimeRecoveryTowerFailureSummary => ({
  towerUrl: normalizeTowerBaseUrl(tower.url),
  towerMode: normalizeRecoveryTowerMode(tower.towerMode),
  checkedAt: nonNegativeInteger(checkedAt),
  error: compactRecoveryError(error),
});

export const receiptSummaryKey = (receipt: RuntimeRecoveryTowerReceiptSummary): string =>
  `${receipt.towerUrl}|${receipt.towerMode}|${receipt.slot ?? 0}`;

export const mergeRuntimeRecoveryTowerReceipts = (
  previous: RuntimeRecoveryTowerReceiptSummary[] | undefined,
  current: RuntimeRecoveryTowerReceiptSummary[],
): RuntimeRecoveryTowerReceiptSummary[] => {
  const deduped = new Map<string, RuntimeRecoveryTowerReceiptSummary>();
  for (const receipt of [...current, ...(previous || [])]) {
    const key = receiptSummaryKey(receipt);
    if (!deduped.has(key)) deduped.set(key, receipt);
  }
  return [...deduped.values()]
    .sort(
      (left, right) =>
        right.receivedAt - left.receivedAt || right.height - left.height || right.sequence - left.sequence,
    )
    .slice(0, RECOVERY_TOWER_STATUS_LIMIT);
};

export const buildDefaultRecoveryTowerConfigs = (): RecoveryTowerConfig[] =>
  defaultRecoveryTowerUrls().map((url, index) => ({
    id: `official-${index + 1}`,
    url: normalizeTowerBaseUrl(url),
    // The official tower does both jobs: encrypted backup storage and delayed
    // last-resort counter-dispute. Blind backups are still uploaded for every
    // configured tower; this mode only opts the same endpoint into the active
    // rescue appointment channel too.
    towerMode: 'delayed_last_resort' as const,
    enabled: true,
  }));

export const buildDefaultRuntimeRecoveryConfig = (): RuntimeRecoveryConfig => ({
  useDefaultTowers: false,
  waitForTowerReceipts: false,
  towers: buildDefaultRecoveryTowerConfigs(),
});

export const buildRuntimeRecoveryConfigForMode = (
  mode: RecoveryTowerSetupMode,
  options: {
    officialTowerUrl?: string | null;
    manualTowers?: RecoveryTowerConfig[];
    previous?: RuntimeRecoveryConfig | null;
  } = {},
): RuntimeRecoveryConfig => {
  const manualTowers = normalizeRecoveryTowerConfigs(options.manualTowers);
  const officialTowerUrl = normalizeTowerBaseUrl(options.officialTowerUrl || defaultRecoveryTowerUrls()[0] || '');
  const towers: RecoveryTowerConfig[] = [];

  if (mode !== 'local_only' && officialTowerUrl) {
    towers.push({
      id: 'official-watchtower',
      url: officialTowerUrl,
      towerMode: mode === 'backup_only' ? 'blind_backup' : 'delayed_last_resort',
      enabled: true,
    });
  }

  for (const tower of manualTowers) {
    if (towers.some(existing => existing.url === tower.url)) continue;
    towers.push(tower);
  }

  return {
    ...(options.previous || {}),
    useDefaultTowers: false,
    waitForTowerReceipts: options.previous?.waitForTowerReceipts === true,
    towers,
  };
};

export const buildTowerRequestUrl = (towerUrl: string, towerPath: string): string =>
  buildCoreTowerRequestUrl(towerUrl, towerPath, currentPageUrl());

export const getConfiguredRecoveryTowers = (runtime: Runtime | null | undefined): RecoveryTowerConfig[] => {
  const explicit = (runtime?.recovery?.towers || [])
    .map(tower => ({
      ...tower,
      url: normalizeTowerBaseUrl(tower.url),
      towerMode: normalizeRecoveryTowerMode(tower.towerMode),
      enabled: tower.enabled !== false,
    }))
    .filter(tower => !!tower.url && tower.enabled !== false);
  const defaultTowers = runtime?.recovery?.useDefaultTowers === false ? [] : buildDefaultRecoveryTowerConfigs();
  const deduped = new Map<string, RecoveryTowerConfig>();
  for (const tower of explicit) {
    if (!tower.url) continue;
    deduped.set(tower.url, tower);
  }
  for (const tower of defaultTowers) {
    if (!tower.url || deduped.has(tower.url)) continue;
    deduped.set(tower.url, tower);
  }
  return [...deduped.values()];
};

export const fetchTowerServerInfo = async (towerUrl: string): Promise<TowerServerInfo> =>
  await fetchCoreTowerServerInfo(towerUrl, currentPageUrl());

export async function parseRuntimeRecoveryCandidateFile(
  seed: string,
  fileContents: string,
  options: { sourceLabel?: string; xln?: XLNModule } = {},
): Promise<RuntimeRecoveryCandidate> {
  return await parseCoreRuntimeRecoveryCandidateFile(seed, fileContents, {
    ...(options.sourceLabel ? { sourceLabel: options.sourceLabel } : {}),
    ...(options.xln ? { crypto: options.xln } : {}),
  });
}

/**
 * Resolve the towers this vault actually trusts, then ask core. Default-tower
 * policy is a browser-origin decision, so it stays here; discovery itself does
 * not differ between wallets.
 */
export async function discoverRuntimeRecoveryCandidates(
  seed: string,
  options: {
    recovery?: RuntimeRecoveryConfig;
    towers?: RecoveryTowerConfig[];
    peers?: RuntimeRecoveryPeerSource[];
    xln?: XLNModule;
  } = {},
): Promise<RuntimeRecoveryDiscoveryResult> {
  const recovery =
    options.recovery ||
    (options.towers ? { useDefaultTowers: false, towers: options.towers } : buildDefaultRuntimeRecoveryConfig());
  const runtimeProbe: Runtime = {
    id: normalizeRuntimeId(deriveAddress(seed, 0)),
    label: 'Recovery probe',
    seed,
    signers: [],
    activeSignerIndex: 0,
    recovery,
    createdAt: Date.now(),
  };
  return await discoverCoreRuntimeRecoveryCandidates(seed, {
    towers: getConfiguredRecoveryTowers(runtimeProbe),
    ...(options.peers ? { peers: options.peers } : {}),
    ...(options.xln ? { crypto: options.xln } : {}),
    ...(currentPageUrl() ? { pageUrl: currentPageUrl() } : {}),
  });
}

export const buildRuntimeRecoverySigners = (runtime: Runtime): RuntimeRecoverySignerV1[] =>
  (runtime.signers || [])
    .map((signer, index) => ({
      index,
      derivationIndex: getSignerDerivationIndex(signer),
      address: normalizeRuntimeId(signer.address),
      name: String(signer.name || `Signer ${index + 1}`),
      ...(signer.entityId ? { entityId: normalizeEntityId(signer.entityId) } : {}),
      ...(signer.jurisdiction ? { jurisdiction: String(signer.jurisdiction).trim() } : {}),
    }))
    .filter(signer => !!signer.address);

export const buildRuntimeRecoveryMeta = (runtime: Runtime): RuntimeRecoveryMetaV1 => ({
  label: runtime.label,
  activeSignerIndex: Math.max(0, Math.floor(Number(runtime.activeSignerIndex || 0))),
  loginType: runtime.loginType === 'demo' ? 'demo' : 'manual',
  ...(typeof runtime.requiresOnboarding === 'boolean' ? { requiresOnboarding: runtime.requiresOnboarding } : {}),
  createdAt: runtime.createdAt,
});

export const applyRecoveryBundleMetadata = (runtime: Runtime, bundle: RuntimeRecoveryBundleV1): boolean => {
  let changed = false;
  const restoredSigners = [...bundle.signers]
    .sort((left, right) => left.index - right.index)
    .map((signer, index) => ({
      index,
      ...(Number.isFinite(Number(signer.derivationIndex))
        ? { derivationIndex: Math.max(0, Math.floor(Number(signer.derivationIndex))) }
        : {}),
      address: normalizeRuntimeId(signer.address),
      name: String(signer.name || `Signer ${index + 1}`),
      ...(signer.entityId ? { entityId: normalizeEntityId(signer.entityId) } : {}),
      ...(signer.jurisdiction ? { jurisdiction: String(signer.jurisdiction).trim() } : {}),
    }))
    .filter(signer => !!signer.address);

  const nextLabel = String(bundle.meta?.label || runtime.label || 'Runtime').trim() || 'Runtime';
  if (runtime.label !== nextLabel) {
    runtime.label = nextLabel;
    changed = true;
  }
  if (restoredSigners.length > 0) {
    const current = JSON.stringify(runtime.signers);
    const incoming = JSON.stringify(restoredSigners);
    if (current !== incoming) {
      runtime.signers = restoredSigners;
      changed = true;
    }
  }

  const nextActiveSignerIndex = Math.max(
    0,
    Math.min(
      restoredSigners.length > 0 ? restoredSigners.length - 1 : Math.max(0, runtime.signers.length - 1),
      Math.floor(Number(bundle.meta?.activeSignerIndex ?? runtime.activeSignerIndex ?? 0)),
    ),
  );
  if (runtime.activeSignerIndex !== nextActiveSignerIndex) {
    runtime.activeSignerIndex = nextActiveSignerIndex;
    changed = true;
  }
  const nextLoginType = bundle.meta?.loginType === 'demo' ? 'demo' : 'manual';
  if (runtime.loginType !== nextLoginType) {
    runtime.loginType = nextLoginType;
    changed = true;
  }
  if (
    typeof bundle.meta?.requiresOnboarding === 'boolean' &&
    runtime.requiresOnboarding !== bundle.meta.requiresOnboarding
  ) {
    runtime.requiresOnboarding = bundle.meta.requiresOnboarding;
    changed = true;
  }
  if (Number.isFinite(Number(bundle.meta?.createdAt || 0))) {
    const nextCreatedAt = Math.max(0, Math.floor(Number(bundle.meta?.createdAt || runtime.createdAt)));
    if (runtime.createdAt !== nextCreatedAt) {
      runtime.createdAt = nextCreatedAt;
      changed = true;
    }
  }
  return changed;
};
