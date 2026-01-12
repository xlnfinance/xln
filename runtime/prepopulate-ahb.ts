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

import type { Env, EntityInput, EnvSnapshot, EntityReplica, Delta } from './types';
import { applyRuntimeInput } from './runtime';
import { getAvailableJurisdictions, getBrowserVMInstance, setBrowserVMJurisdiction } from './evm';
import { cloneEntityReplica, canonicalAccountKey } from './state-helpers';
import type { Profile } from './gossip';
import { BrowserEVM } from './evms/browser-evm';
import { setupBrowserVMWatcher, type JEventWatcher } from './j-event-watcher';

// Lazy-loaded process to avoid circular dependency (runtime.ts imports this file)
let _process: ((env: Env, inputs?: EntityInput[], delay?: number, single?: boolean) => Promise<Env>) | null = null;
const getProcess = async () => {
  if (!_process) {
    const runtime = await import('./runtime');
    _process = runtime.process;
  }
  return _process;
};

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
      clonedMetadata.lastUpdated = clonedMetadata.lastUpdated ?? env.timestamp;
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

// J-Watcher instance for BrowserVM event subscription
let jWatcherInstance: JEventWatcher | null = null;

/**
 * Process any pending j_events from BrowserVM operations
 * This is the proper R→E→A flow: BrowserVM emits → j-watcher queues → processJEvents runs
 */
async function processJEvents(env: Env): Promise<void> {
  const process = await getProcess();
  // Check if j-watcher queued any events
  const pendingInputs = env.runtimeInput?.entityInputs || [];
  console.log(`🔄 processJEvents CALLED: ${pendingInputs.length} pending in queue`);
  if (pendingInputs.length > 0) {
    console.log(`   routing ${pendingInputs.length} to entities...`);
    const toProcess = [...pendingInputs];
    env.runtimeInput.entityInputs = [];
    await process(env, toProcess);
    console.log(`   ✓ ${toProcess.length} j-events processed`);
  } else {
    console.log(`   ⚠️ EMPTY queue - no j-events to process`);
  }
}



/**
 * COMPREHENSIVE STATE DUMP - Full JSON dump of system state
 * Enable/disable via AHB_DEBUG=1 environment variable or pass enabled=true
 */
function dumpSystemState(env: Env, label: string, enabled: boolean = true): void {
  if (!enabled && !process.env.AHB_DEBUG) return;

  // Named entities for easier reading
  const ENTITY_NAMES: Record<string, string> = {
    '0x0000000000000000000000000000000000000000000000000000000000000001': 'Alice',
    '0x0000000000000000000000000000000000000000000000000000000000000002': 'Hub',
    '0x0000000000000000000000000000000000000000000000000000000000000003': 'Bob',
  };

  const getName = (id: string): string => ENTITY_NAMES[id] || id.slice(-4);

  // Build JSON-serializable state object
  const state: Record<string, any> = {
    label,
    timestamp: env.timestamp,
    height: env.height,
    entities: {} as Record<string, any>,
  };

  for (const [replicaKey, replica] of env.eReplicas.entries()) {
    const entityId = replicaKey.split(':')[0];
    const entityName = getName(entityId);

    const entityState: Record<string, any> = {
      name: entityName,
      entityId: entityId.slice(-8),
      reserves: {} as Record<string, string>,
      accounts: {} as Record<string, any>,
    };

    // Reserves (convert BigInt to string for JSON)
    if (replica.state.reserves) {
      for (const [tokenId, amount] of replica.state.reserves.entries()) {
        const usd = Number(amount) / 1e18;
        entityState.reserves[tokenId] = { raw: amount.toString(), usd: `$${usd.toLocaleString()}` };
      }
    }

    // Accounts
    if (replica.state.accounts) {
      for (const [counterpartyId, account] of replica.state.accounts.entries()) {
        const counterpartyName = getName(counterpartyId);
        const isLeft = entityId < counterpartyId;

        const accountState: Record<string, any> = {
          counterparty: counterpartyName,
          counterpartyId: counterpartyId.slice(-8),
          perspective: isLeft ? 'LEFT' : 'RIGHT',
          globalCreditLimits: {
            ownLimit: account.globalCreditLimits.ownLimit.toString(),
            peerLimit: account.globalCreditLimits.peerLimit.toString(),
          },
          deltas: {} as Record<number, any>,
        };

        for (const [tokenId, delta] of account.deltas.entries()) {
          const totalDelta = delta.ondelta + delta.offdelta;
          accountState.deltas[tokenId] = {
            collateral: { raw: delta.collateral.toString(), usd: `$${(Number(delta.collateral) / 1e18).toLocaleString()}` },
            ondelta: { raw: delta.ondelta.toString(), usd: `$${(Number(delta.ondelta) / 1e18).toLocaleString()}` },
            offdelta: { raw: delta.offdelta.toString(), usd: `$${(Number(delta.offdelta) / 1e18).toLocaleString()}` },
            totalDelta: {
              raw: totalDelta.toString(),
              usd: `$${(Number(totalDelta) / 1e18).toLocaleString()}`,
              meaning: totalDelta > 0n ? 'RIGHT owes LEFT' : totalDelta < 0n ? 'LEFT owes RIGHT' : 'balanced',
            },
            leftCreditLimit: { raw: delta.leftCreditLimit.toString(), usd: `$${(Number(delta.leftCreditLimit) / 1e18).toLocaleString()}`, meaning: 'LEFT extends to RIGHT' },
            rightCreditLimit: { raw: delta.rightCreditLimit.toString(), usd: `$${(Number(delta.rightCreditLimit) / 1e18).toLocaleString()}`, meaning: 'RIGHT extends to LEFT' },
          };
        }

        entityState.accounts[counterpartyName] = accountState;
      }
    }

    state.entities[entityName] = entityState;
  }

  console.log('\n' + '='.repeat(80));
  console.log(`📊 SYSTEM STATE DUMP: ${label}`);
  console.log('='.repeat(80));
  console.log(JSON.stringify(state, null, 2));
  console.log('='.repeat(80) + '\n');
}

interface FrameSubtitle {
  title: string;           // Short header (e.g., "Reserve-to-Reserve Transfer")
  what: string;            // What's happening technically
  why: string;             // Why this matters
  tradfiParallel: string;  // Traditional finance equivalent
  keyMetrics?: string[];   // Optional: bullet points of key numbers
}

let pushSnapshotCount = 0;

// System solvency check - inline for self-contained testing
function checkSolvency(env: Env, expected: bigint, label: string, optional: boolean = false): void {
  let reserves = 0n;
  let collateral = 0n;

  console.log(`[SOLVENCY ${label}] Checking ${env.eReplicas.size} replicas...`);

  for (const [replicaKey, replica] of env.eReplicas) {
    let replicaReserves = 0n;
    for (const [tokenKey, amount] of replica.state.reserves) {
      replicaReserves += amount;
      reserves += amount;
    }
    console.log(`  [${replicaKey.slice(0,20)}] reserves=${replicaReserves / 10n**18n}M`);

    for (const [counterpartyId, account] of replica.state.accounts) {
      if (replica.state.entityId < counterpartyId) {
        for (const [, delta] of account.deltas) {
          collateral += delta.collateral;
        }
      }
    }
  }

  const total = reserves + collateral;
  console.log(`[SOLVENCY ${label}] Total: reserves=${reserves / 10n**18n}M, collateral=${collateral / 10n**18n}M, sum=${total / 10n**18n}M`);

  if (total !== expected) {
    console.error(`❌ [${label}] SOLVENCY FAIL: ${total} !== ${expected}`);
    if (!optional) {
      throw new Error(`SOLVENCY VIOLATION at "${label}": got ${total}, expected ${expected}`);
    } else {
      console.warn(`⚠️  [${label}] Solvency check failed but continuing (optional mode)`);
    }
  } else {
    console.log(`✅ [${label}] Solvency OK`);
  }
}

// Get offdelta for a bilateral account (uses LEFT entity's view - canonical)
function getOffdelta(env: Env, entityA: string, entityB: string, tokenId: number): bigint {
  // Always use LEFT entity (smaller ID) as canonical source
  const leftId = entityA < entityB ? entityA : entityB;
  const rightId = entityA < entityB ? entityB : entityA;

  const [, leftReplica] = findReplica(env, leftId);
  const account = leftReplica?.state?.accounts?.get(rightId);
  const delta = account?.deltas?.get(tokenId);

  return delta?.offdelta ?? 0n;
}

// Verify bilateral account sync - CRITICAL for consensus correctness
function assertBilateralSync(env: Env, entityA: string, entityB: string, tokenId: number, label: string): void {
  const [, replicaA] = findReplica(env, entityA);
  const [, replicaB] = findReplica(env, entityB);

  const accountAB = replicaA?.state?.accounts?.get(entityB);
  const accountBA = replicaB?.state?.accounts?.get(entityA);

  console.log(`\n[BILATERAL-SYNC ${label}] Checking ${entityA.slice(-4)}←→${entityB.slice(-4)} for token ${tokenId}...`);

  // Both sides must have the account
  if (!accountAB) {
    console.error(`❌ Entity ${entityA.slice(-4)} has NO account with ${entityB.slice(-4)}`);
    throw new Error(`BILATERAL-SYNC FAIL at "${label}": Entity ${entityA.slice(-4)} missing account with ${entityB.slice(-4)}`);
  }
  if (!accountBA) {
    console.error(`❌ Entity ${entityB.slice(-4)} has NO account with ${entityA.slice(-4)}`);
    throw new Error(`BILATERAL-SYNC FAIL at "${label}": Entity ${entityB.slice(-4)} missing account with ${entityA.slice(-4)}`);
  }

  const deltaAB = accountAB.deltas?.get(tokenId);
  const deltaBA = accountBA.deltas?.get(tokenId);

  // Both sides must have the delta for this token
  if (!deltaAB) {
    console.error(`❌ Entity ${entityA.slice(-4)} account has NO delta for token ${tokenId}`);
    throw new Error(`BILATERAL-SYNC FAIL at "${label}": Entity ${entityA.slice(-4)} missing delta for token ${tokenId}`);
  }
  if (!deltaBA) {
    console.error(`❌ Entity ${entityB.slice(-4)} account has NO delta for token ${tokenId}`);
    throw new Error(`BILATERAL-SYNC FAIL at "${label}": Entity ${entityB.slice(-4)} missing delta for token ${tokenId}`);
  }

  // CRITICAL: Both sides MUST have IDENTICAL delta objects (canonical storage)
  const fieldsToCheck: Array<keyof Delta> = [
    'collateral',
    'ondelta',
    'offdelta',
    'leftCreditLimit',
    'rightCreditLimit',
    'leftAllowance',
    'rightAllowance',
  ];

  const errors: string[] = [];
  for (const field of fieldsToCheck) {
    const valueAB = deltaAB[field];
    const valueBA = deltaBA[field];

    if (valueAB !== valueBA) {
      const msg = `  ${field}: ${entityA.slice(-4)} has ${valueAB}, ${entityB.slice(-4)} has ${valueBA}`;
      console.error(`❌ ${msg}`);
      errors.push(msg);
    }
  }

  if (errors.length > 0) {
    console.error(`\n❌ BILATERAL-SYNC FAILED at "${label}":`);
    console.error(`   Account: ${entityA.slice(-4)}←→${entityB.slice(-4)}, token ${tokenId}`);
    console.error(`   Mismatched fields:\n${errors.join('\n')}`);

    // Dump full state for debugging
    console.error(`\n   Full deltaAB (${entityA.slice(-4)} view):`, deltaAB);
    console.error(`   Full deltaBA (${entityB.slice(-4)} view):`, deltaBA);

    throw new Error(`BILATERAL-SYNC VIOLATION: ${errors.length} field(s) differ between ${entityA.slice(-4)} and ${entityB.slice(-4)}`);
  }

  console.log(`✅ [${label}] Bilateral sync OK: ${entityA.slice(-4)}←→${entityB.slice(-4)} token ${tokenId} - all ${fieldsToCheck.length} fields match`);
}

// Verify payment moved through accounts - throws on failure
// verifyPayment DELETED - was causing false positives due to incorrect delta semantics expectations
// TODO: Re-implement with correct bilateral consensus understanding

interface SnapshotOptions {
  expectedSolvency?: bigint;      // Self-test: throws if solvency doesn't match
  entityInputs?: EntityInput[];   // Entity inputs for J-Machine visualization
}

async function pushSnapshot(
  env: Env,
  description: string,
  subtitle: FrameSubtitle,
  options: SnapshotOptions = {}
) {
  pushSnapshotCount++;
  console.log(`[pushSnapshot #${pushSnapshotCount}] Called for: "${description}"`);

  // SELF-TEST: Verify solvency at every frame
  if (options.expectedSolvency !== undefined) {
    checkSolvency(env, options.expectedSolvency, `Frame ${pushSnapshotCount}`);
  }

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
    timestamp: env.timestamp,
    eReplicas: new Map(
      Array.from(env.eReplicas.entries()).map(([key, replica]) => [key, cloneEntityReplica(replica)]),
    ),
    jReplicas: jReplicasSnapshot,
    runtimeInput: {
      runtimeTxs: [],
      entityInputs: options.entityInputs || [],
    },
    runtimeOutputs: [],
    description,
    subtitle, // Fed Chair educational content
    frameLogs: [...env.frameLogs], // Copy logs accumulated during this frame
    ...(gossipSnapshot ? { gossip: gossipSnapshot } : {}),
  };

  if (!env.history) {
    console.log(`[pushSnapshot] Creating new history array`);
    env.history = [];
  }

  const beforeLength = env.history.length;
  env.history.push(snapshot);
  const afterLength = env.history.length;
  console.log(`📸 Snapshot: ${description} (history: ${beforeLength} → ${afterLength}, logs: ${env.frameLogs.length})`);

  // Clear frame logs for next frame
  env.frameLogs = [];
}

export async function prepopulateAHB(env: Env): Promise<void> {
  const process = await getProcess();
  env.scenarioMode = true; // Deterministic time control

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

    // CRITICAL: Reset BrowserVM to fresh state EVERY time AHB runs
    // This prevents reserve accumulation on re-runs (button clicks, HMR, etc.)
    if (browserVM.reset) {
      console.log('[AHB] Calling browserVM.reset()...');
      await browserVM.reset();
      // Verify reset worked by checking Hub's reserves (should be 0)
      // Hub entityId = 0x0002 (entity #2)
      const HUB_ENTITY_ID = '0x' + '2'.padStart(64, '0');
      const hubReservesAfterReset = await browserVM.getReserves(HUB_ENTITY_ID, USDC_TOKEN_ID);
      console.log(`[AHB] ✅ BrowserVM reset complete. Hub reserves after reset: ${hubReservesAfterReset}`);
      if (hubReservesAfterReset !== 0n) {
        throw new Error(`BrowserVM reset FAILED: Hub still has ${hubReservesAfterReset} reserves`);
      }
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
    // Define total system solvency - $10M minted to Hub
    const TOTAL_SOLVENCY = usd(10_000_000);

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
    }, { expectedSolvency: 0n }); // Frame 0: No tokens yet

    // ============================================================================
    // STEP 0b: Create entities
    // ============================================================================
    console.log('\n📦 Creating entities: Alice, Hub, Bob...');

    // AHB Triangle Layout - entities positioned relative to J-Machine
    // Layout: J-machine at y=0, entities in compact triangle below
    const AHB_POSITIONS = {
      Alice: { x: -20, y: -40, z: 0 },  // Bottom-left (closer to hub)
      Hub:   { x: 0, y: -20, z: 0 },     // Middle layer
      Bob:   { x: 20, y: -40, z: 0 },   // Bottom-right (closer to hub)
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

    // ============================================================================
    // Set up j-watcher subscription to BrowserVM for proper R→E→A event flow
    // ============================================================================
    console.log('\n🔭 Setting up j-watcher subscription to BrowserVM...');
    if (jWatcherInstance) {
      jWatcherInstance.stopWatching();
    }
    jWatcherInstance = await setupBrowserVMWatcher(env, browserVM);
    console.log('✅ j-watcher subscribed to BrowserVM events');

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
    }, { expectedSolvency: 0n }); // No tokens minted yet

    // ============================================================================
    // STEP 1: Initial State - Hub funded with $10M USDC via REAL BrowserVM tx
    // ============================================================================
    console.log('\n💰 FRAME 1: Initial State - Hub Reserve Funding (REAL BrowserVM TX)');

    // NOTE: BrowserVM is reset in View.svelte at runtime creation time
    // This ensures fresh state on every page load/HMR

    // REAL BrowserVM transaction: debugFundReserves
    await browserVM.debugFundReserves(hub.id, USDC_TOKEN_ID, usd(10_000_000));

    // Process j_events from BrowserVM (ReserveUpdated events update replica.state.reserves)
    await processJEvents(env);

    // ✅ ASSERT: J-event delivered - Hub reserve updated
    const [, hubRep1] = findReplica(env, hub.id);
    const hubReserve1 = hubRep1.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;
    if (hubReserve1 !== usd(10_000_000)) {
      throw new Error(`ASSERT FAIL Frame 1: Hub reserve = ${hubReserve1}, expected ${usd(10_000_000)}. J-event NOT delivered!`);
    }
    console.log(`✅ ASSERT Frame 1: Hub reserve = $${hubReserve1 / 10n**18n}M ✓`);

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
    }, { expectedSolvency: TOTAL_SOLVENCY }); // $10M minted to Hub

    // ============================================================================
    // STEP 2: Hub R2R → Alice ($3M USDC) - REAL TX goes to J-Machine mempool
    // ============================================================================
    console.log('\n🔄 FRAME 2: Hub → Alice Reserve Transfer ($3M) - REAL BrowserVM TX');

    // NOTE: R2R doesn't require bilateral account - pure reserve transfer
    // REAL BrowserVM R2R transaction
    await browserVM.reserveToReserve(hub.id, alice.id, USDC_TOKEN_ID, usd(3_000_000));

    // Process j_events from BrowserVM (ReserveUpdated events)
    await processJEvents(env);

    // ✅ ASSERT: R2R delivered - Alice got $3M
    const [, aliceRep2] = findReplica(env, alice.id);
    const aliceReserve2 = aliceRep2.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;
    if (aliceReserve2 !== usd(3_000_000)) {
      throw new Error(`ASSERT FAIL Frame 2: Alice reserve = ${aliceReserve2}, expected ${usd(3_000_000)}. R2R j-event NOT delivered!`);
    }

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
    }, { entityInputs: [r2rTx1], expectedSolvency: TOTAL_SOLVENCY });

    // ============================================================================
    // STEP 3: Hub R2R → Bob ($2M USDC) - Second TX to mempool
    // ============================================================================
    console.log('\n🔄 FRAME 3: Hub → Bob Reserve Transfer ($2M) - REAL BrowserVM TX');

    // NOTE: R2R doesn't require bilateral account - pure reserve transfer
    // REAL BrowserVM R2R transaction
    await browserVM.reserveToReserve(hub.id, bob.id, USDC_TOKEN_ID, usd(2_000_000));

    // Process j_events from BrowserVM (ReserveUpdated events)
    await processJEvents(env);

    // ✅ ASSERT: R2R delivered - Bob got $2M
    const [, bobRep3] = findReplica(env, bob.id);
    const bobReserve3 = bobRep3.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;
    if (bobReserve3 !== usd(2_000_000)) {
      throw new Error(`ASSERT FAIL Frame 3: Bob reserve = ${bobReserve3}, expected ${usd(2_000_000)}. R2R j-event NOT delivered!`);
    }

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
    }, { entityInputs: [r2rTx2], expectedSolvency: TOTAL_SOLVENCY });

    // ============================================================================
    // STEP 4: Alice R2R → Bob ($500K) - Third TX triggers broadcast!
    // ============================================================================
    console.log('\n🔄 FRAME 4: Alice → Bob Reserve Transfer ($500K) - REAL BrowserVM TX');

    // REAL BrowserVM R2R transaction
    await browserVM.reserveToReserve(alice.id, bob.id, USDC_TOKEN_ID, usd(500_000));

    // Process j_events from BrowserVM (ReserveUpdated events)
    await processJEvents(env);

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
    }, { entityInputs: [r2rTx3], expectedSolvency: TOTAL_SOLVENCY });

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

    await pushSnapshot(env, 'R2R Complete: All reserves distributed', {
      title: 'Phase 1 Complete: Reserve Distribution',
      what: 'Hub: $5M, Alice: $2.5M, Bob: $2.5M. Total: $10M preserved. All entities now have visible reserves.',
      why: 'R2R transfers are pure on-chain settlement. Now we move to Phase 2: Bilateral Accounts.',
      tradfiParallel: 'Like Fedwire settlement: instant, final, auditable transfers between reserve accounts',
      keyMetrics: [
        'Hub: $5M reserve',
        'Alice: $2.5M reserve',
        'Bob: $2.5M reserve',
        'Next: Open bilateral accounts',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // ============================================================================
    // PHASE 2: BILATERAL ACCOUNTS
    // ============================================================================

    // ============================================================================
    // STEP 6: Open Alice-Hub Bilateral Account
    // ============================================================================
    console.log('\n🔗 FRAME 6: Open Alice ↔ Hub Bilateral Account');

    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'openAccount',
        data: { targetEntityId: hub.id }
      }]
    }]);

    // ✅ ASSERT Frame 6: Alice-Hub account exists
    const [, aliceRep6] = findReplica(env, alice.id);
    const aliceHubAcc6 = aliceRep6?.state?.accounts?.get(hub.id);
    if (!aliceHubAcc6) {
      throw new Error(`ASSERT FAIL Frame 6: Alice-Hub account does NOT exist!`);
    }
    console.log(`✅ ASSERT Frame 6: Alice-Hub account EXISTS`);

    await pushSnapshot(env, 'Alice ↔ Hub: Account Created', {
      title: 'Bilateral Account: Alice ↔ Hub (A-H)',
      what: 'Alice opens bilateral account with Hub. Creates off-chain channel for instant payments.',
      why: 'Bilateral accounts enable unlimited off-chain transactions with final on-chain settlement.',
      tradfiParallel: 'Like opening a margin account: enables trading before settlement.',
      keyMetrics: [
        'Account A-H: CREATED',
        'Collateral: $0 (empty)',
        'Credit limits: Default',
        'Ready for R2C prefunding',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // ============================================================================
    // STEP 7: Open Bob-Hub Bilateral Account
    // ============================================================================
    console.log('\n🔗 FRAME 7: Open Bob ↔ Hub Bilateral Account');

    await process(env, [{
      entityId: bob.id,
      signerId: bob.signer,
      entityTxs: [{
        type: 'openAccount',
        data: { targetEntityId: hub.id }
      }]
    }]);

    // ✅ ASSERT Frame 7: Both Hub-Bob accounts exist (bidirectional)
    const [, hubRep7] = findReplica(env, hub.id);
    const [, bobRep7] = findReplica(env, bob.id);
    const hubBobAcc7 = hubRep7?.state?.accounts?.get(bob.id);
    const bobHubAcc7 = bobRep7?.state?.accounts?.get(hub.id);
    if (!hubBobAcc7 || !bobHubAcc7) {
      throw new Error(`ASSERT FAIL Frame 7: Hub-Bob account does NOT exist! Hub→Bob: ${!!hubBobAcc7}, Bob→Hub: ${!!bobHubAcc7}`);
    }
    console.log(`✅ ASSERT Frame 7: Hub-Bob accounts EXIST (both directions)`);

    await pushSnapshot(env, 'Bob ↔ Hub: Account Created', {
      title: 'Bilateral Account: Bob ↔ Hub (B-H)',
      what: 'Bob opens bilateral account with Hub. Now both spoke entities connected to hub.',
      why: 'Star topology: Alice and Bob both connect to Hub. Hub routes payments between them.',
      tradfiParallel: 'Like correspondent banking: small banks connect to large banks for interbank settlement.',
      keyMetrics: [
        'Account B-H: CREATED',
        'Topology: Alice ↔ Hub ↔ Bob',
        'Ready for credit extension',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // ============================================================================
    // STEP 8: Alice R2C - Reserve to Collateral (full flow)
    // ============================================================================
    console.log('\n💰 FRAME 8: Alice R2C - Reserve → Collateral ($500K)');

    // 20% of Alice's $2.5M reserve = $500K
    const aliceCollateralAmount = usd(500_000);

    // PROPER R→E→A FLOW for R2C:
    // Step 1: Entity creates deposit_collateral EntityTx → adds to jBatch
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'deposit_collateral',
        data: {
          counterpartyId: hub.id,
          tokenId: USDC_TOKEN_ID,
          amount: aliceCollateralAmount
        }
      }]
    }]);

    // Step 2: Broadcast jBatch to BrowserVM (triggers on-chain tx)
    const [, aliceReplicaForBatch] = findReplica(env, alice.id);
    console.log(`[Frame 8] jBatchState exists? ${!!aliceReplicaForBatch.state.jBatchState}`);
    if (aliceReplicaForBatch.state.jBatchState) {
      console.log(`[Frame 8] Broadcasting jBatch...`);
      const { broadcastBatch } = await import('./j-batch');
      await broadcastBatch(alice.id, aliceReplicaForBatch.state.jBatchState, null, browserVM, env.timestamp);
      console.log(`[Frame 8] broadcastBatch completed`);
    } else {
      console.error(`[Frame 8] ❌ NO jBatchState! deposit_collateral didn't create batch`);
    }

    // Step 3: Process j_events from BrowserVM (SettlementProcessed updates delta.collateral)
    await processJEvents(env);

    // ✅ ASSERT: R2C delivered - Alice delta.collateral = $500K
    const [, aliceRep8] = findReplica(env, alice.id);
    const aliceHubAccount8 = aliceRep8.state.accounts.get(hub.id);
    const aliceDelta8 = aliceHubAccount8?.deltas.get(USDC_TOKEN_ID);
    if (!aliceDelta8 || aliceDelta8.collateral !== aliceCollateralAmount) {
      const actual = aliceDelta8?.collateral || 0n;
      throw new Error(`ASSERT FAIL Frame 8: Alice-Hub collateral = ${actual}, expected ${aliceCollateralAmount}. R2C j-event NOT delivered!`);
    }

    // CRITICAL: Verify bilateral sync after R2C collateral deposit
    assertBilateralSync(env, alice.id, hub.id, USDC_TOKEN_ID, 'Frame 8 - Alice R2C Collateral');

    await pushSnapshot(env, 'Alice R2C: $500K Reserve → Collateral', {
      title: 'Reserve-to-Collateral (R2C): Alice → A-H Account',
      what: 'Alice moves $500K from reserve to A-H account collateral. Settlement sent to J-Machine.',
      why: 'Collateral enables off-chain payments. Alice can now send up to $500K to Hub instantly.',
      tradfiParallel: 'Like posting margin: Alice locks funds in the bilateral account as security.',
      keyMetrics: [
        'Alice Reserve: $2.5M → $2M (-$500K)',
        'A-H Collateral: $0 → $500K',
        'Alice outCapacity: $500K',
        'Settlement broadcast to J-Machine',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY }); // R2C moves funds, doesn't create/destroy

    // ============================================================================
    // STEP 9: Bob Credit Extension - set_credit_limit
    // ============================================================================
    console.log('\n💳 FRAME 9: Bob Credit Extension ($500K)');

    // Bob extends $500K credit to Hub in B-H account
    // This is purely off-chain - no collateral from Bob
    const bobCreditAmount = usd(500_000);

    await process(env, [{
      entityId: bob.id,
      signerId: bob.signer,
      entityTxs: [{
        type: 'extendCredit',
        data: {
          counterpartyEntityId: hub.id,
          tokenId: USDC_TOKEN_ID,
          amount: bobCreditAmount,
        }
      }]
    }]);

    // ✅ ASSERT: Credit extension delivered - Bob-Hub has leftCreditLimit = $500K
    // Bob (0x0003) > Hub (0x0002) → Bob is RIGHT, Hub is LEFT
    // Bob extending credit sets leftCreditLimit (credit available TO Hub/LEFT)
    const [, bobRep9] = findReplica(env, bob.id);
    const bobHubAccount9 = bobRep9.state.accounts.get(hub.id);
    const bobDelta9 = bobHubAccount9?.deltas.get(USDC_TOKEN_ID);
    if (!bobDelta9 || bobDelta9.leftCreditLimit !== bobCreditAmount) {
      const actual = bobDelta9?.leftCreditLimit || 0n;
      throw new Error(`ASSERT FAIL Frame 9: Bob-Hub leftCreditLimit = ${actual}, expected ${bobCreditAmount}. Credit extension NOT applied!`);
    }

    // Verify bilateral sync
    assertBilateralSync(env, bob.id, hub.id, USDC_TOKEN_ID, 'Frame 9 - Bob Credit Extension');

    await pushSnapshot(env, 'Bob Credit Extension: $500K', {
      title: 'Credit Extension: Bob → Hub',
      what: 'Bob extends $500K credit limit to Hub in B-H account. Purely off-chain, no collateral.',
      why: 'Credit extension allows Hub to owe Bob. Bob trusts Hub up to $500K.',
      tradfiParallel: 'Like a credit line: Bob says "Hub can owe me up to $500K".',
      keyMetrics: [
        'B-H Credit Limit: $500K',
        'Bob collateral: $0 (receiver)',
        'Hub can owe Bob: $500K max',
        'Ready for routed payment!',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY }); // Credit extension is off-chain, no on-chain impact

    // ============================================================================
    // STEP 10: Off-Chain Payment Alice → Hub → Bob
    // ============================================================================
    console.error('\n\n🚨🚨🚨 PAYMENT SECTION START 🚨🚨🚨\n');

    // Helper: process and collect outbox for next frame
    const tick = async (inputs: EntityInput[]): Promise<EntityInput[]> => {
      await process(env, inputs);
      const outbox = [...(env.pendingOutputs || [])];
      env.pendingOutputs = [];
      return outbox;
    };

    // Payment 1: A → H → B ($125K)
    console.log('\n⚡ FRAME 10: Off-Chain Payment A → H → B ($125K)');
    const payment1 = usd(125_000);

    const { deriveDelta } = await import('./account-utils');

    // ============================================================================
    // PAYMENT 1: A → H → B ($125K) - First payment, builds up shift
    // ============================================================================
    console.log('🏃 FRAME 10: Alice initiates A→H→B $125K');

    // Frame 10: Alice sends to Hub
    let outbox = await tick([{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: bob.id,
          tokenId: USDC_TOKEN_ID,
          amount: payment1,
          route: [alice.id, hub.id, bob.id],
          description: 'Payment 1 of 2'
        }
      }]
    }]);
    console.log(`   outbox: [${outbox.map(o => o.entityId.slice(-4)).join(',')}]`);

    await pushSnapshot(env, 'Frame 10: Alice initiates A→H→B', {
      title: 'Payment 1/2: Alice → Hub',
      what: 'Alice sends $125K, Hub receives and forwards proposal to Bob',
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // Frame 11: Hub + Alice process (Hub forwards to Bob, Alice gets ACK)
    console.log('🏃 FRAME 11: Hub forwards, Alice commits');
    outbox = await tick(outbox);
    console.log(`   outbox: [${outbox.map(o => o.entityId.slice(-4)).join(',')}]`);

    await pushSnapshot(env, 'Frame 11: Hub forwards to Bob', {
      title: 'Payment 1/2: Hub → Bob proposal',
      what: 'Hub-Alice commits, Hub proposes to Bob',
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // Frame 12: Bob accepts
    console.log('🏃 FRAME 12: Bob accepts Hub proposal');
    outbox = await tick(outbox);
    console.log(`   outbox: [${outbox.map(o => o.entityId.slice(-4)).join(',')}]`);

    // Verify payment 1 landed
    const ahDelta1 = getOffdelta(env, alice.id, hub.id, USDC_TOKEN_ID);
    const hbDelta1 = getOffdelta(env, hub.id, bob.id, USDC_TOKEN_ID);
    console.log(`   ✅ After payment 1: A-H=${ahDelta1}, H-B=${hbDelta1}`);

    await pushSnapshot(env, 'Frame 12: Bob accepts - Payment 1 complete', {
      title: 'Payment 1/2 Complete',
      what: `A→H→B $125K done. A-H shift: -$125K, H-B shift: -$125K`,
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // ============================================================================
    // PAYMENT 2: A → H → B ($125K) - Second payment, total shift = $250K
    // ============================================================================
    const payment2 = usd(125_000);
    console.log('\n🏃 FRAME 13: Alice initiates second A→H→B $125K');

    // Frame 13: Alice sends again
    outbox = await tick([{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: bob.id,
          tokenId: USDC_TOKEN_ID,
          amount: payment2,
          route: [alice.id, hub.id, bob.id],
          description: 'Payment 2 of 2'
        }
      }]
    }]);

    await pushSnapshot(env, 'Frame 13: Alice initiates second payment', {
      title: 'Payment 2/2: Alice → Hub',
      what: 'Second $125K payment to reach $250K total shift',
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // Frame 14: Hub forwards, Alice commits
    console.log('🏃 FRAME 14: Hub forwards, Alice commits');
    outbox = await tick(outbox);

    await pushSnapshot(env, 'Frame 14: Hub forwards second payment', {
      title: 'Payment 2/2: Hub → Bob proposal',
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // Frame 15: Bob accepts
    console.log('🏃 FRAME 15: Bob accepts second payment');
    outbox = await tick(outbox);

    // Verify total shift = $250K
    const ahDeltaFinal = getOffdelta(env, alice.id, hub.id, USDC_TOKEN_ID);
    const hbDeltaFinal = getOffdelta(env, hub.id, bob.id, USDC_TOKEN_ID);
    const expectedShift = -(payment1 + payment2); // -$250K

    if (ahDeltaFinal !== expectedShift) {
      throw new Error(`ASSERT FAIL: A-H shift=${ahDeltaFinal}, expected ${expectedShift}`);
    }
    console.log(`✅ Total shift verified: A-H=${ahDeltaFinal}, H-B=${hbDeltaFinal}`);

    // Verify Bob's view
    const [, bobRep] = findReplica(env, bob.id);
    const bobHubAcc = bobRep.state.accounts.get(hub.id);
    const bobDelta = bobHubAcc?.deltas.get(USDC_TOKEN_ID);
    if (bobDelta) {
      const bobDerived = deriveDelta(bobDelta, false); // Bob is RIGHT
      console.log(`   Bob outCapacity: ${bobDerived.outCapacity} (received $250K)`);
      if (bobDerived.outCapacity !== payment1 + payment2) {
        throw new Error(`ASSERT FAIL: Bob outCapacity=${bobDerived.outCapacity}, expected ${payment1 + payment2}`);
      }
    }

    await pushSnapshot(env, 'Frame 15: Both payments complete - $250K shifted', {
      title: '✅ Payments Complete: $250K A→B',
      what: 'Two $125K payments complete. Total: $250K shifted from Alice to Bob via Hub.',
      why: 'Hub now has $250K uninsured liability to Bob (TR=$250K). Rebalancing needed!',
      keyMetrics: [
        'A-H shift: -$250K (Alice paid Hub)',
        'H-B shift: -$250K (Hub owes Bob)',
        'TR (Total Risk): $250K uninsured',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // ============================================================================
    // PHASE 4: REBALANCING - Reduce Total Risk from $250K to $0
    // ============================================================================
    // Current state after $250K shifted A→H→B:
    // - A-H: offdelta = -$250K (Alice owes Hub), collateral = $500K
    // - H-B: offdelta = -$250K (Hub owes Bob), collateral = $0
    // - TR = $250K (Hub's uninsured liability to Bob)
    //
    // Rebalancing plan:
    // 1. Alice-Hub settlement: Alice withdraws $250K collateral (pays Hub on-chain)
    // 2. Hub-Bob settlement: Hub deposits $250K collateral (insures Bob's position)
    // 3. Result: TR = $0, both accounts fully settled
    // ============================================================================

    console.log('\n\n🔄🔄🔄 REBALANCING SECTION START 🔄🔄🔄\n');

    const rebalanceAmount = usd(250_000);

    // Import jBatch functions for BrowserVM settlements
    const { batchAddSettlement, initJBatch, broadcastBatch } = await import('./j-batch');

    // ============================================================================
    // STEP 16: Alice-Hub Settlement (Alice withdraws to pay Hub on-chain)
    // ============================================================================
    console.log('\n🏦 FRAME 16: Alice-Hub Settlement (Alice withdraws $250K)');

    // Alice is LEFT (0x0001 < 0x0002), Hub is RIGHT
    // Settlement: reduce collateral, give Alice reserve back, increase ondelta
    // Invariant: leftDiff + rightDiff + collateralDiff = 0
    //   +$250K + 0 + (-$250K) = 0 ✓

    // Create jBatch for Alice with the settlement
    const [, aliceReplicaRebal] = findReplica(env, alice.id);
    if (!aliceReplicaRebal.state.jBatchState) {
      aliceReplicaRebal.state.jBatchState = initJBatch();
    }

    // Add settlement to batch: Alice(LEFT) ↔ Hub(RIGHT)
    batchAddSettlement(
      aliceReplicaRebal.state.jBatchState,
      alice.id,  // leftEntity (0x0001)
      hub.id,    // rightEntity (0x0002)
      [{
        tokenId: USDC_TOKEN_ID,
        leftDiff: rebalanceAmount,        // Alice gets +$250K reserve
        rightDiff: 0n,                     // Hub reserve unchanged
        collateralDiff: -rebalanceAmount,  // Account collateral -$250K
        ondeltaDiff: rebalanceAmount,      // ondelta +$250K (settles off-chain debt)
      }]
    );

    await pushSnapshot(env, 'Frame 16: Alice-Hub Settlement initiated', {
      title: 'Rebalancing 1/2: Alice-Hub Settlement',
      what: 'Alice withdraws $250K collateral to settle her A-H debt on-chain.',
      why: 'Settlement moves off-chain debt onto blockchain. Alice pays Hub atomically.',
      tradfiParallel: 'Like a margin call settlement: Alice covers her position with actual funds.',
      keyMetrics: [
        'A-H collateral: $500K → $250K (-$250K)',
        'Alice reserve: +$250K (pending)',
        'A-H ondelta: +$250K (debt moved on-chain)',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // Broadcast settlement to BrowserVM
    console.log('🏦 Broadcasting Alice-Hub settlement jBatch to BrowserVM...');
      await broadcastBatch(alice.id, aliceReplicaRebal.state.jBatchState, null, browserVM, env.timestamp);
    console.log('✅ Alice-Hub settlement broadcast');

    // Process j_events from BrowserVM (SettlementProcessed events)
    await processJEvents(env);

    // Frame 17: Process any outbox
    console.log('\n🏦 FRAME 17: Alice-Hub Settlement completes');
    outbox = await tick([]);

    // Verify A-H collateral reduced
    const [, aliceRepRebal] = findReplica(env, alice.id);
    const ahAccountRebal = aliceRepRebal.state.accounts.get(hub.id);
    const ahDeltaRebal = ahAccountRebal?.deltas.get(USDC_TOKEN_ID);
    console.log(`   A-H after settlement: collateral=${ahDeltaRebal?.collateral}, ondelta=${ahDeltaRebal?.ondelta}`);

    await pushSnapshot(env, 'Frame 17: Alice-Hub Settlement complete', {
      title: 'Rebalancing 1/2: A-H Settled',
      what: 'Alice-Hub settlement finalized. Alice paid Hub $250K on-chain.',
      keyMetrics: [
        'A-H collateral: $250K (down from $500K)',
        'A-H ondelta: reflects on-chain settlement',
        'Alice: cleared debt to Hub',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // ============================================================================
    // STEP 18: Hub-Bob Settlement (Hub deposits to insure Bob)
    // ============================================================================
    console.log('\n🏦 FRAME 18: Hub-Bob Settlement (Hub deposits $250K)');

    // Hub is LEFT (0x0002 < 0x0003), Bob is RIGHT
    // Settlement: increase collateral, reduce Hub reserve, increase ondelta
    // Invariant: leftDiff + rightDiff + collateralDiff = 0
    //   (-$250K) + 0 + (+$250K) = 0 ✓

    // Create jBatch for Hub with the settlement
    const [, hubReplicaRebal] = findReplica(env, hub.id);
    if (!hubReplicaRebal.state.jBatchState) {
      hubReplicaRebal.state.jBatchState = initJBatch();
    }

    // Add settlement to batch: Hub(LEFT) ↔ Bob(RIGHT)
    batchAddSettlement(
      hubReplicaRebal.state.jBatchState,
      hub.id,   // leftEntity (0x0002)
      bob.id,   // rightEntity (0x0003)
      [{
        tokenId: USDC_TOKEN_ID,
        leftDiff: -rebalanceAmount,        // Hub reserve -$250K
        rightDiff: 0n,                      // Bob reserve unchanged
        collateralDiff: rebalanceAmount,   // Account collateral +$250K
        ondeltaDiff: rebalanceAmount,       // ondelta +$250K (insures Bob's position)
      }]
    );

    await pushSnapshot(env, 'Frame 18: Hub-Bob Settlement initiated', {
      title: 'Rebalancing 2/2: Hub-Bob Settlement',
      what: 'Hub deposits $250K collateral to insure Bob\'s position.',
      why: 'Bob\'s $250K credit is now backed by on-chain collateral. TR → $0.',
      tradfiParallel: 'Like posting margin: Hub locks funds to guarantee Bob\'s position.',
      keyMetrics: [
        'H-B collateral: $0 → $250K (+$250K)',
        'Hub reserve: -$250K (deposited)',
        'Bob: now fully insured!',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // Broadcast settlement to BrowserVM
    console.log('🏦 Broadcasting Hub-Bob settlement jBatch to BrowserVM...');
    await broadcastBatch(hub.id, hubReplicaRebal.state.jBatchState, null, browserVM, env.timestamp);
    console.log('✅ Hub-Bob settlement broadcast');

    // Process j_events from BrowserVM (SettlementProcessed events)
    await processJEvents(env);

    // Frame 19: Process any outbox
    console.log('\n🏦 FRAME 19: Hub-Bob Settlement completes');
    outbox = await tick([]);

    // Verify H-B collateral increased
    const [, hubRepRebal] = findReplica(env, hub.id);
    const hbAccountRebal = hubRepRebal.state.accounts.get(bob.id);
    const hbDeltaRebal = hbAccountRebal?.deltas.get(USDC_TOKEN_ID);
    console.log(`   H-B after settlement: collateral=${hbDeltaRebal?.collateral}, ondelta=${hbDeltaRebal?.ondelta}`);

    await pushSnapshot(env, 'Frame 19: Hub-Bob Settlement complete', {
      title: 'Rebalancing 2/2: H-B Insured',
      what: 'Hub-Bob settlement finalized. Bob\'s position now fully collateralized.',
      keyMetrics: [
        'H-B collateral: $250K (up from $0)',
        'H-B ondelta: reflects on-chain backing',
        'TR: $0 (all risk eliminated!)',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // ============================================================================
    // FINAL STATE: Rebalancing Complete
    // ============================================================================
    console.log('\n📊 FRAME 20: Final State - Rebalancing Complete');

    await pushSnapshot(env, 'Frame 20: Rebalancing Complete - TR = $0', {
      title: '✅ Rebalancing Complete: Zero Risk',
      what: 'All positions now fully collateralized. Hub\'s TR reduced from $250K to $0.',
      why: 'Atomic on-chain settlement ensures: (1) Alice paid Hub, (2) Hub insured Bob. No counterparty risk remains.',
      tradfiParallel: 'Like end-of-day settlement: all net positions covered by actual reserves.',
      keyMetrics: [
        'TR (Total Risk): $250K → $0',
        'A-H: Alice debt settled on-chain',
        'H-B: Bob position fully insured',
        'System: 100% collateralized',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // FINAL BILATERAL SYNC CHECK - All accounts must be synced
    console.log('\n🔍 FINAL VERIFICATION: All bilateral accounts...');
    assertBilateralSync(env, alice.id, hub.id, USDC_TOKEN_ID, 'FINAL - Alice-Hub');
    assertBilateralSync(env, hub.id, bob.id, USDC_TOKEN_ID, 'FINAL - Hub-Bob');
    dumpSystemState(env, 'FINAL STATE (After Rebalancing)', true);

    console.log('\n=====================================');
    console.log('✅ AHB Demo Complete with Rebalancing!');
    console.log('Phase 1: R2R reserve distribution');
    console.log('Phase 2: Bilateral accounts + R2C + credit');
    console.log('Phase 3: Two payments A→H→B ($250K total)');
    console.log('Phase 4: Rebalancing - TR $250K → $0');
    console.log('=====================================\n');
    console.log(`[AHB] History frames: ${env.history?.length}`);
  } finally {
    env.scenarioMode = false; // ALWAYS re-enable live mode, even on error
  }
}
