/**
 * Shared scenario boot utilities
 * Single entry point for all scenarios — configurable backend (browservm | rpc)
 */

import type { RuntimeReplica } from '../runtime/types';
import type { JurisdictionConfig } from '../entity/types';
import type { JReplica, JTx } from '../types/jurisdiction-runtime';
import type { JAdapter, JAdapterMode } from '../jurisdiction/adapter/types';
import { ethers } from 'ethers';
import { createXlnJsonRpcProvider } from '../jurisdiction/adapter';
import { getSignerPrivateKey, registerSignerKey } from '../account/crypto';
import { isLoopbackUrl } from '../network/p2p/loopback-url';
import { commitRuntimeInput, ensureSignerKeysFromSeed, requireRuntimeSeed, processJEvents, converge, setScenarioStorageEnabled } from './helpers';
import { getCertifiedBoardStackKey } from '../jurisdiction/machine/board-registry';
import { registrationEvidenceKey } from '../jurisdiction/machine/registration-evidence';
import {
  attachLiveJAdapter,
  getLiveJAdapter,
  getLiveJAdapterEntries,
} from '../runtime/live-jadapters';

export type { JAdapterMode };

export const SCENARIO_JADAPTER_MISSING = 'SCENARIO_JADAPTER_MISSING';

export const isScenarioJAdapterMissingError = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith(`${SCENARIO_JADAPTER_MISSING}:`);

const IS_BROWSER_RUNTIME = typeof window !== 'undefined' && typeof document !== 'undefined';
const IS_NODE_RUNTIME = !IS_BROWSER_RUNTIME;

const getDefaultAnvilRpcUrl = (): string => {
  if (!IS_BROWSER_RUNTIME) return 'http://localhost:8545';
  return new URL('/rpc', window.location.origin).toString();
};

/**
 * The endpoint a scenario must record as its jurisdiction `address`. Storage
 * validation requires a non-empty string, so a scenario that hand-rolls this
 * and leaves it blank cannot commit its very first frame.
 */
export const resolveScenarioJurisdictionAddress = (mode: JAdapterMode): string =>
  mode === 'browservm'
    ? 'browservm://'
    : (process.env['ANVIL_RPC'] || getDefaultAnvilRpcUrl());

type ManagedAnvilProcess = {
  exitCode: number | null;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  unref?: () => void;
  once?: (event: 'exit' | 'error', listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (event: 'exit' | 'error', listener: (...args: unknown[]) => void) => unknown;
};

// Keyed by RPC url, not a single slot. A cross-jurisdiction scenario runs two
// stacks in one process, and the old single-slot form stopped the first anvil
// the moment the second was requested — the source chain then died mid-run with
// ECONNREFUSED.
const managedAnvils = new Map<string, ManagedAnvilProcess>();
let managedAnvilCleanupRegistered = false;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const readRpcChainId = async (rpcUrl: string): Promise<number | null> => {
  try {
    const probe = createXlnJsonRpcProvider(rpcUrl);
    return Number((await probe.getNetwork()).chainId);
  } catch {
    return null;
  }
};

const isLocalRpcUrl = (rpcUrl: string): boolean => {
  try {
    return isLoopbackUrl(rpcUrl);
  } catch {
    return false;
  }
};

const killManagedAnvil = (): void => {
  for (const child of managedAnvils.values()) {
    if (child.exitCode !== null) continue;
    try {
      child.kill('SIGTERM');
    } catch (error) {
      console.warn('[scenario] managed Anvil SIGTERM failed', error);
    }
  }
};

const waitForManagedAnvilExit = async (
  child: ManagedAnvilProcess,
  timeoutMs: number,
): Promise<void> => {
  if (child.exitCode !== null || typeof child.once !== 'function') return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      child.removeListener?.('exit', finish);
      child.removeListener?.('error', finish);
      if (timer) clearTimeout(timer);
      resolve();
    };
    const timer = timeoutMs > 0 ? setTimeout(finish, timeoutMs) : null;
    child.once?.('exit', finish);
    child.once?.('error', finish);
  });
};

/** Stops one managed anvil, or every one of them when no url is given. */
export const stopManagedScenarioAnvil = async (
  timeoutMs = 3_000,
  rpcUrl?: string,
): Promise<void> => {
  const entries = rpcUrl
    ? (managedAnvils.has(rpcUrl) ? [[rpcUrl, managedAnvils.get(rpcUrl)!] as const] : [])
    : [...managedAnvils.entries()];
  for (const [url, child] of entries) {
    managedAnvils.delete(url);
    if (child.exitCode !== null) continue;
    try {
      child.kill('SIGTERM');
    } catch (error) {
      console.warn('[scenario] managed Anvil SIGTERM failed', error);
      continue;
    }
    await waitForManagedAnvilExit(child, timeoutMs);
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch (error) {
        console.warn('[scenario] managed Anvil SIGKILL failed', error);
      }
      await waitForManagedAnvilExit(child, Math.min(timeoutMs, 1_000));
    }
  }
};

const ensureAnvilCleanupHooks = (): void => {
  if (!IS_NODE_RUNTIME) return;
  if (managedAnvilCleanupRegistered) return;
  managedAnvilCleanupRegistered = true;
  process.on('exit', killManagedAnvil);
  process.on('SIGINT', () => {
    killManagedAnvil();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    killManagedAnvil();
    process.exit(143);
  });
};

const startManagedAnvil = async (rpcUrl: string, chainId: number): Promise<void> => {
  if (!IS_NODE_RUNTIME) {
    throw new Error(`RPC_UNAVAILABLE_IN_BROWSER: ${rpcUrl}`);
  }

  const parsed = new URL(rpcUrl);
  const port = parsed.port ? Number(parsed.port) : 8545;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid RPC port for auto Anvil bootstrap: ${rpcUrl}`);
  }

  const existing = managedAnvils.get(rpcUrl);
  if (existing && existing.exitCode === null) return;
  await stopManagedScenarioAnvil(3_000, rpcUrl);
  console.warn(`[Boot] RPC ${rpcUrl} unavailable, auto-starting local anvil (chainId=${chainId}, port=${port})`);
  const { spawn } = await import('node:child_process');
  // Keep scenario auto-start aligned with the E2E/dev stack. If this diverges,
  // scenarios can fail on contract deployment while the rest of the system passes.
  const child = spawn('anvil', [
    '--host', '127.0.0.1',
    '--port', String(port),
    '--chain-id', String(chainId),
    // Keep genesis ahead of wall clock so Anvil auto-mining advances by one
    // deterministic second instead of jumping to the host's current time.
    '--timestamp', '4102444800',
    '--block-gas-limit', '60000000',
    '--code-size-limit', '65536',
    '--prune-history', '256',
  ], {
    stdio: 'ignore',
  });
  child.unref?.();
  managedAnvils.set(rpcUrl, child);
  ensureAnvilCleanupHooks();

  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Auto-started anvil exited early (rpc=${rpcUrl})`);
    }
    const readyChainId = await readRpcChainId(rpcUrl);
    if (readyChainId !== null) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for auto-started anvil on ${rpcUrl}`);
};

const ensureScenarioRpcReady = async (rpcUrl: string, expectedChainId: number): Promise<number> => {
  const forceFreshLocalAnvil =
    process.env['XLN_FORCE_FRESH_ANVIL'] === '1' &&
    IS_NODE_RUNTIME &&
    isLocalRpcUrl(rpcUrl);
  if (forceFreshLocalAnvil) {
    await startManagedAnvil(rpcUrl, expectedChainId);
    const freshChainId = await readRpcChainId(rpcUrl);
    if (freshChainId === null) throw new Error(`RPC_STILL_UNAVAILABLE_AFTER_FRESH_ANVIL_START: ${rpcUrl}`);
    return freshChainId;
  }

  const existingChainId = await readRpcChainId(rpcUrl);
  if (existingChainId !== null) return existingChainId;

  if (!IS_NODE_RUNTIME) {
    throw new Error(`RPC_UNAVAILABLE_IN_BROWSER: ${rpcUrl}`);
  }

  if (!isLocalRpcUrl(rpcUrl)) {
    throw new Error(`RPC_UNAVAILABLE_NONLOCAL: ${rpcUrl}`);
  }

  await startManagedAnvil(rpcUrl, expectedChainId);
  const chainId = await readRpcChainId(rpcUrl);
  if (chainId === null) throw new Error(`RPC_STILL_UNAVAILABLE_AFTER_AUTOSTART: ${rpcUrl}`);
  return chainId;
};

// ============================================================================
// TYPES
// ============================================================================

export interface ScenarioConfig {
  name: string;
  signerIds: string[];
  mode?: JAdapterMode;       // default: JADAPTER_MODE env var → 'rpc'
  rpcUrl?: string;            // default: ANVIL_RPC env var → 'http://localhost:8545'
  jurisdictionName?: string;  // default: `${name} Demo`
  position?: { x: number; y: number; z: number }; // jReplica position
  seed?: string;              // runtime seed (default: `${name}-scenario-seed`)
  storageEnabled?: boolean;    // Optional scenario harness override
}

export interface ScenarioBootResult {
  env: RuntimeReplica;
  jadapter: JAdapter;
  jurisdiction: JurisdictionConfig;
}

export interface EntityConfig {
  name: string;
  signer: string;
  position: { x: number; y: number; z: number };
}

export interface RegisteredEntity {
  id: string;
  name: string;
  signer: string;
}

// ============================================================================
// BOOT
// ============================================================================

/**
 * Get JAdapter mode from environment
 * Set via: JADAPTER_MODE=browservm|rpc (default: rpc)
 */
export function getJAdapterMode(): JAdapterMode {
  // BrowserVM JAdapter is intentionally disabled in the current runtime path.
  // Browser scenario previews must use the app's /rpc proxy instead of choosing
  // browservm and failing before the scenario can build deterministic history.
  if (IS_BROWSER_RUNTIME) return 'rpc';
  const mode = process.env['JADAPTER_MODE']?.toLowerCase();
  if (mode === 'rpc' || mode === 'anvil') return mode as JAdapterMode;
  if (mode === 'browservm') return 'browservm';
  return 'rpc';
}

/**
 * Create JAdapter based on mode flag
 */
export async function ensureJAdapter(
  env?: RuntimeReplica,
  mode?: JAdapterMode,
  options?: { deployStack?: boolean; rpcUrl?: string; chainId?: number },
): Promise<JAdapter> {
  const { createJAdapter } = await import('../jurisdiction/adapter');
  const { assertBrowserVMJurisdiction } = await import('../jurisdiction/adapter');

  const actualMode = mode ?? env?.scenarioJAdapterMode ?? getJAdapterMode();
  // An explicit rpcUrl must win over the ambient ANVIL_RPC. Without this the
  // adapter always connected to the one ambient endpoint while step 7 of
  // bootScenario recorded whatever the caller asked for, so the jurisdiction
  // config could name an endpoint the adapter was not talking to — and a second
  // jurisdiction in one process (the whole point of a cross-j scenario) was
  // impossible to express.
  const rpcUrl = options?.rpcUrl || process.env['ANVIL_RPC'] || getDefaultAnvilRpcUrl();
  // A jurisdiction is identified by (chainId, depository address). Two fresh
  // anvils deploy the identical deterministic addresses, so a second stack that
  // reuses 31337 is indistinguishable from the first and the event watcher
  // fails with J_WATCHER_JURISDICTION_AMBIGUOUS. A cross-jurisdiction scenario
  // must therefore be able to name its own chain id, exactly as the mesh does
  // (31337 / 31338).
  const expectedChainId = options?.chainId ?? 31337;
  const chainId = actualMode === 'browservm'
    ? expectedChainId
    : await ensureScenarioRpcReady(rpcUrl, expectedChainId);

  console.log(`[JAdapter] Mode: ${actualMode}${actualMode !== 'browservm' ? ` (${rpcUrl})` : ''}, chainId=${chainId}`);

  const jadapter = await createJAdapter({
    mode: actualMode,
    chainId,
    ...(actualMode !== 'browservm' ? { rpcUrl } : {}),
  });

  if (options?.deployStack !== false) {
    await jadapter.deployStack();
  }

  // If browservm and env provided, register the BrowserVM instance
  if (actualMode === 'browservm' && env) {
    const browserVM = jadapter.getBrowserVM();
    if (browserVM) {
      assertBrowserVMJurisdiction(
        jadapter.addresses.depository,
        jadapter.chainId,
        browserVM,
      );
    }
  }

  return jadapter;
}

/**
 * Single entry point for all scenarios.
 * Creates env + jadapter + jReplica + jurisdiction. Starts event watching.
 *
 * Usage:
 *   const { env, jadapter, jurisdiction } = await bootScenario({
 *     name: 'lock-ahb', signerIds: ['1', '2', '3']
 *   });
 */
export async function bootScenario(config: ScenarioConfig): Promise<ScenarioBootResult> {
  const { createEmptyEnv } = await import('../runtime');

  // 1. Create fresh env with deterministic seed
  const seed = config.seed ?? `${config.name}-scenario-seed`;
  const env = createEmptyEnv(seed);
  env.scenarioMode = true;
  env.state.timestamp = 1;
  setScenarioStorageEnabled(env, config.storageEnabled ?? false);

  // 2. Seed signer keys
  requireRuntimeSeed(env, config.name);
  ensureSignerKeysFromSeed(env, config.signerIds, config.name);

  // 3. Create JAdapter (creates BrowserVM or connects to RPC)
  const jReplicaName = config.jurisdictionName ?? `${config.name} Demo`;
  const jadapter = await ensureJAdapter(env, config.mode, {
    deployStack: true,
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
  });

  // 4. Create jReplica
  const position = config.position ?? { x: 0, y: 600, z: 0 };
  bindScenarioJReplica(
    env,
    createJReplica(env, jReplicaName, jadapter.addresses.depository, position),
    jadapter,
  );

  // 5. Attach jadapter to jReplica (all 4 contract addresses)
  // 6. Start watching (feeds events into env.runtimeMempool.entityInputs)
  jadapter.startWatching(env);

  // 7. Create jurisdiction config
  const jurisdictionRpcUrl = jadapter.mode === 'browservm'
    ? 'browservm://'
    : (config.rpcUrl ?? process.env['ANVIL_RPC'] ?? getDefaultAnvilRpcUrl());
  const jurisdiction = createJurisdictionConfig(
    jReplicaName,
    jadapter.addresses.depository,
    jadapter.addresses.entityProvider,
    jurisdictionRpcUrl,
    Number(jadapter.chainId || 31337),
  );

  console.log(`[Boot] ${config.name}: env + jadapter + jReplica "${jReplicaName}" ready`);

  return { env, jadapter, jurisdiction };
}

// ============================================================================
// ENTITY REGISTRATION
// ============================================================================

type ScenarioBoardIdentity = Readonly<{
  signer: string;
  privateKey: Uint8Array;
  boardHash: string;
}>;

export const resolveScenarioBoardSigner = (env: RuntimeReplica, signerId: string): string => {
  const privateKey = getSignerPrivateKey(env, signerId);
  const signer = new ethers.Wallet(ethers.hexlify(privateKey)).address.toLowerCase();
  registerSignerKey(env, signer, privateKey);
  return signer;
};

/** Resolve scenario aliases before the consensus boundary. Board member zero is
 * always the literal EOA that Solidity will verify; aliases remain local UX only. */
function computeBoardIdentity(env: RuntimeReplica, signerId: string): ScenarioBoardIdentity {
  const privateKey = getSignerPrivateKey(env, signerId);
  const signer = resolveScenarioBoardSigner(env, signerId);
  const wallet = new ethers.Wallet(ethers.hexlify(privateKey));
  const validatorEntityId = ethers.zeroPadValue(signer, 32);

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encodedBoard = abiCoder.encode(
    ['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'],
    [[1n, [validatorEntityId], [1n], 0n, 0n, 0n]]
  );

  const boardHash = ethers.keccak256(encodedBoard);
  console.log(`[Boot] computeBoardHash(signer=${signerId}): addr=${wallet.address}, entityId=${validatorEntityId.slice(0, 20)}..., boardHash=${boardHash.slice(0, 18)}...`);
  return { signer, privateKey, boardHash };
}

/**
 * Register entities on-chain + create eReplicas via importReplica.
 *
 * Usage:
 *   const [alice, hub, bob] = await registerEntities(env, jadapter, [
 *     { name: 'Alice', signer: '2', position: { x: -20, y: -40, z: 0 } },
 *     { name: 'Hub',   signer: '3', position: { x: 0, y: -20, z: 0 } },
 *     { name: 'Bob',   signer: '4', position: { x: 20, y: -40, z: 0 } },
 *   ], jurisdiction);
 */
export async function registerEntities(
  env: RuntimeReplica,
  jadapter: JAdapter,
  entities: EntityConfig[],
  jurisdiction: JurisdictionConfig,
): Promise<RegisteredEntity[]> {
  // 1. Compute board hashes and register on-chain
  const boardIdentities = entities.map(entity => computeBoardIdentity(env, entity.signer));
  const boardHashes = boardIdentities.map(identity => identity.boardHash);
  const nextEntityNumber = await jadapter.entityProvider.nextNumber();
  const registerTx = await jadapter.entityProvider.registerNumberedEntitiesBatch(boardHashes);
  const registerReceipt = await registerTx.wait();
  if (!registerReceipt || registerReceipt.status === 0) {
    throw new Error('registerNumberedEntitiesBatch failed');
  }
  const entityNumbers = boardHashes.map((_, index) => Number(nextEntityNumber) + index);

  // 2. Build entity info from returned numbers
  const result: RegisteredEntity[] = entities.map((e, i) => {
    const entityNumber = entityNumbers[i];
    if (entityNumber === undefined) throw new Error(`REGISTER_ENTITY_NUMBER_MISSING: index=${i}`);
    return {
      id: '0x' + entityNumber.toString(16).padStart(64, '0'),
      name: e.name,
      signer: boardIdentities[i]!.signer,
    };
  });

  // A numbered H0 must never share a Runtime frame with the evidence that
  // authorizes it. Drain the authenticated watcher through the registration
  // receipt first, commit that local authority evidence, then import replicas.
  // This remains correct after a long watcher backlog and when ethers has a
  // cached pre-receipt block number.
  if (jadapter.isWatching()) {
    await processJEvents(env);
    const stackKey = getCertifiedBoardStackKey(jurisdiction);
    const receiptBlock = Number(registerReceipt.blockNumber);
    for (const [index, registered] of result.entries()) {
      const evidence = env.infrastructure?.certifiedRegistrationEvidence?.get(
        registrationEvidenceKey(stackKey, registered.id),
      );
      if (!evidence) {
        throw new Error(`REGISTER_ENTITY_AUTHORITY_EVIDENCE_MISSING:${registered.id}:${stackKey}`);
      }
      if (
        evidence.boardHash !== boardHashes[index]!.toLowerCase() ||
        evidence.activationHeight !== receiptBlock
      ) {
        throw new Error(`REGISTER_ENTITY_AUTHORITY_EVIDENCE_MISMATCH:${registered.id}`);
      }
    }
  }

  for (const registered of result) {
    jadapter.registerEntityWallet?.(
      registered.id,
      ethers.hexlify(getSignerPrivateKey(env, registered.signer)),
    );
  }

  // 3. Create eReplicas via importReplica
  await commitRuntimeInput(env, {
    runtimeTxs: result.map((r, i) => {
      const sourceEntity = entities[i];
      if (!sourceEntity) throw new Error(`REGISTER_ENTITY_SOURCE_MISSING: index=${i}`);
      return {
        type: 'importReplica' as const,
        entityId: r.id,
        signerId: r.signer,
        data: {
          isProposer: true,
          position: sourceEntity.position,
          config: {
            mode: 'proposer-based' as const,
            threshold: 1n,
            validators: [r.signer],
            shares: { [r.signer]: 1n },
            jurisdiction,
          }
        }
      };
    }),
    entityInputs: []
  });

  // 4. Process any j-events from registration + converge
  await processJEvents(env);
  await converge(env);

  console.log(`[Boot] Registered ${result.length} entities: ${result.map(r => `${r.name}(${r.id.slice(-4)})`).join(', ')}`);
  return result;
}

/**
 * Fund entity reserves using debugFundReserves (dev-only convenience).
 * For real ERC20 deposits, use jadapter.externalTokenToReserve() directly.
 */
export async function fundEntities(
  env: RuntimeReplica,
  jadapter: JAdapter,
  funds: Array<{ id: string; tokenId: number; amount: bigint }>,
): Promise<void> {
  for (const { id, tokenId, amount } of funds) {
    await jadapter.debugFundReserves(id, tokenId, amount);
  }
  await processJEvents(env);
  await converge(env);
  console.log(`[Boot] Funded ${funds.length} entities`);
}

// ============================================================================
// JADAPTER ACCESS
// ============================================================================

/**
 * Get JAdapter from env's active jReplica.
 * Scenarios call this to access the adapter without passing it separately.
 */
export function getScenarioJAdapter(env: RuntimeReplica): JAdapter {
  if (env.activeJurisdiction) {
    const active = getLiveJAdapter(env, env.activeJurisdiction);
    if (active) return active;
  }
  const first = getLiveJAdapterEntries(env)[0]?.adapter;
  if (first) return first;
  throw new Error(`${SCENARIO_JADAPTER_MISSING}: call bootScenario() first`);
}

// ============================================================================
// JREPLICA + JURISDICTION HELPERS
// ============================================================================

/**
 * Create jReplica (J-Machine) for a jurisdiction
 */
export function createJReplica(
  env: RuntimeReplica,
  name: string,
  depositoryAddress: string,
  position: { x: number; y: number; z: number } = { x: 0, y: 600, z: 0 }
): JReplica {
  if (!env.state.jReplicas) {
    env.state.jReplicas = new Map();
  }

  const jReplica = {
    name,
    blockNumber: 0n,
    stateRoot: new Uint8Array(32),
    mempool: [] as JTx[],
    blockDelayMs: 300,
    lastBlockTimestamp: env.state.timestamp,
    position,
    contracts: {
      depository: depositoryAddress,
      entityProvider: '0x0000000000000000000000000000000000000000',
      account: '',
      deltaTransformer: '',
    }
  };

  env.state.jReplicas.set(name, jReplica);
  env.activeJurisdiction = name;

  return jReplica;
}

/** Install the exact trusted adapter policy used by scenario J-authority checks. */
export function bindScenarioJReplica(env: RuntimeReplica, replica: JReplica, adapter: JAdapter): JReplica {
  const chainId = Number(adapter.chainId);
  const confirmationDepth = adapter.getFinalityDepth?.();
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`SCENARIO_J_CHAIN_ID_INVALID:${String(adapter.chainId)}`);
  }
  if (!Number.isSafeInteger(confirmationDepth) || Number(confirmationDepth) < 0) {
    throw new Error(`SCENARIO_J_CONFIRMATION_DEPTH_INVALID:${String(confirmationDepth)}`);
  }
  Object.assign(replica, {
    chainId,
    watcherConfirmationDepth: Number(confirmationDepth),
    depositoryAddress: adapter.addresses.depository,
    entityProviderAddress: adapter.addresses.entityProvider,
    entityProviderDeploymentBlock: adapter.entityProviderDeploymentBlock,
    contracts: { ...adapter.addresses },
  });
  attachLiveJAdapter(env, replica.name, adapter);
  return replica;
}

/**
 * Create jurisdiction config for entity registration
 */
export function createJurisdictionConfig(
  name: string,
  depositoryAddress: string,
  entityProviderAddress: string = '0x0000000000000000000000000000000000000000',
  address: string = 'browservm://',
  chainId: number = 31337,
  // Cross-j derives wall-clock dispute deadlines from the settlement chain's
  // signed account clock (`committedCrossJSourceResponseWindowMs`), and the real
  // jurisdiction loader requires the field. Omitting it here left scenario
  // jurisdictions incomplete in a way only cross-j could notice, as
  // CROSS_J_PREPARED_BLOCK_TIME_MISSING.
  blockTimeMs: number = 1_000,
): JurisdictionConfig {
  return {
    address,
    name,
    chainId,
    entityProviderAddress,
    depositoryAddress,
    blockTimeMs,
  };
}

// ============================================================================
// GRID HELPERS (used by grid.ts)
// ============================================================================

/**
 * Create a numbered scenario entity using importReplica.
 */
export async function createNumberedEntity(
  env: RuntimeReplica,
  entityNumber: number,
  _name: string,
  jurisdiction: JurisdictionConfig,
  position: { x: number; y: number; z: number }
): Promise<string> {
  const signer = `${entityNumber}`;
  const boardIdentity = computeBoardIdentity(env, signer);
  const entityId = boardIdentity.boardHash;
  getScenarioJAdapter(env).registerEntityWallet?.(
    entityId,
    ethers.hexlify(boardIdentity.privateKey),
  );

  await commitRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importReplica' as const,
      entityId,
      signerId: boardIdentity.signer,
      data: {
        isProposer: true,
        position,
        config: {
          mode: 'proposer-based' as const,
          threshold: 1n,
          validators: [boardIdentity.signer],
          shares: { [boardIdentity.signer]: 1n },
          jurisdiction
        }
      }
    }],
    entityInputs: []
  });

  return entityId;
}

/**
 * Create a 3D grid of scenario entities (NxMxZ).
 */
export async function createGridEntities(
  env: RuntimeReplica,
  dimensions: { x: number; y: number; z: number },
  jurisdiction: JurisdictionConfig,
  centerOffset: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
  spacing: number = 40
): Promise<string[]> {
  const entities: string[] = [];
  let entityNum = 1;

  for (let zi = 0; zi < dimensions.z; zi++) {
    for (let yi = 0; yi < dimensions.y; yi++) {
      for (let xi = 0; xi < dimensions.x; xi++) {
        const x = centerOffset.x + (xi - dimensions.x / 2 + 0.5) * spacing;
        const y = centerOffset.y + (yi - dimensions.y / 2 + 0.5) * spacing;
        const z = centerOffset.z + (zi - dimensions.z / 2 + 0.5) * spacing;

        const entityId = await createNumberedEntity(
          env,
          entityNum,
          `Node${entityNum}`,
          jurisdiction,
          { x, y, z }
        );

        entities.push(entityId);
        entityNum++;
      }
    }
  }

  return entities;
}
