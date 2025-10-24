/**
 * Xlnomy (Jurisdiction) Factory
 * Creates self-contained economies with J-Machine + contracts + entities
 *
 * Architecture:
 * - Xlnomy = J-Machine (court/jurisdiction) + Entities + Contracts
 * - EVM: BrowserVM (simnet) or RPC (Reth/Erigon/Monad)
 * - Persisted to Level/IndexedDB for time-travel + export/import
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import type {
  Xlnomy,
  XlnomySnapshot,
  JurisdictionEVM,
  Env,
} from './types.js';

/**
 * Create new Xlnomy (jurisdiction + J-Machine + entities)
 * Returns Xlnomy instance ready for use
 */
export async function createXlnomy(options: {
  name: string;
  evmType: 'browservm' | 'rpc';
  rpcUrl?: string;
  blockTimeMs?: number;
  autoGrid?: boolean;
  env?: any; // Optional env to apply grid entities to
}): Promise<Xlnomy> {
  const { name, evmType, rpcUrl, blockTimeMs = 1000, autoGrid = false, env } = options;

  console.log(`[Xlnomy] Creating "${name}" (${evmType}, ${blockTimeMs}ms blocks)...`);

  // 1. Initialize EVM (BrowserVM or RPC)
  const evm = await createEVM(evmType, rpcUrl);

  // 2. Get deployed contracts (BrowserVM already deploys in init())
  const contracts = await deployContracts(evm);

  // 3. Calculate J-Machine position (circular arrangement for VR)
  const xlnomyCount = env?.xlnomies ? env.xlnomies.size : 0;
  const maxSlots = 8; // Support up to 8 Xlnomies in a circle
  const radius = 200; // Distance from origin
  const angle = (xlnomyCount * 2 * Math.PI) / maxSlots; // Evenly spaced around circle

  const jMachinePosition = {
    x: Math.round(radius * Math.cos(angle)),
    y: 100, // Elevated above ground
    z: Math.round(radius * Math.sin(angle)),
  };

  console.log(`[Xlnomy] "${name}" J-Machine position (slot ${xlnomyCount}/${maxSlots}):`, jMachinePosition);

  // 3. Create J-Machine config
  const jMachine = {
    position: jMachinePosition,
    capacity: 3, // Broadcast after 3 transactions
    jHeight: 0, // Current block height
    mempool: [], // Pending transactions queue
  };

  // 4. Initialize Xlnomy
  const xlnomy: Xlnomy = {
    name,
    evmType,
    blockTimeMs,
    jMachine,
    contracts,
    evm,
    entities: [],
    created: Date.now(),
    version: '1.0.0',
  };

  // 5. Optional: Auto-create 2x2x2 grid with $1M reserves
  if (autoGrid && env) {
    await createGridEntities(xlnomy, env);
  }

  console.log(`[Xlnomy] ✅ "${name}" created with ${xlnomy.entities.length} entities queued`);

  return xlnomy;
}

/**
 * Create EVM instance (BrowserVM or RPC)
 */
async function createEVM(
  type: 'browservm' | 'rpc',
  rpcUrl?: string
): Promise<JurisdictionEVM> {
  if (type === 'browservm') {
    const { BrowserVMEVM } = await import('./evms/browservm-evm.js');
    const evm = new BrowserVMEVM();
    await evm.init();
    return evm;
  } else {
    const { RPCEVM } = await import('./evms/rpc-evm.js');
    if (!rpcUrl) throw new Error('RPC EVM requires rpcUrl');
    return new RPCEVM(rpcUrl);
  }
}

/**
 * Get deployed contracts from EVM
 * BrowserVM already deploys contracts in init(), so just retrieve addresses
 */
async function deployContracts(evm: JurisdictionEVM): Promise<{
  entityProviderAddress: string;
  depositoryAddress: string;
}> {
  console.log('[Xlnomy] Getting deployed contracts...');

  // BrowserVM already deploys contracts in init()
  // Just retrieve the addresses
  const entityProviderAddress = evm.getEntityProviderAddress();
  const depositoryAddress = evm.getDepositoryAddress();

  console.log(`[Xlnomy] EntityProvider: ${entityProviderAddress}`);
  console.log(`[Xlnomy] Depository: ${depositoryAddress}`);

  return { entityProviderAddress, depositoryAddress };
}

/**
 * Create 2x2x2 grid (8 entities) with $1M reserves each
 * Entities positioned around their Xlnomy's J-Machine
 */
async function createGridEntities(xlnomy: Xlnomy, env: any): Promise<void> {
  console.log('[Xlnomy] Creating 2x2x2 grid with $1M reserves...');

  // Import necessary functions
  const { generateNumberedEntityId } = await import('./entity-factory.js');

  // Get J-Machine center position to offset entities around it
  const jCenter = xlnomy.jMachine.position;

  // Generate 8 numbered entity IDs
  const gridEntities: string[] = [];
  const entityInputs: any[] = [];

  // Base entity number for this Xlnomy (each Xlnomy gets 8 sequential IDs)
  // xlnomies.size = count of EXISTING xlnomies (doesn't include current one being created)
  const xlnomyIndex = env?.xlnomies ? env.xlnomies.size : 0;
  const baseEntityNum = xlnomyIndex * 8 + 1; // Index 0→1-8, Index 1→9-16, Index 2→17-24

  console.log(`[Xlnomy] "${xlnomy.name}" (index ${xlnomyIndex}) → Entity IDs ${baseEntityNum}-${baseEntityNum + 7}`);

  for (let i = 0; i < 8; i++) {
    const entityNum = baseEntityNum + i;
    const entityId = generateNumberedEntityId(entityNum);
    gridEntities.push(entityId);

    // Calculate grid position (2x2x2 cube, 50 units apart)
    // Offset from J-Machine position
    const localX = (i % 2) * 50 - 25; // -25 or 25
    const localY = (Math.floor(i / 2) % 2) * 50 - 25;
    const localZ = (Math.floor(i / 4)) * 50 - 25;

    const x = jCenter.x + localX;
    const y = jCenter.y + localY - 100; // Below J-Machine (ground level)
    const z = jCenter.z + localZ;

    // Create importReplica RuntimeTx for each entity
    const signerId = `${xlnomy.name.toLowerCase()}_e${i}`; // e.g., "simnet_e0", "jamaica_e1"

    const runtimeTx = {
      type: 'importReplica' as const,
      entityId,
      signerId,
      data: {
        config: {
          mode: 'proposer-based' as const,
          threshold: 1n,
          validators: [signerId],
          shares: { [signerId]: 1n },
        },
        isProposer: true,
        position: { x, y, z }
      }
    };

    entityInputs.push(runtimeTx);
  }

  // Add entities to xlnomy registry
  xlnomy.entities = gridEntities;

  // Apply to env to actually create the replicas
  if (env) {
    env.runtimeInput.runtimeTxs.push(...entityInputs);
  }

  console.log(`[Xlnomy] ✅ Grid queued: ${gridEntities.length} entities at positions`);
}

/**
 * Export Xlnomy to JSON (shareable snapshot)
 */
export async function exportXlnomy(xlnomy: Xlnomy): Promise<string> {
  const snapshot = await xlnomy.evm.serialize();

  return JSON.stringify(snapshot, (key, value) =>
    typeof value === 'bigint' ? `BigInt(${value.toString()})` : value
  , 2);
}

/**
 * Import Xlnomy from JSON snapshot
 */
export async function importXlnomy(json: string): Promise<Xlnomy> {
  const snapshot: XlnomySnapshot = JSON.parse(json, (key, value) => {
    if (typeof value === 'string' && value.startsWith('BigInt(')) {
      return BigInt(value.slice(7, -1));
    }
    return value;
  });

  // Reconstruct EVM from snapshot
  const evm = await createEVM(snapshot.evmType, snapshot.evmState.rpcUrl);

  // TODO: Restore VM state from snapshot.evmState.vmState

  return {
    name: snapshot.name,
    evmType: snapshot.evmType,
    blockTimeMs: snapshot.blockTimeMs,
    jMachine: snapshot.jMachine,
    contracts: snapshot.contracts,
    evm,
    entities: snapshot.entities,
    created: snapshot.created,
    version: snapshot.version,
  };
}

/**
 * Persist Xlnomy to Level/IndexedDB
 */
export async function saveXlnomy(xlnomy: Xlnomy): Promise<void> {
  const snapshot = await xlnomy.evm.serialize();

  // TODO: Save to Level storage
  // await level.put(`xln-xlnomy-${xlnomy.name}`, snapshot);

  console.log(`[Xlnomy] Saved "${xlnomy.name}" to storage`);
}

/**
 * Load Xlnomy from Level/IndexedDB
 */
export async function loadXlnomy(name: string): Promise<Xlnomy | null> {
  // TODO: Load from Level storage
  // const snapshot = await level.get(`xln-xlnomy-${name}`);
  // return importXlnomy(JSON.stringify(snapshot));

  console.log(`[Xlnomy] Loaded "${name}" from storage`);
  return null;
}
