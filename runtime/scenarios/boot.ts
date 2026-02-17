/**
 * Shared scenario boot utilities
 * Single entry point for all scenarios — configurable backend (browservm | rpc)
 */

import type { Env, JurisdictionConfig } from '../types';
import type { JAdapter, JAdapterMode } from '../jadapter/types';
import { ethers } from 'ethers';
import { getCachedSignerPrivateKey } from '../account-crypto';
import { ensureSignerKeysFromSeed, requireRuntimeSeed, processJEvents, converge } from './helpers';

export type { JAdapterMode };

// ============================================================================
// TYPES
// ============================================================================

export interface ScenarioConfig {
  name: string;
  signerIds: string[];
  mode?: JAdapterMode;       // default: JADAPTER_MODE env var → 'browservm'
  rpcUrl?: string;            // default: ANVIL_RPC env var → 'http://localhost:8545'
  jurisdictionName?: string;  // default: `${name} Demo`
  position?: { x: number; y: number; z: number }; // jReplica position
  seed?: string;              // runtime seed (default: `${name}-scenario-seed`)
}

export interface ScenarioBootResult {
  env: Env;
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
 * Set via: JADAPTER_MODE=browservm|rpc (default: browservm)
 */
export function getJAdapterMode(): JAdapterMode {
  const mode = process.env.JADAPTER_MODE?.toLowerCase();
  if (mode === 'rpc' || mode === 'anvil') return mode as JAdapterMode;
  return 'browservm';
}

/**
 * Create JAdapter based on mode flag
 */
export async function ensureJAdapter(env?: Env, mode?: JAdapterMode): Promise<JAdapter> {
  const { createJAdapter } = await import('../jadapter');
  const { setBrowserVMJurisdiction } = await import('../evm');

  const actualMode = mode ?? getJAdapterMode();
  const rpcUrl = process.env.ANVIL_RPC || 'http://localhost:8545';

  console.log(`[JAdapter] Mode: ${actualMode}${actualMode !== 'browservm' ? ` (${rpcUrl})` : ''}`);

  const jadapter = await createJAdapter({
    mode: actualMode,
    chainId: 31337,
    rpcUrl: actualMode !== 'browservm' ? rpcUrl : undefined,
  });

  // If browservm and env provided, register the BrowserVM instance
  if (actualMode === 'browservm' && env) {
    const browserVM = jadapter.getBrowserVM();
    if (browserVM) {
      (env as any).browserVM = browserVM;
      setBrowserVMJurisdiction(env, jadapter.addresses.depository, browserVM);
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
  env.timestamp = 1;

  // 2. Seed signer keys
  requireRuntimeSeed(env, config.name);
  ensureSignerKeysFromSeed(env, config.signerIds, config.name);

  // 3. Create JAdapter (creates BrowserVM or connects to RPC)
  const jadapter = await ensureJAdapter(env, config.mode);
  await jadapter.deployStack();

  // 4. Create jReplica
  const jReplicaName = config.jurisdictionName ?? `${config.name} Demo`;
  const position = config.position ?? { x: 0, y: 600, z: 0 };
  const jReplica = createJReplica(env, jReplicaName, jadapter.addresses.depository, position);

  // 5. Attach jadapter to jReplica (all 4 contract addresses)
  (jReplica as any).jadapter = jadapter;
  (jReplica as any).depositoryAddress = jadapter.addresses.depository;
  (jReplica as any).entityProviderAddress = jadapter.addresses.entityProvider;
  (jReplica as any).contracts = {
    depository: jadapter.addresses.depository,
    entityProvider: jadapter.addresses.entityProvider,
    account: jadapter.addresses.account,
    deltaTransformer: jadapter.addresses.deltaTransformer,
  };

  // 6. Start watching (feeds events into env.runtimeInput.entityInputs)
  jadapter.startWatching(env);

  // 7. Create jurisdiction config
  const jurisdictionRpcUrl = jadapter.mode === 'browservm'
    ? 'browservm://'
    : (config.rpcUrl ?? process.env.ANVIL_RPC ?? 'http://localhost:8545');
  const jurisdiction = createJurisdictionConfig(
    jReplicaName,
    jadapter.addresses.depository,
    jadapter.addresses.entityProvider,
    jurisdictionRpcUrl,
  );

  console.log(`[Boot] ${config.name}: env + jadapter + jReplica "${jReplicaName}" ready`);

  return { env, jadapter, jurisdiction };
}

// ============================================================================
// ENTITY REGISTRATION
// ============================================================================

/**
 * Compute board hash for entity registration (matches Solidity abi.encode(Board))
 */
function computeBoardHash(signerId: string): string {
  const privateKey = getCachedSignerPrivateKey(signerId);
  if (!privateKey) {
    throw new Error(`No private key for signer ${signerId} — register keys before entity registration`);
  }

  const wallet = new ethers.Wallet(ethers.hexlify(privateKey));
  const validatorEntityId = ethers.zeroPadValue(wallet.address, 32);

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encodedBoard = abiCoder.encode(
    ['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'],
    [[1n, [validatorEntityId], [1n], 0n, 0n, 0n]]
  );

  const boardHash = ethers.keccak256(encodedBoard);
  console.log(`[Boot] computeBoardHash(signer=${signerId}): addr=${wallet.address}, entityId=${validatorEntityId.slice(0, 20)}..., boardHash=${boardHash.slice(0, 18)}...`);
  return boardHash;
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
  env: Env,
  jadapter: JAdapter,
  entities: EntityConfig[],
  jurisdiction: JurisdictionConfig,
): Promise<RegisteredEntity[]> {
  const { applyRuntimeInput } = await import('../runtime');

  // 1. Compute board hashes and register on-chain
  const boardHashes = entities.map(e => computeBoardHash(e.signer));
  const { entityNumbers } = await jadapter.registerNumberedEntitiesBatch(boardHashes);

  // 2. Build entity info from returned numbers
  const result: RegisteredEntity[] = entities.map((e, i) => ({
    id: '0x' + entityNumbers[i].toString(16).padStart(64, '0'),
    name: e.name,
    signer: e.signer,
  }));

  // 3. Create eReplicas via importReplica
  await applyRuntimeInput(env, {
    runtimeTxs: result.map((r, i) => ({
      type: 'importReplica' as const,
      entityId: r.id,
      signerId: r.signer,
      data: {
        isProposer: true,
        position: entities[i].position,
        config: {
          mode: 'proposer-based' as const,
          threshold: 1n,
          validators: [r.signer],
          shares: { [r.signer]: 1n },
          jurisdiction,
        }
      }
    })),
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
  env: Env,
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
export function getScenarioJAdapter(env: Env): JAdapter {
  const jReplica = env.jReplicas?.get(env.activeJurisdiction || '');
  if (jReplica && (jReplica as any).jadapter) {
    return (jReplica as any).jadapter;
  }
  for (const jr of env.jReplicas?.values() || []) {
    if ((jr as any).jadapter) return (jr as any).jadapter;
  }
  throw new Error('No JAdapter found on env — call bootScenario() first');
}

// ============================================================================
// LEGACY (kept for backward compat during migration)
// ============================================================================

/**
 * Attach a BrowserVM-backed JAdapter to an existing jReplica and start watching.
 * @deprecated Use bootScenario() instead.
 */
export async function attachBrowserVMAdapter(
  env: Env,
  jReplicaName: string,
  browserVM: any,
): Promise<void> {
  const jReplica = env.jReplicas?.get(jReplicaName);
  if (!jReplica) throw new Error(`jReplica "${jReplicaName}" not found`);

  const { createBrowserVMAdapter } = await import('../jadapter/browservm');
  const { ethers } = await import('ethers');
  const { BrowserVMEthersProvider } = await import('../jadapter/browservm-ethers-provider');

  const bvmProvider = new BrowserVMEthersProvider(browserVM);
  const bvmSigner = new ethers.Wallet(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    bvmProvider as any,
  );

  const jadapter = await createBrowserVMAdapter(
    { mode: 'browservm', chainId: 31337 },
    bvmProvider as any,
    bvmSigner as any,
    browserVM,
  );

  (jReplica as any).jadapter = jadapter;
  (jReplica as any).depositoryAddress = jadapter.addresses.depository;
  (jReplica as any).entityProviderAddress = jadapter.addresses.entityProvider;
  (jReplica as any).contracts = {
    depository: jadapter.addresses.depository,
    entityProvider: jadapter.addresses.entityProvider,
    account: jadapter.addresses.account,
    deltaTransformer: jadapter.addresses.deltaTransformer,
  };

  jadapter.startWatching(env);
  console.log(`[JAdapter] BrowserVM adapter attached to "${jReplicaName}" + watching started`);
}

// ============================================================================
// JREPLICA + JURISDICTION HELPERS
// ============================================================================

/**
 * Create jReplica (J-Machine) for a jurisdiction
 */
export function createJReplica(
  env: Env,
  name: string,
  depositoryAddress: string,
  position: { x: number; y: number; z: number } = { x: 0, y: 600, z: 0 }
) {
  if (!env.jReplicas) {
    env.jReplicas = new Map();
  }

  const jReplica = {
    name,
    blockNumber: 0n,
    stateRoot: new Uint8Array(32),
    mempool: [] as any[],
    blockDelayMs: 300,
    lastBlockTimestamp: env.timestamp,
    position,
    contracts: {
      depository: depositoryAddress,
      entityProvider: '0x0000000000000000000000000000000000000000',
      account: '',
      deltaTransformer: '',
    }
  };

  env.jReplicas.set(name, jReplica);
  env.activeJurisdiction = name;

  return jReplica;
}

/**
 * Create jurisdiction config for entity registration
 */
export function createJurisdictionConfig(
  name: string,
  depositoryAddress: string,
  entityProviderAddress: string = '0x0000000000000000000000000000000000000000',
  address: string = 'browservm://',
): JurisdictionConfig {
  return {
    address,
    name,
    chainId: 31337,
    entityProviderAddress,
    depositoryAddress,
  };
}

// ============================================================================
// GRID HELPERS (used by grid.ts)
// ============================================================================

/**
 * Create numbered entity using importReplica pattern
 * @deprecated Use registerEntities() for proper on-chain registration
 */
export async function createNumberedEntity(
  env: Env,
  entityNumber: number,
  name: string,
  jurisdiction: JurisdictionConfig,
  position: { x: number; y: number; z: number }
): Promise<string> {
  const entityId = '0x' + entityNumber.toString(16).padStart(64, '0');
  const signer = `${entityNumber}`;

  const { applyRuntimeInput } = await import('../runtime');

  await applyRuntimeInput(env, {
    runtimeTxs: [{
      type: 'importReplica' as const,
      entityId,
      signerId: signer,
      data: {
        isProposer: true,
        position,
        config: {
          mode: 'proposer-based' as const,
          threshold: 1n,
          validators: [signer],
          shares: { [signer]: 1n },
          jurisdiction
        }
      }
    }],
    entityInputs: []
  });

  return entityId;
}

/**
 * Create 3D grid of entities (NxMxZ)
 * @deprecated Use registerEntities() for proper on-chain registration
 */
export async function createGridEntities(
  env: Env,
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
