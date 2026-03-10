import { writable, get, derived } from 'svelte/store';
import { HDNodeWallet, Mnemonic, getAddress } from 'ethers';
import type { Env, JurisdictionConfig, PersistedFrameJournal, RoutedEntityInput, RuntimeInput, XLNModule } from '@xln/runtime/xln-api';
import { runtimeOperations, runtimes, activeRuntimeId } from './runtimeStore';
import { xlnEnvironment, setXlnEnvironment } from './xlnStore';
import { settings } from './settingsStore';
import { writeSavedCollateralPolicy, writeHubJoinPreference } from '$lib/utils/onboardingPreferences';
import { writeOnboardingComplete } from '$lib/utils/onboardingState';

// Types
export interface Signer {
  index: number;
  address: string;
  name: string;
  entityId?: string; // Auto-created entity for this signer
}

export interface Runtime {
  id: string; // signer EOA (0xABCD...)
  label: string; // user-chosen name ("MyWallet")
  seed: string; // raw 12-word mnemonic
  devicePassphrase?: string; // optional BrainVault device passphrase (if available)
  signers: Signer[];
  activeSignerIndex: number;
  loginType?: 'manual' | 'demo';
  requiresOnboarding?: boolean;
  createdAt: number;
}

type CreateRuntimeOptions = {
  loginType?: 'manual' | 'demo';
  requiresOnboarding?: boolean;
  devicePassphrase?: string;
};

export interface RuntimesState {
  runtimes: Record<string, Runtime>;
  activeRuntimeId: string | null;
}

// BIP44 derivation path for Ethereum: m/44'/60'/0'/0/index
const ETH_PATH_PREFIX = "m/44'/60'/0'/0/";

// Default state
const defaultState: RuntimesState = {
  runtimes: {},
  activeRuntimeId: null
};

// Storage key
const VAULT_STORAGE_KEY = 'xln-vaults';
const BROWSER_GOSSIP_POLL_MS = 1000;
const DEBUG_GLOBAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);
const normalizeRuntimeId = (value: string | null | undefined): string => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return getAddress(raw).toLowerCase();
  } catch {
    return '';
  }
};

// Main store
export const runtimesState = writable<RuntimesState>(defaultState);

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

// Backward compatibility aliases
export const activeVault = activeRuntime;
export const allVaults = allRuntimes;

let initializePromise: Promise<void> | null = null;
let initialized = false;
let resumeListenerRegistered = false;
let resumeRefreshPromise: Promise<boolean> | null = null;
let runtimeSyncChannel: BroadcastChannel | null = null;
const runtimeEnvChangeUnsubscribers = new Map<string, () => void>();

type FrameLogEntry = Env['frameLogs'][number];
type HealthMachine = { name?: string; status?: string; chainId?: number; lastBlock?: unknown };
type HealthPayload = {
  timestamp?: number;
  reset?: { inProgress?: boolean; lastError?: unknown };
  system?: { runtime?: boolean } | null;
  jMachines?: HealthMachine[];
};
type JurisdictionsPayload = { jurisdictions: Record<string, JurisdictionConfig> };
type FaucetResult = { success?: boolean; txHash?: string; error?: string };
type RuntimeP2PHandle = {
  isConnected?: () => boolean;
  connect?: () => void;
  refreshGossip?: () => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const hasStartRuntimeLoop = (xln: XLNModule): xln is XLNModule & { startRuntimeLoop: (env: Env) => unknown } =>
  typeof Reflect.get(xln as object, 'startRuntimeLoop') === 'function';

const hasStartJEventWatcher = (xln: XLNModule): xln is XLNModule & { startJEventWatcher: (env: Env) => Promise<void> } =>
  typeof Reflect.get(xln as object, 'startJEventWatcher') === 'function';

const getRuntimeP2PHandle = (xln: XLNModule, env: Env): RuntimeP2PHandle | null => {
  const candidate = xln.getP2P(env);
  return isRecord(candidate) ? (candidate as RuntimeP2PHandle) : null;
};

const getReplayMeta = (env: Env): unknown | null => {
  const value = Reflect.get(env as object, '__replayMeta');
  return value === undefined ? null : value;
};

// HD derivation helper
function deriveAddress(seed: string, index: number): string {
  const mnemonic = Mnemonic.fromPhrase(seed);
  const hdNode = HDNodeWallet.fromMnemonic(mnemonic, ETH_PATH_PREFIX + index);
  return hdNode.address;
}

function derivePrivateKey(seed: string, index: number): string {
  const mnemonic = Mnemonic.fromPhrase(seed);
  const hdNode = HDNodeWallet.fromMnemonic(mnemonic, ETH_PATH_PREFIX + index);
  return hdNode.privateKey;
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
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`[VaultStore] Timeout waiting for condition: ${label}`);
}

const getRuntimeFatalDiagnostics = (env: Env): string => {
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
  const replica = env.jReplicas.get('Testnet');
  const jState = replica
    ? {
        name: replica.name ?? null,
        chainId: replica.chainId ?? null,
        depositoryAddress: replica.depositoryAddress ?? null,
        entityProviderAddress: replica.entityProviderAddress ?? null,
        hasAdapter: hasConnectedJurisdictionAdapter(replica),
      }
    : null;
  return JSON.stringify(
    {
      runtimeId: env.runtimeId ?? null,
      height: env.height ?? null,
      latestHeight: env.latestHeight ?? null,
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
): Promise<void> {
  xln.enqueueRuntimeInput(env, runtimeInput);
  await waitForCondition(ready, label, timeoutMs);
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

const resolveJurisdictionConfig = (jurisdictions: JurisdictionsPayload): JurisdictionConfig => {
  const map = jurisdictions.jurisdictions;
  const arrakis = map.arrakis;
  const first = arrakis ?? Object.values(map)[0];
  if (!first) {
    throw new Error('No jurisdictions found in /api/jurisdictions');
  }
  return first;
};

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
      const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '0.0.0.0';
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

const RPC_FATAL_STYLE = 'background:#3b0000;color:#ff4d4f;font-weight:800;padding:2px 6px;border-radius:4px;';

const logRpcFatal = (reason: string, details: Record<string, unknown>): void => {
  console.error('%c[RPC FAIL-FAST]', RPC_FATAL_STYLE, reason, details);
};

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

const waitForServerRuntimeReady = async (baseOrigin: string, timeoutMs = 30_000): Promise<void> => {
  const healthUrl = new URL('/api/health', baseOrigin).toString();
  const started = Date.now();
  let lastHealth: Record<string, unknown> | null = null;
  let lastStatus = 0;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(healthUrl);
      lastStatus = response.status;
      if (response.ok) {
        const payload = (await response.json().catch(() => ({}))) as HealthPayload;
        lastHealth = summarizeHealth(payload);
        const ready =
          typeof payload?.timestamp === 'number'
          && payload?.reset?.inProgress !== true
          && payload?.system?.runtime === true;
        if (ready) return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `SERVER_RUNTIME_NOT_READY: status=${lastStatus} health=${JSON.stringify(lastHealth ?? {})}`,
  );
};

const detectRpcChainId = async (rpcUrl: string, baseOrigin?: string): Promise<number> => {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), 5000) : null;
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_chainId',
        params: [],
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 300);
      let health: Record<string, unknown> | null = null;
      if (baseOrigin) {
        try {
          const healthRes = await fetch(new URL('/api/health', baseOrigin).toString());
          const healthPayload = healthRes.ok ? await healthRes.json().catch(() => ({})) : { status: healthRes.status };
          health = summarizeHealth(healthPayload);
        } catch {
          health = null;
        }
      }
      logRpcFatal('RPC_CHAINID_HTTP_ERROR', { rpcUrl, status: response.status, body, health });
      throw new Error(`RPC_CHAINID_HTTP_${response.status}:${body || 'empty'}`);
    }
    const payload = await response.json();
    const hex = typeof payload?.result === 'string' ? payload.result : '';
    if (!hex || !hex.startsWith('0x')) {
      logRpcFatal('RPC_CHAINID_MALFORMED_RESPONSE', { rpcUrl, payload });
      throw new Error(`RPC_CHAINID_MALFORMED_RESPONSE:${JSON.stringify(payload)}`);
    }
    const parsed = Number.parseInt(hex, 16);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      logRpcFatal('RPC_CHAINID_PARSE_FAILED', { rpcUrl, hex });
      throw new Error(`RPC_CHAINID_PARSE_FAILED:${hex}`);
    }
    return parsed;
  } catch (error) {
    logRpcFatal('RPC_CHAINID_REQUEST_FAILED', {
      rpcUrl,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const assertAnvilChain = (chainId: number, rpcUrl: string, context: string): void => {
  if (chainId !== 31337) {
    throw new Error(`[${context}] CHAIN_ID_MISMATCH: expected=31337 actual=${chainId} rpc=${rpcUrl}`);
  }
};

const fetchJurisdictions = async (baseOrigin?: string): Promise<JurisdictionsPayload> => {
  const primaryOrigin = baseOrigin ?? (typeof window !== 'undefined' ? window.location.origin : 'https://xln.finance');
  const configuredApiBase =
    typeof window !== 'undefined'
      ? (() => {
          const fromWindow = (window as typeof window & { __XLN_API_BASE_URL__?: string }).__XLN_API_BASE_URL__;
          if (typeof fromWindow === 'string' && fromWindow.trim().length > 0) return fromWindow.trim();
          try {
            const fromStorage = localStorage.getItem('xln-api-base-url');
            return typeof fromStorage === 'string' && fromStorage.trim().length > 0 ? fromStorage.trim() : null;
          } catch {
            return null;
          }
        })()
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
      console.log('[VaultStore] jurisdictions fetched:', JSON.stringify({
        url,
        finalUrl: resp.url,
        arrakis: payload?.jurisdictions?.arrakis?.contracts ?? null,
      }));
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
      console.log('[VaultStore] ✅ Funded wallet via faucet:', result.txHash);
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
    const runtimeEntry = get(runtimes).get(runtimeId);
    const env = runtimeEntry?.env;
    if (!env) return;

    const { getXLN } = await import('./xlnStore');
    const xln = await getXLN();

    // Stop WS/P2P first to avoid new inbound events while shutting down loop.
    xln.stopP2P(env);

    // Stop async runtime loop if active.
    env.runtimeState?.stopLoop?.();
    if (env.runtimeState) {
      env.runtimeState.loopActive = false;
      env.runtimeState.stopLoop = null;
    }

    try {
      await xln.clearDB(env);
      console.log(`[VaultStore] 🗑️ Database cleared for runtime ${runtimeId.slice(0, 12)}`);
    } catch (dbErr) {
      console.warn('[VaultStore] DB clear failed:', dbErr);
    }
  } catch (err) {
    console.warn(`[VaultStore] Failed to cleanup runtime ${runtimeId.slice(0, 12)}:`, err);
  }
}

async function stopRuntimeEnv(env: Env): Promise<void> {
  const { getXLN } = await import('./xlnStore');
  const xln = await getXLN();

  if (xln.stopP2P) {
    xln.stopP2P(env);
  }

  env.runtimeState?.stopLoop?.();
  if (env.runtimeState) {
    env.runtimeState.loopActive = false;
    env.runtimeState.stopLoop = null;
  }
}

function unregisterRuntimeEnvChange(runtimeId: string): void {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  if (!normalizedRuntimeId) return;
  const unsubscribe = runtimeEnvChangeUnsubscribers.get(normalizedRuntimeId);
  if (!unsubscribe) return;
  runtimeEnvChangeUnsubscribers.delete(normalizedRuntimeId);
  unsubscribe();
}

function registerRuntimeEnvChange(
  runtimeId: string,
  env: Env,
  xln: { registerEnvChangeCallback?: (env: Env, callback: (env: Env) => void) => (() => void) },
): void {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId || env.runtimeId);
  if (!normalizedRuntimeId) {
    throw new Error('[VaultStore] Cannot register env change callback without runtimeId');
  }
  unregisterRuntimeEnvChange(normalizedRuntimeId);
  if (typeof xln.registerEnvChangeCallback !== 'function') return;

  const onEnvChange = (nextEnv: Env): void => {
    runtimeOperations.updateRuntimeEnv(normalizedRuntimeId, nextEnv);
    if (normalizeRuntimeId(get(activeRuntimeId) || '') === normalizedRuntimeId) {
      setXlnEnvironment(nextEnv);
    }
  };

  runtimeEnvChangeUnsubscribers.set(
    normalizedRuntimeId,
    xln.registerEnvChangeCallback(env, onEnvChange),
  );
  onEnvChange(env);
}

function runtimeToEntry(runtime: Runtime, env: Env) {
  const runtimeId = normalizeRuntimeId(runtime.id);
  if (!runtimeId) {
    throw new Error(`[VaultStore] Invalid runtime.id: ${String(runtime.id)}`);
  }
  return {
    id: runtimeId,
    type: 'local' as const,
    label: runtime.label,
    env,
    seed: runtime.seed,
    vaultId: runtimeId,
    permissions: 'write' as const,
    status: 'connected' as const,
  };
}

async function registerRuntimeSignerKeys(runtime: Runtime, xln: XLNModule): Promise<void> {
  for (const signer of runtime.signers) {
    const privateKey = derivePrivateKey(runtime.seed, signer.index);
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

function ensureRuntimeLoopRunning(env: Env, xln: XLNModule, reason: string): void {
  if (!hasStartRuntimeLoop(xln)) return;
  if (env.runtimeState?.loopActive) return;
  xln.startRuntimeLoop(env);
  console.log(`[VaultStore] ♻️ Runtime loop started for ${reason}`);
}

async function buildOrRestoreRuntimeEnv(runtime: Runtime, xln: XLNModule, strictRestore = false): Promise<Env> {
  const runtimeIdLower = normalizeRuntimeId(runtime.id);
  if (!runtimeIdLower) {
    throw new Error(`[VaultStore] Invalid runtime.id for env restore: ${String(runtime.id)}`);
  }
  console.log('[VaultStore] 🔎 buildOrRestoreRuntimeEnv called for:', runtimeIdLower?.slice(0, 12), new Error('stack').stack?.split('\n').slice(1, 5).join(' ← '));
  const runtimeSeed = runtime.seed;
  let env: Env | null = null;

  try {
    if (xln.loadEnvFromDB) {
      console.log('[VaultStore] Loading env from DB namespace:', runtimeIdLower);
      env = await xln.loadEnvFromDB(runtimeIdLower, runtimeSeed);
    }
  } catch (error) {
    if (strictRestore) {
      throw new Error(`[VaultStore] Strict restore failed for ${runtime.id.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.warn('[VaultStore] ⚠️ Failed to load env from DB, falling back to fresh import:', error);
    env = null;
  }

  if (!env && strictRestore) {
    throw new Error(`[VaultStore] Strict restore failed for ${runtime.id.slice(0, 12)}: persisted env missing`);
  }

  if (env && (!env.jReplicas || env.jReplicas.size === 0)) {
    if (strictRestore) {
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

  if (env && strictRestore) {
    for (const signer of runtime.signers || []) {
      if (!signer?.entityId) continue;
      if (!hasEntityReplica(signer.entityId)) {
        throw new Error(
          `[VaultStore] Strict restore failed for ${runtime.id.slice(0, 12)}: missing restored entity ${signer.entityId.slice(0, 12)}`
        );
      }
    }
  }

  const baseOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://xln.finance';
  await waitForServerRuntimeReady(baseOrigin);
  const jurisdictions = await fetchJurisdictions(baseOrigin);
  const arrakisConfig = resolveJurisdictionConfig(jurisdictions);
  const rpcUrl = resolveRpcUrl(arrakisConfig.rpc, baseOrigin);
  let chainId: number;
  try {
    chainId = await detectRpcChainId(rpcUrl, baseOrigin);
    assertAnvilChain(chainId, rpcUrl, 'VaultStore.restore');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logRpcFatal('VAULT_RPC_CHAIN_VALIDATION_FAILED', { context: 'restore', rpcUrl, message });
    env?.error?.(
      'network',
      'VAULT_RPC_CHAIN_VALIDATION_FAILED',
      { rpcUrl, message },
      env?.runtimeId,
    );
    throw error;
  }

  if (!env) {
    env = xln.createEmptyEnv(runtimeSeed);
    applyRuntimeLogPreference(env);
    env.runtimeId = runtimeIdLower;
    env.dbNamespace = runtimeIdLower;
    ensureRuntimeLoopRunning(env, xln, `fresh-env:${runtimeIdLower.slice(0, 12)}`);

    console.log('[VaultStore] Importing testnet anvil...');
    await enqueueAndAwait(
      xln,
      env,
      {
        runtimeTxs: [{
          type: 'importJ',
          data: {
            name: 'Testnet',
            chainId,
            ticker: 'USDC',
            rpcs: [rpcUrl],
            contracts: arrakisConfig.contracts,
          }
        }],
        entityInputs: []
      },
      () => hasConnectedJurisdictionAdapter(env?.jReplicas?.get?.('Testnet')),
      'importJ(Testnet)',
      45_000,
    );
    await waitForCondition(
      () => hasRuntimeJurisdictionAddresses(env?.jReplicas?.get?.('Testnet')),
      'importJ(Testnet).addresses',
      45_000,
    );
    console.log('[VaultStore] ✅ Testnet imported');
  } else {
    applyRuntimeLogPreference(env);
    env.runtimeSeed = runtimeSeed;
    env.runtimeId = runtimeIdLower;
    env.dbNamespace = runtimeIdLower;
    let restoredAccounts = 0;
    for (const [, replica] of (env.eReplicas ?? new Map()).entries()) {
      restoredAccounts += Number(replica?.state?.accounts?.size || 0);
    }
    console.log('[VaultStore] ✅ Env restored from DB:', JSON.stringify({
      runtimeId: runtime.id.slice(0, 12),
      height: env.height,
      history: env.history?.length || 0,
      jReplicas: env.jReplicas?.size || 0,
      entities: env.eReplicas?.size || 0,
      accounts: restoredAccounts,
      replayMeta: getReplayMeta(env),
    }));
  }

  if (!hasLiveJAdapter(env)) {
    ensureRuntimeLoopRunning(env, xln, `repair-import-j:${runtimeIdLower.slice(0, 12)}`);
    console.warn('[VaultStore] ⚠️ Restored env has no live J-adapter; re-importing Testnet jurisdiction');
    await enqueueAndAwait(
      xln,
      env,
      {
        runtimeTxs: [{
          type: 'importJ',
          data: {
            name: 'Testnet',
            chainId,
            ticker: 'USDC',
            rpcs: [rpcUrl],
            contracts: arrakisConfig.contracts,
          }
        }],
        entityInputs: []
      },
      () => hasConnectedJurisdictionAdapter(env?.jReplicas?.get?.('Testnet')),
      'repairImportJ(Testnet)',
      45_000,
    );
    await waitForCondition(
      () => hasRuntimeJurisdictionAddresses(env?.jReplicas?.get?.('Testnet')),
      'repairImportJ(Testnet).addresses',
      45_000,
    );
    console.log('[VaultStore] ✅ Testnet repaired');
  }

  ensureRuntimeLoopRunning(env, xln, `post-restore:${runtimeIdLower.slice(0, 12)}`);

  if (hasStartJEventWatcher(xln)) {
    await xln.startJEventWatcher(env);
  }

  if (runtime.signers[0]?.entityId) {
    const entityId = runtime.signers[0].entityId;
    const signerAddress = runtime.signers[0].address;
    const entityIdNorm = String(entityId).toLowerCase();
    const hasEntityAlready = !!(
      env.eReplicas &&
      [...env.eReplicas.keys()].some((k: string) => String(k).split(':')[0]?.toLowerCase() === entityIdNorm)
    );
    if (hasEntityAlready) {
      console.log('[VaultStore] ✅ Entity already present in restored env:', entityId.slice(0, 18));
    }
    const jReplica = env.jReplicas?.get('Testnet');
    if (jReplica && !hasEntityAlready) {
      if (strictRestore) {
        throw new Error(
          `[VaultStore] Strict restore failed for ${runtime.id.slice(0, 12)}: entity missing after restore ${entityId.slice(0, 12)}`
        );
      }
      const entityConfig = {
        mode: 'proposer-based' as const,
        threshold: 1n,
        validators: [signerAddress],
        shares: { [signerAddress]: 1n },
        jurisdiction: {
          address: jReplica.depositoryAddress,
          name: 'Testnet',
          chainId: Number(jReplica.chainId ?? chainId ?? 31337),
          entityProviderAddress: jReplica.entityProviderAddress,
          depositoryAddress: jReplica.depositoryAddress,
        }
      };

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
              profileName: runtime.name,
            }
          }],
          entityInputs: []
        },
        () => {
          const reps = env?.eReplicas;
          if (!reps?.keys) return false;
          const entityIdNorm = String(entityId).toLowerCase();
          for (const key of reps.keys()) {
            const [repEntityId] = String(key).split(':');
            if (String(repEntityId || '').toLowerCase() === entityIdNorm) return true;
          }
          return false;
        },
        `importReplica(${entityId.slice(0, 12)})`,
      );
      console.log('[VaultStore] ✅ Entity ensured:', entityId.slice(0, 18));
    }
  }

  if (xln.startP2P) {
    const { resolveRelayUrls } = await import('./xlnStore');
    xln.startP2P(env, {
      relayUrls: resolveRelayUrls(),
      gossipPollMs: BROWSER_GOSSIP_POLL_MS,
    });
  }

  return env;
}

function registerRuntimeResumeListener(): void {
  if (resumeListenerRegistered || typeof window === 'undefined' || typeof document === 'undefined') return;
  const triggerRefresh = () => {
    if (document.visibilityState !== 'visible') return;
    void vaultOperations.refreshActiveRuntimeFromDbIfBehind().catch((error) => {
      console.warn('[VaultStore] Resume refresh failed:', error);
    });
  };
  document.addEventListener('visibilitychange', triggerRefresh);
  window.addEventListener('focus', triggerRefresh);
  if (typeof BroadcastChannel !== 'undefined') {
    runtimeSyncChannel = new BroadcastChannel('xln-runtime-sync');
    runtimeSyncChannel.onmessage = (event: MessageEvent<{ runtimeId?: string; height?: number }>) => {
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

  // Runtime operations
export const vaultOperations = {
  async refreshActiveRuntimeFromDbIfBehind(): Promise<boolean> {
    if (resumeRefreshPromise) return resumeRefreshPromise;
    resumeRefreshPromise = (async () => {
      const currentState = get(runtimesState);
      const runtimeId = normalizeRuntimeId(currentState.activeRuntimeId);
      if (!runtimeId) return false;

      const runtime = currentState.runtimes[runtimeId];
      const runtimeEntry = get(runtimes).get(runtimeId);
      const env = runtimeEntry?.env as Env | undefined;
      if (!runtime || !env) return false;

      const { getXLN } = await import('./xlnStore');
      const xln = await getXLN();
      if (typeof xln.getPersistedLatestHeight !== 'function') return false;

      const persistedLatestHeight = Number(await xln.getPersistedLatestHeight(env) || 0);
      const currentHeight = Number(env.height || 0);
      if (persistedLatestHeight <= currentHeight) return false;

      console.log(
        `[VaultStore] ♻️ Refreshing runtime ${runtimeId.slice(0, 12)} from DB ` +
        `(persisted=${persistedLatestHeight}, current=${currentHeight})`,
      );

      await registerRuntimeSignerKeys(runtime, xln);
      const refreshedEnv = await buildOrRestoreRuntimeEnv(runtime, xln, true);
      unregisterRuntimeEnvChange(runtimeId);
      await stopRuntimeEnv(env);

      runtimes.update((currentRuntimes) => {
        currentRuntimes.set(runtimeId, runtimeToEntry(runtime, refreshedEnv));
        return currentRuntimes;
      });
      registerRuntimeEnvChange(runtimeId, refreshedEnv, xln);

      if (normalizeRuntimeId(get(activeRuntimeId) || '') === runtimeId) {
        setXlnEnvironment(refreshedEnv);
      }

      return true;
    })();

    try {
      return await resumeRefreshPromise;
    } finally {
      resumeRefreshPromise = null;
    }
  },

  async enqueueRuntimeInput(env: Env, input: RuntimeInput): Promise<Env> {
    const { enqueueAndProcess } = await import('./xlnStore');
    return enqueueAndProcess(env, input);
  },

  async enqueueEntityInputs(env: Env, inputs: RoutedEntityInput[]): Promise<Env> {
    const { enqueueEntityInputs } = await import('./xlnStore');
    return enqueueEntityInputs(env, inputs);
  },

  async getPersistedLatestHeight(env: Env): Promise<number> {
    const { getXLN } = await import('./xlnStore');
    const xln = await getXLN();
    return xln.getPersistedLatestHeight(env);
  },

  async readPersistedFrameJournal(env: Env, height: number): Promise<PersistedFrameJournal | null> {
    const { getXLN } = await import('./xlnStore');
    const xln = await getXLN();
    return xln.readPersistedFrameJournal(env, height);
  },

  syncRuntime(runtime: Runtime | null) {
    const meta: { label?: string; seed?: string; vaultId?: string } = {};
    meta.label = runtime?.label || 'Runtime';
    if (runtime?.seed) meta.seed = runtime.seed;
    if (runtime?.id) meta.vaultId = runtime.id;

    runtimeOperations.setLocalRuntimeMetadata(meta);
    if (runtime?.env) {
      setXlnEnvironment(runtime.env);
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
        console.log('🔐 Runtimes loaded from localStorage');
      }
    } catch (error) {
      console.error('❌ Failed to load runtimes (clearing corrupted storage):', error);
      localStorage.removeItem(VAULT_STORAGE_KEY);
      runtimesState.set(defaultState);
    }
  },

  // Save to localStorage
  saveToStorage() {
    try {
      if (typeof localStorage === 'undefined') return;

      const current = get(runtimesState);
      localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(current));
      console.log('💾 Runtimes saved to localStorage');
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
      console.log(`[VaultStore.createRuntime][timing] status=${status} total=${totalMs}ms ${parts.join(' | ')}`);
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
    console.log('[VaultStore.createRuntime] Creating isolated runtime:', runtimeId);

    // Import XLN and create env BEFORE returning
    const { getXLN } = await import('./xlnStore');
    const xln = await getXLN();
    markPerf('load_xln_runtime');
    const newEnv = xln.createEmptyEnv(seed);
    applyRuntimeLogPreference(newEnv);
    const runtimeIdLower = runtimeId.toLowerCase();
    newEnv.runtimeId = runtimeIdLower;
    newEnv.dbNamespace = runtimeIdLower;

    // REMOVED: setRuntimeSeed() - seed now stored in env.runtimeSeed and passed to pure functions
    console.log('[VaultStore.createRuntime] Runtime seed stored in env.runtimeSeed (pure)');
    // All crypto functions now read from env.runtimeSeed, not global state

    // Fetch pre-deployed contract addresses from prod
    console.log('[VaultStore.createRuntime] Fetching /api/jurisdictions...');
    const baseOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://xln.finance';
    await waitForServerRuntimeReady(baseOrigin);
    markPerf('wait_server_runtime_ready');
    const jurisdictions = await fetchJurisdictions(baseOrigin);
    markPerf('fetch_jurisdictions');
    const arrakisConfig = resolveJurisdictionConfig(jurisdictions);
    console.log('[VaultStore.createRuntime] Loaded contracts:', arrakisConfig.contracts);
    const rpcUrl = resolveRpcUrl(arrakisConfig.rpc, baseOrigin);
    let chainId: number;
    try {
      chainId = await detectRpcChainId(rpcUrl, baseOrigin);
      markPerf('detect_rpc_chain_id');
      assertAnvilChain(chainId, rpcUrl, 'VaultStore.createRuntime');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logRpcFatal('VAULT_RPC_CHAIN_VALIDATION_FAILED', { context: 'createRuntime', rpcUrl, message });
      newEnv.error?.(
        'network',
        'VAULT_RPC_CHAIN_VALIDATION_FAILED',
        { rpcUrl, message },
        newEnv.runtimeId,
      );
      throw error;
    }

    // Import testnet J-machine (shared anvil on xln.finance)
    console.log('[VaultStore.createRuntime] Importing testnet anvil...');
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
            name: 'Testnet',
            chainId,
            ticker: 'USDC',
            rpcs: [rpcUrl],
            contracts: arrakisConfig.contracts, // Use pre-deployed addresses
          }
        }],
        entityInputs: []
      },
      () => {
        const replica = newEnv?.jReplicas?.get?.('Testnet');
        if (hasConnectedJurisdictionAdapter(replica)) return true;
        if (newEnv?.runtimeState?.loopActive === false) {
          throw new Error(`createRuntime.importJ(Testnet) failed: runtime loop halted\n${getRuntimeFatalDiagnostics(newEnv)}`);
        }
        return false;
      },
      'createRuntime.importJ(Testnet)',
      45_000,
    );
    await waitForCondition(
      () => hasRuntimeJurisdictionAddresses(newEnv?.jReplicas?.get?.('Testnet')),
      'createRuntime.importJ(Testnet).addresses',
      45_000,
    );
    markPerf('import_j_testnet');
    if (hasStartJEventWatcher(xln)) {
      await xln.startJEventWatcher(newEnv);
    }
    markPerf('start_j_event_watcher');
    console.log('[VaultStore.createRuntime] ✅ Testnet imported');

    // === MVP: Create entity ===
    console.log('[VaultStore.createRuntime] Creating user entity...');
    const { generateLazyEntityId } = await import('@xln/runtime/entity-factory');

    // Create entity config (single-signer, threshold 1)
    const signerAddress = firstAddress;

    // Get contract addresses from imported J-machine
    const jReplica = newEnv.jReplicas?.get('Testnet');
    if (!jReplica) {
      throw new Error('Testnet J-machine not found after import');
    }
    const depositoryAddress = jReplica.depositoryAddress;
    const entityProviderAddress = jReplica.entityProviderAddress;

    // Generate entityId using canonical lazy entity ID (sorted validators, consistent encoding)
    // This ensures same signer → same entityId regardless of where it's generated
    // For lazy entities: entityId == boardHash (as per EntityProvider contract)
    //
    // TODO(provider-scoped-entities): Current format is entityId = boardHash (local to EP)
    // Future format: entityAddress = hash(providerAddress + entityId)
    // Why: Same boardHash on different EntityProviders should be different global addresses
    //      (like user@google vs user@github in OAuth)
    // When: Needed for multi-jurisdiction routing and cross-EP entity references
    // Impact on Hanko:
    //   - Current: 65-byte short hanko (signature only) - sufficient for self-entities
    //   - Future: Extended hanko = sig(65) + entityId(32) + providerAddress(20) = 117 bytes
    //   - Verifier reconstructs entityAddress from hanko fields
    // EP Generalization:
    //   - Current: Single EP per Depository (rigid but simple)
    //   - Future: Multiple EPs can authenticate/dispute in same Depository
    //   - Cross-EP entity references for federated trust
    const entityId = generateLazyEntityId([signerAddress], 1n);
    console.log('[VaultStore.createRuntime] Entity ID:', entityId.slice(0, 18) + '...');
    console.log('[VaultStore.createRuntime]   signer:', signerAddress);
    console.log('[VaultStore.createRuntime]   provider:', entityProviderAddress);

    const entityConfig = {
      mode: 'proposer-based' as const,
      threshold: 1n,
      validators: [signerAddress],
      shares: { [signerAddress]: 1n },
      jurisdiction: {
        address: depositoryAddress,
        name: 'Testnet',
        chainId: Number(jReplica.chainId ?? chainId ?? 31337),
        entityProviderAddress: entityProviderAddress,
        depositoryAddress: depositoryAddress,
      }
    };

    // CRITICAL: Register HD-derived private key with runtime BEFORE importing entity
    // Why: Runtime's deriveSignerKeySync uses different derivation than BIP44 HD
    // The vault uses BIP44 (m/44'/60'/0'/0/index), runtime uses keccak256(seed+signerId)
    // Without this, hanko verification fails (signature from wrong key)
    const signerPrivateKey = derivePrivateKey(seed, 0);
    const privateKeyBytes = new Uint8Array(
      signerPrivateKey.slice(2).match(/.{2}/g)!.map(byte => parseInt(byte, 16))
    );
    xln.registerSignerKey(signerAddress, privateKeyBytes);
    markPerf('register_signer_key');
    console.log('[VaultStore.createRuntime] ✅ Registered HD-derived private key for signer');

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

    // Skip auto-funding (use faucet API)
    console.log('[VaultStore.createRuntime] ✅ Entity ready (use /api/faucet to fund)');

    // Store entityId in signer
    runtime.signers[0]!.entityId = entityId;
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
    runtimesState.update(state => ({
      ...state,
      runtimes: { ...state.runtimes, [id]: runtime }
    }));
    this.saveToStorage();
    markPerf('save_runtime_metadata');

    // Add to runtimes store
    runtimes.update(r => {
      r.set(runtimeId, {
        id: runtimeId,
        type: 'local',
        label: label,
        env: newEnv,
        seed: runtime.seed,
        vaultId: id,
        permissions: 'write',
        status: 'connected'
      });
      return r;
    });
    registerRuntimeEnvChange(runtimeId, newEnv, xln);
    markPerf('attach_runtime_to_store');

    // Start P2P for this runtime's env (one WS per runtime, stays alive across switches)
    if (xln.startP2P) {
      const { resolveRelayUrls } = await import('./xlnStore');
      const relayUrls = resolveRelayUrls();
      console.log(`[VaultStore.createRuntime] P2P: Starting on env runtimeId=${newEnv.runtimeId?.slice(0,12)}, relay=${relayUrls[0]}`);
      xln.startP2P(newEnv, {
        relayUrls,
        gossipPollMs: BROWSER_GOSSIP_POLL_MS,
      });
    }
    markPerf('start_p2p');

    // Switch to new runtime
    activeRuntimeId.set(runtimeId);
    markPerf('activate_runtime');
    console.log('[VaultStore.createRuntime] ✅ Runtime created with entity:', entityId.slice(0, 18));

    // Sync metadata (no P2P — already started above)
    this.syncRuntime(runtime);
    markPerf('sync_runtime');
    flushPerf('ok');

    return runtime;
  },

  // Alias for backward compatibility
  async createVault(name: string, seed: string): Promise<Runtime> {
    return this.createRuntime(name, seed);
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
      const { getXLN } = await import('./xlnStore');
      const { resolveRelayUrls } = await import('./xlnStore');
      const xln = await getXLN();

      for (const signer of runtime.signers) {
        const privateKey = derivePrivateKey(runtime.seed, signer.index);
        const privateKeyBytes = new Uint8Array(
          privateKey.slice(2).match(/.{2}/g)!.map(byte => parseInt(byte, 16))
        );
        xln.registerSignerKey(signer.address, privateKeyBytes);
      }
      console.log(`[VaultStore.selectRuntime] ✅ Registered ${runtime.signers.length} signer keys`);

      // Ensure selected runtime processing pipeline is alive.
      // We do NOT blindly recreate P2P; we only recover if missing/disconnected.
      const runtimeEntry = get(runtimes).get(resolvedRuntimeId);
      let env = runtimeEntry?.env;
      if (!env) {
        await registerRuntimeSignerKeys(runtime, xln);
        env = await buildOrRestoreRuntimeEnv(runtime, xln, true);
        runtimes.update(r => {
          r.set(resolvedRuntimeId, runtimeToEntry(runtime, env));
          return r;
        });
        registerRuntimeEnvChange(resolvedRuntimeId, env, xln);
      }
      if (env) {
        registerRuntimeEnvChange(resolvedRuntimeId, env, xln);
        const envRuntimeId = normalizeRuntimeId(env.runtimeId || '');
        if (envRuntimeId !== resolvedRuntimeId) {
          throw new Error(
            `[VaultStore.selectRuntime] Runtime isolation mismatch: selected=${resolvedRuntimeId} env.runtimeId=${String(env.runtimeId || 'none')}`
          );
        }
        if (!env.runtimeState?.loopActive && xln.startRuntimeLoop) {
          xln.startRuntimeLoop(env);
          console.log(`[VaultStore.selectRuntime] ♻️ Restarted runtime loop for ${resolvedRuntimeId.slice(0, 12)}`);
        }

        let p2p = getRuntimeP2PHandle(xln, env);
        if (!p2p) {
          xln.startP2P(env, {
            relayUrls: resolveRelayUrls(),
            gossipPollMs: BROWSER_GOSSIP_POLL_MS,
          });
          p2p = getRuntimeP2PHandle(xln, env);
          console.log(`[VaultStore.selectRuntime] ♻️ Started P2P for ${resolvedRuntimeId.slice(0, 12)}`);
        } else if (p2p && typeof p2p.isConnected === 'function' && !p2p.isConnected()) {
          if (typeof p2p.connect === 'function') {
            p2p.connect();
            console.log(`[VaultStore.selectRuntime] ♻️ Reconnected P2P for ${resolvedRuntimeId.slice(0, 12)}`);
          }
        }

        if (p2p && typeof p2p.refreshGossip === 'function') {
          p2p.refreshGossip();
        }
      }
    }

    activeRuntimeId.set(resolvedRuntimeId);
    if (runtime?.env) {
      setXlnEnvironment(runtime.env);
    }
    this.syncRuntime(runtime || null);
  },

  // Alias for backward compatibility
  async selectVault(vaultId: string) {
    await this.selectRuntime(vaultId);
  },

  // Add signer to active runtime
  addSigner(name?: string): Signer | null {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return null;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime) return null;

    const nextIndex = runtime.signers.length;
    const address = deriveAddress(runtime.seed, nextIndex);

    const newSigner: Signer = {
      index: nextIndex,
      address,
      name: name || `Signer ${nextIndex + 1}`
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
    import('./xlnStore').then(async ({ getXLN }) => {
      const xln = await getXLN();
      const privateKey = derivePrivateKey(runtime.seed, nextIndex);
      const privateKeyBytes = new Uint8Array(
        privateKey.slice(2).match(/.{2}/g)!.map(byte => parseInt(byte, 16))
      );
      xln.registerSignerKey(address, privateKeyBytes);
      console.log(`[VaultStore] ✅ Registered HD key for signer ${address.slice(0, 10)}`);

      // Now create entity (key is registered, signing will work)
      const { autoCreateEntityForSigner } = await import('../utils/entityFactory');
      const entityId = await autoCreateEntityForSigner(address);
      if (entityId) {
        this.setSignerEntity(nextIndex, entityId);
        console.log(`[VaultStore] ✅ Entity created for signer ${address.slice(0, 10)}`);
      }
    }).catch(err => {
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
      r.delete(normalizedRuntimeId);
      return r;
    });

    activeRuntimeId.set(nextActiveId || '');
    this.saveToStorage();
    const current = get(runtimesState);
    this.syncRuntime(current.activeRuntimeId ? current.runtimes[current.activeRuntimeId] || null : null);
  },

  // Alias for backward compatibility
  async deleteVault(vaultId: string) {
    await this.deleteRuntime(vaultId);
  },

  // Get private key for active signer
  getActiveSignerPrivateKey(): string | null {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return null;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime) return null;

    return derivePrivateKey(runtime.seed, runtime.activeSignerIndex);
  },

  // Get private key for specific signer
  getSignerPrivateKey(signerIndex: number): string | null {
    const current = get(runtimesState);
    if (!current.activeRuntimeId) return null;

    const runtime = current.runtimes[current.activeRuntimeId];
    if (!runtime || signerIndex >= runtime.signers.length) return null;

    return derivePrivateKey(runtime.seed, signerIndex);
  },

  // Check if runtime exists
  runtimeExists(id: string): boolean {
    const current = get(runtimesState);
    if (!current?.runtimes) return false;
    const normalized = normalizeRuntimeId(id);
    if (!normalized) return false;
    return normalized in current.runtimes;
  },

  // Alias for backward compatibility
  vaultExists(id: string): boolean {
    return this.runtimeExists(id);
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

      if (all.length > 0) {
        const { getXLN } = await import('./xlnStore');
        const xln = await getXLN();

        for (const runtime of all) {
          const runtimeId = normalizeRuntimeId(runtime.id);
          if (!runtimeId) continue;
          const existing = get(runtimes).get(runtimeId);
          if (existing?.env) {
            continue;
          }

          console.log('[VaultStore.initialize] Restoring runtime:', runtimeId);
          await registerRuntimeSignerKeys(runtime, xln);
          console.log(`[VaultStore.initialize] ✅ Registered ${runtime.signers.length} HD-derived keys for ${runtimeId.slice(0, 12)}`);

          const env = await buildOrRestoreRuntimeEnv(runtime, xln, true);
          if (normalizeRuntimeId(env?.runtimeId || '') !== runtimeId) {
            throw new Error(
              `[VaultStore.initialize] Runtime isolation mismatch: slot=${runtimeId} env.runtimeId=${String(env?.runtimeId || 'none')}`
            );
          }
          runtimes.update(r => {
            r.set(runtimeId, runtimeToEntry({ ...runtime, id: runtimeId }, env));
            return r;
          });
          registerRuntimeEnvChange(runtimeId, env, xln);
          console.log('[VaultStore.initialize] ✅ Runtime restored:', runtimeId.slice(0, 12));
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
      const runtimeToSync = activeId ? latest.runtimes[activeId] : null;
      if (activeId && runtimeToSync?.env && normalizeRuntimeId(runtimeToSync.env.runtimeId || '') !== activeId) {
        throw new Error(
          `[VaultStore.initialize] Active runtime env mismatch: active=${activeId} env.runtimeId=${String(runtimeToSync.env.runtimeId || 'none')}`
        );
      }
      this.syncRuntime(runtimeToSync);
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
      const { getXLN } = await import('./xlnStore');
      const xln = await getXLN();
      const env = get(xlnEnvironment);
      const jadapter = xln.getActiveJAdapter?.(env);
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
      const { getXLN } = await import('./xlnStore');
      const xln = await getXLN();
      const env = get(xlnEnvironment);
      const jadapter = xln.getActiveJAdapter?.(env);
      if (!jadapter?.reserveToReserve) return { success: false, error: 'J-adapter not available' };

      // Execute reserve_to_reserve transfer
      await jadapter.reserveToReserve(signer.entityId, toEntityId, tokenId, amount);

      // Process queued J-events to update runtime state
      if (xln.processJBlockEvents) {
        await xln.processJBlockEvents(env);
      }

      console.log(`[VaultStore] ✅ Sent ${amount} to ${toEntityId.slice(0, 12)}...`);
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

// Localhost-only debug surface for legacy E2E helpers during migration off globals.
if (typeof window !== 'undefined' && DEBUG_GLOBAL_HOSTS.has(window.location.hostname)) {
  const debugWindow = window as Window & typeof globalThis & {
    vaultOperations?: typeof vaultOperations;
    runtimesState?: typeof runtimesState;
  };
  debugWindow.vaultOperations = vaultOperations;
  debugWindow.runtimesState = runtimesState;
}
