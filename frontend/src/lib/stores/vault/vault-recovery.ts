import type {
  ConsensusConfig,
  EncryptedRuntimeRecoveryBundleV1,
  RuntimeReplica,
  JurisdictionConfig,
  RuntimeRecoveryBundleV1,
  RuntimeRecoveryMetaV1,
  RuntimeRecoverySignerV1,
  TowerModeV1,
  TowerReceiptV1,
  XLNModule,
} from '@xln/runtime/api/public/runtime-module';
import { parseJsonUnknown } from '$lib/utils/boundary';
import { HDNodeWallet, Mnemonic, getAddress, getIndexedAccountPath } from 'ethers';
import {
  redactVaultRuntimeForPersistence,
  type ProtectedVaultSecrets,
  type VaultUnlockDurationMs,
} from '../../security/vaultProtection';
import { unwrapLiveRuntimeEnv } from '../../utils/runtime/liveRuntimeEnv';
import { installRuntimeCommandJournalKeys } from '../commands/runtimeCommandJournalKeyring';
import { getXLN } from '../xlnStore';

const recoveryTowerInfoCache = new Map<string, { fetchedAt: number; info: TowerServerInfo }>();

// Persisted signer metadata intentionally excludes private key material.
export interface Signer {
  index: number; // signer list index
  derivationIndex?: number; // HD account index; defaults to the visible signer index when absent
  address: string;
  name: string;
  entityId?: string; // Auto-created entity for this signer
  jurisdiction?: string; // Preferred jurisdiction for this signer/runtime lane
}

export interface RecoveryTowerConfig {
  id?: string;
  url: string;
  towerMode?: TowerModeV1;
  enabled?: boolean;
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

export const normalizeRuntimeId = (value: string | null | undefined): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return getAddress(raw).toLowerCase();
  } catch {
    return '';
  }
};

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

export const RECOVERY_SNAPSHOT_INTERVAL_FRAMES = 10_000;

export const RUNTIME_P2P_SHUTDOWN_TIMEOUT_MS = 10_000;

export const RECOVERY_TOWER_INFO_TTL_MS = 60_000;

export const RECOVERY_TOWER_STATUS_LIMIT = 16;

export const shouldSkipRuntimeRecoveryUploadAtHeight = (
  previous: { lastUploadedHeight: number; lastBundleHash: string | null } | undefined,
  height: unknown,
): boolean => {
  const currentHeight = Math.max(0, Math.floor(Number(height || 0)));
  const previousHeight = Math.max(0, Math.floor(Number(previous?.lastUploadedHeight || 0)));
  return Boolean(previous?.lastBundleHash && currentHeight <= previousHeight);
};

export type FrameLogEntry = RuntimeReplica['frameLogs'][number];

export type HealthMachine = { name?: string; status?: string; chainId?: number; lastBlock?: unknown };

export type HealthPayload = {
  timestamp?: number;
  reset?: { inProgress?: boolean; lastError?: unknown };
  system?: { runtime?: boolean } | null;
  jMachines?: HealthMachine[];
};

export type JurisdictionsPayload = { version?: string; jurisdictions: Record<string, ApiJurisdictionConfig> };

export type FaucetResult = { success?: boolean; txHash?: string; error?: string };

export type RuntimeP2PHandle = {
  isConnected?: () => boolean;
  isConnecting?: () => boolean;
  connect?: () => void;
  refreshGossip?: () => void;
  getReconnectState?: () => { attempt: number; nextAt: number } | null;
};

export type TowerRestorePayload = {
  ok: boolean;
  receipt?: TowerReceiptV1;
  bundle?: EncryptedRuntimeRecoveryBundleV1;
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

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const getRuntimeP2PHandle = (xln: XLNModule, env: RuntimeReplica): RuntimeP2PHandle | null => {
  const candidate = xln.getP2P(unwrapLiveRuntimeEnv(env) ?? env);
  return isRecord(candidate) ? (candidate as RuntimeP2PHandle) : null;
};

export const getReplayMeta = (env: RuntimeReplica): unknown | null => {
  const value = Reflect.get(env as object, '__replayMeta');
  return value === undefined ? null : value;
};

export // HD derivation helper
function deriveAddress(seed: string, index: number): string {
  const mnemonic = Mnemonic.fromPhrase(seed);
  const hdNode = HDNodeWallet.fromMnemonic(mnemonic, getIndexedAccountPath(index));
  return hdNode.address.toLowerCase();
}

export function derivePrivateKey(seed: string, index: number): string {
  const mnemonic = Mnemonic.fromPhrase(seed);
  const hdNode = HDNodeWallet.fromMnemonic(mnemonic, getIndexedAccountPath(index));
  return hdNode.privateKey;
}

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

export const normalizeTowerBaseUrl = (url: string): string =>
  String(url || '')
    .trim()
    .replace(/\/+$/, '');

export const normalizeRecoveryTowerMode = (mode: unknown): TowerModeV1 =>
  mode === 'delayed_last_resort' ? mode : 'blind_backup';

export const normalizeRecoveryTowerConfigs = (towers: RecoveryTowerConfig[] | undefined): RecoveryTowerConfig[] => {
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

export const buildTowerRequestUrl = (towerUrl: string, towerPath: string): string => {
  const normalizedBaseUrl = normalizeTowerBaseUrl(towerUrl);
  const normalizedPath = towerPath.startsWith('/') ? towerPath : `/${towerPath}`;
  if (typeof window !== 'undefined') {
    const pageUrl = new URL(window.location.href);
    const targetUrl = new URL(`${normalizedBaseUrl}/`);
    const isSecurePage = pageUrl.protocol === 'https:';
    const isLocalInsecureTower =
      targetUrl.protocol === 'http:' && (targetUrl.hostname === '127.0.0.1' || targetUrl.hostname === 'localhost');
    if (isSecurePage && isLocalInsecureTower) {
      const proxyUrl = new URL('/api/watchtower-proxy', pageUrl.origin);
      proxyUrl.searchParams.set('target', normalizedBaseUrl);
      proxyUrl.searchParams.set('path', normalizedPath);
      return proxyUrl.toString();
    }
  }
  return new URL(normalizedPath, `${normalizedBaseUrl}/`).toString();
};

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

export async function fetchTowerServerInfo(towerUrl: string): Promise<TowerServerInfo> {
  const normalizedUrl = normalizeTowerBaseUrl(towerUrl);
  const cached = recoveryTowerInfoCache.get(normalizedUrl);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < RECOVERY_TOWER_INFO_TTL_MS) {
    return cached.info;
  }
  const response = await fetch(buildTowerRequestUrl(normalizedUrl, '/api/tower/healthz'), {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`TOWER_INFO_HTTP_${response.status}`);
  }
  const payload = (await response.json()) as TowerServerInfo;
  if (!payload.ok) {
    throw new Error(`TOWER_INFO_INVALID:${normalizedUrl}`);
  }
  recoveryTowerInfoCache.set(normalizedUrl, { fetchedAt: now, info: payload });
  return payload;
}

export async function towerHasRecoveryBundle(tower: RecoveryTowerConfig, lookupKey: string): Promise<boolean> {
  const discoverUrl = buildTowerRequestUrl(tower.url, '/api/recovery/discover');
  const response = await fetch(discoverUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lookupKey }),
  });
  if (!response.ok) {
    throw new Error(`HTTP_${response.status}`);
  }
  const payload = (await response.json()) as TowerDiscoverPayload;
  if (!payload.ok) {
    if (payload.error === 'TOWER_BUNDLE_NOT_FOUND') return false;
    throw new Error(String(payload.error || 'unknown'));
  }
  return payload.available === true;
}

export const isEncryptedRuntimeRecoveryBundle = (value: unknown): value is EncryptedRuntimeRecoveryBundleV1 => {
  if (!isRecord(value)) return false;
  return (
    value['version'] === 1 &&
    typeof value['runtimeId'] === 'string' &&
    typeof value['lookupKey'] === 'string' &&
    typeof value['bundleHash'] === 'string' &&
    typeof value['iv'] === 'string' &&
    typeof value['ciphertext'] === 'string'
  );
};

export const extractEncryptedRecoveryBundles = (payload: unknown): EncryptedRuntimeRecoveryBundleV1[] => {
  if (isEncryptedRuntimeRecoveryBundle(payload)) return [payload];
  if (!isRecord(payload)) return [];
  const rawBundles = Array.isArray(payload['bundles'])
    ? payload['bundles']
    : payload['bundle']
      ? [payload['bundle']]
      : [];
  return rawBundles.filter(isEncryptedRuntimeRecoveryBundle);
};

export const getBundleReferenceHash = (bundle: RuntimeRecoveryBundleV1): string =>
  String(bundle.checkpointHash || bundle.baseCheckpointHash || '')
    .trim()
    .toLowerCase();

export const sortRecoveryBundlesByTip = (left: RuntimeRecoveryBundleV1, right: RuntimeRecoveryBundleV1): number => {
  if (right.runtimeHeight !== left.runtimeHeight) return right.runtimeHeight - left.runtimeHeight;
  return right.createdAt - left.createdAt;
};

export const sortRecoveryCandidatesByTip = (
  left: RuntimeRecoveryCandidate,
  right: RuntimeRecoveryCandidate,
): number => {
  if (right.runtimeHeight !== left.runtimeHeight) return right.runtimeHeight - left.runtimeHeight;
  if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt;
  return (right.receipt?.sequence || 0) - (left.receipt?.sequence || 0);
};

export const normalizeRecoveryFailureCode = (message: string): string => {
  const code = message.trim().split(/[\s:]/)[0] || 'UNKNOWN';
  return code.replace(/[^A-Z0-9_]/gi, '_').toUpperCase();
};

export const classifyRuntimeRecoveryDiscoveryFailure = (input: {
  source: Exclude<RuntimeRecoveryCandidateSource, 'file'>;
  sourceLabel: string;
  message: string;
}): RuntimeRecoveryDiscoveryFailure => {
  const message = String(input.message || 'unknown').trim() || 'unknown';
  const code = normalizeRecoveryFailureCode(message);
  const lower = message.toLowerCase();
  const category: RuntimeRecoveryFailureCategory =
    code === 'TOWER_BUNDLE_NOT_FOUND' ||
    code === 'PEER_RECOVERY_BUNDLE_EMPTY' ||
    code === 'RECOVERY_CANDIDATE_EMPTY' ||
    code === 'HTTP_404'
      ? 'ExpectedEmpty'
      : code.startsWith('HTTP_5') ||
          code === 'HTTP_408' ||
          code === 'HTTP_409' ||
          code === 'HTTP_425' ||
          code === 'HTTP_429' ||
          lower.includes('timeout') ||
          lower.includes('offline') ||
          lower.includes('connect') ||
          lower.includes('network') ||
          lower.includes('fetch') ||
          code === 'RECOVERY_REQUEST_SEND_FAILED' ||
          code === 'RECOVERY_REQUEST_SOCKET_CLOSED' ||
          code === 'RECOVERY_REQUEST_SOCKET_PAUSED'
        ? 'TransientRace'
        : 'Contradiction';
  return {
    source: input.source,
    sourceLabel: String(input.sourceLabel || input.source).trim() || input.source,
    category,
    code,
    message,
  };
};

export const recoveryFailureErrorText = (failure: RuntimeRecoveryDiscoveryFailure): string =>
  `${failure.sourceLabel}:${failure.message}`;

export const buildRuntimeRecoveryCandidate = async (input: {
  source: RuntimeRecoveryCandidateSource;
  sourceLabel: string;
  seed: string;
  expectedRuntimeId: string;
  encryptedBundles: EncryptedRuntimeRecoveryBundleV1[];
  xln: XLNModule;
  towerUrl?: string;
  peerId?: string;
  receipt?: TowerReceiptV1;
}): Promise<RuntimeRecoveryCandidate> => {
  if (input.encryptedBundles.length === 0) {
    throw new Error('RECOVERY_CANDIDATE_EMPTY');
  }
  const bundles: RuntimeRecoveryBundleV1[] = [];
  for (const encryptedBundle of input.encryptedBundles) {
    bundles.push(await input.xln.decryptRuntimeRecoveryBundle(encryptedBundle, input.seed));
  }
  if (bundles.length === 0) throw new Error('RECOVERY_CANDIDATE_EMPTY');
  for (const bundle of bundles) {
    const runtimeId = normalizeRuntimeId(bundle.runtimeId);
    if (!runtimeId || runtimeId !== input.expectedRuntimeId) {
      throw new Error(
        `RECOVERY_CANDIDATE_RUNTIME_ID_MISMATCH: expected=${input.expectedRuntimeId} actual=${String(bundle.runtimeId || 'none')}`,
      );
    }
  }

  const tipBundle = [...bundles].sort(sortRecoveryBundlesByTip)[0]!;
  const metadataBundle = bundles.find(bundle => (bundle.kind ?? 'snapshot') === 'snapshot') ?? tipBundle;
  const checkpointHash = getBundleReferenceHash(metadataBundle) || getBundleReferenceHash(tipBundle);
  const sourceKey = input.towerUrl || input.sourceLabel;
  const id = [
    input.source,
    sourceKey,
    tipBundle.runtimeHeight,
    tipBundle.createdAt,
    checkpointHash || input.encryptedBundles[0]?.bundleHash || 'no-hash',
  ].join(':');

  return {
    id,
    source: input.source,
    sourceLabel: input.sourceLabel,
    ...(input.towerUrl ? { towerUrl: input.towerUrl } : {}),
    ...(input.peerId ? { peerId: input.peerId } : {}),
    ...(input.receipt ? { receipt: input.receipt } : {}),
    encryptedBundles: input.encryptedBundles,
    bundles,
    tipBundle,
    metadataBundle,
    runtimeId: input.expectedRuntimeId,
    runtimeHeight: tipBundle.runtimeHeight,
    createdAt: Math.max(tipBundle.createdAt, metadataBundle.createdAt),
    signerCount: metadataBundle.signers.length,
    checkpointHash,
    bundleCount: bundles.length,
  };
};

export async function parseRuntimeRecoveryCandidateFile(
  seed: string,
  fileContents: string,
  options: { sourceLabel?: string; xln?: XLNModule } = {},
): Promise<RuntimeRecoveryCandidate> {
  const xln = options.xln || (await getXLN());
  if (typeof xln.decryptRuntimeRecoveryBundle !== 'function') {
    throw new Error('RECOVERY_DECRYPT_UNAVAILABLE');
  }
  const runtimeId = normalizeRuntimeId(deriveAddress(seed, 0));
  if (!runtimeId) throw new Error('RECOVERY_RUNTIME_ID_INVALID');
  let parsed: unknown;
  try {
    parsed = parseJsonUnknown(fileContents, 'RECOVERY_BACKUP_FILE_JSON_INVALID');
  } catch {
    throw new Error('RECOVERY_BACKUP_FILE_JSON_INVALID');
  }
  const encryptedBundles = extractEncryptedRecoveryBundles(parsed);
  if (encryptedBundles.length === 0) {
    throw new Error('RECOVERY_BACKUP_FILE_EMPTY');
  }
  return buildRuntimeRecoveryCandidate({
    source: 'file',
    sourceLabel: options.sourceLabel || 'Local backup file',
    seed,
    expectedRuntimeId: runtimeId,
    encryptedBundles,
    xln,
  });
}

export async function discoverRuntimeRecoveryCandidates(
  seed: string,
  options: {
    recovery?: RuntimeRecoveryConfig;
    towers?: RecoveryTowerConfig[];
    peers?: RuntimeRecoveryPeerSource[];
    xln?: XLNModule;
  } = {},
): Promise<RuntimeRecoveryDiscoveryResult> {
  const xln = options.xln || (await getXLN());
  if (
    typeof xln.decryptRuntimeRecoveryBundle !== 'function' ||
    typeof xln.deriveRuntimeRecoveryLookupKey !== 'function'
  ) {
    throw new Error('RECOVERY_DISCOVERY_UNAVAILABLE');
  }
  const runtimeId = normalizeRuntimeId(deriveAddress(seed, 0));
  if (!runtimeId) throw new Error('RECOVERY_RUNTIME_ID_INVALID');
  const lookupKey = xln.deriveRuntimeRecoveryLookupKey(runtimeId, seed);
  const runtimeProbe: Runtime = {
    id: runtimeId,
    label: 'Recovery probe',
    seed,
    signers: [],
    activeSignerIndex: 0,
    recovery:
      options.recovery ||
      (options.towers ? { useDefaultTowers: false, towers: options.towers } : buildDefaultRuntimeRecoveryConfig()),
    createdAt: Date.now(),
  };
  const towers = getConfiguredRecoveryTowers(runtimeProbe);
  const candidates: RuntimeRecoveryCandidate[] = [];
  const errors: string[] = [];
  const failures: RuntimeRecoveryDiscoveryFailure[] = [];
  const peers = options.peers || [];
  const recordFailure = (
    source: Exclude<RuntimeRecoveryCandidateSource, 'file'>,
    sourceLabel: string,
    message: string,
  ): void => {
    const failure = classifyRuntimeRecoveryDiscoveryFailure({ source, sourceLabel, message });
    failures.push(failure);
    if (failure.category !== 'ExpectedEmpty') {
      errors.push(recoveryFailureErrorText(failure));
    }
  };

  for (const tower of towers) {
    try {
      if (!(await towerHasRecoveryBundle(tower, lookupKey))) {
        recordFailure('tower', tower.url, 'TOWER_BUNDLE_NOT_FOUND');
        continue;
      }
      const restoreUrl = buildTowerRequestUrl(tower.url, '/api/tower/restore');
      const response = await fetch(restoreUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lookupKey }),
      });
      if (response.status === 404) {
        recordFailure('tower', tower.url, 'HTTP_404');
        continue;
      }
      if (!response.ok) {
        recordFailure('tower', tower.url, `HTTP_${response.status}`);
        continue;
      }
      const payload = (await response.json()) as TowerRestorePayload;
      const encryptedBundles = extractEncryptedRecoveryBundles(payload);
      if (!payload.ok || encryptedBundles.length === 0) {
        if (payload.error === 'TOWER_BUNDLE_NOT_FOUND') {
          recordFailure('tower', tower.url, 'TOWER_BUNDLE_NOT_FOUND');
          continue;
        }
        recordFailure('tower', tower.url, String(payload.error || 'unknown'));
        continue;
      }
      candidates.push(
        await buildRuntimeRecoveryCandidate({
          source: 'tower',
          sourceLabel: tower.url,
          towerUrl: tower.url,
          ...(payload.receipt ? { receipt: payload.receipt } : {}),
          seed,
          expectedRuntimeId: runtimeId,
          encryptedBundles,
          xln,
        }),
      );
    } catch (error) {
      recordFailure('tower', tower.url, error instanceof Error ? error.message : String(error));
    }
  }

  for (const peer of peers) {
    const sourceLabel = String(peer.label || peer.id || 'Peer').trim() || 'Peer';
    try {
      const payload = await peer.fetchBundles({ runtimeId, lookupKey });
      const encryptedBundles = extractEncryptedRecoveryBundles(payload);
      if (encryptedBundles.length === 0) {
        recordFailure('peer', sourceLabel, 'PEER_RECOVERY_BUNDLE_EMPTY');
        continue;
      }
      candidates.push(
        await buildRuntimeRecoveryCandidate({
          source: 'peer',
          sourceLabel,
          ...(peer.id ? { peerId: peer.id } : {}),
          seed,
          expectedRuntimeId: runtimeId,
          encryptedBundles,
          xln,
        }),
      );
    } catch (error) {
      recordFailure('peer', sourceLabel, error instanceof Error ? error.message : String(error));
    }
  }

  candidates.sort(sortRecoveryCandidatesByTip);
  return {
    runtimeId,
    lookupKey,
    candidates,
    errors,
    failures,
    checkedTowers: towers.length,
    checkedPeers: peers.length,
  };
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
