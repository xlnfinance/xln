import { writable, get, derived } from 'svelte/store';
import { HDNodeWallet, Mnemonic, Wallet, getAddress, getIndexedAccountPath, keccak256, toUtf8Bytes } from 'ethers';
import type {
  ConsensusConfig,
  EncryptedRuntimeRecoveryBundleV1,
  Env,
  JurisdictionConfig,
  PersistedFrameJournal,
  RoutedEntityInput,
  RuntimeInput,
  TowerActivePayloadV1,
  TowerCounterDisputeRemedyV1,
  RuntimeRecoveryBundleV1,
  RuntimeRecoveryMetaV1,
  RuntimeRecoverySignerV1,
  TowerModeV1,
  TowerAppointmentV1,
  TowerReceiptV1,
  XLNModule,
} from '@xln/runtime/xln-api';
import { runtimeOperations, runtimes, activeRuntimeId } from './runtimeStore';
import {
  xlnEnvironment,
  setXlnEnvironment,
  resolveRelayUrls,
  getXLN,
  enqueueAndProcess,
  enqueueEntityInputs as enqueueXlnEntityInputs,
} from './xlnStore';
import { settings } from './settingsStore';
import { toasts } from './toastStore';
import { writeSavedCollateralPolicy, writeHubJoinPreference } from '$lib/utils/onboardingPreferences';
import { writeOnboardingComplete } from '$lib/utils/onboardingState';
import { tabOperations } from './tabStore';
import { isInactiveTabStandby } from '$lib/utils/activeTabLock';
import { unwrapLiveRuntimeEnv } from '$lib/utils/liveRuntimeEnv';
import { generateLazyEntityIdPreview } from '$lib/utils/lazyEntityId';

// Types
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

export interface RuntimeRecoveryConfig {
  towers?: RecoveryTowerConfig[];
  minSuccessfulTowers?: number;
  maxStoredBytes?: number;
  lastKnownStoredBytes?: number;
  lastQuotaWarningAt?: number;
}

export interface Runtime {
  id: string; // signer EOA (0xABCD...)
  label: string; // user-chosen name ("MyWallet")
  seed: string; // canonical 24-word mnemonic
  mnemonic12?: string; // optional 12-word compatibility mnemonic
  devicePassphrase?: string; // optional BrainVault device passphrase (if available)
  signers: Signer[];
  activeSignerIndex: number;
  loginType?: 'manual' | 'demo';
  requiresOnboarding?: boolean;
  recovery?: RuntimeRecoveryConfig;
  createdAt: number;
  env?: Env | null;
}

type CreateRuntimeOptions = {
  loginType?: 'manual' | 'demo' | undefined;
  requiresOnboarding?: boolean | undefined;
  devicePassphrase?: string | undefined;
  mnemonic12?: string | undefined;
};

type ImportedJMachineConfig = {
  name: string;
  mode: 'browservm' | 'rpc';
  chainId: number;
  ticker: string;
  rpcs: string[];
  blockTimeMs: number;
  contracts?: {
    depository?: string;
    entityProvider?: string;
    account?: string;
    deltaTransformer?: string;
  };
};
type ApiJurisdictionConfig = JurisdictionConfig & {
  rpc?: string;
  rpcs?: string[];
  contracts: {
    depository: string;
    entityProvider: string;
    account: string;
    deltaTransformer: string;
  };
};

const requireContractAddress = (value: string | null | undefined, label: string): string => {
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

export interface RuntimesState {
  runtimes: Record<string, Runtime>;
  activeRuntimeId: string | null;
}

// Default state
const defaultState: RuntimesState = {
  runtimes: {},
  activeRuntimeId: null
};

// Storage key
const VAULT_STORAGE_KEY = 'xln-vaults';
const BROWSER_GOSSIP_POLL_MS = 250;
const normalizeRuntimeId = (value: string | null | undefined): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return getAddress(raw).toLowerCase();
  } catch {
    return '';
  }
};

const normalizeEntityId = (value: string | null | undefined): string => String(value || '').trim().toLowerCase();

// Main store
export const runtimesState = writable<RuntimesState>(defaultState);
export const vaultStorageLoaded = writable(false);

// Derived stores
export const activeRuntime = derived(runtimesState, ($state) => {
  if (!$state.activeRuntimeId) return null;
  return $state.runtimes[$state.activeRuntimeId] || null;
});

export const activeSigner = derived(activeRuntime, ($runtime) => {
  if (!$runtime) return null;
  return $runtime.signers[$runtime.activeSignerIndex] || null;
});

export const allRuntimes = derived(runtimesState, ($state) => {
  return Object.values($state.runtimes).sort((a, b) => b.createdAt - a.createdAt);
});

let initializePromise: Promise<void> | null = null;
let initialized = false;
let resumeListenerRegistered = false;
let resumeRefreshPromise: Promise<boolean> | null = null;
let runtimeSyncChannel: BroadcastChannel | null = null;
let runtimeResumeTrigger: (() => void) | null = null;
const runtimeEnvChangeUnsubscribers = new Map<string, () => void>();
const runtimeRecoveryBarrierUnsubscribers = new Map<string, () => void>();
const runtimeRecoveryUploadTimers = new Map<string, ReturnType<typeof setTimeout>>();
const runtimeRecoveryUploadMeta = new Map<string, { lastUploadedHeight: number; lastBundleHash: string | null }>();
const recoveryTowerInfoCache = new Map<string, { fetchedAt: number; info: TowerServerInfo }>();

const RECOVERY_UPLOAD_DEBOUNCE_MS = 1_500;
const RECOVERY_TOWER_INFO_TTL_MS = 60_000;
const WATCHTOWER_LAST_RESORT_WINDOW_BLOCKS = 60;
const WATCHTOWER_SAFETY_MARGIN_BLOCKS = 12;

type FrameLogEntry = Env['frameLogs'][number];
type HealthMachine = { name?: string; status?: string; chainId?: number; lastBlock?: unknown };
type HealthPayload = {
  timestamp?: number;
  reset?: { inProgress?: boolean; lastError?: unknown };
  system?: { runtime?: boolean } | null;
  jMachines?: HealthMachine[];
};
type JurisdictionsPayload = { version?: string; jurisdictions: Record<string, ApiJurisdictionConfig> };
type FaucetResult = { success?: boolean; txHash?: string; error?: string };
type RuntimeP2PHandle = {
  isConnected?: () => boolean;
  connect?: () => void;
  refreshGossip?: () => void;
  getReconnectState?: () => { attempt: number; nextAt: number } | null;
};

type TowerRestorePayload = {
  ok: boolean;
  receipt?: TowerReceiptV1;
  bundle?: EncryptedRuntimeRecoveryBundleV1;
  error?: string;
};

type TowerServerInfo = {
  ok: boolean;
  service?: string;
  towerId?: string;
  signerAddress?: string;
  maxStoredBytesPerLookupKey?: number;
  maxBundlesPerLookupKey?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const hasStartRuntimeLoop = (xln: XLNModule): xln is XLNModule & { startRuntimeLoop: (env: Env) => unknown } =>
  typeof Reflect.get(xln as object, 'startRuntimeLoop') === 'function';

const getRuntimeP2PHandle = (xln: XLNModule, env: Env): RuntimeP2PHandle | null => {
  const candidate = xln.getP2P(unwrapLiveRuntimeEnv(env) ?? env);
  return isRecord(candidate) ? (candidate as RuntimeP2PHandle) : null;
};

const getReplayMeta = (env: Env): unknown | null => {
  const value = Reflect.get(env as object, '__replayMeta');
  return value === undefined ? null : value;
};

// HD derivation helper
function deriveAddress(seed: string, index: number): string {
  const mnemonic = Mnemonic.fromPhrase(seed);
  const hdNode = HDNodeWallet.fromMnemonic(mnemonic, getIndexedAccountPath(index));
  return hdNode.address.toLowerCase();
}

function derivePrivateKey(seed: string, index: number): string {
  const mnemonic = Mnemonic.fromPhrase(seed);
  const hdNode = HDNodeWallet.fromMnemonic(mnemonic, getIndexedAccountPath(index));
  return hdNode.privateKey;
}

const normalizeJurisdictionKey = (value: string | null | undefined): string =>
  String(value || '').trim().toLowerCase();

type RuntimeJReplica = Env['jReplicas'] extends Map<string, infer T> ? T : never;
type RuntimeEntityReplica = Env['eReplicas'] extends Map<string, infer T> ? T : never;

const getJReplicaJurisdictionName = (replica: RuntimeJReplica | null | undefined, fallback = ''): string =>
  String(replica?.name || fallback || '').trim();

const findJReplicaByName = (env: Env, name: string): RuntimeJReplica | undefined => {
  const normalized = normalizeJurisdictionKey(name);
  if (!normalized) return undefined;
  const direct = env.jReplicas?.get(name);
  if (direct) return direct;
  for (const replica of env.jReplicas?.values?.() || []) {
    if (normalizeJurisdictionKey(replica?.name) === normalized) return replica;
  }
  return undefined;
};

const getEntityReplicaJurisdictionName = (replica: RuntimeEntityReplica | null | undefined): string =>
  String(replica?.state?.config?.jurisdiction?.name || '').trim();

const getEntityReplicaEntityId = (key: string, replica: RuntimeEntityReplica | null | undefined): string =>
  String(replica?.entityId || replica?.state?.entityId || String(key || '').split(':')[0] || '').trim().toLowerCase();

const findEntityReplicaByEntityId = (env: Env, entityId: string): RuntimeEntityReplica | undefined => {
  const target = normalizeEntityId(entityId);
  if (!target) return undefined;
  for (const [key, replica] of env.eReplicas?.entries?.() || []) {
    if (getEntityReplicaEntityId(String(key), replica) === target) return replica;
  }
  return undefined;
};

const findEntityReplicaByEntityAndSigner = (
  env: Env,
  entityId: string,
  signerId: string,
): RuntimeEntityReplica | undefined => {
  const targetEntity = normalizeEntityId(entityId);
  const targetSigner = normalizeRuntimeId(signerId);
  if (!targetEntity || !targetSigner) return undefined;
  for (const [key, replica] of env.eReplicas?.entries?.() || []) {
    const [keyEntityId, keySignerId] = String(key || '').split(':');
    const replicaEntity = getEntityReplicaEntityId(String(key), replica);
    const replicaSigner = normalizeRuntimeId(replica?.signerId || keySignerId || '');
    if ((replicaEntity || normalizeEntityId(keyEntityId)) === targetEntity && replicaSigner === targetSigner) {
      return replica;
    }
  }
  return undefined;
};

const getJReplicaContractAddress = (
  replica: RuntimeJReplica,
  label: 'depository' | 'entity_provider',
): string => {
  const contractKey = label === 'entity_provider' ? 'entityProvider' : 'depository';
  return requireContractAddress(
    replica[`${contractKey}Address` as keyof RuntimeJReplica] as string | undefined
      || replica.contracts?.[contractKey]
      || replica.jadapter?.addresses?.[contractKey],
    label,
  );
};

const buildSignerEntityConfig = (
  signerAddress: string,
  jReplica: RuntimeJReplica,
  preferredJurisdictionName: string,
  fallbackChainId: number,
): ConsensusConfig => {
  const jurisdictionName = getJReplicaJurisdictionName(jReplica, preferredJurisdictionName);
  if (!jurisdictionName) throw new Error('ENTITY_JURISDICTION_MISSING');
  const depositoryAddress = getJReplicaContractAddress(jReplica, 'depository');
  const entityProviderAddress = getJReplicaContractAddress(jReplica, 'entity_provider');
  const rpcAddress = String(jReplica.rpcs?.[0] || '').trim();
  const chainId = Number(jReplica.chainId ?? jReplica.jadapter?.chainId ?? fallbackChainId);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new Error(`ENTITY_JURISDICTION_CHAIN_ID_MISSING: ${jurisdictionName}`);
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
      entityProviderAddress,
      depositoryAddress,
    },
  };
};

function deriveJurisdictionSignerIndex(jurisdiction: string): number {
  const key = normalizeJurisdictionKey(jurisdiction);
  if (!key) throw new Error('Jurisdiction is required for jurisdiction signer derivation');
  const digest = keccak256(toUtf8Bytes(`xln:jurisdiction-signer:v1:${key}`));
  const bucket = Number(BigInt(digest) % 1_000_000n);
  return 100_000 + bucket;
}

function getSignerDerivationIndex(signer: Signer | null | undefined): number {
  return Number.isInteger(signer?.derivationIndex) ? Number(signer!.derivationIndex) : Number(signer?.index ?? 0);
}

const parseRecoveryTowerUrls = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && typeof (entry as { url?: unknown }).url === 'string') {
          return String((entry as { url: string }).url);
        }
        return '';
      })
      .map((url) => String(url || '').trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      return parseRecoveryTowerUrls(JSON.parse(trimmed));
    } catch {
      return trimmed.split(',').map((entry) => entry.trim()).filter(Boolean);
    }
  }
  return [];
};

const defaultRecoveryTowerUrls = (): string[] => {
  if (typeof window === 'undefined') return ['https://tower.xln.finance'];
  const w = window as Window & { __XLN_WATCHTOWERS__?: unknown };
  const globalUrls = parseRecoveryTowerUrls(w.__XLN_WATCHTOWERS__);
  if (globalUrls.length > 0) return globalUrls;
  try {
    const local = localStorage.getItem('xln-watchtower-urls');
    const localUrls = parseRecoveryTowerUrls(local);
    if (localUrls.length > 0) return localUrls;
  } catch {
    // Recovery should not fail because local tower preferences are unreadable.
  }
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return ['http://127.0.0.1:9100'];
  }
  return ['https://tower.xln.finance'];
};

const normalizeTowerBaseUrl = (url: string): string => String(url || '').trim().replace(/\/+$/, '');

const getConfiguredRecoveryTowers = (runtime: Runtime | null | undefined): RecoveryTowerConfig[] => {
  const explicit = (runtime?.recovery?.towers || [])
    .map((tower) => ({
      ...tower,
      url: normalizeTowerBaseUrl(tower.url),
      towerMode: (tower.towerMode === 'active_watchtower' || tower.towerMode === 'delayed_last_resort'
        ? tower.towerMode
        : 'blind_backup') as TowerModeV1,
      enabled: tower.enabled !== false,
    }))
    .filter((tower) => !!tower.url && tower.enabled !== false);
  const fallback = defaultRecoveryTowerUrls().map((url, index) => ({
    id: `default-${index + 1}`,
    url: normalizeTowerBaseUrl(url),
    towerMode: 'blind_backup' as const,
    enabled: true,
  }));
  const deduped = new Map<string, RecoveryTowerConfig>();
  for (const tower of [...explicit, ...fallback]) {
    if (!tower.url) continue;
    deduped.set(tower.url, tower);
  }
  return [...deduped.values()];
};

async function fetchTowerServerInfo(towerUrl: string): Promise<TowerServerInfo> {
  const normalizedUrl = normalizeTowerBaseUrl(towerUrl);
  const cached = recoveryTowerInfoCache.get(normalizedUrl);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < RECOVERY_TOWER_INFO_TTL_MS) {
    return cached.info;
  }
  const response = await fetch(new URL('/', `${normalizedUrl}/`), {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`TOWER_INFO_HTTP_${response.status}`);
  }
  const payload = await response.json() as TowerServerInfo;
  if (!payload.ok) {
    throw new Error(`TOWER_INFO_INVALID:${normalizedUrl}`);
  }
  recoveryTowerInfoCache.set(normalizedUrl, { fetchedAt: now, info: payload });
  return payload;
}

const buildRuntimeRecoverySigners = (runtime: Runtime): RuntimeRecoverySignerV1[] =>
  (runtime.signers || [])
    .map((signer, index) => ({
      index,
      derivationIndex: getSignerDerivationIndex(signer),
      address: normalizeRuntimeId(signer.address),
      name: String(signer.name || `Signer ${index + 1}`),
      ...(signer.entityId ? { entityId: normalizeEntityId(signer.entityId) } : {}),
      ...(signer.jurisdiction ? { jurisdiction: String(signer.jurisdiction).trim() } : {}),
    }))
    .filter((signer) => !!signer.address);

const buildRuntimeRecoveryMeta = (runtime: Runtime): RuntimeRecoveryMetaV1 => ({
  label: runtime.label,
  activeSignerIndex: Math.max(0, Math.floor(Number(runtime.activeSignerIndex || 0))),
  loginType: runtime.loginType === 'demo' ? 'demo' : 'manual',
  ...(typeof runtime.requiresOnboarding === 'boolean'
    ? { requiresOnboarding: runtime.requiresOnboarding }
    : {}),
  createdAt: runtime.createdAt,
});

const applyRecoveryBundleMetadata = (runtime: Runtime, bundle: RuntimeRecoveryBundleV1): boolean => {
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
    .filter((signer) => !!signer.address);

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
  if (typeof bundle.meta?.requiresOnboarding === 'boolean' && runtime.requiresOnboarding !== bundle.meta.requiresOnboarding) {
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

const persistRuntimeMetadataSnapshot = (): void => {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(get(runtimesState)));
  } catch {
    // Recovery upload should never break the interactive runtime.
  }
};

async function tryRestoreRuntimeEnvFromTower(
  runtime: Runtime,
  xln: XLNModule,
): Promise<{ env: Env; bundle: RuntimeRecoveryBundleV1 } | null> {
  if (
    typeof xln.restoreEnvFromCheckpointSnapshot !== 'function' ||
    typeof xln.decryptRuntimeRecoveryBundle !== 'function' ||
    typeof xln.deriveRuntimeRecoveryLookupKey !== 'function' ||
    typeof xln.saveEnvToDB !== 'function'
  ) {
    return null;
  }

  const runtimeId = normalizeRuntimeId(runtime.id);
  if (!runtimeId || !runtime.seed) return null;

  const lookupKey = xln.deriveRuntimeRecoveryLookupKey(runtimeId, runtime.seed);
  const towers = getConfiguredRecoveryTowers(runtime);
  const candidates: Array<{
    bundle: RuntimeRecoveryBundleV1;
    receipt?: TowerReceiptV1;
    towerUrl: string;
  }> = [];
  const errors: string[] = [];

  for (const tower of towers) {
    try {
      const response = await fetch(new URL('/api/tower/restore', `${tower.url}/`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lookupKey }),
      });
      if (response.status === 404) continue;
      if (!response.ok) {
        errors.push(`${tower.url}:HTTP_${response.status}`);
        continue;
      }
      const payload = await response.json() as TowerRestorePayload;
      if (!payload.ok || !payload.bundle) {
        if (payload.error === 'TOWER_BUNDLE_NOT_FOUND') continue;
        errors.push(`${tower.url}:${String(payload.error || 'unknown')}`);
        continue;
      }
      const bundle = await xln.decryptRuntimeRecoveryBundle(payload.bundle, runtime.seed);
      candidates.push({
        bundle,
        ...(payload.receipt ? { receipt: payload.receipt } : {}),
        towerUrl: tower.url,
      });
    } catch (error) {
      errors.push(`${tower.url}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (candidates.length === 0) {
    if (errors.length > 0) {
      throw new Error(`[VaultStore] Tower restore failed for ${runtimeId.slice(0, 12)}: ${errors.join(' | ')}`);
    }
    return null;
  }

  candidates.sort((left, right) => {
    if (right.bundle.runtimeHeight !== left.bundle.runtimeHeight) {
      return right.bundle.runtimeHeight - left.bundle.runtimeHeight;
    }
    if (right.bundle.createdAt !== left.bundle.createdAt) {
      return right.bundle.createdAt - left.bundle.createdAt;
    }
    return (right.receipt?.sequence || 0) - (left.receipt?.sequence || 0);
  });

  const best = candidates[0]!;
  const bundle = best.bundle;
  if (candidates.length > 1) {
    const conflictingSameHeight = candidates.some((candidate) =>
      candidate !== best
      && candidate.bundle.runtimeHeight === best.bundle.runtimeHeight
      && candidate.bundle.checkpointHash !== best.bundle.checkpointHash,
    );
    if (conflictingSameHeight) {
      console.warn(`[VaultStore] Tower restore conflict detected for ${runtimeId.slice(0, 12)}; choosing highest valid bundle from ${best.towerUrl}`);
    }
  }
  applyRecoveryBundleMetadata(runtime, bundle);
  const restoredEnv = await xln.restoreEnvFromCheckpointSnapshot(bundle.checkpoint, {
    runtimeSeed: runtime.seed,
    runtimeId,
  });
  applyRuntimeLogPreference(restoredEnv);
  await xln.saveEnvToDB(restoredEnv);
  return { env: restoredEnv, bundle };
}

async function uploadRuntimeRecoverySnapshot(
  runtimeId: string,
  env: Env,
  xln: XLNModule,
): Promise<void> {
  if (
    typeof xln.buildRuntimeRecoveryBundle !== 'function' ||
    typeof xln.encryptRuntimeRecoveryBundle !== 'function' ||
    typeof xln.buildTowerAppointmentOwnerMessage !== 'function'
  ) {
    return;
  }

  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  const runtime = get(runtimesState).runtimes[normalizedRuntimeId];
  if (!runtime?.seed) return;
  if (Number(env.height || 0) <= 0) return;
  if (!(env.eReplicas instanceof Map) || env.eReplicas.size === 0) return;
  const towers = getConfiguredRecoveryTowers(runtime);
  if (towers.length === 0) return;

  const previous = runtimeRecoveryUploadMeta.get(normalizedRuntimeId);
  if (previous && Number(env.height || 0) < previous.lastUploadedHeight) return;

  // Blind tower mode stores opaque ciphertext only. The browser still validates the
  // restored checkpoint locally after decrypting it with the same BrainVault seed.
  const bundle = xln.buildRuntimeRecoveryBundle(env, {
    signers: buildRuntimeRecoverySigners(runtime),
    meta: buildRuntimeRecoveryMeta(runtime),
  });
  const encrypted = await xln.encryptRuntimeRecoveryBundle(bundle, runtime.seed);
  if (previous && previous.lastBundleHash === encrypted.bundleHash && previous.lastUploadedHeight === encrypted.height) {
    return;
  }

  const signedAt = Date.now();
  const message = xln.buildTowerAppointmentOwnerMessage(
    normalizedRuntimeId,
    'blind_backup',
    encrypted.lookupKey,
    0,
    encrypted.bundleHash,
    encrypted.height,
    signedAt,
    undefined,
  );
  const signature = await new Wallet(derivePrivateKey(runtime.seed, 0)).signMessage(message);
  const appointment: TowerAppointmentV1 = {
    type: 'tower_appointment',
    version: 1,
    towerMode: 'blind_backup',
    lookupKey: encrypted.lookupKey,
    slot: 0,
    bundle: encrypted,
    ownerProof: {
      runtimeId: normalizedRuntimeId,
      signedAt,
      signature,
    },
  };

  const minSuccessfulTowers = Math.max(1, Math.floor(Number(runtime.recovery?.minSuccessfulTowers ?? 1)));
  let successfulTowers = 0;
  const errors: string[] = [];
  let maxObservedStoredBytes = runtime.recovery?.lastKnownStoredBytes ?? 0;
  const delayedTowers = towers.filter((tower) => tower.towerMode === 'delayed_last_resort');
  const activeTowerErrors: string[] = [];

  for (const tower of towers) {
    try {
      const response = await fetch(new URL('/api/tower/appointment', `${tower.url}/`), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(appointment),
      });
      const payload = await response.json() as { ok: boolean; error?: string; receipt?: TowerReceiptV1 };
      if (!response.ok || !payload.ok) {
        const errorText = String(payload.error || `HTTP_${response.status}`);
        errors.push(`${tower.url}:${errorText}`);
        if (errorText.startsWith('TOWER_QUOTA_EXCEEDED')) {
          const nextRecovery = runtime.recovery || {};
          runtime.recovery = {
            ...nextRecovery,
            lastQuotaWarningAt: Date.now(),
          };
          toasts.warning('Recovery backup quota exceeded. Runtime state is larger than the free tower allowance.', 8_000);
        }
        continue;
      }
      successfulTowers += 1;
      maxObservedStoredBytes = Math.max(maxObservedStoredBytes, Number(payload.receipt?.storedBytes || 0));
    } catch (error) {
      errors.push(`${tower.url}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const tower of delayedTowers) {
    try {
      const info = await fetchTowerServerInfo(tower.url);
      const towerSignerAddress = normalizeRuntimeId(info.signerAddress || '');
      if (!towerSignerAddress) {
        throw new Error('TOWER_SIGNER_ADDRESS_MISSING');
      }
      const activeAppointments = await buildDelayedLastResortAppointmentsForTower(
        runtime,
        env,
        xln,
        tower,
        towerSignerAddress,
        encrypted,
      );
      for (const upload of activeAppointments) {
        const response = await fetch(new URL('/api/tower/appointment', `${tower.url}/`), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(upload.appointment),
        });
        const payload = await response.json() as { ok: boolean; error?: string; receipt?: TowerReceiptV1 };
        if (!response.ok || !payload.ok) {
          const errorText = String(payload.error || `HTTP_${response.status}`);
          if (errorText.startsWith('TOWER_QUOTA_EXCEEDED')) {
            runtime.recovery = {
              ...(runtime.recovery || {}),
              lastQuotaWarningAt: Date.now(),
            };
            toasts.warning('Watchtower dispute backup quota exceeded. Last-resort coverage is incomplete until the runtime state shrinks or quota is raised.', 8_000);
          }
          throw new Error(`${upload.triggerHint}:${errorText}`);
        }
        maxObservedStoredBytes = Math.max(maxObservedStoredBytes, Number(payload.receipt?.storedBytes || 0));
      }
    } catch (error) {
      activeTowerErrors.push(`${tower.url}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  runtime.recovery = {
    ...(runtime.recovery || {}),
    towers,
    lastKnownStoredBytes: maxObservedStoredBytes,
  };
  if (successfulTowers < minSuccessfulTowers) {
    throw new Error(`[VaultStore] Tower appointment failed for ${normalizedRuntimeId.slice(0, 12)}: ${errors.join(' | ') || 'no tower accepted backup'}`);
  }
  if (activeTowerErrors.length > 0) {
    throw new Error(`[VaultStore] Tower last-resort appointment failed for ${normalizedRuntimeId.slice(0, 12)}: ${activeTowerErrors.join(' | ')}`);
  }
  runtimeRecoveryUploadMeta.set(normalizedRuntimeId, {
    lastUploadedHeight: encrypted.height,
    lastBundleHash: encrypted.bundleHash,
  });
  persistRuntimeMetadataSnapshot();
}

function scheduleRuntimeRecoveryUpload(
  runtimeId: string,
  env: Env,
  xln: XLNModule,
): void {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  if (!normalizedRuntimeId) return;
  const existingTimer = runtimeRecoveryUploadTimers.get(normalizedRuntimeId);
  if (existingTimer) clearTimeout(existingTimer);
  runtimeRecoveryUploadTimers.set(
    normalizedRuntimeId,
    setTimeout(() => {
      runtimeRecoveryUploadTimers.delete(normalizedRuntimeId);
      void uploadRuntimeRecoverySnapshot(normalizedRuntimeId, unwrapLiveRuntimeEnv(env) ?? env, xln).catch((error) => {
        console.warn(`[VaultStore] Tower recovery upload failed for ${normalizedRuntimeId.slice(0, 12)}:`, error);
      });
    }, RECOVERY_UPLOAD_DEBOUNCE_MS),
  );
}

const findRuntimeByIdCaseInsensitive = (
  runtimeMap: Record<string, Runtime>,
  requestedId: string | null | undefined,
): { key: string; runtime: Runtime } | null => {
  if (!requestedId) return null;
  const direct = runtimeMap[requestedId];
  if (direct) return { key: requestedId, runtime: direct };
  const requestedLower = requestedId.toLowerCase();
  for (const [key, runtime] of Object.entries(runtimeMap)) {
    if (key.toLowerCase() === requestedLower || runtime.id.toLowerCase() === requestedLower) {
      return { key, runtime };
    }
  }
  return null;
};

async function waitForCondition(
  check: () => boolean,
  label: string,
  timeoutMs = 30_000,
  intervalMs = 50,
  describeTimeout?: () => string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const details = describeTimeout?.();
  throw new Error(`[VaultStore] Timeout waiting for condition: ${label}${details ? `\n${details}` : ''}`);
}

const getLiveRuntimeEnvForId = (runtimeId: string, fallback?: Env | null): Env | null => {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  const latest = normalizedRuntimeId ? get(runtimes).get(normalizedRuntimeId)?.env : null;
  return unwrapLiveRuntimeEnv(latest) ?? unwrapLiveRuntimeEnv(fallback) ?? fallback ?? null;
};

const getRuntimeFatalDiagnostics = (env: Env, replicaName?: string): string => {
  const frameLogs = env.frameLogs;
  const cleanLogs = Array.isArray(env.runtimeState?.cleanLogs) ? env.runtimeState.cleanLogs : [];
  const recentErrors = frameLogs
    .filter((entry: FrameLogEntry) => entry.level === 'error' || entry.message === 'RUNTIME_LOOP_ERROR' || entry.message === 'RUNTIME_LOOP_HALTED')
    .slice(-3)
    .map((entry: FrameLogEntry) => ({
      level: entry.level ?? null,
      category: entry.category ?? null,
      message: entry.message ?? null,
      data: entry.data ?? null,
      entityId: entry.entityId ?? null,
      timestamp: entry.timestamp ?? null,
    }));
  const recentLogs = cleanLogs.slice(-8);
  const replica = replicaName ? env.jReplicas.get(replicaName) : env.jReplicas.values().next().value;
  const jState = replica
    ? {
        name: replica.name ?? null,
        chainId: replica.chainId ?? null,
        depositoryAddress: replica.depositoryAddress ?? null,
        entityProviderAddress: replica.entityProviderAddress ?? null,
        contracts: replica.contracts ?? null,
        rpcs: replica.rpcs ?? null,
        hasAdapter: hasConnectedJurisdictionAdapter(replica),
        hasAddresses: hasRuntimeJurisdictionAddresses(replica),
      }
    : null;
  return JSON.stringify(
    {
      runtimeId: env.runtimeId ?? null,
      height: env.height ?? null,
      latestHeight: env.height ?? null,
      loopActive: env.runtimeState?.loopActive ?? null,
      jState,
      recentErrors,
      recentLogs,
    },
    null,
    2,
  );
};

async function enqueueAndAwait(
  xln: XLNModule,
  env: Env,
  runtimeInput: RuntimeInput,
  ready: () => boolean,
  label: string,
  timeoutMs = 30_000,
  describeTimeout?: () => string,
): Promise<void> {
  const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
  xln.enqueueRuntimeInput(runtimeEnv, runtimeInput);
  await waitForCondition(ready, label, timeoutMs, 50, describeTimeout);
}

async function ensureRuntimePipelineAlive(runtime: Runtime | null, xln: XLNModule): Promise<void> {
  if (!runtime?.env) return;
  const resolvedRuntimeId = normalizeRuntimeId(runtime.id);
  if (!resolvedRuntimeId) return;
  const env = unwrapLiveRuntimeEnv(runtime.env) ?? runtime.env;
  registerRuntimeEnvChange(resolvedRuntimeId, env, xln);
  const envRuntimeId = normalizeRuntimeId(env.runtimeId || '');
  if (envRuntimeId !== resolvedRuntimeId) {
    throw new Error(
      `[VaultStore.ensureRuntimePipelineAlive] Runtime isolation mismatch: selected=${resolvedRuntimeId} env.runtimeId=${String(env.runtimeId || 'none')}`,
    );
  }
  if (!env.runtimeState?.loopActive && xln.startRuntimeLoop) {
    xln.startRuntimeLoop(env);
  }

  let p2p = getRuntimeP2PHandle(xln, env);
  if (!p2p) {
    xln.startP2P(env, {
      signerId: resolvedRuntimeId,
      relayUrls: resolveRelayUrls(),
      gossipPollMs: BROWSER_GOSSIP_POLL_MS,
    });
    p2p = getRuntimeP2PHandle(xln, env);
  } else if (typeof p2p.isConnected === 'function' && !p2p.isConnected()) {
    const waitDeadline = Date.now() + 2_000;
    while (Date.now() < waitDeadline) {
      if (p2p.isConnected()) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (p2p.isConnected()) {
      // no-op
    } else {
    const reconnectState = typeof p2p.getReconnectState === 'function' ? p2p.getReconnectState() : null;
    if (!reconnectState && typeof p2p.connect === 'function') {
      p2p.connect();
    }
    }
  }

  if (p2p && typeof p2p.refreshGossip === 'function') {
    p2p.refreshGossip();
  }
}

const hasRuntimeJurisdictionAddresses = (replica: unknown): boolean => {
  const candidate = replica as {
    depositoryAddress?: unknown;
    entityProviderAddress?: unknown;
    contracts?: { depository?: unknown; entityProvider?: unknown };
  } | null;
  const depository =
    typeof candidate?.depositoryAddress === 'string' && candidate.depositoryAddress.length > 0
      ? candidate.depositoryAddress
      : (typeof candidate?.contracts?.depository === 'string' ? candidate.contracts.depository : '');
  const entityProvider =
    typeof candidate?.entityProviderAddress === 'string' && candidate.entityProviderAddress.length > 0
      ? candidate.entityProviderAddress
      : (typeof candidate?.contracts?.entityProvider === 'string' ? candidate.contracts.entityProvider : '');
  return Boolean(depository && entityProvider);
};

const hasConnectedJurisdictionAdapter = (replica: unknown): boolean => {
  const candidate = replica as {
    jadapter?: {
      addresses?: { depository?: string; entityProvider?: string };
      depository?: unknown;
      entityProvider?: unknown;
    };
  } | null;
  return Boolean(
    candidate?.jadapter?.addresses?.depository &&
      candidate?.jadapter?.addresses?.entityProvider &&
      candidate?.jadapter?.depository &&
      candidate?.jadapter?.entityProvider,
  );
};

const resolveJurisdictionConfig = (jurisdictions: JurisdictionsPayload): ApiJurisdictionConfig => {
  const map = jurisdictions.jurisdictions;
  const arrakis = map['arrakis'];
  const first = arrakis ?? Object.values(map)[0];
  if (!first) {
    throw new Error('No jurisdictions found in /api/jurisdictions');
  }
  return first;
};

const stripLocalJurisdictionSuffix = (name: string): string =>
  String(name || '').replace(/\s*\((?:shared|local)\s+anvil\)\s*$/i, '').trim();

const resolveDefaultJurisdictionImportName = (
  key: string,
  config: ApiJurisdictionConfig,
  index: number,
): string => {
  const rawName = stripLocalJurisdictionSuffix(config.name || key);
  const normalizedKey = normalizeJurisdictionKey(key);
  const normalizedName = normalizeJurisdictionKey(rawName);
  const chainId = Number(config.chainId || 0);
  if (
    index === 0 &&
    (normalizedKey === 'arrakis' || normalizedName === 'arrakis' || normalizedName === 'localhost' || chainId === 31337)
  ) {
    return 'Testnet';
  }
  if (normalizedKey === 'tron' || normalizedKey === 'rpc2' || normalizedName === 'tron') {
    return 'Tron';
  }
  return rawName || (index === 0 ? 'primary' : `Jurisdiction ${index + 1}`);
};

const listDefaultJurisdictionImports = (jurisdictions: JurisdictionsPayload): Array<{ key: string; name: string; config: ApiJurisdictionConfig }> => {
  const entries = Object.entries(jurisdictions.jurisdictions || {})
    .filter(([, config]) => {
      const status = String((config as { status?: unknown })?.status || 'active').trim().toLowerCase();
      return status === 'active' &&
        Boolean(config?.contracts?.depository && config?.contracts?.entityProvider && resolveJurisdictionRpc(config));
    });
  if (entries.length === 0) return [];
  const primary = resolveJurisdictionConfig(jurisdictions);
  const primaryKey = entries.find(([, config]) => config === primary)?.[0] || 'primary';
  const ordered = [
    [primaryKey, primary] as const,
    ...entries.filter(([key, config]) => key !== primaryKey && config !== primary),
  ];
  const seen = new Set<string>();
  return ordered.flatMap(([key, config], index) => {
    const name = resolveDefaultJurisdictionImportName(key, config, index);
    const normalized = normalizeJurisdictionKey(name);
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [{ key, name, config }];
  });
};

const resolveJurisdictionRpc = (config: ApiJurisdictionConfig): string =>
  config.rpc ?? config.rpcs?.[0] ?? '';

const resolveRpcUrl = (rpc: string, baseOrigin?: string): string => {
  if (!rpc) throw new Error('Missing RPC URL in /api/jurisdictions');
  if (typeof window !== 'undefined' && rpc.startsWith('/rpc/')) {
    const origin = baseOrigin ?? window.location.origin;
    return new URL('/rpc', origin).toString();
  }
  if (typeof window !== 'undefined' && rpc.startsWith('http')) {
    try {
      const parsed = new URL(rpc);
      if (parsed.pathname.startsWith('/rpc/')) {
        return `${parsed.origin}/rpc`;
      }
      const isLocal = parsed.hostname === 'localhost';
      if (isLocal) {
        // Route localhost RPC through same-origin RPC bridge.
        const origin = baseOrigin ?? window.location.origin;
        return new URL('/rpc', origin).toString();
      }
    } catch {
      // fall through
    }
  }
  if (rpc.startsWith('http')) return rpc;
  if (typeof window !== 'undefined') {
    const origin = baseOrigin ?? window.location.origin;
    return new URL(rpc, origin).toString();
  }
  return rpc;
};

type ActiveTowerAppointmentUpload = {
  tower: RecoveryTowerConfig;
  appointment: TowerAppointmentV1;
  lookupKey: string;
  triggerHint: string;
};

async function buildDelayedLastResortAppointmentsForTower(
  runtime: Runtime,
  env: Env,
  xln: XLNModule,
  tower: RecoveryTowerConfig,
  towerSignerAddress: string,
  encryptedBundle: EncryptedRuntimeRecoveryBundleV1,
): Promise<ActiveTowerAppointmentUpload[]> {
  if (
    typeof xln.deriveRuntimeRecoveryActionLookupKey !== 'function' ||
    typeof xln.computeWatchtowerCounterDisputeAuthorizationHash !== 'function' ||
    typeof xln.buildTowerAppointmentOwnerMessage !== 'function' ||
    typeof xln.buildSingleSignerHanko !== 'function'
  ) {
    return [];
  }

  const normalizedRuntimeId = normalizeRuntimeId(runtime.id);
  if (!normalizedRuntimeId || !runtime.seed) return [];

  const rootWallet = new Wallet(derivePrivateKey(runtime.seed, 0));
  const uploads = new Map<string, ActiveTowerAppointmentUpload>();

  // We publish one last-resort appointment per concrete bilateral account.
  // The tower never gets spend authority. It only receives the latest
  // counterparty-signed proof plus a narrow owner authorization bound to the
  // tower address, the exact account pair, and the last-resort window.
  for (const signer of runtime.signers || []) {
    const entityId = normalizeEntityId(signer.entityId);
    const signerAddress = normalizeRuntimeId(signer.address);
    if (!entityId || !signerAddress) continue;

    const replica = findEntityReplicaByEntityAndSigner(env, entityId, signerAddress);
    if (!replica?.state?.accounts || !(replica.state.accounts instanceof Map)) continue;

    const jurisdictionName =
      getEntityReplicaJurisdictionName(replica)
      || String(signer.jurisdiction || '').trim()
      || String(env.activeJurisdiction || '').trim();
    const jReplica = findJReplicaByName(env, jurisdictionName);
    if (!jReplica) continue;

    let depositoryAddress = '';
    try {
      depositoryAddress = getJReplicaContractAddress(jReplica, 'depository');
    } catch {
      continue;
    }
    const chainId = Number(jReplica.chainId ?? jReplica.jadapter?.chainId ?? 0);
    if (!Number.isFinite(chainId) || chainId <= 0) continue;

    const rpcBase = String(jReplica.rpcs?.[0] || '').trim();
    if (!rpcBase) continue;
    const rpcUrl = resolveRpcUrl(rpcBase);
    const signerPrivateKey = derivePrivateKey(runtime.seed, getSignerDerivationIndex(signer));

    for (const [rawCounterpartyId, account] of replica.state.accounts.entries()) {
      const counterpartyId = normalizeEntityId(rawCounterpartyId);
      const proofNonce = Math.max(0, Math.floor(Number(account?.counterpartyDisputeProofNonce || 0)));
      const proofBodyHash = String(account?.counterpartyDisputeProofBodyHash || '').trim().toLowerCase();
      const proofHanko = String(account?.counterpartyDisputeProofHanko || '').trim();
      const proofBody = proofBodyHash ? account?.disputeProofBodiesByHash?.[proofBodyHash] : null;
      if (!counterpartyId || proofNonce <= 0 || !proofBodyHash || !proofHanko || !proofBody || typeof proofBody !== 'object') {
        continue;
      }

      const appointmentSequence = proofNonce;
      const lookupKey = xln.deriveRuntimeRecoveryActionLookupKey(
        normalizedRuntimeId,
        runtime.seed,
        entityId,
        counterpartyId,
      );
      const ownerAuthorizationHash = xln.computeWatchtowerCounterDisputeAuthorizationHash(
        chainId,
        depositoryAddress,
        towerSignerAddress,
        entityId,
        counterpartyId,
        proofNonce,
        proofBodyHash,
        WATCHTOWER_LAST_RESORT_WINDOW_BLOCKS,
        appointmentSequence,
      );
      const ownerAuthorizationHanko = xln.buildSingleSignerHanko(
        entityId,
        ownerAuthorizationHash,
        signerPrivateKey,
      );

      const remedy: TowerCounterDisputeRemedyV1 = {
        version: 1,
        type: 'counter_dispute_remedy',
        rpcUrl,
        chainId,
        depositoryAddress,
        watchedEntityId: entityId,
        towerAddress: towerSignerAddress,
        lastResortWindowBlocks: WATCHTOWER_LAST_RESORT_WINDOW_BLOCKS,
        appointmentSequence,
        ownerAuthorizationHanko,
        latestProof: {
          counterentity: counterpartyId,
          finalNonce: proofNonce,
          finalProofbody: structuredClone(proofBody as Record<string, unknown>),
          finalArguments: '0x',
          sig: proofHanko,
        },
      };
      const triggerHint = `chain:${chainId}:acct:${entityId}:${counterpartyId}`;
      const activePayload: TowerActivePayloadV1 = {
        triggerHint,
        encryptedRemedy: JSON.stringify(remedy),
        actionKind: 'counter_dispute_only',
        appointmentSequence,
        proofNonce,
        proofBodyHash,
        responseMode: 'last_resort',
        lastResortWindowBlocks: WATCHTOWER_LAST_RESORT_WINDOW_BLOCKS,
        safetyMarginBlocks: WATCHTOWER_SAFETY_MARGIN_BLOCKS,
      };
      const signedAt = Date.now();
      const ownerProofSignature = await rootWallet.signMessage(
        xln.buildTowerAppointmentOwnerMessage(
          normalizedRuntimeId,
          'delayed_last_resort',
          lookupKey,
          0,
          encryptedBundle.bundleHash,
          encryptedBundle.height,
          signedAt,
          activePayload,
        ),
      );
      const nextUpload: ActiveTowerAppointmentUpload = {
        tower,
        lookupKey,
        triggerHint,
        appointment: {
          type: 'tower_appointment',
          version: 1,
          towerMode: 'delayed_last_resort',
          lookupKey,
          slot: 0,
          // Active appointments use a separate blind lookup namespace so towers
          // cannot infer backup availability from the action channel and vice
          // versa. The ciphertext stays opaque to the tower either way.
          bundle: {
            ...encryptedBundle,
            lookupKey,
          },
          activePayload,
          ownerProof: {
            runtimeId: normalizedRuntimeId,
            signedAt,
            signature: ownerProofSignature,
          },
        },
      };
      const previous = uploads.get(lookupKey);
      if (!previous || (previous.appointment.activePayload?.proofNonce || 0) < proofNonce) {
        uploads.set(lookupKey, nextUpload);
      }
    }
  }

  return [...uploads.values()];
}

const summarizeHealth = (payload: HealthPayload | null): Record<string, unknown> => {
  if (!payload) return {};
  return {
    timestamp: payload.timestamp,
    resetInProgress: payload?.reset?.inProgress ?? null,
    resetError: payload?.reset?.lastError ?? null,
    system: payload?.system ?? null,
    jMachines: Array.isArray(payload?.jMachines)
      ? payload.jMachines.map((j: HealthMachine) => ({
          name: j?.name,
          status: j?.status,
          chainId: j?.chainId,
          lastBlock: j?.lastBlock,
        }))
      : [],
  };
};

const resolveJurisdictionChainId = (config: JurisdictionConfig, context: string): number => {
  const chainId = Number(config.chainId || 31337);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new Error(`[${context}] CHAIN_ID_INVALID: ${String(config.chainId)}`);
  }
  return Math.floor(chainId);
};

const fetchJurisdictions = async (baseOrigin?: string): Promise<JurisdictionsPayload> => {
  const primaryOrigin = baseOrigin ?? (typeof window !== 'undefined' ? window.location.origin : 'https://xln.finance');
  const configuredApiBase =
    typeof window !== 'undefined'
      ? (window as typeof window & { __XLN_API_BASE_URL__?: string }).__XLN_API_BASE_URL__?.trim() || null
      : null;
  const bust = `ts=${Date.now()}`;
  const candidates = configuredApiBase
    ? Array.from(new Set([
        `${configuredApiBase}/api/jurisdictions?${bust}`,
        `${primaryOrigin}/api/jurisdictions?${bust}`,
      ]))
    : [`${primaryOrigin}/api/jurisdictions?${bust}`];

  let lastError: unknown = null;
  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        cache: 'no-store',
        headers: {
          'cache-control': 'no-cache, no-store, must-revalidate',
          pragma: 'no-cache',
        },
      });
      if (!resp.ok) {
        lastError = new Error(`HTTP ${resp.status}`);
        continue;
      }
      const payload = (await resp.json()) as JurisdictionsPayload;
      return payload;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('Failed to fetch /api/jurisdictions');
};

async function fundSignerWalletViaFaucet(address: string): Promise<void> {
  try {
    // Call testnet faucet API (Faucet A - ERC20 to wallet)
    const apiBase = typeof window !== 'undefined' ? window.location.origin : 'https://xln.finance';
    const response = await fetch(`${apiBase}/api/faucet/erc20`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userAddress: address,
        tokenSymbol: 'USDC',
        amount: '100'
      })
    });

    const raw = await response.text();
    let result: FaucetResult | null = null;
    if (raw) {
      try { result = JSON.parse(raw); } catch { /* ignore */ }
    }

    if (!response.ok) {
      const errorMsg = result?.error || `Faucet failed (${response.status})`;
      console.warn('[VaultStore] Faucet failed:', errorMsg);
      return;
    }

    if (result?.success) {
    } else {
      console.warn('[VaultStore] Faucet failed:', result?.error || 'Unknown faucet error');
    }
  } catch (err) {
    console.warn('[VaultStore] Failed to call faucet:', err);
  }
}

async function fundRuntimeSignersInBrowserVM(runtime: Runtime | null): Promise<void> {
  if (!runtime) return;
  for (const signer of runtime.signers) {
    await fundSignerWalletViaFaucet(signer.address);
  }
}

async function cleanupRuntimeEnv(runtimeId: string): Promise<void> {
  try {
    unregisterRuntimeEnvChange(runtimeId);
    runtimeRecoveryUploadMeta.delete(normalizeRuntimeId(runtimeId));
    const runtimeEntry = get(runtimes).get(runtimeId);
    const env = runtimeEntry?.env;
    if (!env) return;
    const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;

    const xln = await getXLN();

    // Stop WS/P2P first to avoid new inbound events while shutting down loop.
    xln.stopP2P(runtimeEnv);

    // Stop async runtime loop if active.
    runtimeEnv.runtimeState?.stopLoop?.();
    if (runtimeEnv.runtimeState) {
      runtimeEnv.runtimeState.loopActive = false;
      runtimeEnv.runtimeState.stopLoop = null;
    }

    try {
      await xln.clearDB(runtimeEnv);
    } catch (dbErr) {
      console.warn('[VaultStore] DB clear failed:', dbErr);
    }
  } catch (err) {
    console.warn(`[VaultStore] Failed to cleanup runtime ${runtimeId.slice(0, 12)}:`, err);
  }
}

async function stopRuntimeEnv(env: Env): Promise<void> {
  const xln = await getXLN();

  for (const jReplica of env.jReplicas?.values?.() || []) {
    try {
      jReplica.jadapter?.stopWatching?.();
    } catch (error) {
      console.warn(`[VaultStore] Failed to stop J-watcher for ${jReplica.name}:`, error);
    }
  }

  if (xln.stopP2P) {
    xln.stopP2P(env);
  }

  env.runtimeState?.stopLoop?.();
  if (env.runtimeState) {
    env.runtimeState.loopActive = false;
    env.runtimeState.stopLoop = null;
  }

  if (typeof xln.closeRuntimeDb === 'function') {
    await xln.closeRuntimeDb(env);
  }
  if (typeof xln.closeInfraDb === 'function') {
    await xln.closeInfraDb(env);
  }
}

function unregisterRuntimeEnvChange(runtimeId: string): void {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  if (!normalizedRuntimeId) return;
  const unsubscribe = runtimeEnvChangeUnsubscribers.get(normalizedRuntimeId);
  if (unsubscribe) {
    runtimeEnvChangeUnsubscribers.delete(normalizedRuntimeId);
    unsubscribe();
  }
  const recoveryBarrierUnsub = runtimeRecoveryBarrierUnsubscribers.get(normalizedRuntimeId);
  if (recoveryBarrierUnsub) {
    runtimeRecoveryBarrierUnsubscribers.delete(normalizedRuntimeId);
    recoveryBarrierUnsub();
  }
  const uploadTimer = runtimeRecoveryUploadTimers.get(normalizedRuntimeId);
  if (uploadTimer) {
    clearTimeout(uploadTimer);
    runtimeRecoveryUploadTimers.delete(normalizedRuntimeId);
  }
}

function registerRuntimeEnvChange(
  runtimeId: string,
  env: Env,
  xln: XLNModule,
): void {
  const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId || runtimeEnv.runtimeId);
  if (!normalizedRuntimeId) {
    throw new Error('[VaultStore] Cannot register env change callback without runtimeId');
  }
  unregisterRuntimeEnvChange(normalizedRuntimeId);
  if (typeof xln.registerEnvChangeCallback !== 'function') return;
  if (typeof xln.registerRecoveryBackupBarrier === 'function') {
    runtimeRecoveryBarrierUnsubscribers.set(
      normalizedRuntimeId,
      xln.registerRecoveryBackupBarrier(runtimeEnv, async (backupEnv) => {
        await uploadRuntimeRecoverySnapshot(normalizedRuntimeId, unwrapLiveRuntimeEnv(backupEnv) ?? backupEnv, xln);
      }),
    );
  }

  const onEnvChange = (nextEnv: Env): void => {
    runtimeOperations.updateRuntimeEnv(normalizedRuntimeId, nextEnv);
    if (normalizeRuntimeId(get(activeRuntimeId) || '') === normalizedRuntimeId) {
      setXlnEnvironment(nextEnv);
    }
    scheduleRuntimeRecoveryUpload(normalizedRuntimeId, nextEnv, xln);
  };

  runtimeEnvChangeUnsubscribers.set(
    normalizedRuntimeId,
    xln.registerEnvChangeCallback(runtimeEnv, onEnvChange),
  );
  onEnvChange(runtimeEnv);
}

function runtimeToEntry(runtime: Runtime, env: Env) {
  const runtimeId = normalizeRuntimeId(runtime.id);
  if (!runtimeId) {
    throw new Error(`[VaultStore] Invalid runtime.id: ${String(runtime.id)}`);
  }
  const viewEnv = runtimeOperations.createRuntimeEnvView(env);
  return {
    id: runtimeId,
    type: 'local' as const,
    label: runtime.label,
    env: viewEnv,
    seed: runtime.seed,
    vaultId: runtimeId,
    permissions: 'write' as const,
    status: 'connected' as const,
  };
}

async function registerRuntimeSignerKeys(runtime: Runtime, xln: XLNModule): Promise<void> {
  for (const signer of runtime.signers) {
    const privateKey = derivePrivateKey(runtime.seed, getSignerDerivationIndex(signer));
    const privateKeyBytes = new Uint8Array(
      privateKey.slice(2).match(/.{2}/g)!.map(byte => parseInt(byte, 16))
    );
    xln.registerSignerKey(signer.address, privateKeyBytes);
  }
}

function applyRuntimeLogPreference(env: Env): void {
  if (!env) return;
  const verbose = !!get(settings).verboseLogging;
  env.quietRuntimeLogs = !verbose;
}

async function resetRuntimePersistence(runtime: Runtime, xln: XLNModule): Promise<void> {
  const runtimeIdLower = normalizeRuntimeId(runtime.id);
  if (!runtimeIdLower) throw new Error('Invalid runtime id for reset');
  const liveRuntimeEntry = get(runtimes).get(runtimeIdLower);
  if (liveRuntimeEntry?.env) {
    await stopRuntimeEnv(unwrapLiveRuntimeEnv(liveRuntimeEntry.env) ?? liveRuntimeEntry.env);
  }
  runtimes.update((currentRuntimes) => {
    const runtimeEntry = currentRuntimes.get(runtimeIdLower);
    if (!runtimeEntry) return currentRuntimes;
    const updated = new Map(currentRuntimes);
    updated.set(runtimeIdLower, {
      ...runtimeEntry,
      env: null,
      status: 'disconnected',
      lastSynced: Date.now(),
    });
    return updated;
  });
  if (normalizeRuntimeId(get(activeRuntimeId) || '') === runtimeIdLower) {
    setXlnEnvironment(null);
    tabOperations.clearAllTabs();
  }
  const resetEnv = xln.createEmptyEnv(runtime.seed);
  applyRuntimeLogPreference(resetEnv);
  resetEnv.runtimeId = runtimeIdLower;
  resetEnv.dbNamespace = runtimeIdLower;
  await xln.clearDB(resetEnv);
  toasts.warning('This runtime storage was reset', 8000);
}

function ensureRuntimeLoopRunning(env: Env, xln: XLNModule, reason: string): void {
  if (!hasStartRuntimeLoop(xln)) return;
  if (env.runtimeState?.loopActive) return;
  xln.startRuntimeLoop(env);
}

async function buildOrRestoreRuntimeEnv(runtime: Runtime, xln: XLNModule, strictRestore = false): Promise<Env> {
  const runtimeIdLower = normalizeRuntimeId(runtime.id);
  if (!runtimeIdLower) {
    throw new Error(`[VaultStore] Invalid runtime.id for env restore: ${String(runtime.id)}`);
  }
  const runtimeSeed = runtime.seed;
  let env: Env | null = null;
  let signerMetadataChanged = false;
  let restoredFromTower = false;

  for (const signer of runtime.signers || []) {
    if (!signer?.address) continue;
    const canonicalEntityId = String(xln.generateLazyEntityId([signer.address], 1n)).toLowerCase();
    if (normalizeEntityId(signer.entityId) === canonicalEntityId) continue;
    signer.entityId = canonicalEntityId;
    signerMetadataChanged = true;
    console.error(
      `[VaultStore] Canonical signer/entity mismatch detected for ${signer.address.slice(0, 10)}; forcing lazy entity ${canonicalEntityId.slice(0, 12)} without deleting persisted runtime`,
    );
  }

  try {
    if (xln.loadEnvFromDB) {
      env = await xln.loadEnvFromDB(runtimeIdLower, runtimeSeed);
    }
  } catch (error) {
    if (strictRestore) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[VaultStore] Strict restore failed for ${runtime.id.slice(0, 12)}; refusing to reset persisted runtime state`, error);
      throw new Error(`[VaultStore] Strict restore failed for ${runtime.id.slice(0, 12)}: ${message}`);
    } else {
      console.warn('[VaultStore] ⚠️ Failed to load env from DB, falling back to fresh import:', error);
      env = null;
    }
  }

  if (!env) {
    try {
      const towerRestored = await tryRestoreRuntimeEnvFromTower(runtime, xln);
      if (towerRestored) {
        env = towerRestored.env;
        restoredFromTower = true;
        signerMetadataChanged = true;
      }
    } catch (error) {
      if (strictRestore) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`[VaultStore] Tower restore failed for ${runtime.id.slice(0, 12)}: ${message}`);
      }
      console.warn('[VaultStore] ⚠️ Failed to restore env from tower, continuing with local recovery path:', error);
    }
  }

  if (signerMetadataChanged) {
    runtimesState.update((state) => ({
      ...state,
      runtimes: {
        ...state.runtimes,
        [runtime.id]: runtime,
      },
    }));
    persistRuntimeMetadataSnapshot();
  }

  if (!env && strictRestore) {
    throw new Error(`[VaultStore] Strict restore failed for ${runtime.id.slice(0, 12)}: persisted env missing`);
  }

  if (env && (!env.jReplicas || env.jReplicas.size === 0)) {
    if (strictRestore && !restoredFromTower) {
      throw new Error(`[VaultStore] Strict restore failed for ${runtime.id.slice(0, 12)}: restored env missing jReplicas`);
    }
    console.warn('[VaultStore] ⚠️ Restored env missing J-replicas; re-importing');
    env = null;
  }

  const hasLiveJAdapter = (targetEnv: Env | null): boolean => {
    if (!targetEnv?.jReplicas || targetEnv.jReplicas.size === 0) return false;
    for (const [, jReplica] of targetEnv.jReplicas.entries()) {
      if (hasConnectedJurisdictionAdapter(jReplica)) return true;
    }
    return false;
  };

  const hasEntityReplica = (targetEntityId: string): boolean => {
    if (!env?.eReplicas) return false;
    const target = String(targetEntityId).toLowerCase();
    for (const key of env.eReplicas.keys()) {
      const [entityId] = String(key).split(':');
      if (String(entityId || '').toLowerCase() === target) return true;
    }
    return false;
  };

  if (env && strictRestore && !restoredFromTower) {
    for (const signer of runtime.signers || []) {
      if (!signer?.entityId) continue;
      if (!hasEntityReplica(signer.entityId)) {
        const restoredEntityKeys = env.eReplicas
          ? Array.from(env.eReplicas.keys()).map((key) => String(key))
          : [];
        console.error(
          `[VaultStore] Strict restore failed for ${runtime.id.slice(0, 12)}: missing restored entity ${signer.entityId.slice(0, 12)}; ` +
          `restoredKeys=${JSON.stringify(restoredEntityKeys)} replayMeta=${JSON.stringify(getReplayMeta(env))}; resetting runtime storage`
        );
        throw new Error(
          `[VaultStore] Strict restore failed for ${runtime.id.slice(0, 12)}: missing restored entity ${signer.entityId.slice(0, 12)}`
        );
      }
    }
  }

  const baseOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://xln.finance';
  const jurisdictions = await fetchJurisdictions(baseOrigin);
  const arrakisConfig = resolveJurisdictionConfig(jurisdictions);
  const defaultJurisdictionImports = listDefaultJurisdictionImports(jurisdictions);
  const primaryJurisdictionName =
    defaultJurisdictionImports[0]?.name ||
    stripLocalJurisdictionSuffix(arrakisConfig.name || 'primary') ||
    'primary';
  const rpcUrl = resolveRpcUrl(resolveJurisdictionRpc(arrakisConfig), baseOrigin);
  const canonicalDeltaTransformerAddress = requireContractAddress(
    arrakisConfig.contracts?.deltaTransformer,
    'delta_transformer',
  );
  xln.setDeltaTransformerAddress?.(canonicalDeltaTransformerAddress);
  const chainId = resolveJurisdictionChainId(arrakisConfig, 'VaultStore.restore');

  if (!env) {
    env = xln.createEmptyEnv(runtimeSeed);
    applyRuntimeLogPreference(env);
    env.runtimeId = runtimeIdLower;
    env.dbNamespace = runtimeIdLower;
    ensureRuntimeLoopRunning(env, xln, `fresh-env:${runtimeIdLower.slice(0, 12)}`);
    await enqueueAndAwait(
      xln,
      env,
      {
        runtimeTxs: [{
          type: 'importJ',
          data: {
            name: primaryJurisdictionName,
            chainId,
            ticker: 'USDC',
            rpcs: [rpcUrl],
            blockTimeMs: 1_000,
            contracts: arrakisConfig.contracts,
          }
        }],
        entityInputs: []
      },
      () => hasConnectedJurisdictionAdapter(findJReplicaByName(env!, primaryJurisdictionName)),
      `importJ(${primaryJurisdictionName})`,
      45_000,
    );
    await waitForCondition(
      () => hasRuntimeJurisdictionAddresses(findJReplicaByName(env!, primaryJurisdictionName)),
      `importJ(${primaryJurisdictionName}).addresses`,
      45_000,
    );
  } else {
    applyRuntimeLogPreference(env);
    env.runtimeSeed = runtimeSeed;
    env.runtimeId = runtimeIdLower;
    env.dbNamespace = runtimeIdLower;
    if (env.jReplicas && env.jReplicas.size > 0) {
      for (const [, jReplica] of env.jReplicas.entries()) {
        const existingContracts = (jReplica.contracts || {}) as {
          account?: string;
          depository?: string;
          entityProvider?: string;
          deltaTransformer?: string;
        };
        jReplica.contracts = {
          account: String(existingContracts.account || arrakisConfig.contracts.account || ''),
          depository: String(existingContracts.depository || arrakisConfig.contracts.depository || ''),
          entityProvider: String(existingContracts.entityProvider || arrakisConfig.contracts.entityProvider || ''),
          deltaTransformer: String(existingContracts.deltaTransformer || arrakisConfig.contracts.deltaTransformer || ''),
        };
        jReplica.depositoryAddress = String(jReplica.depositoryAddress || jReplica.contracts.depository || '');
        jReplica.entityProviderAddress = String(
          jReplica.entityProviderAddress || jReplica.contracts.entityProvider || '',
        );
      }
    }
  }

  if (!hasLiveJAdapter(env)) {
    ensureRuntimeLoopRunning(env, xln, `repair-import-j:${runtimeIdLower.slice(0, 12)}`);
    console.warn(`[VaultStore] ⚠️ Restored env has no live J-adapter; re-importing ${primaryJurisdictionName} jurisdiction`);
    await enqueueAndAwait(
      xln,
      env,
      {
        runtimeTxs: [{
          type: 'importJ',
          data: {
            name: primaryJurisdictionName,
            chainId,
            ticker: 'USDC',
            rpcs: [rpcUrl],
            blockTimeMs: 1_000,
            contracts: arrakisConfig.contracts,
          }
        }],
        entityInputs: []
      },
      () => hasConnectedJurisdictionAdapter(findJReplicaByName(env, primaryJurisdictionName)),
      `repairImportJ(${primaryJurisdictionName})`,
      45_000,
    );
    await waitForCondition(
      () => hasRuntimeJurisdictionAddresses(findJReplicaByName(env, primaryJurisdictionName)),
      `repairImportJ(${primaryJurisdictionName}).addresses`,
      45_000,
    );
  }

  ensureRuntimeLoopRunning(env, xln, `post-restore:${runtimeIdLower.slice(0, 12)}`);

  for (const signer of runtime.signers || []) {
    const entityId = normalizeEntityId(signer?.entityId);
    const signerAddress = normalizeRuntimeId(signer?.address);
    if (!entityId || !signerAddress) continue;

    let preferredJurisdictionName = String(signer.jurisdiction || primaryJurisdictionName).trim();
    let jReplica = findJReplicaByName(env, preferredJurisdictionName);
    if (!jReplica && normalizeJurisdictionKey(preferredJurisdictionName) === 'testnet') {
      preferredJurisdictionName = primaryJurisdictionName;
      signer.jurisdiction = primaryJurisdictionName;
      jReplica = findJReplicaByName(env, preferredJurisdictionName);
    }
    if (!jReplica) {
      const message =
        `[VaultStore] Missing signer jurisdiction ${preferredJurisdictionName} for entity ${entityId.slice(0, 12)}`;
      if (normalizeJurisdictionKey(preferredJurisdictionName) === normalizeJurisdictionKey(primaryJurisdictionName)) {
        throw new Error(message);
      }
      console.warn(`${message}; waiting for jurisdiction import`);
      continue;
    }

    const targetJurisdictionName = getJReplicaJurisdictionName(jReplica, preferredJurisdictionName);
    const targetJurisdictionKey = normalizeJurisdictionKey(targetJurisdictionName);
    const exactReplica = findEntityReplicaByEntityAndSigner(env, entityId, signerAddress);
    const anyEntityReplica = exactReplica || findEntityReplicaByEntityId(env, entityId);
    const existingJurisdictionName = getEntityReplicaJurisdictionName(anyEntityReplica);
    if (existingJurisdictionName && normalizeJurisdictionKey(existingJurisdictionName) !== targetJurisdictionKey) {
      throw new Error(
        `ENTITY_JURISDICTION_CONFLICT: entity=${entityId} existing=${existingJurisdictionName} incoming=${targetJurisdictionName}`,
      );
    }

    if (exactReplica && normalizeJurisdictionKey(getEntityReplicaJurisdictionName(exactReplica)) === targetJurisdictionKey) {
      continue;
    }

    if (strictRestore && !anyEntityReplica) {
      throw new Error(
        `[VaultStore] Strict restore failed for ${runtime.id.slice(0, 12)}: entity missing after restore ${entityId.slice(0, 12)}`,
      );
    }

    const entityConfig = buildSignerEntityConfig(signerAddress, jReplica, preferredJurisdictionName, chainId);
    await enqueueAndAwait(
      xln,
      env,
      {
        runtimeTxs: [{
          type: 'importReplica',
          entityId,
          signerId: signerAddress,
          data: {
            isProposer: true,
            config: entityConfig,
            profileName: runtime.label,
          }
        }],
        entityInputs: []
      },
      () => {
        const repaired = findEntityReplicaByEntityAndSigner(env!, entityId, signerAddress);
        return normalizeJurisdictionKey(getEntityReplicaJurisdictionName(repaired)) === targetJurisdictionKey;
      },
      `importReplica(${entityId.slice(0, 12)}@${targetJurisdictionName})`,
    );
  }

  if (xln.startP2P) {
    xln.startP2P(env, {
      signerId: runtimeIdLower,
      relayUrls: resolveRelayUrls(),
      gossipPollMs: BROWSER_GOSSIP_POLL_MS,
    });
  }

  return env;
}

function registerRuntimeResumeListener(): void {
  if (resumeListenerRegistered || typeof window === 'undefined' || typeof document === 'undefined') return;
  const triggerRefresh = () => {
    if (isInactiveTabStandby()) return;
    if (document.visibilityState !== 'visible') return;
    void vaultOperations.refreshActiveRuntimeFromDbIfBehind().catch((error) => {
      console.warn('[VaultStore] Resume refresh failed:', error);
    });
  };
  runtimeResumeTrigger = triggerRefresh;
  document.addEventListener('visibilitychange', triggerRefresh);
  window.addEventListener('focus', triggerRefresh);
  if (typeof BroadcastChannel !== 'undefined') {
    runtimeSyncChannel = new BroadcastChannel('xln-runtime-sync');
    runtimeSyncChannel.onmessage = (event: MessageEvent<{ runtimeId?: string; height?: number }>) => {
      if (isInactiveTabStandby()) return;
      const runtimeId = normalizeRuntimeId(event.data?.runtimeId);
      const height = Number(event.data?.height ?? 0);
      if (!runtimeId || !Number.isFinite(height) || height <= 0) return;
      const runtimeEntry = get(runtimes).get(runtimeId);
      const currentHeight = Number(runtimeEntry?.env?.height ?? 0);
      if (height <= currentHeight) return;
      void vaultOperations.refreshActiveRuntimeFromDbIfBehind().catch((error) => {
        console.warn('[VaultStore] Broadcast refresh failed:', error);
      });
    };
  }
  resumeListenerRegistered = true;
}

export function shutdownRuntimeResumeListener(): void {
  if (typeof window !== 'undefined' && runtimeResumeTrigger) {
    window.removeEventListener('focus', runtimeResumeTrigger);
  }
  if (typeof document !== 'undefined' && runtimeResumeTrigger) {
    document.removeEventListener('visibilitychange', runtimeResumeTrigger);
  }
  runtimeResumeTrigger = null;
  runtimeSyncChannel?.close();
  runtimeSyncChannel = null;
  resumeListenerRegistered = false;
}

  // Runtime operations
export const vaultOperations = {
  async suspendAllRuntimeActivity(): Promise<void> {
    shutdownRuntimeResumeListener();
    const entries = Array.from(get(runtimes).entries());
    await Promise.all(entries.map(async ([runtimeId, entry]) => {
      unregisterRuntimeEnvChange(runtimeId);
      if (!entry?.env) return;
      await stopRuntimeEnv(unwrapLiveRuntimeEnv(entry.env) ?? entry.env);
    }));
  },

  async refreshActiveRuntimeFromDbIfBehind(): Promise<boolean> {
    if (resumeRefreshPromise) return resumeRefreshPromise;
    resumeRefreshPromise = (async () => {
      const currentState = get(runtimesState);
      const runtimeId = normalizeRuntimeId(currentState.activeRuntimeId);
      if (!runtimeId) return false;

      const runtime = currentState.runtimes[runtimeId];
      const runtimeEntry = get(runtimes).get(runtimeId);
      const entryEnv = runtimeEntry?.env as Env | undefined;
      const env = unwrapLiveRuntimeEnv(entryEnv) ?? entryEnv;
      if (!runtime || !env) return false;

      const xln = await getXLN();
      if (typeof xln.getPersistedLatestHeight !== 'function') return false;

      const persistedLatestHeight = Number(await xln.getPersistedLatestHeight(env) || 0);
      const currentHeight = Number(env.height || 0);
      if (persistedLatestHeight <= currentHeight) return false;

      await registerRuntimeSignerKeys(runtime, xln);
      const refreshedEnv = await buildOrRestoreRuntimeEnv(runtime, xln, true);
      unregisterRuntimeEnvChange(runtimeId);
      await stopRuntimeEnv(env);

      runtimes.update((currentRuntimes) => {
        const updated = new Map(currentRuntimes);
        updated.set(runtimeId, runtimeToEntry(runtime, refreshedEnv));
        return updated;
      });
      registerRuntimeEnvChange(runtimeId, refreshedEnv, xln);

      return true;
    })();

    try {
      return await resumeRefreshPromise;
    } finally {
      resumeRefreshPromise = null;
    }
  },

  async enqueueRuntimeInput(env: Env, input: RuntimeInput): Promise<Env> {
    return enqueueAndProcess(env, input);
  },

  async importJMachine(config: ImportedJMachineConfig): Promise<ImportedJMachineConfig> {
    const runtimeId = normalizeRuntimeId(get(activeRuntimeId));
    if (!runtimeId) throw new Error('No active runtime selected');

    const state = get(runtimesState);
    const runtime = state.runtimes[runtimeId];
    if (!runtime) throw new Error(`Runtime not found: ${runtimeId}`);

    const xln = await getXLN();
    await registerRuntimeSignerKeys(runtime, xln);

    let env = get(runtimes).get(runtimeId)?.env as Env | undefined;
    if (!env) {
      env = await buildOrRestoreRuntimeEnv(runtime, xln, true);
      runtimes.update((currentRuntimes) => {
        const updated = new Map(currentRuntimes);
        updated.set(runtimeId, runtimeToEntry(runtime, env!));
        return updated;
      });
      registerRuntimeEnvChange(runtimeId, env, xln);
    }
    const runtimeEnv = unwrapLiveRuntimeEnv(env) ?? env;
    const getLatestEnv = (): Env => {
      const latest = getLiveRuntimeEnvForId(runtimeId, runtimeEnv);
      if (!latest) throw new Error(`Runtime env not found: ${runtimeId}`);
      return latest;
    };

    if (getLatestEnv().jReplicas?.has(config.name)) {
      const existing = getLatestEnv().jReplicas.get(config.name);
      return {
        ...config,
        contracts: {
          depository: String(existing?.depositoryAddress || existing?.contracts?.depository || config.contracts?.depository || ''),
          entityProvider: String(existing?.entityProviderAddress || existing?.contracts?.entityProvider || config.contracts?.entityProvider || ''),
          account: String(existing?.contracts?.account || config.contracts?.account || ''),
          deltaTransformer: String(existing?.contracts?.deltaTransformer || config.contracts?.deltaTransformer || ''),
        },
      };
    }

    ensureRuntimeLoopRunning(runtimeEnv, xln, `import-jmachine:${config.name}`);
    await enqueueAndAwait(
      xln,
      runtimeEnv,
      {
        runtimeTxs: [{
          type: 'importJ',
          data: {
            name: config.name,
            chainId: config.chainId,
            ticker: config.ticker,
            rpcs: config.mode === 'browservm' ? [] : config.rpcs,
            blockTimeMs: config.blockTimeMs,
            ...(config.contracts ? { contracts: config.contracts } : {}),
          }
        }],
        entityInputs: []
      },
      () => {
        const latestEnv = getLatestEnv();
        if (latestEnv.runtimeState?.loopActive === false) {
          throw new Error(`importJ(${config.name}) failed: runtime loop halted\n${getRuntimeFatalDiagnostics(latestEnv, config.name)}`);
        }
        return hasConnectedJurisdictionAdapter(latestEnv.jReplicas?.get?.(config.name));
      },
      `importJ(${config.name})`,
      45_000,
      () => getRuntimeFatalDiagnostics(getLatestEnv(), config.name),
    );
    await waitForCondition(
      () => hasRuntimeJurisdictionAddresses(getLatestEnv().jReplicas?.get?.(config.name)),
      `importJ(${config.name}).addresses`,
      45_000,
      50,
      () => getRuntimeFatalDiagnostics(getLatestEnv(), config.name),
    );

    const finalEnv = getLatestEnv();
    runtimes.update((currentRuntimes) => {
      const updated = new Map(currentRuntimes);
      updated.set(runtimeId, runtimeToEntry(runtime, finalEnv));
      return updated;
    });
    if (normalizeRuntimeId(get(activeRuntimeId)) === runtimeId) {
      setXlnEnvironment(finalEnv);
    }
    const imported = finalEnv.jReplicas?.get(config.name);
    return {
      ...config,
      contracts: {
        depository: String(imported?.depositoryAddress || imported?.contracts?.depository || config.contracts?.depository || ''),
        entityProvider: String(imported?.entityProviderAddress || imported?.contracts?.entityProvider || config.contracts?.entityProvider || ''),
        account: String(imported?.contracts?.account || config.contracts?.account || ''),
        deltaTransformer: String(imported?.contracts?.deltaTransformer || config.contracts?.deltaTransformer || ''),
      },
    };
  },

  async enqueueEntityInputs(env: Env, inputs: RoutedEntityInput[]): Promise<Env> {
    return enqueueXlnEntityInputs(env, inputs);
  },

  async getPersistedLatestHeight(env: Env): Promise<number> {
    const xln = await getXLN();
    return xln.getPersistedLatestHeight(unwrapLiveRuntimeEnv(env) ?? env);
  },

  async listPersistedCheckpointHeights(env: Env): Promise<number[]> {
    const xln = await getXLN();
    return xln.listPersistedCheckpointHeights(unwrapLiveRuntimeEnv(env) ?? env);
  },

  async verifyRuntimeChain(
    runtimeId?: string | null,
    runtimeSeed?: string | null,
    options?: { fromSnapshotHeight?: number },
  ) {
    const xln = await getXLN();
    return xln.verifyRuntimeChain(runtimeId, runtimeSeed, options);
  },

  async readPersistedFrameJournal(env: Env, height: number): Promise<PersistedFrameJournal | null> {
    const xln = await getXLN();
    return xln.readPersistedFrameJournal(unwrapLiveRuntimeEnv(env) ?? env, height);
  },

  syncRuntime(runtime: Runtime | null) {
    const meta: { label?: string; seed?: string; vaultId?: string } = {};
    meta.label = runtime?.label || 'Runtime';
    if (runtime?.seed) meta.seed = runtime.seed;
    if (runtime?.id) meta.vaultId = runtime.id;

    runtimeOperations.setLocalRuntimeMetadata(meta);
    if (runtime?.env) {
      setXlnEnvironment(unwrapLiveRuntimeEnv(runtime.env) ?? runtime.env);
    }
    // P2P is started per-env in createRuntime() and initialize() — no need to restart here
    // Restarting on every selectRuntime caused WS connection leak (15+ connections with 4 runtimes)
  },

  // Load from localStorage
  loadFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return;

      const saved = localStorage.getItem(VAULT_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        const normalizedRuntimes: Record<string, Runtime> = {};
        for (const [rawKey, rawRuntime] of Object.entries(parsed?.runtimes || {})) {
          const runtime = rawRuntime as Runtime;
          const normalizedId = normalizeRuntimeId(runtime?.id || rawKey);
          if (!normalizedId) continue;
          normalizedRuntimes[normalizedId] = {
            ...runtime,
            id: normalizedId,
          };
        }
        const normalizedActiveId = normalizeRuntimeId(parsed?.activeRuntimeId || '');
        runtimesState.set({
          runtimes: normalizedRuntimes,
          activeRuntimeId: normalizedActiveId && normalizedRuntimes[normalizedActiveId]
            ? normalizedActiveId
            : (Object.keys(normalizedRuntimes)[0] || null),
        });
      }
      vaultStorageLoaded.set(true);
    } catch (error) {
      console.error('❌ Failed to load runtimes (clearing corrupted storage):', error);
      localStorage.removeItem(VAULT_STORAGE_KEY);
      runtimesState.set(defaultState);
      vaultStorageLoaded.set(true);
    }
  },

  // Save to localStorage
  saveToStorage() {
    try {
      if (typeof localStorage === 'undefined') return;

      const current = get(runtimesState);
      localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(current));
    } catch (error) {
      console.error('❌ Failed to save runtimes:', error);
    }
  },

  // Create new runtime from seed
  async createRuntime(name: string, seed: string, options: CreateRuntimeOptions = {}): Promise<Runtime> {
    registerRuntimeResumeListener();
    const perfStartedAt = Date.now();
    const perfMarks: Array<{ step: string; at: number }> = [{ step: 'start', at: perfStartedAt }];
    const markPerf = (step: string): void => {
      perfMarks.push({ step, at: Date.now() });
    };
    const flushPerf = (status: 'ok' | 'existing'): void => {
      let prev = perfStartedAt;
      const parts: string[] = [];
      for (const mark of perfMarks) {
        const delta = mark.at - prev;
        parts.push(`${mark.step}:${delta}ms`);
        prev = mark.at;
      }
      const totalMs = Date.now() - perfStartedAt;
    };

    // Derive first signer (index 0)
    const firstAddress = deriveAddress(seed, 0);
    markPerf('derive_first_address');

    // Use signer EOA as ID (deterministic, unique)
    const id = normalizeRuntimeId(firstAddress);
    if (!id) throw new Error('Invalid runtimeId derived from seed');
    const label = name;

    // Single-runtime invariant per signer EOA.
    // Creating a second runtime with the same id causes local/server chain divergence
    // (same entity ids, different local genesis) and leads to pending/mismatch loops.
    const currentState = get(runtimesState);
    const existing = findRuntimeByIdCaseInsensitive(currentState.runtimes, id);
    if (existing) {
      if (existing.runtime.seed !== seed) {
        throw new Error(`Runtime id collision for ${id}: existing runtime has different seed`);
      }
      await this.selectRuntime(existing.key);
      markPerf('select_existing_runtime');
      flushPerf('existing');
      return existing.runtime;
    }

    const loginType = options.loginType === 'demo' ? 'demo' : 'manual';
    const requiresOnboarding =
      typeof options.requiresOnboarding === 'boolean'
        ? options.requiresOnboarding
        : loginType !== 'demo';

    const runtime: Runtime = {
      id,
      label,
      seed,
      ...(options.mnemonic12 ? { mnemonic12: options.mnemonic12 } : {}),
      ...(options.devicePassphrase ? { devicePassphrase: options.devicePassphrase } : {}),
      signers: [{
        index: 0,
        address: firstAddress,
        name: 'Signer 1'
      }],
      activeSignerIndex: 0,
      loginType,
      requiresOnboarding,
      createdAt: Date.now()
    };

    runtimesState.update(state => ({
      ...state,
      runtimes: {
        ...state.runtimes,
        [id]: runtime
      },
      activeRuntimeId: id
    }));
    markPerf('persist_runtime_state');

    // CRITICAL: Create NEW isolated runtime for this runtime (AWAIT to avoid race)
    const runtimeId = normalizeRuntimeId(id); // Use normalized runtime ID key

    // Import XLN and create env BEFORE returning
    const xln = await getXLN();
    markPerf('load_xln_runtime');
    const towerRestored = await tryRestoreRuntimeEnvFromTower(runtime, xln);
    const runtimeIdLower = runtimeId.toLowerCase();
    let newEnv: Env;

    if (towerRestored) {
      newEnv = await buildOrRestoreRuntimeEnv(runtime, xln, false);
      applyRuntimeLogPreference(newEnv);
      markPerf('restore_runtime_from_tower');
      toasts.info('Runtime restored from recovery backup', 6_000);
    } else {
      newEnv = xln.createEmptyEnv(seed);
      applyRuntimeLogPreference(newEnv);
      newEnv.runtimeId = runtimeIdLower;
      newEnv.dbNamespace = runtimeIdLower;

      // REMOVED: setRuntimeSeed() - seed now stored in env.runtimeSeed and passed to pure functions
      // All crypto functions now read from env.runtimeSeed, not global state

      // Fetch pre-deployed contract addresses from prod
      const baseOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://xln.finance';
      markPerf('wait_server_runtime_ready');
      const jurisdictions = await fetchJurisdictions(baseOrigin);
      markPerf('fetch_jurisdictions');
      const arrakisConfig = resolveJurisdictionConfig(jurisdictions);
      const defaultJurisdictionImports = listDefaultJurisdictionImports(jurisdictions);
      const primaryJurisdictionName =
        defaultJurisdictionImports[0]?.name ||
        stripLocalJurisdictionSuffix(arrakisConfig.name || 'primary') ||
        'primary';
      const secondaryJurisdictionImports = defaultJurisdictionImports.slice(1);
      const rpcUrl = resolveRpcUrl(resolveJurisdictionRpc(arrakisConfig), baseOrigin);
      const chainId = resolveJurisdictionChainId(arrakisConfig, 'VaultStore.createRuntime');

      // Import the same primary jurisdiction name that hub profiles advertise.
      if (xln.startRuntimeLoop) {
        xln.startRuntimeLoop(newEnv);
      }
      await enqueueAndAwait(
        xln,
        newEnv,
        {
          runtimeTxs: [{
            type: 'importJ',
            data: {
              name: primaryJurisdictionName,
              chainId,
              ticker: 'USDC',
              rpcs: [rpcUrl],
              blockTimeMs: 1_000,
              contracts: arrakisConfig.contracts, // Use pre-deployed addresses
            }
          }],
          entityInputs: []
        },
        () => {
          const replica = findJReplicaByName(newEnv, primaryJurisdictionName);
          if (hasConnectedJurisdictionAdapter(replica)) return true;
          if (newEnv?.runtimeState?.loopActive === false) {
            throw new Error(`createRuntime.importJ(${primaryJurisdictionName}) failed: runtime loop halted\n${getRuntimeFatalDiagnostics(newEnv)}`);
          }
          return false;
        },
        `createRuntime.importJ(${primaryJurisdictionName})`,
        45_000,
      );
      await waitForCondition(
        () => hasRuntimeJurisdictionAddresses(findJReplicaByName(newEnv, primaryJurisdictionName)),
        `createRuntime.importJ(${primaryJurisdictionName}).addresses`,
        45_000,
      );
      markPerf('import_j_testnet');

      for (const secondary of secondaryJurisdictionImports) {
        const secondaryRpcUrl = resolveRpcUrl(resolveJurisdictionRpc(secondary.config), baseOrigin);
        const secondaryChainId = resolveJurisdictionChainId(secondary.config, `VaultStore.createRuntime.${secondary.name}`);
        await enqueueAndAwait(
          xln,
          newEnv,
          {
            runtimeTxs: [{
              type: 'importJ',
              data: {
                name: secondary.name,
                chainId: secondaryChainId,
                ticker: String((secondary.config as { currency?: unknown }).currency || 'USDC'),
                rpcs: [secondaryRpcUrl],
                blockTimeMs: secondary.config.blockTimeMs ?? 1_000,
                contracts: secondary.config.contracts,
              },
            }],
            entityInputs: [],
          },
          () => hasConnectedJurisdictionAdapter(newEnv?.jReplicas?.get?.(secondary.name)),
          `createRuntime.importJ(${secondary.name})`,
          45_000,
        );
        await waitForCondition(
          () => hasRuntimeJurisdictionAddresses(newEnv?.jReplicas?.get?.(secondary.name)),
          `createRuntime.importJ(${secondary.name}).addresses`,
          45_000,
        );
      }

      // === MVP: Create entity ===
      // Create entity config (single-signer, threshold 1)
      const signerAddress = firstAddress;

      // Get contract addresses from imported J-machine
      const jReplica = findJReplicaByName(newEnv, primaryJurisdictionName);
      if (!jReplica) {
        throw new Error(`${primaryJurisdictionName} J-machine not found after import`);
      }
      const depositoryAddress = requireContractAddress(jReplica.depositoryAddress, 'depository');
      const entityProviderAddress = requireContractAddress(jReplica.entityProviderAddress, 'entity_provider');

      // Lazy entity IDs are board hashes generated from the sorted validator set.
      const entityId = generateLazyEntityIdPreview([signerAddress], 1n);

      const entityConfig = {
        mode: 'proposer-based' as const,
        threshold: 1n,
        validators: [signerAddress],
        shares: { [signerAddress]: 1n },
        jurisdiction: {
          address: depositoryAddress,
          name: primaryJurisdictionName,
          chainId: Number(jReplica.chainId ?? chainId ?? 31337),
          entityProviderAddress: entityProviderAddress,
          depositoryAddress: depositoryAddress,
        }
      };

      // CRITICAL: Register the canonical signer key with runtime BEFORE importing entity.
      // The wallet/runtime signer for index 0 is the BIP44 account-path key derived above;
      // the entity uses the resulting EOA address as signerId, so consensus/J-batch signing
      // must reuse this exact private key instead of deriving a second one from other labels.
      const signerPrivateKey = derivePrivateKey(seed, 0);
      const privateKeyBytes = new Uint8Array(
        signerPrivateKey.slice(2).match(/.{2}/g)!.map(byte => parseInt(byte, 16))
      );
      xln.registerSignerKey(signerAddress, privateKeyBytes);
      markPerf('register_signer_key');

      // Import entity replica into runtime
      await enqueueAndAwait(
        xln,
        newEnv,
        {
          runtimeTxs: [{
            type: 'importReplica',
            entityId: entityId,
            signerId: signerAddress,
            data: {
              isProposer: true,
              config: entityConfig,
              profileName: name,
            }
          }],
          entityInputs: []
        },
        () => {
          const reps = newEnv?.eReplicas;
          if (!reps?.keys) return false;
          const entityIdNorm = String(entityId).toLowerCase();
          for (const key of reps.keys()) {
            const [repEntityId] = String(key).split(':');
            if (String(repEntityId || '').toLowerCase() === entityIdNorm) return true;
          }
          return false;
        },
        `createRuntime.importReplica(${entityId.slice(0, 12)})`,
      );
      markPerf('import_entity_replica');

      // Store entityId in signer
      runtime.signers[0]!.entityId = entityId;
      runtime.signers[0]!.jurisdiction = primaryJurisdictionName;
      void fundSignerWalletViaFaucet(signerAddress);

      for (const secondary of secondaryJurisdictionImports) {
        const jReplicaSecondary = findJReplicaByName(newEnv, secondary.name);
        if (!jReplicaSecondary) throw new Error(`${secondary.name} J-machine not found after import`);
        const derivationIndex = deriveJurisdictionSignerIndex(secondary.name);
        const secondaryAddress = deriveAddress(seed, derivationIndex);
        const secondaryPrivateKey = derivePrivateKey(seed, derivationIndex);
        const secondaryPrivateKeyBytes = new Uint8Array(
          secondaryPrivateKey.slice(2).match(/.{2}/g)!.map(byte => parseInt(byte, 16))
        );
        xln.registerSignerKey(secondaryAddress, secondaryPrivateKeyBytes);
        const secondaryEntityId = generateLazyEntityIdPreview([secondaryAddress], 1n);
        const secondaryChainId = Number(jReplicaSecondary.chainId ?? secondary.config.chainId ?? chainId);
        const secondaryEntityConfig = buildSignerEntityConfig(
          secondaryAddress,
          jReplicaSecondary,
          secondary.name,
          Number.isFinite(secondaryChainId) && secondaryChainId > 0 ? secondaryChainId : chainId,
        );
        await enqueueAndAwait(
          xln,
          newEnv,
          {
            runtimeTxs: [{
              type: 'importReplica',
              entityId: secondaryEntityId,
              signerId: secondaryAddress,
              data: {
                isProposer: true,
                config: secondaryEntityConfig,
                profileName: `${name} ${secondary.name}`,
              },
            }],
            entityInputs: [],
          },
          () => Boolean(findEntityReplicaByEntityAndSigner(newEnv, secondaryEntityId, secondaryAddress)),
          `createRuntime.importReplica(${secondary.name}:${secondaryEntityId.slice(0, 12)})`,
        );
        runtime.signers.push({
          index: runtime.signers.length,
          derivationIndex,
          address: secondaryAddress,
          name: `${secondary.name} Signer`,
          jurisdiction: secondary.name,
          entityId: secondaryEntityId,
        });
        void fundSignerWalletViaFaucet(secondaryAddress);
      }
      if (!requiresOnboarding) {
        writeSavedCollateralPolicy({
          mode: 'autopilot',
          softLimitUsd: 500,
          hardLimitUsd: 10_000,
          maxFeeUsd: 15,
        });
        writeHubJoinPreference(loginType === 'demo' ? '1' : 'manual');
        writeOnboardingComplete(entityId, true);
      }
    }
    runtimesState.update(state => ({
      ...state,
      runtimes: { ...state.runtimes, [id]: runtime }
    }));
    this.saveToStorage();
    markPerf('save_runtime_metadata');

    // Add to runtimes store
    runtimes.update(r => {
      const updated = new Map(r);
      updated.set(runtimeId, runtimeToEntry(runtime, newEnv));
      return updated;
    });
    registerRuntimeEnvChange(runtimeId, newEnv, xln);
    markPerf('attach_runtime_to_store');

    // Start P2P for this runtime's env (one WS per runtime, stays alive across switches)
    if (xln.startP2P) {
      const relayUrls = resolveRelayUrls();
      xln.startP2P(newEnv, {
        signerId: runtimeId,
        relayUrls,
        gossipPollMs: BROWSER_GOSSIP_POLL_MS,
      });
    }
    markPerf('start_p2p');

    // Switch to new runtime
    activeRuntimeId.set(runtimeId);
    markPerf('activate_runtime');

    // Sync metadata (no P2P — already started above)
    this.syncRuntime(runtime);
    markPerf('sync_runtime');
    flushPerf('ok');

    return runtime;
  },

  // Select runtime
  async selectRuntime(runtimeId: string) {
    // If restore is still in progress after reload, wait for it to settle first.
    // This prevents initialize() from clobbering a just-selected runtime/env.
    if (initializePromise && !initialized) {
      await initializePromise;
    }

    const requestedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!requestedRuntimeId) throw new Error('Invalid runtimeId');
    const currentState = get(runtimesState);
    const resolved = findRuntimeByIdCaseInsensitive(currentState.runtimes, requestedRuntimeId);
    if (!resolved) {
      throw new Error(`Runtime not found: ${requestedRuntimeId}`);
    }
    const resolvedRuntimeId = normalizeRuntimeId(resolved.key);
    if (!resolvedRuntimeId) throw new Error('Invalid resolved runtimeId');

    runtimesState.update(state => ({
      ...state,
      activeRuntimeId: resolvedRuntimeId
    }));
    this.saveToStorage();

    // CRITICAL: Switch to runtime's isolated runtime + seed
    const current = get(runtimesState);
    const runtime = current.runtimes[resolvedRuntimeId];

    if (runtime) {
      // CRITICAL: Re-register ALL signer private keys when switching runtimes
      // Keys are stored in memory (signerKeys Map), lost on page refresh
      // Must re-register from HD derivation to enable signing
      const xln = await getXLN();

      for (const signer of runtime.signers) {
        const privateKey = derivePrivateKey(runtime.seed, getSignerDerivationIndex(signer));
        const privateKeyBytes = new Uint8Array(
          privateKey.slice(2).match(/.{2}/g)!.map(byte => parseInt(byte, 16))
        );
        xln.registerSignerKey(signer.address, privateKeyBytes);
      }

      // Ensure selected runtime processing pipeline is alive.
      // We do NOT blindly recreate P2P; we only recover if missing/disconnected.
      const runtimeEntry = get(runtimes).get(resolvedRuntimeId);
      let env = runtimeEntry?.env;
      if (!env) {
        await registerRuntimeSignerKeys(runtime, xln);
        env = await buildOrRestoreRuntimeEnv(runtime, xln, true);
        const restoredEnv = env;
        runtimes.update(r => {
          const updated = new Map(r);
          updated.set(resolvedRuntimeId, runtimeToEntry(runtime, restoredEnv));
          return updated;
        });
        registerRuntimeEnvChange(resolvedRuntimeId, restoredEnv, xln);
      }
      await ensureRuntimePipelineAlive(runtime ? { ...runtime, env } : null, xln);
    }

    activeRuntimeId.set(resolvedRuntimeId);
    this.syncRuntime(runtime || null);
  },

  // Add signer to active runtime
  addSigner(name?: string, jurisdiction?: string): Signer | null {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return null;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime) return null;

    const jurisdictionKey = normalizeJurisdictionKey(jurisdiction);
    if (jurisdictionKey) {
      const existing = runtime.signers.find((signer) => normalizeJurisdictionKey(signer.jurisdiction) === jurisdictionKey);
      if (existing) return existing;
    }

    const nextIndex = runtime.signers.length;
    const derivationIndex = jurisdictionKey ? deriveJurisdictionSignerIndex(jurisdictionKey) : nextIndex;
    const address = deriveAddress(runtime.seed, derivationIndex);

    const newSigner: Signer = {
      index: nextIndex,
      ...(derivationIndex !== nextIndex ? { derivationIndex } : {}),
      address,
      name: name || `Signer ${nextIndex + 1}`,
      ...(jurisdiction ? { jurisdiction } : {}),
    };

    runtimesState.update(state => ({
      ...state,
      runtimes: {
        ...state.runtimes,
        [runtime.id]: {
          ...runtime,
          signers: [...runtime.signers, newSigner]
        }
      }
    }));

    this.saveToStorage();

    // CRITICAL: Register HD-derived private key with runtime BEFORE creating entity
    // Why: Runtime's deriveSignerKeySync uses different derivation than BIP44 HD
    // Without this, hanko verification fails (signature from wrong key)
    void (async () => {
      const xln = await getXLN();
      const privateKey = derivePrivateKey(runtime.seed, derivationIndex);
      const privateKeyBytes = new Uint8Array(
        privateKey.slice(2).match(/.{2}/g)!.map(byte => parseInt(byte, 16))
      );
      xln.registerSignerKey(address, privateKeyBytes);

      // Now create entity (key is registered, signing will work)
      const { autoCreateEntityForSigner } = await import('../utils/entityFactory');
      const entityId = await autoCreateEntityForSigner(address, jurisdiction);
      if (entityId) {
        this.setSignerEntity(nextIndex, entityId);
      }
    })().catch(err => {
      console.warn('[VaultStore] Failed to register key/create entity:', err);
    });
    // Auto-faucet removed - user can request funds manually via XLNSend

    return newSigner;
  },

  // Select signer
  selectSigner(index: number) {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime || index >= runtime.signers.length) return;

    runtimesState.update(state => ({
      ...state,
      runtimes: {
        ...state.runtimes,
        [runtime.id]: {
          ...runtime,
          activeSignerIndex: index
        }
      }
    }));

    this.saveToStorage();
  },

  // Rename signer
  renameSigner(index: number, name: string) {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime || index >= runtime.signers.length) return;

    runtimesState.update(state => ({
      ...state,
      runtimes: {
        ...state.runtimes,
        [runtime.id]: {
          ...runtime,
          signers: runtime.signers.map((s, i) =>
            i === index ? { ...s, name } : s
          )
        }
      }
    }));

    this.saveToStorage();
  },

  // Set entity ID for signer
  setSignerEntity(signerIndex: number, entityId: string) {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime || signerIndex >= runtime.signers.length) return;

    runtimesState.update(state => ({
      ...state,
      runtimes: {
        ...state.runtimes,
        [runtime.id]: {
          ...runtime,
          signers: runtime.signers.map((s, i) =>
            i === signerIndex ? { ...s, entityId } : s
          )
        }
      }
    }));

    this.saveToStorage();
  },

  // Delete runtime
  async deleteRuntime(runtimeId: string) {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    await cleanupRuntimeEnv(normalizedRuntimeId);

    let nextActiveId: string | null = null;
    runtimesState.update(state => {
      const { [normalizedRuntimeId]: removed, ...remaining } = state.runtimes;
      const remainingIds = Object.keys(remaining);
      nextActiveId = state.activeRuntimeId === normalizedRuntimeId
        ? (remainingIds[0] || null)
        : state.activeRuntimeId;

      return {
        runtimes: remaining,
        activeRuntimeId: nextActiveId
      };
    });

    runtimes.update(r => {
      const updated = new Map(r);
      updated.delete(normalizedRuntimeId);
      return updated;
    });

    activeRuntimeId.set(nextActiveId || '');
    this.saveToStorage();
    const current = get(runtimesState);
    this.syncRuntime(current.activeRuntimeId ? current.runtimes[current.activeRuntimeId] || null : null);
  },

  // Get private key for active signer
  getActiveSignerPrivateKey(): string | null {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return null;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime) return null;

    const signer = runtime.signers[runtime.activeSignerIndex];
    if (!signer) return null;
    return derivePrivateKey(runtime.seed, getSignerDerivationIndex(signer));
  },

  // Get private key for specific signer
  getSignerPrivateKey(signerIndex: number): string | null {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return null;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime || signerIndex >= runtime.signers.length) return null;

    return derivePrivateKey(runtime.seed, getSignerDerivationIndex(runtime.signers[signerIndex]));
  },

  // Check if runtime exists
  runtimeExists(id: string): boolean {
    const current = get(runtimesState);
    if (!current?.runtimes) return false;
    const normalized = normalizeRuntimeId(id);
    if (!normalized) return false;
    return normalized in current.runtimes;
  },

  // Initialize
  async initialize() {
    registerRuntimeResumeListener();
    if (initialized) return;
    if (initializePromise) return initializePromise;

    initializePromise = (async () => {
      this.loadFromStorage();
      const current = get(runtimesState);
      const all = Object.values(current.runtimes);
      let xln: XLNModule | null = null;

      if (all.length > 0) {
        xln = await getXLN();

        for (const runtime of all) {
          const runtimeId = normalizeRuntimeId(runtime.id);
          if (!runtimeId) continue;
          const existing = get(runtimes).get(runtimeId);
          if (existing?.env) {
            continue;
          }
          await registerRuntimeSignerKeys(runtime, xln);

          const env = await buildOrRestoreRuntimeEnv(runtime, xln, true);
          if (normalizeRuntimeId(env?.runtimeId || '') !== runtimeId) {
            throw new Error(
              `[VaultStore.initialize] Runtime isolation mismatch: slot=${runtimeId} env.runtimeId=${String(env?.runtimeId || 'none')}`
            );
          }
          runtimes.update(r => {
            const updated = new Map(r);
            updated.set(runtimeId, runtimeToEntry({ ...runtime, id: runtimeId }, env));
            return updated;
          });
          registerRuntimeEnvChange(runtimeId, env, xln);
        }
      }

      const latest = get(runtimesState);
      const allLatest = Object.values(latest.runtimes);
      const resolvedActive = findRuntimeByIdCaseInsensitive(latest.runtimes, latest.activeRuntimeId ?? undefined);
      const currentSelected = normalizeRuntimeId(get(activeRuntimeId) || '');
      const keepCurrentSelection = !!(currentSelected && latest.runtimes[currentSelected]);
      const activeId = keepCurrentSelection
        ? currentSelected
        : normalizeRuntimeId(resolvedActive?.key ?? allLatest[0]?.id ?? null);
      activeRuntimeId.set(activeId);
      const runtimeEntry = activeId ? get(runtimes).get(activeId) : null;
      const runtimeMeta = activeId ? latest.runtimes[activeId] : null;
      const runtimeToSync = runtimeMeta && runtimeEntry?.env
        ? { ...runtimeMeta, env: runtimeEntry.env }
        : runtimeMeta;
      if (activeId && runtimeToSync?.env && normalizeRuntimeId(runtimeToSync.env.runtimeId || '') !== activeId) {
        throw new Error(
          `[VaultStore.initialize] Active runtime env mismatch: active=${activeId} env.runtimeId=${String(runtimeToSync.env.runtimeId || 'none')}`
        );
      }
      if (runtimeToSync) {
        const activeXln = xln ?? await getXLN();
        await ensureRuntimePipelineAlive(runtimeToSync as Runtime, activeXln);
      }
      this.syncRuntime(runtimeToSync ?? null);
      initialized = true;
    })();

    try {
      await initializePromise;
    } finally {
      initializePromise = null;
    }
  },

  // Clear all runtimes
  async clearAll() {
    const runtimeIds = Array.from(get(runtimes).keys());
    await Promise.all(runtimeIds.map(id => cleanupRuntimeEnv(id)));

    runtimesState.set(defaultState);
    vaultStorageLoaded.set(true);
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(VAULT_STORAGE_KEY);
    }

    runtimes.set(new Map());
    activeRuntimeId.set('');
    this.syncRuntime(null);
  },

  // === MVP: Get XLN balance for active entity ===
  async getEntityBalance(tokenId: number = 1): Promise<bigint> {
    const signer = get(activeSigner);
    if (!signer?.entityId) return 0n;

    try {
      const xln = await getXLN();
      const env = unwrapLiveRuntimeEnv(get(xlnEnvironment));
      const jadapter = env ? xln.getEntityJAdapter(env, signer.entityId, signer.address) : null;
      if (!jadapter?.getReserves) return 0n;

      return await jadapter.getReserves(signer.entityId, tokenId);
    } catch (err) {
      console.error('[VaultStore] Failed to get balance:', err);
      return 0n;
    }
  },

  // === MVP: Send tokens to another entity ===
  async sendTokens(toEntityId: string, amount: bigint, tokenId: number = 1): Promise<{ success: boolean; error?: string }> {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return { success: false, error: 'No active runtime' };

    const runtime = current.runtimes[current.activeRuntimeId];
    const signer = runtime?.signers[runtime.activeSignerIndex];
    if (!signer?.entityId) return { success: false, error: 'No entity for signer' };

    try {
      const xln = await getXLN();
      if (!xln.queueEntityInput) return { success: false, error: 'XLN queueEntityInput unavailable' };
      const env = unwrapLiveRuntimeEnv(get(xlnEnvironment));
      if (!env) return { success: false, error: 'Runtime env unavailable' };

      await xln.queueEntityInput(env, signer.entityId, signer.address, {
        type: 'r2r',
        toEntityId,
        tokenId,
        amount,
      });
      return { success: true };
    } catch (err) {
      console.error('[VaultStore] Send failed:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Transfer failed' };
    }
  },

  // Get active entity ID
  getActiveEntityId(): string | null {
    const signer = get(activeSigner);
    return signer?.entityId || null;
  }
};

if (typeof window !== 'undefined') {
  const isLocalDev =
    import.meta.env.DEV ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';
  if (isLocalDev) {
    Object.defineProperty(window, '__xlnVaultOperations', {
      value: vaultOperations,
      configurable: true,
    });
  }
}
