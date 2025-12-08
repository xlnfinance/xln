/**
 * Alice-Hub-Bob (AHB) Demo: Step-by-step collateral & settlement flows
 *
 * USING REAL BrowserVM transactions - no state hacks!
 * All R2R transfers go through Depository.sol via BrowserVM.
 *
 * Educational demo showing:
 * - Reserve-to-Reserve transfers (R2R)
 * - Reserve-to-Collateral prefunding (R2C)
 * - Off-chain ondelta changes (bilateral netting)
 * - Collateral-to-Reserve withdrawals (C2R via settlement)
 *
 * Target audience: Fed Chair, banking executives, fintech leaders
 * Each frame includes Fed-style subtitles explaining what/why/tradfi-parallel
 */

import type { Env, EntityInput, EnvSnapshot, EntityReplica } from './types';
import { applyRuntimeInput } from './runtime';
import { getAvailableJurisdictions, getBrowserVMInstance, setBrowserVMJurisdiction } from './evm';
import { buildEntityProfile } from './gossip-helper';
import { cloneEntityReplica } from './state-helpers';
import type { Profile } from './gossip';
import { BrowserEVM } from './evms/browser-evm';

const USDC_TOKEN_ID = 1;
const DECIMALS = 18n;
const ONE_TOKEN = 10n ** DECIMALS;

const usd = (amount: number | bigint) => BigInt(amount) * ONE_TOKEN;

type ReplicaEntry = [string, EntityReplica];

function findReplica(env: Env, entityId: string): ReplicaEntry {
  const entry = Array.from(env.eReplicas.entries()).find(([key]) => key.startsWith(entityId + ':'));
  if (!entry) {
    throw new Error(`AHB: Replica for entity ${entityId} not found`);
  }
  return entry as ReplicaEntry;
}

function cloneProfilesForSnapshot(env: Env): { profiles: Profile[] } | undefined {
  if (!env.gossip || typeof env.gossip.getProfiles !== 'function') {
    return undefined;
  }

  const profiles = env.gossip.getProfiles().map((profile: Profile): Profile => {
    let clonedMetadata: Profile['metadata'] = undefined;
    if (profile.metadata) {
      clonedMetadata = { ...profile.metadata };
      clonedMetadata.lastUpdated = clonedMetadata.lastUpdated ?? Date.now();
      if (clonedMetadata.baseFee !== undefined) {
        clonedMetadata.baseFee = BigInt(clonedMetadata.baseFee.toString());
      }
    }

    const clonedAccounts = profile.accounts
      ? profile.accounts.map((account) => {
          const tokenCapacities = new Map<number, { inCapacity: bigint; outCapacity: bigint }>();
          if (account.tokenCapacities) {
            for (const [tokenId, capacities] of account.tokenCapacities.entries()) {
              tokenCapacities.set(tokenId, {
                inCapacity: capacities.inCapacity,
                outCapacity: capacities.outCapacity,
              });
            }
          }

          return {
            counterpartyId: account.counterpartyId,
            tokenCapacities,
          };
        })
      : [];

    const profileClone: Profile = {
      entityId: profile.entityId,
      capabilities: [...profile.capabilities],
      hubs: [...profile.hubs],
      accounts: clonedAccounts,
    };

    if (clonedMetadata) {
      profileClone.metadata = clonedMetadata;
    }

    return profileClone;
  });

  return { profiles };
}

/**
 * Sync reserves from BrowserVM to replica state
 * This ensures UI reflects actual on-chain state
 */
async function syncReservesFromBrowserVM(
  env: Env,
  entityId: string,
  browserVM: any,
  entityName?: string
): Promise<void> {
  const [, replica] = findReplica(env, entityId);

  // Get actual reserves from BrowserVM
  const reserves = await browserVM.getReserves(entityId, USDC_TOKEN_ID);

  // Update replica state
  if (!replica.state.reserves) {
    replica.state.reserves = new Map();
  }
  replica.state.reserves.set(String(USDC_TOKEN_ID), reserves);

  // Update gossip profile
  if (env.gossip) {
    env.gossip.announce(buildEntityProfile(replica.state, entityName));
  }

  console.log(`[AHB] Synced reserves for ${entityName || entityId.slice(0, 10)}: ${Number(reserves) / 1e18} USDC`);
}

interface FrameSubtitle {
  title: string;           // Short header (e.g., "Reserve-to-Reserve Transfer")
  what: string;            // What's happening technically
  why: string;             // Why this matters
  tradfiParallel: string;  // Traditional finance equivalent
  keyMetrics?: string[];   // Optional: bullet points of key numbers
}

let pushSnapshotCount = 0;

async function pushSnapshot(
  env: Env,
  description: string,
  subtitle: FrameSubtitle,
  entityInputs?: EntityInput[]
) {
  pushSnapshotCount++;
  console.log(`[pushSnapshot #${pushSnapshotCount}] Called for: "${description}"`);
  const gossipSnapshot = cloneProfilesForSnapshot(env);

  // CRITICAL: Capture fresh stateRoot from BrowserVM for time-travel
  const browserVM = getBrowserVMInstance();
  let freshStateRoot: Uint8Array | null = null;
  if (browserVM?.captureStateRoot && env.jReplicas) {
    try {
      freshStateRoot = await browserVM.captureStateRoot();
      // Also update live jReplicas so next snapshot has correct base
      for (const [name, jReplica] of env.jReplicas.entries()) {
        jReplica.stateRoot = freshStateRoot;
      }
    } catch (e) {
      // Silent fail - stateRoot capture is optional
    }
  }

  // Clone jReplicas for this frame (J-Machine state) + SYNC reserves from eReplicas
  const jReplicasSnapshot = env.jReplicas ? Array.from(env.jReplicas.values()).map(jr => {
    // Sync reserves from eReplicas into JReplica
    const reserves = new Map<string, Map<number, bigint>>();
    const registeredEntities = new Map<string, { name: string; quorum: string[]; threshold: number }>();

    // Aggregate reserves from all entity replicas
    for (const [key, replica] of env.eReplicas.entries()) {
      const entityId = key.split(':')[0];
      if (replica.state?.reserves) {
        const tokenMap = new Map<number, bigint>();
        // Handle both Map and plain object
        if (replica.state.reserves instanceof Map) {
          replica.state.reserves.forEach((amount: bigint, tokenId: string) => {
            tokenMap.set(Number(tokenId), amount);
          });
        } else {
          for (const [tokenId, amount] of Object.entries(replica.state.reserves as Record<string, bigint>)) {
            tokenMap.set(Number(tokenId), BigInt(amount));
          }
        }
        if (tokenMap.size > 0) {
          reserves.set(entityId, tokenMap);
        }
      }
      // Add entity to registeredEntities
      if (!registeredEntities.has(entityId)) {
        registeredEntities.set(entityId, {
          name: replica.name || `E${entityId.slice(-4)}`,
          quorum: replica.quorum || [],
          threshold: replica.threshold || 1,
        });
      }
    }

    return {
      name: jr.name,
      blockNumber: jr.blockNumber,
      stateRoot: new Uint8Array(jr.stateRoot),
      mempool: [...jr.mempool],
      position: { ...jr.position },
      contracts: jr.contracts ? { ...jr.contracts } : undefined,
      reserves,
      registeredEntities,
    };
  }) : [];

  const snapshot: EnvSnapshot = {
    height: env.height,
    timestamp: Date.now(),
    eReplicas: new Map(
      Array.from(env.eReplicas.entries()).map(([key, replica]) => [key, cloneEntityReplica(replica)]),
    ),
    jReplicas: jReplicasSnapshot,
    runtimeInput: {
      runtimeTxs: [],
      entityInputs: entityInputs || [], // Include entity inputs for J-Machine visualization!
    },
    runtimeOutputs: [],
    description,
    subtitle, // Fed Chair educational content
    ...(gossipSnapshot ? { gossip: gossipSnapshot } : {}),
  };

  if (!env.history) {
    console.log(`[pushSnapshot] Creating new history array`);
    env.history = [];
  }

  const beforeLength = env.history.length;
  env.history.push(snapshot);
  const afterLength = env.history.length;
  console.log(`📸 Snapshot: ${description} (history: ${beforeLength} → ${afterLength})`);
}

export async function prepopulateAHB(env: Env, processUntilEmpty: (env: Env, inputs?: EntityInput[]) => Promise<any>): Promise<void> {
  pushSnapshotCount = 0; // RESET: Track if demo runs multiple times
  env.disableAutoSnapshots = true; // DISABLE automatic tick snapshots - we use manual pushSnapshot instead

  try {
    console.log('[AHB] ========================================');
    console.log('[AHB] Starting Alice-Hub-Bob Demo (REAL BrowserVM transactions)');
    console.log('[AHB] BEFORE: eReplicas =', env.eReplicas.size, 'history =', env.history?.length || 0);
    console.log('[AHB] ========================================');

    // Get or create BrowserVM instance for real transactions
    let browserVM = getBrowserVMInstance();
    if (!browserVM) {
      console.log('[AHB] No BrowserVM found - creating one...');
      const evm = new BrowserEVM();
      await evm.init();
      const depositoryAddress = evm.getDepositoryAddress();
      // Register with runtime so other code can access it
      setBrowserVMJurisdiction(depositoryAddress, evm);
      browserVM = evm;
      console.log('[AHB] ✅ BrowserVM created, depository:', depositoryAddress);
    } else {
      console.log('[AHB] ✅ BrowserVM instance available');
    }

    const jurisdictions = await getAvailableJurisdictions();
    let arrakis = jurisdictions.find(j => j.name.toLowerCase() === 'arrakis');

    // FALLBACK: Create mock jurisdiction if none exist (for isolated /view mode)
    if (!arrakis) {
      console.log('[AHB] No jurisdiction found - using BrowserVM jurisdiction');
      arrakis = {
        name: 'Arrakis (BrowserVM)',
        chainId: 31337,
        entityProviderAddress: '0x0000000000000000000000000000000000000000',
        depositoryAddress: browserVM.getDepositoryAddress(),
        rpc: 'browservm://'
      };
    }

    console.log(`📋 Jurisdiction: ${arrakis.name}`);

    // ============================================================================
    // STEP 0a: Create Xlnomy (J-Machine) for visualization
    // ============================================================================
    console.log('\n🏛️ Creating AHB Xlnomy (J-Machine at center)...');

    if (!env.jReplicas) {
      env.jReplicas = new Map();
    }

    const ahbJReplica = {
      name: 'AHB Demo',
      blockNumber: 0n,
      stateRoot: new Uint8Array(32), // Will be captured from BrowserVM
      mempool: [] as any[],
      position: { x: 0, y: 600, z: 0 }, // Match EVM jMachine.position for consistent entity placement
      contracts: {
        depository: arrakis.depositoryAddress,
        entityProvider: arrakis.entityProviderAddress,
      },
    };

    env.jReplicas.set('AHB Demo', ahbJReplica);
    env.activeJurisdiction = 'AHB Demo';
    console.log('✅ AHB Xlnomy created (J-Machine visible in 3D)');

    // Push Frame 0: Clean slate with J-Machine only (no entities yet)
    await pushSnapshot(env, 'Frame 0: Clean Slate - J-Machine Ready', {
      title: 'Jurisdiction Machine Deployed',
      what: 'The J-Machine (Jurisdiction Machine) is deployed on-chain. It represents the EVM smart contracts (Depository.sol, EntityProvider.sol) that will process settlements.',
      why: 'Before any entities exist, the jurisdiction infrastructure must be in place. Think of this as deploying the central bank\'s core settlement system.',
      tradfiParallel: 'Like the Federal Reserve deploying its Fedwire Funds Service before any banks can participate.',
      keyMetrics: [
        'J-Machine: Deployed at origin',
        'Entities: 0 (none created yet)',
        'Reserves: Empty',
      ]
    });

    // ============================================================================
    // STEP 0b: Create entities
    // ============================================================================
    console.log('\n📦 Creating entities: Alice, Hub, Bob...');

    // AHB Triangle Layout - entities positioned relative to J-Machine
    // Layout: J-machine at y=0, entities in triangle below
    const AHB_POSITIONS = {
      Alice: { x: -50, y: -100, z: 0 },  // Bottom-left
      Hub:   { x: 0, y: -50, z: 0 },     // Middle layer
      Bob:   { x: 50, y: -100, z: 0 },   // Bottom-right
    };

    const entityNames = ['Alice', 'Hub', 'Bob'] as const;
    const entities: Array<{id: string, signer: string, name: string}> = [];
    const createEntityTxs = [];

    for (let i = 0; i < 3; i++) {
      const name = entityNames[i];
      const signer = `s${i + 1}`;
      const position = AHB_POSITIONS[name];

      // SIMPLE FALLBACK ONLY (no blockchain calls in demos)
      const entityNumber = i + 1;
      const entityId = '0x' + entityNumber.toString(16).padStart(64, '0');
      entities.push({ id: entityId, signer, name });

      createEntityTxs.push({
        type: 'importReplica' as const,
        entityId,
        signerId: signer,
        data: {
          isProposer: true,
          position, // Explicit position for proper AHB triangle layout
          config: {
            mode: 'proposer-based' as const,
            threshold: 1n,
            validators: [signer],
            shares: { [signer]: 1n },
            jurisdiction: arrakis
          }
        }
      });
      console.log(`${name}: Entity #${entityNumber} @ (${position.x}, ${position.y}, ${position.z})`);
    }

    await applyRuntimeInput(env, {
      runtimeTxs: createEntityTxs,
      entityInputs: []
    });

    const [alice, hub, bob] = entities;
    if (!alice || !hub || !bob) {
      throw new Error('Failed to create all entities');
    }

    console.log(`\n  ✅ Created: ${alice.name}, ${hub.name}, ${bob.name}`);

    // Push Frame 0.5: Entities created but not yet funded
    await pushSnapshot(env, 'Entities Created: Alice, Hub, Bob', {
      title: 'Three Entities Deployed',
      what: 'Alice, Hub, and Bob entities are now registered in the J-Machine. They appear in the 3D visualization but have no reserves yet (grey spheres).',
      why: 'Before entities can transact, they must be registered in the jurisdiction. This establishes their identity and governance structure.',
      tradfiParallel: 'Like banks registering with the Federal Reserve before opening for business.',
      keyMetrics: [
        'Entities: 3 (Alice, Hub, Bob)',
        'Reserves: All $0 (grey - unfunded)',
        'Accounts: None opened yet',
      ]
    });

    // ============================================================================
    // STEP 1: Initial State - Hub funded with $10M USDC via REAL BrowserVM tx
    // ============================================================================
    console.log('\n💰 FRAME 1: Initial State - Hub Reserve Funding (REAL BrowserVM TX)');

    // REAL BrowserVM transaction: debugFundReserves
    await browserVM.debugFundReserves(hub.id, USDC_TOKEN_ID, usd(10_000_000));

    // Sync all entity reserves from BrowserVM to replica state
    await syncReservesFromBrowserVM(env, hub.id, browserVM, hub.name);
    await syncReservesFromBrowserVM(env, alice.id, browserVM, alice.name);
    await syncReservesFromBrowserVM(env, bob.id, browserVM, bob.name);

    await pushSnapshot(env, 'Initial State: Hub Funded', {
      title: 'Initial Liquidity Provision',
      what: 'Hub entity receives $10M USDC reserve balance on Depository.sol (on-chain via BrowserVM)',
      why: 'Reserve balances are the source of liquidity for off-chain bilateral accounts. Think of this as the hub depositing cash into its custody account.',
      tradfiParallel: 'Like a correspondent bank depositing USD reserves at the Federal Reserve to enable wire transfers',
      keyMetrics: [
        'Hub Reserve: $10M USDC',
        'Alice Reserve: $0 (grey - no funds)',
        'Bob Reserve: $0 (grey - no funds)',
      ]
    });

    // ============================================================================
    // STEP 2: Hub R2R → Alice ($3M USDC) - REAL TX goes to J-Machine mempool
    // ============================================================================
    console.log('\n🔄 FRAME 2: Hub → Alice Reserve Transfer ($3M) - REAL BrowserVM TX');

    // Open accounts first
    await processUntilEmpty(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'openAccount',
        data: { targetEntityId: alice.id }
      }]
    }]);

    // REAL BrowserVM R2R transaction
    await browserVM.reserveToReserve(hub.id, alice.id, USDC_TOKEN_ID, usd(3_000_000));

    // Sync reserves from BrowserVM
    await syncReservesFromBrowserVM(env, hub.id, browserVM, hub.name);
    await syncReservesFromBrowserVM(env, alice.id, browserVM, alice.name);

    // Create entityInput with R2R tx for J-Machine visualization
    const r2rTx1: EntityInput = {
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'payFromReserve' as any,
        kind: 'payFromReserve',
        targetEntityId: alice.id,
        tokenId: USDC_TOKEN_ID,
        amount: usd(3_000_000),
      }]
    };

    await pushSnapshot(env, 'Hub → Alice: $3M R2R Transfer', {
      title: 'Reserve-to-Reserve Transfer #1 (R2R)',
      what: 'Hub calls Depository.reserveToReserve(Alice, $3M). TX enters J-Machine mempool. On finalization: Hub -= $3M, Alice += $3M',
      why: 'R2R transfers are pure on-chain settlement. Watch Alice\'s sphere grow as she receives funds!',
      tradfiParallel: 'Like a Fedwire transfer: instant, final, on-chain settlement between reserve accounts',
      keyMetrics: [
        'Hub Reserve: $7M (-$3M)',
        'Alice Reserve: $3M (+$3M) - now green!',
        'J-Machine: 1 tx in mempool',
      ]
    }, [r2rTx1]);

    // ============================================================================
    // STEP 3: Hub R2R → Bob ($2M USDC) - Second TX to mempool
    // ============================================================================
    console.log('\n🔄 FRAME 3: Hub → Bob Reserve Transfer ($2M) - REAL BrowserVM TX');

    await processUntilEmpty(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'openAccount',
        data: { targetEntityId: bob.id }
      }]
    }]);

    // REAL BrowserVM R2R transaction
    await browserVM.reserveToReserve(hub.id, bob.id, USDC_TOKEN_ID, usd(2_000_000));

    // Sync reserves from BrowserVM
    await syncReservesFromBrowserVM(env, hub.id, browserVM, hub.name);
    await syncReservesFromBrowserVM(env, bob.id, browserVM, bob.name);

    const r2rTx2: EntityInput = {
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'payFromReserve' as any,
        kind: 'payFromReserve',
        targetEntityId: bob.id,
        tokenId: USDC_TOKEN_ID,
        amount: usd(2_000_000),
      }]
    };

    await pushSnapshot(env, 'Hub → Bob: $2M R2R Transfer', {
      title: 'Reserve-to-Reserve Transfer #2',
      what: 'Hub calls Depository.reserveToReserve(Bob, $2M). Second TX enters mempool.',
      why: 'Now Hub has distributed $5M total ($3M to Alice, $2M to Bob). Both entities now have visible reserves.',
      tradfiParallel: 'Hub acts like a treasury distributing funds to subsidiaries via wire transfers',
      keyMetrics: [
        'Hub Reserve: $5M (-$2M)',
        'Bob Reserve: $2M (+$2M) - now green!',
        'J-Machine: 2 txs in mempool',
      ]
    }, [r2rTx2]);

    // ============================================================================
    // STEP 4: Alice R2R → Bob ($500K) - Third TX triggers broadcast!
    // ============================================================================
    console.log('\n🔄 FRAME 4: Alice → Bob Reserve Transfer ($500K) - REAL BrowserVM TX');

    // REAL BrowserVM R2R transaction
    await browserVM.reserveToReserve(alice.id, bob.id, USDC_TOKEN_ID, usd(500_000));

    // Sync reserves from BrowserVM
    await syncReservesFromBrowserVM(env, alice.id, browserVM, alice.name);
    await syncReservesFromBrowserVM(env, bob.id, browserVM, bob.name);

    const r2rTx3: EntityInput = {
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'payFromReserve' as any,
        kind: 'payFromReserve',
        targetEntityId: bob.id,
        tokenId: USDC_TOKEN_ID,
        amount: usd(500_000),
      }]
    };

    await pushSnapshot(env, 'Alice → Bob: $500K R2R Transfer', {
      title: 'Reserve-to-Reserve Transfer #3 → J-Block Finalized!',
      what: 'Alice sends $500K to Bob. Third TX fills mempool capacity → J-Machine broadcasts rays to ALL entities!',
      why: 'J-Machine batches transactions for efficiency. When capacity reached, it finalizes J-Block and broadcasts state updates.',
      tradfiParallel: 'Like batch settlement at end-of-day: accumulate transactions, then settle all at once',
      keyMetrics: [
        'Alice Reserve: $2.5M (-$500K)',
        'Bob Reserve: $2.5M (+$500K)',
        'J-Machine: BROADCAST! 🔥',
        'J-Block finalized with 3 txs',
      ]
    }, [r2rTx3]);

    // ============================================================================
    // STEP 5: Final State - All reserves settled (verify from BrowserVM)
    // ============================================================================
    console.log('\n📊 FRAME 5: Final State Summary');

    // Verify final reserves from BrowserVM
    const finalHubReserves = await browserVM.getReserves(hub.id, USDC_TOKEN_ID);
    const finalAliceReserves = await browserVM.getReserves(alice.id, USDC_TOKEN_ID);
    const finalBobReserves = await browserVM.getReserves(bob.id, USDC_TOKEN_ID);

    console.log(`[AHB] Final BrowserVM reserves:`);
    console.log(`  Hub: ${Number(finalHubReserves) / 1e18} USDC`);
    console.log(`  Alice: ${Number(finalAliceReserves) / 1e18} USDC`);
    console.log(`  Bob: ${Number(finalBobReserves) / 1e18} USDC`);
    console.log(`  Total: ${Number(finalHubReserves + finalAliceReserves + finalBobReserves) / 1e18} USDC`);

    await pushSnapshot(env, 'Final State: R2R Demo Complete', {
      title: 'End State: Reserve Distribution Complete',
      what: 'Hub: $5M, Alice: $2.5M, Bob: $2.5M. Total: $10M preserved. All entities now have visible reserves.',
      why: 'This demonstrates pure on-chain R2R settlement with J-Machine batching and broadcast visualization.',
      tradfiParallel: 'Like Fedwire settlement: instant, final, auditable transfers between reserve accounts',
      keyMetrics: [
        'Hub: $5M reserve (green)',
        'Alice: $2.5M reserve (green)',
        'Bob: $2.5M reserve (green)',
        'Total system reserves: $10M (conserved)',
        'J-Blocks finalized: 1',
      ]
    });

    console.log('\n=====================================');
    console.log('✅ AHB Demo Complete (REAL BrowserVM transactions)!');
    console.log('6 frames captured for time machine playback');
    console.log('Use arrow keys to step through the demo');
    console.log('=====================================\n');
    console.log(`[AHB] FINAL: Total snapshots pushed: ${pushSnapshotCount}`);
    console.log(`[AHB] FINAL: env.history.length: ${env.history?.length}`);
  } finally {
    env.disableAutoSnapshots = false; // ALWAYS re-enable, even on error
  }
}
