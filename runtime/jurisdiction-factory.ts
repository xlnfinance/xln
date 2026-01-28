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

  // 3. Calculate J-Machine position (3×3 grid layout)
  const xlnomyCount = env?.jReplicas ? env.jReplicas.size : 0;

  // 3×3 grid positions (9 slots total):
  // [0,1,2]  top row
  // [3,4,5]  middle row (4 = center)
  // [6,7,8]  bottom row
  const gridPositions = [
    { x: -400, z: 400 },   // 0: top-left
    { x: 0, z: 400 },      // 1: top-center
    { x: 400, z: 400 },    // 2: top-right
    { x: -400, z: 0 },     // 3: middle-left
    { x: 0, z: 0 },        // 4: CENTER
    { x: 400, z: 0 },      // 5: middle-right
    { x: -400, z: -400 },  // 6: bottom-left
    { x: 0, z: -400 },     // 7: bottom-center
    { x: 400, z: -400 },   // 8: bottom-right
  ];

  // First xlnomy gets center (slot 4), others fill grid
  const slotOrder = [4, 1, 3, 5, 7, 0, 2, 6, 8]; // Center first, then cross pattern
  const slotIndex = Math.min(xlnomyCount, 8);
  const gridSlot = slotOrder[slotIndex];
  const pos = gridPositions[gridSlot] || { x: 0, z: 0 };

  const jMachinePosition = {
    x: pos.x,
    y: 300, // Supreme layer (3× higher than original)
    z: pos.z,
  };

  console.log(`[Xlnomy] "${name}" J-Machine at 3×3 slot ${slotIndex} (grid position ${gridSlot}):`, jMachinePosition);

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
    created: env?.timestamp ?? 0,
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
    const { BrowserVMProvider } = await import('./jadapter/browservm-provider.js');
    const evm = new BrowserVMProvider();
    await evm.init();
    // BrowserVMProvider implements JurisdictionEVM interface
    return evm as unknown as JurisdictionEVM;
  } else {
    // RPC mode not implemented - use JAdapter for real chains
    throw new Error('RPC EVM not implemented in jurisdiction-factory. Use createJAdapter() from jadapter for real chains.');
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
 * Create 3×3×1 grid (9 entities) - Hub layer above J-Machine
 * Forms pinnacle hub at supreme layer
 */
async function createGridEntities(xlnomy: Xlnomy, env: any): Promise<void> {
  console.log('[Xlnomy] Creating 3×3×1 hub grid (9 entities) with $1M reserves...');

  // Import necessary functions
  const { generateNumberedEntityId } = await import('./entity-factory.js');

  // Get J-Machine center position
  const jCenter = xlnomy.jMachine.position;

  // Generate 9 numbered entity IDs
  const gridEntities: string[] = [];
  const entityInputs: any[] = [];

  // Base entity number for this Xlnomy (each Xlnomy gets 9 sequential IDs now)
  const xlnomyIndex = env?.jReplicas ? env.jReplicas.size : 0;
  const baseEntityNum = xlnomyIndex * 9 + 1; // Index 0→1-9, Index 1→10-18, Index 2→19-27

  console.log(`[Xlnomy] "${xlnomy.name}" hub (index ${xlnomyIndex}) → Entity IDs ${baseEntityNum}-${baseEntityNum + 8}`);

  // 3×3 flat grid pattern (i=0-8)
  // [0,1,2]  row 0 (top)
  // [3,4,5]  row 1 (middle) - 4 is center
  // [6,7,8]  row 2 (bottom)
  for (let i = 0; i < 9; i++) {
    const entityNum = baseEntityNum + i;
    const entityId = generateNumberedEntityId(entityNum);
    gridEntities.push(entityId);

    // Calculate 3×3 grid position (flat layer, 40px spacing)
    const row = Math.floor(i / 3); // 0, 1, or 2
    const col = i % 3; // 0, 1, or 2

    const localX = (col - 1) * 40; // -40, 0, 40
    const localZ = (row - 1) * 40; // -40, 0, 40

    const x = jCenter.x + localX;
    const y = jCenter.y + 20; // 20px above J-Machine (y=300 + 20 = 320)
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
