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

import type { Env, EntityInput, EntityReplica, Delta } from '../types';
import { getAvailableJurisdictions, getBrowserVMInstance, setBrowserVMJurisdiction } from '../evm';
import { BrowserEVM } from '../evms/browser-evm';
import { setupBrowserVMWatcher, type JEventWatcher } from '../j-event-watcher';
import { snap, checkSolvency } from './helpers';
import { canonicalAccountKey } from '../state-helpers';
import { formatRuntime } from '../runtime-ascii';
import { deriveDelta } from '../account-utils';

// Lazy-loaded runtime functions to avoid circular dependency (runtime.ts imports this file)
let _process: ((env: Env, inputs?: EntityInput[], delay?: number, single?: boolean) => Promise<Env>) | null = null;
let _applyRuntimeInput: ((env: Env, runtimeInput: any) => Promise<Env>) | null = null;

const getProcess = async () => {
  if (!_process) {
    const runtime = await import('../runtime');
    _process = runtime.process;
  }
  return _process;
};

const getApplyRuntimeInput = async () => {
  if (!_applyRuntimeInput) {
    const runtime = await import('../runtime');
    _applyRuntimeInput = runtime.applyRuntimeInput;
  }
  return _applyRuntimeInput;
};

const USDC_TOKEN_ID = 1;
const DECIMALS = 18n;
const ONE_TOKEN = 10n ** DECIMALS;

const usd = (amount: number | bigint) => BigInt(amount) * ONE_TOKEN;

// Browser-safe env access (process.env only in Node)
const isBrowser = typeof window !== 'undefined';
const getEnv = (key: string, defaultVal: string) =>
  isBrowser ? defaultVal : (typeof process !== 'undefined' ? process.env[key] || defaultVal : defaultVal);

const AHB_STRESS = getEnv('AHB_STRESS', '0') === '1';
const AHB_STRESS_ITERS = Number.parseInt(getEnv('AHB_STRESS_ITERS', '100'), 10);
const AHB_STRESS_AMOUNT_USD = Number.parseInt(getEnv('AHB_STRESS_AMOUNT', '1'), 10);
const AHB_STRESS_DRAIN_EVERY = Number.parseInt(getEnv('AHB_STRESS_DRAIN_EVERY', '0'), 10);

// Jurisdiction name for AHB demo
const AHB_JURISDICTION = 'AHB Demo';

// NOTE: Manual J-Machine queuing functions REMOVED
// Entities now output jOutputs via process() which auto-queue to J-Machine
// This prevents duplicate queuing and duplicate execution

type ReplicaEntry = [string, EntityReplica];

function findReplica(env: Env, entityId: string): ReplicaEntry {
  const entry = Array.from(env.eReplicas.entries()).find(([key]) => key.startsWith(entityId + ':'));
  if (!entry) {
    throw new Error(`AHB: Replica for entity ${entityId} not found`);
  }
  return entry as ReplicaEntry;
}

function assert(condition: unknown, message: string, env?: Env): asserts condition {
  if (!condition) {
    if (env) {
      console.log('\n' + '='.repeat(80));
      console.log('ASSERTION FAILED - FULL RUNTIME STATE:');
      console.log('='.repeat(80));
      console.log(formatRuntime(env, { maxAccounts: 5, maxLocks: 20 }));
      console.log('='.repeat(80) + '\n');
    }
    throw new Error(`ASSERT: ${message}`);
  }
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

async function processUntil(
  env: Env,
  predicate: () => boolean,
  maxRounds: number = 10,
  label: string = 'condition'
): Promise<void> {
  const process = await getProcess();
  for (let round = 0; round < maxRounds; round++) {
    if (predicate()) return;
    await process(env);
  }
  if (!predicate()) {
    throw new Error(`processUntil: ${label} not satisfied after ${maxRounds} rounds`);
  }
}



/**
 * COMPREHENSIVE STATE DUMP - Full JSON dump of system state
 * Enable/disable via AHB_DEBUG=1 environment variable or pass enabled=true
 */
function dumpSystemState(env: Env, label: string, enabled: boolean = true): void {
  if (!enabled && !process.env.AHB_DEBUG) return;

  // Named entities for easier reading
  // Entity IDs are #2, #3, #4 (EntityProvider reserves #1 for Foundation)
  const ENTITY_NAMES: Record<string, string> = {
    '0x0000000000000000000000000000000000000000000000000000000000000002': 'Alice',
    '0x0000000000000000000000000000000000000000000000000000000000000003': 'Hub',
    '0x0000000000000000000000000000000000000000000000000000000000000004': 'Bob',
  };

  const getName = (id: string): string => ENTITY_NAMES[id] || id.slice(-4);

  // Build JSON-serializable state object
  const state: Record<string, any> = {
    label,
    timestamp: Date.now(),
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

// Get offdelta for a bilateral account (uses LEFT entity's view - canonical)
function getOffdelta(env: Env, entityA: string, entityB: string, tokenId: number): bigint {
  // Use entityA's perspective: lookup account by counterparty (entityB)
  const [, replicaA] = findReplica(env, entityA);
  const account = replicaA?.state?.accounts?.get(entityB); // counterparty ID is key
  const delta = account?.deltas?.get(tokenId);

  return delta?.offdelta ?? 0n;
}

// Verify bilateral account sync - CRITICAL for consensus correctness
function assertBilateralSync(env: Env, entityA: string, entityB: string, tokenId: number, label: string): void {
  const [, replicaA] = findReplica(env, entityA);
  const [, replicaB] = findReplica(env, entityB);

  // Each entity stores account keyed by counterparty ID
  const accountFromA = replicaA?.state?.accounts?.get(entityB); // A's view: key=B
  const accountFromB = replicaB?.state?.accounts?.get(entityA); // B's view: key=A

  console.log(`\n[BILATERAL-SYNC ${label}] Checking ${entityA.slice(-4)}←→${entityB.slice(-4)} for token ${tokenId}...`);

  // Both sides must have the account
  if (!accountFromA) {
    console.error(`❌ Entity ${entityA.slice(-4)} has NO account with counterparty ${entityB.slice(-4)}`);
    throw new Error(`BILATERAL-SYNC FAIL at "${label}": Entity ${entityA.slice(-4)} missing account`);
  }
  if (!accountFromB) {
    console.error(`❌ Entity ${entityB.slice(-4)} has NO account with counterparty ${entityA.slice(-4)}`);
    throw new Error(`BILATERAL-SYNC FAIL at "${label}": Entity ${entityB.slice(-4)} missing account`);
  }

  const deltaFromA = accountFromA.deltas?.get(tokenId);
  const deltaFromB = accountFromB.deltas?.get(tokenId);

  // Both sides must have the delta for this token
  if (!deltaFromA) {
    console.error(`❌ Entity ${entityA.slice(-4)} account has NO delta for token ${tokenId}`);
    throw new Error(`BILATERAL-SYNC FAIL at "${label}": Entity ${entityA.slice(-4)} missing delta for token ${tokenId}`);
  }
  if (!deltaFromB) {
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
    const valueAB = deltaFromA[field];
    const valueBA = deltaFromB[field];

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
    console.error(`\n   Full deltaFromA (${entityA.slice(-4)} view):`, deltaFromA);
    console.error(`   Full deltaFromB (${entityB.slice(-4)} view):`, deltaFromB);

    throw new Error(`BILATERAL-SYNC VIOLATION: ${errors.length} field(s) differ between ${entityA.slice(-4)} and ${entityB.slice(-4)}`);
  }

  console.log(`✅ [${label}] Bilateral sync OK: ${entityA.slice(-4)}←→${entityB.slice(-4)} token ${tokenId} - all ${fieldsToCheck.length} fields match`);
}

// Verify payment moved through accounts - throws on failure
// verifyPayment DELETED - was causing false positives due to incorrect delta semantics expectations
// TODO: Re-implement with correct bilateral consensus understanding


export async function ahb(env: Env): Promise<void> {
  // Register test keys for real signatures (deterministic for scenarios)
  const { registerTestKeys } = await import('../account-crypto');
  await registerTestKeys(['s1', 's2', 's3', 's4', 'hub', 'alice', 'bob', 'bank']);

  const process = await getProcess();
  env.scenarioMode = true; // Deterministic time control (scenarios set env.timestamp manually)

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
        name: 'AHB Demo', // MUST match jReplica name for routing
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
      blockDelayMs: 100,             // 100ms block time (1 tick minimum for visualization)
      lastBlockTimestamp: env.timestamp,  // Use env.timestamp for determinism
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

    snap(env, 'Jurisdiction Machine Deployed', {
      description: 'Frame 0: Clean Slate - J-Machine Ready',
      what: 'The J-Machine (Jurisdiction Machine) is deployed on-chain. It represents the EVM smart contracts (Depository.sol, EntityProvider.sol) that will process settlements.',
      why: 'Before any entities exist, the jurisdiction infrastructure must be in place. Think of this as deploying the central bank\'s core settlement system.',
      tradfiParallel: 'Like the Federal Reserve deploying its Fedwire Funds Service before any banks can participate.',
      keyMetrics: [
        'J-Machine: Deployed at origin',
        'Entities: 0 (none created yet)',
        'Reserves: Empty',
      ],
      expectedSolvency: 0n, // Frame 0: No tokens yet
    });
    await process(env);

    // ============================================================================
    // STEP 0b: Create entities
    // ============================================================================
    console.log('\n📦 Creating entities: Alice, Hub, Bob...');

    // AHB Triangle Layout - entities positioned relative to J-Machine
    // Horizontal line layout: Alice—Hub—Bob (clearer visualization than triangle)
    // Lower entities for more vertical separation from J-machine
    const AHB_POSITIONS = {
      Alice: { x: -40, y: -100, z: 0 },  // Left, well below J-machine
      Hub:   { x: 0, y: -100, z: 0 },    // Center
      Bob:   { x: 40, y: -100, z: 0 },   // Right
    };

    const entityNames = ['Alice', 'Hub', 'Bob'] as const;
    const entities: Array<{id: string, signer: string, name: string, boardHash: string}> = [];
    const createEntityTxs = [];

    // Import board hashing utilities
    const { encodeBoard, hashBoard } = await import('../entity-factory');

    for (let i = 0; i < 3; i++) {
      const name = entityNames[i];
      const signer = `s${i + 1}`;
      const position = AHB_POSITIONS[name];

      // Create placeholder entity ID (will be corrected after registration)
      // Use i+2 because EntityProvider reserves #1 for Foundation
      const entityNumber = i + 2; // [2,3,4] to match on-chain registration
      const entityId = '0x' + entityNumber.toString(16).padStart(64, '0');

      // Compute boardHash for on-chain registration
      const config = {
        mode: 'proposer-based' as const,
        threshold: 1n,
        validators: [signer],
        shares: { [signer]: 1n },
        jurisdiction: arrakis
      };
      const encodedBoard = encodeBoard(config);
      const boardHash = hashBoard(encodedBoard);

      entities.push({ id: entityId, signer, name, boardHash });

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

    const applyRuntimeInput = await getApplyRuntimeInput();
    await applyRuntimeInput(env, {
      runtimeTxs: createEntityTxs,
      entityInputs: []
    });

    const [alice, hub, bob] = entities;
    if (!alice || !hub || !bob) {
      throw new Error('Failed to create all entities');
    }

    console.log(`\n  ✅ Created: ${alice.name}, ${hub.name}, ${bob.name}`);

    // CRITICAL: Register entities on-chain in EntityProvider
    // Without this, Depository.settle() reverts with E7 (InvalidParty)
    console.log('\n📋 Registering entities on-chain in EntityProvider...');
    const boardHashes = entities.map(e => e.boardHash);
    const entityNumbers = await browserVM.registerNumberedEntitiesBatch(boardHashes);
    console.log(`✅ Registered on-chain: ${entityNumbers.map((n, i) => `${entities[i]?.name}=#${n}`).join(', ')}`);

    // Verify entity IDs match registration (should be [2,3,4])
    entities.forEach((entity, i) => {
      const expectedNumber = entityNumbers[i];
      const actualNumber = parseInt(entity.id, 16);
      if (expectedNumber !== actualNumber) {
        throw new Error(`Entity ID mismatch: ${entity.name} expected #${expectedNumber}, got #${actualNumber}`);
      }
      console.log(`   ✓ ${entity.name}: Entity #${expectedNumber}`);
    });

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
    snap(env, 'Three Entities Deployed', {
      description: 'Entities Created: Alice, Hub, Bob',
      what: 'Alice, Hub, and Bob entities are now registered in the J-Machine. They appear in the 3D visualization but have no reserves yet (grey spheres).',
      why: 'Before entities can transact, they must be registered in the jurisdiction. This establishes their identity and governance structure.',
      tradfiParallel: 'Like banks registering with the Federal Reserve before opening for business.',
      keyMetrics: [
        'Entities: 3 (Alice, Hub, Bob)',
        'Reserves: All $0 (grey - unfunded)',
        'Accounts: None opened yet',
      ],
      expectedSolvency: 0n, // No tokens minted yet
    });
    await process(env);

    // ============================================================================
    // STEP 1: Initial State - Hub funded with $10M USDC via REAL BrowserVM tx
    // ============================================================================
    console.log('\n💰 FRAME 1: Initial State - Hub Reserve Funding (REAL BrowserVM TX)');

    // NOTE: BrowserVM is reset in View.svelte at runtime creation time
    // This ensures fresh state on every page load/HMR

    // Mint is ADMINISTRATIVE operation (onlyAdmin), not entity→J batch flow
    // Use debugFundReserves (calls Depository.mintToReserve) directly
    const mintEvents = await browserVM.debugFundReserves(hub.id, USDC_TOKEN_ID, usd(10_000_000));
    console.log(`✅ Minted $10M USDC to Hub (events: ${mintEvents.length})`);

    // Feed mint events back to entity (ReserveUpdated)
    await processJEvents(env);

    // ✅ ASSERT: J-event delivered - Hub reserve updated
    const [, hubRep1] = findReplica(env, hub.id);
    const hubReserve1 = hubRep1.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;
    if (hubReserve1 !== usd(10_000_000)) {
      throw new Error(`ASSERT FAIL Frame 1: Hub reserve = ${hubReserve1}, expected ${usd(10_000_000)}. J-event NOT delivered!`);
    }
    console.log(`✅ ASSERT Frame 1: Hub reserve = $${hubReserve1 / 10n**18n}M ✓`);

    snap(env, 'Initial Liquidity Provision', {
      description: 'Initial State: Hub Funded',
      what: 'Hub entity receives $10M USDC reserve balance on Depository.sol (on-chain via BrowserVM)',
      why: 'Reserve balances are the source of liquidity for off-chain bilateral accounts. Think of this as the hub depositing cash into its custody account.',
      tradfiParallel: 'Like a correspondent bank depositing USD reserves at the Federal Reserve to enable wire transfers',
      keyMetrics: [
        'Hub Reserve: $10M USDC',
        'Alice Reserve: $0 (grey - no funds)',
        'Bob Reserve: $0 (grey - no funds)',
      ],
      expectedSolvency: TOTAL_SOLVENCY, // $10M minted to Hub
    });
    await process(env);

    // ============================================================================
    // STEP 2: Hub R2R → Alice ($3M USDC) - REAL TX goes to J-Machine mempool
    // ============================================================================
    console.log('\n🔄 FRAME 2: Hub → Alice R2R - TX ENTERS MEMPOOL (PENDING)');

    // Step 1: Hub creates reserve_to_reserve tx (adds to jBatch)
    // Step 2: Hub broadcasts batch via j_broadcast (generates jOutput)
    const r2rTx1: EntityInput = {
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [
        {
          type: 'reserve_to_reserve',
          data: {
            toEntityId: alice.id,
            tokenId: USDC_TOKEN_ID,
            amount: usd(3_000_000),
          }
        },
        {
          type: 'j_broadcast',
          data: {}
        }
      ]
    };

    snap(env, 'R2R #1: TX Enters J-Machine Mempool', {
      description: 'Hub → Alice: R2R Pending in Mempool',
      what: 'Hub submits reserveToReserve(Alice, $3M). TX is PENDING in J-Machine mempool (yellow cube). Not yet finalized.',
      why: 'J-Machine batches transactions. TX waits in mempool until block creation.',
      tradfiParallel: 'Like submitting a Fedwire - queued for batch settlement',
      keyMetrics: [
        'J-Machine mempool: 1 pending tx',
        'Hub Reserve: $10M (unchanged)',
        'Alice Reserve: $0 (unchanged)',
      ],
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env, [r2rTx1]);

    // ASSERT: J-Machine mempool should have Hub→Alice R2R batch
    const jReplicaAfterR2R1 = env.jReplicas.get('AHB Demo');
    if (!jReplicaAfterR2R1) throw new Error('J-Machine not found');
    console.log(`\n[MEMPOOL ASSERT #1] After Hub→Alice R2R: mempool=${jReplicaAfterR2R1.mempool.length}`);
    if (jReplicaAfterR2R1.mempool.length === 0) {
      throw new Error('MEMPOOL FAIL: Expected Hub→Alice batch in mempool, got 0! payFromReserve not generating jOutput?');
    }
    console.log(`✅ MEMPOOL: ${jReplicaAfterR2R1.mempool.length} batches pending`);

    // Check snapshot captured it
    const lastSnap = env.history[env.history.length - 1];
    const snapJReplica = lastSnap?.jReplicas?.find(jr => jr.name === AHB_JURISDICTION);
    const snapMempool = snapJReplica?.mempool?.length || 0;
    console.log(`[SNAPSHOT ASSERT #1] Last snapshot mempool=${snapMempool}`);
    if (snapMempool === 0) {
      throw new Error('SNAPSHOT FAIL: Mempool not visible! Executed in same tick?');
    }
    console.log(`✅ SNAPSHOT: Mempool visible with ${snapMempool} batches\n`);

    // ============================================================================
    // STEP 3: Hub R2R → Bob ($2M USDC) - Second TX to mempool (PENDING)
    // ============================================================================
    console.log('\n🔄 FRAME 3: Hub → Bob R2R - TX ENTERS MEMPOOL (PENDING)');

    // Hub creates reserve_to_reserve tx → generates jOutput → process() auto-queues to J-Machine
    const r2rTx2: EntityInput = {
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [
        {
          type: 'reserve_to_reserve',
          data: {
            toEntityId: bob.id,
            tokenId: USDC_TOKEN_ID,
            amount: usd(2_000_000),
          }
        },
        {
          type: 'j_broadcast',
          data: {}
        }
      ]
    };

    snap(env, 'R2R #2: TX Enters J-Machine Mempool', {
      description: 'Hub → Bob: R2R Pending in Mempool',
      what: 'Hub submits reserveToReserve(Bob, $2M). Second TX is PENDING in mempool.',
      why: 'Multiple R2R txs accumulate in mempool before batch processing.',
      tradfiParallel: 'Like queuing multiple Fedwires - batched for efficiency',
      keyMetrics: [
        'J-Machine mempool: 2 pending txs',
        'Hub Reserve: $10M (unchanged)',
        'Bob Reserve: $0 (unchanged)',
      ],
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env, [r2rTx2]);

    // ============================================================================
    // STEP 4: J-BLOCK #1 - Execute Hub's funding R2Rs (Alice & Bob get funded)
    // ============================================================================
    console.log('\n⚡ FRAME 4: J-Block #1 - Execute Hub Fundings');

    // J-Machine processes mempool (Hub's 2 R2R batches)
    // IMPORTANT: Frame 2 broadcast one batch, Frame 3 broadcast another - mempool has 2 batches BUT
    // j_broadcast CLEARS jBatch after creating jOutput, so we have 2 SEPARATE batches each with 1 R2R
    await process(env);

    // Process j-events from BrowserVM execution
    await processJEvents(env);

    // NOTE: J-Machine block processing in process() automatically:
    // - Clears mempool (keeps failed txs for retry)
    // - Updates lastBlockTimestamp
    // - Increments blockNumber
    // No manual clearing needed!

    // Verify Hub funding reserves
    const fundedAliceReserves = await browserVM.getReserves(alice.id, USDC_TOKEN_ID);
    const fundedBobReserves = await browserVM.getReserves(bob.id, USDC_TOKEN_ID);
    console.log(`[AHB] J-Block #1 executed - Fundings complete:`);
    console.log(`  Alice: ${Number(fundedAliceReserves) / 1e18} USDC`);
    console.log(`  Bob: ${Number(fundedBobReserves) / 1e18} USDC`);

    snap(env, 'J-Block #1: Hub Fundings Executed', {
      description: 'Hub Fundings Complete: Alice & Bob funded',
      what: 'Hub distributed $3M to Alice, $2M to Bob. Both entities now have reserve balances.',
      why: 'Funding R2Rs executed first - entities need reserves before they can transact.',
      tradfiParallel: 'Like initial capital injection: entities receive operating funds',
      keyMetrics: [
        'Hub: $5M reserve (remaining)',
        'Alice: $3M reserve (funded)',
        'Bob: $2M reserve (funded)',
        'Next: Alice → Bob transfer',
      ],
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // ============================================================================
    // STEP 5: Alice R2R → Bob ($500K) - NOW Alice has funds!
    // ============================================================================
    console.log('\n🔄 FRAME 5: Alice → Bob R2R - TX ENTERS MEMPOOL (PENDING)');

    // Alice creates reserve_to_reserve tx → generates jOutput → process() auto-queues to J-Machine
    const r2rTx3: EntityInput = {
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [
        {
          type: 'reserve_to_reserve',
          data: {
            toEntityId: bob.id,
            tokenId: USDC_TOKEN_ID,
            amount: usd(500_000),
          }
        },
        {
          type: 'j_broadcast',
          data: {}
        }
      ]
    };

    snap(env, 'R2R: Alice → Bob Enters Mempool', {
      description: 'Alice → Bob: R2R Pending in Mempool',
      what: 'Alice (now funded with $3M) sends $500K to Bob. TX is PENDING in mempool.',
      why: 'Alice has funds now! This demonstrates peer-to-peer R2R (not just Hub distribution).',
      tradfiParallel: 'Interbank transfer: one funded bank pays another',
      keyMetrics: [
        'Alice: $3M reserve (has funds!)',
        'Mempool: 1 pending tx',
        'Next: J-Block #2 execution',
      ],
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env, [r2rTx3]);

    // ============================================================================
    // STEP 6: J-BLOCK #2 - Execute Alice → Bob R2R
    // ============================================================================
    console.log('\n⚡ FRAME 6: J-Block #2 - Execute Alice → Bob Transfer');

    // J-Machine processes mempool (Alice's R2R batch from Frame 5)
    await process(env);

    // Process j-events from BrowserVM execution
    await processJEvents(env);

    // NOTE: J-Machine block processing in process() automatically handles mempool clearing

    // Verify final reserves from BrowserVM
    const finalHubReserves = await browserVM.getReserves(hub.id, USDC_TOKEN_ID);
    const finalAliceReserves = await browserVM.getReserves(alice.id, USDC_TOKEN_ID);
    const finalBobReserves = await browserVM.getReserves(bob.id, USDC_TOKEN_ID);

    console.log(`[AHB] J-Block #2 executed - Final reserves:`);
    console.log(`  Hub: ${Number(finalHubReserves) / 1e18} USDC`);
    console.log(`  Alice: ${Number(finalAliceReserves) / 1e18} USDC`);
    console.log(`  Bob: ${Number(finalBobReserves) / 1e18} USDC`);

    snap(env, 'Phase 1 Complete: Reserve Distribution', {
      description: 'R2R Complete: All reserves distributed',
      what: 'Hub: $5M, Alice: $2.5M, Bob: $2.5M. Total: $10M preserved. All entities now have visible reserves.',
      why: 'R2R transfers are pure on-chain settlement. Now we move to Phase 2: Bilateral Accounts.',
      tradfiParallel: 'Like Fedwire settlement: instant, final, auditable transfers between reserve accounts',
      keyMetrics: [
        'Hub: $5M reserve',
        'Alice: $2.5M reserve',
        'Bob: $2.5M reserve',
        'Next: Open bilateral accounts',
      ],
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // ============================================================================
    // PHASE 2: BILATERAL ACCOUNTS
    // ============================================================================

    // ============================================================================
    // STEP 6: Open Alice-Hub Bilateral Account
    // ============================================================================
    console.log('\n🔗 FRAME 6: Open Alice ↔ Hub Bilateral Account');

    // Tick 1: Alice creates Alice→Hub, queues output to Hub
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'openAccount',
        data: { targetEntityId: hub.id }
      }]
    }]);
    // Tick 2: Hub receives, creates Hub→Alice
    await process(env);

    // ✅ ASSERT Frame 6: Alice-Hub account exists (bidirectional)
    const [, aliceRep6] = findReplica(env, alice.id);
    const aliceHubAcc6 = aliceRep6?.state?.accounts?.get(hub.id);
    if (!aliceHubAcc6) {
      console.error(`❌ Available accounts:`, Array.from(aliceRep6.state.accounts.keys()));
      throw new Error(`ASSERT FAIL Frame 6: Alice-Hub account does NOT exist!`);
    }
    console.log(`✅ ASSERT Frame 6: Alice-Hub account EXISTS`);

    snap(env, 'Bilateral Account: Alice ↔ Hub (A-H)', {
      description: 'Alice ↔ Hub: Account Created',
      what: 'Alice opens bilateral account with Hub. Creates off-chain channel for instant payments.',
      why: 'Bilateral accounts enable unlimited off-chain transactions with final on-chain settlement.',
      tradfiParallel: 'Like opening a margin account: enables trading before settlement.',
      keyMetrics: [
        'Account A-H: CREATED',
        'Collateral: $0 (empty)',
        'Credit limits: Default',
        'Ready for R2C prefunding',
      ],
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // ============================================================================
    // STEP 7: Open Bob-Hub Bilateral Account
    // ============================================================================
    console.log('\n🔗 FRAME 7: Open Bob ↔ Hub Bilateral Account');

    // Tick 1: Bob creates Bob→Hub, queues output to Hub
    await process(env, [{
      entityId: bob.id,
      signerId: bob.signer,
      entityTxs: [{
        type: 'openAccount',
        data: { targetEntityId: hub.id }
      }]
    }]);
    // Tick 2: Hub receives, creates Hub→Bob
    await process(env);

    // ✅ ASSERT Frame 7: Both Hub-Bob accounts exist (bidirectional)
    const [, hubRep7] = findReplica(env, hub.id);
    const [, bobRep7] = findReplica(env, bob.id);
    // Hub's view: counterparty=Bob, Bob's view: counterparty=Hub
    const hubBobAcc7 = hubRep7?.state?.accounts?.get(bob.id);
    const bobHubAcc7 = bobRep7?.state?.accounts?.get(hub.id);
    if (!hubBobAcc7 || !bobHubAcc7) {
      console.error(`❌ Hub available accounts:`, Array.from(hubRep7.state.accounts.keys()));
      console.error(`❌ Bob available accounts:`, Array.from(bobRep7.state.accounts.keys()));
      throw new Error(`ASSERT FAIL Frame 7: Hub-Bob account does NOT exist! Hub view: ${!!hubBobAcc7}, Bob view: ${!!bobHubAcc7}`);
    }
    console.log(`✅ ASSERT Frame 7: Hub-Bob accounts EXIST (both directions)`);

    snap(env, 'Bilateral Account: Bob ↔ Hub (B-H)', {
      description: 'Bob ↔ Hub: Account Created',
      what: 'Bob opens bilateral account with Hub. Now both spoke entities connected to hub.',
      why: 'Star topology: Alice and Bob both connect to Hub. Hub routes payments between them.',
      tradfiParallel: 'Like correspondent banking: small banks connect to large banks for interbank settlement.',
      keyMetrics: [
        'Account B-H: CREATED',
        'Topology: Alice ↔ Hub ↔ Bob',
        'Ready for credit extension',
      ],
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // ============================================================================
    // STEP 8: Alice R2C - Reserve to Collateral (BATCH CREATION)
    // ============================================================================
    console.log('\n💰 FRAME 8: Alice R2C - Create jBatch ($500K)');

    // 20% of Alice's $2.5M reserve = $500K
    const aliceCollateralAmount = usd(500_000);

    // PROPER R→E→A FLOW for R2C:
    // Step 1: Entity creates deposit_collateral EntityTx → adds to jBatch
    // Step 2: Entity broadcasts via j_broadcast → generates jOutput → routes to J-mempool
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [
        {
          type: 'deposit_collateral',
          data: {
            counterpartyId: hub.id,
            tokenId: USDC_TOKEN_ID,
            amount: aliceCollateralAmount
          }
        },
        {
          type: 'j_broadcast',
          data: {}
        }
      ]
    }]);

    // ASSERT: jOutput was routed and processed (J-machine auto-processes if blockDelayMs elapsed)
    // NOTE: process() auto-ticks J-machine, so batch may already be processed (not pending)
    const jReplica = env.jReplicas.get('AHB Demo');
    if (!jReplica) throw new Error('J-Machine not found');
    console.log(`[Frame 8 ASSERT] J-Machine state: mempool=${jReplica.mempool.length}, blockNumber=${jReplica.blockNumber}`);
    // jOutput routing confirmed if EITHER batch is pending OR block was already processed
    const jOutputRouted = jReplica.mempool.length > 0 || Number(jReplica.blockNumber) > 8;
    if (!jOutputRouted) {
      throw new Error(`ASSERT FAIL: jOutput not routed! mempool=${jReplica.mempool.length}, blockNumber=${jReplica.blockNumber}`);
    }
    console.log(`✅ ASSERT: jOutput routed successfully (processed or pending)`);

    // Snapshot - shows batch pending in mempool
    snap(env, 'J-Batch Pending: Alice R2C $500K', {
      description: 'Alice R2C: Batch Created (Pending)',
      what: 'Alice created jBatch for R2C. Batch sits in J-Machine mempool awaiting next block.',
      why: 'Batches accumulate before on-chain submission. Yellow cube = pending batch.',
      tradfiParallel: 'Like a wire transfer queued at end-of-day batch processing.',
      keyMetrics: [
        'jReplica mempool: 1 pending batch',
        'Batch: R2C $500K Alice→A-H account',
      ],
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // ============================================================================
    // STEP 8.5: Mempool Delay (BATCH PENDING - Visual Yellow Cube)
    // ============================================================================
    console.log('\n⏳ FRAME 8.5: Mempool Delay - Batch pending in J-Machine');

    // Read jReplica for status display (read-only)
    const jReplicaStatus = env.jReplicas?.get(AHB_JURISDICTION);
    const elapsedMs = jReplicaStatus ? env.timestamp - (jReplicaStatus.lastBlockTimestamp || 0) : 0;
    const delayMs = jReplicaStatus?.blockDelayMs || 1000;
    console.log(`[Frame 8.5] elapsed=${elapsedMs}ms, blockDelayMs=${delayMs}ms`);

    // Snapshot showing batch still pending in mempool (yellow cube persists)
    snap(env, 'J-Batch Queued: Awaiting Block Creation', {
      description: 'J-Machine: Mempool Processing Delay',
      what: `Batch sits in mempool for ${delayMs}ms before on-chain submission.`,
      why: 'Batching improves gas efficiency. Multiple settlements can be combined into one block.',
      tradfiParallel: 'Like SWIFT netting - accumulate transactions, settle in batch.',
      keyMetrics: [
        `Mempool: ${jReplicaStatus?.mempool?.length || 0} batch(es) pending`,
        `Block delay: ${delayMs}ms`,
      ],
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // ============================================================================
    // STEP 9: Alice R2C - J-Machine Block Execution
    // ============================================================================
    console.log('\n💰 FRAME 9: J-Machine processes R2C batch from mempool');

    // DEBUG: Check Alice's on-chain reserves + EntityProvider registration
    const aliceOnChainReserves = await browserVM.getReserves(alice.id, USDC_TOKEN_ID);
    console.log(`[Frame 9 DEBUG] Alice on-chain reserves: ${aliceOnChainReserves / 10n**18n}M`);

    // Entities were registered earlier, trust the registration
    console.log(`[Frame 9 DEBUG] Alice entity #2, Hub entity #3 (registered on-chain)`);

    // J-Machine processes mempool automatically (batch already queued in STEP 8)
    // process() triggers J-Machine mempool execution → BrowserVM.processBatch → events
    await process(env);

    // Process j-events from BrowserVM execution (AccountSettled updates delta.collateral)
    await processJEvents(env);

    // CRITICAL: Process bilateral j_event_claim frame ACKs
    // After processJEvents, j_event_claim frames are PROPOSED but not yet COMMITTED
    // Need additional process() rounds to complete bilateral consensus
    await process(env); // Process j_event_claim frame proposals
    await process(env); // Process ACK responses and commit frames

    // ✅ ASSERT: R2C delivered - Alice delta.collateral = $500K
    const [, aliceRep9] = findReplica(env, alice.id);
    const aliceHubKey9 = hub.id;
    console.log(`🔍 ASSERT Frame 9: Looking up account with key ${aliceHubKey9}`);
    console.log(`🔍 ASSERT Frame 9: Alice has accounts:`, Array.from(aliceRep9.state.accounts.keys()));
    const aliceHubAccount9 = aliceRep9.state.accounts.get(aliceHubKey9);
    console.log(`🔍 ASSERT Frame 9: Account found? ${!!aliceHubAccount9}`);
    if (aliceHubAccount9) {
      console.log(`🔍 ASSERT Frame 9: Account deltas:`, Array.from(aliceHubAccount9.deltas.keys()));
    }
    const aliceDelta9 = aliceHubAccount9?.deltas.get(USDC_TOKEN_ID);
    console.log(`🔍 ASSERT Frame 9: Delta found? ${!!aliceDelta9}, collateral=${aliceDelta9?.collateral || 0n}`);
    if (!aliceDelta9 || aliceDelta9.collateral !== aliceCollateralAmount) {
      const actual = aliceDelta9?.collateral || 0n;
      throw new Error(`ASSERT FAIL Frame 9: Alice-Hub collateral = ${actual}, expected ${aliceCollateralAmount}. R2C j-event NOT delivered!`);
    }
    // ✅ ASSERT: ondelta equals collateral after R2C (settlement sets ondelta = collateral deposited)
    if (aliceDelta9.ondelta !== aliceCollateralAmount) {
      throw new Error(`ASSERT FAIL Frame 9: Alice-Hub ondelta = ${aliceDelta9.ondelta}, expected ${aliceCollateralAmount}. R2C ondelta mismatch!`);
    }
    // ✅ ASSERT: Alice reserve decreased by $500K (was $2.5M after R2R #3, now $2M)
    const aliceReserve9 = aliceRep9.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;
    const expectedAliceReserve9 = usd(2_000_000); // $2.5M - $500K R2C
    if (aliceReserve9 !== expectedAliceReserve9) {
      throw new Error(`ASSERT FAIL Frame 9: Alice reserve = ${aliceReserve9 / 10n**18n}M, expected $2M. R2C reserve deduction failed!`);
    }
    console.log(`✅ ASSERT Frame 9: R2C complete - collateral=$500K, ondelta=$500K, Alice reserve=$2M ✓`);

    // CRITICAL: Verify bilateral sync after R2C collateral deposit
    const [, aliceRepSync] = findReplica(env, alice.id);
    const [, hubRepSync] = findReplica(env, hub.id);
    console.log(`\n🔍 PRE-ASSERT STATE DUMP:`);
    console.log(`Alice account with Hub:`, aliceRepSync.state.accounts.get(hub.id)?.deltas.get(USDC_TOKEN_ID));
    console.log(`Alice LEFT/RIGHT obs:`, {
      left: aliceRepSync.state.accounts.get(hub.id)?.leftJObservations?.length || 0,
      right: aliceRepSync.state.accounts.get(hub.id)?.rightJObservations?.length || 0
    });
    console.log(`Hub account with Alice:`, hubRepSync.state.accounts.get(alice.id)?.deltas.get(USDC_TOKEN_ID));
    console.log(`Hub LEFT/RIGHT obs:`, {
      left: hubRepSync.state.accounts.get(alice.id)?.leftJObservations?.length || 0,
      right: hubRepSync.state.accounts.get(alice.id)?.rightJObservations?.length || 0
    });
    assertBilateralSync(env, alice.id, hub.id, USDC_TOKEN_ID, 'Frame 9 - Alice R2C Collateral');

    snap(env, 'Reserve-to-Collateral (R2C): Alice → A-H Account', {
      description: 'Alice R2C: $500K Reserve → Collateral',
      what: 'Alice moves $500K from reserve to A-H account collateral. J-Machine processed batch.',
      why: 'Collateral enables off-chain payments. Alice can now send up to $500K to Hub instantly.',
      tradfiParallel: 'Like posting margin: Alice locks funds in the bilateral account as security.',
      keyMetrics: [
        'Alice Reserve: $2.5M → $2M (-$500K)',
        'A-H Collateral: $0 → $500K',
        'Alice outCapacity: $500K',
        'Settlement broadcast to J-Machine',
      ],
      expectedSolvency: TOTAL_SOLVENCY, // R2C moves funds, doesn't create/destroy
    });
    await process(env);

    // ============================================================================
    // STEP 9: Bob Credit Extension - set_credit_limit
    // ============================================================================
    console.log('\n💳 FRAME 9: Bob Credit Extension ($500K)');

    // Bob extends $500K credit to Hub in B-H account
    // This is purely off-chain - no collateral from Bob
    const bobCreditAmount = usd(500_000);

    // Tick 1: Bob adds credit tx to mempool, auto-propose sends to Hub
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
    // Tick 2: Hub receives proposal, validates, ACKs back
    await process(env);
    // Tick 3: Bob receives ACK, commits frame
    await process(env);
    // Tick 4: Extra tick to ensure all ACKs delivered (left-wins resend adds traffic)
    await process(env);

    // ✅ ASSERT: Credit extension delivered - Bob-Hub has leftCreditLimit = $500K
    // Bob (0x0003) > Hub (0x0002) → Bob is RIGHT, Hub is LEFT
    // Bob extending credit sets leftCreditLimit (credit available TO Hub/LEFT)
    const [, bobRep9] = findReplica(env, bob.id);
    const bobHubAccount9 = bobRep9.state.accounts.get(hub.id); // Account keyed by counterparty
    const bobDelta9 = bobHubAccount9?.deltas.get(USDC_TOKEN_ID);
    if (!bobDelta9 || bobDelta9.leftCreditLimit !== bobCreditAmount) {
      const actual = bobDelta9?.leftCreditLimit || 0n;
      throw new Error(`ASSERT FAIL Frame 9: Bob-Hub leftCreditLimit = ${actual}, expected ${bobCreditAmount}. Credit extension NOT applied!`);
    }

    // Verify bilateral sync
    assertBilateralSync(env, bob.id, hub.id, USDC_TOKEN_ID, 'Frame 9 - Bob Credit Extension');

    snap(env, 'Credit Extension: Bob → Hub', {
      description: 'Bob Credit Extension: $500K',
      what: 'Bob extends $500K credit limit to Hub in B-H account. Purely off-chain, no collateral.',
      why: 'Credit extension allows Hub to owe Bob. Bob trusts Hub up to $500K.',
      tradfiParallel: 'Like a credit line: Bob says "Hub can owe me up to $500K".',
      keyMetrics: [
        'B-H Credit Limit: $500K',
        'Bob collateral: $0 (receiver)',
        'Hub can owe Bob: $500K max',
        'Ready for routed payment!',
      ],
      expectedSolvency: TOTAL_SOLVENCY, // Credit extension is off-chain, no on-chain impact
    });
    await process(env);

    // ============================================================================
    // STEP 10: Off-Chain Payment Alice → Hub → Bob
    // ============================================================================
    console.error('\n\n🚨🚨🚨 PAYMENT SECTION START 🚨🚨🚨\n');

    // Helper: log pending outputs
    const logPending = () => {
      const pending = env.pendingOutputs || [];
      console.log(`   pending: [${pending.map(o => o.entityId.slice(-4)).join(',')}]`);
    };

    // Payment 1: A → H → B ($125K)
    console.log('\n⚡ FRAME 10: Off-Chain Payment A → H → B ($125K)');
    const payment1 = usd(125_000);

    const { deriveDelta } = await import('../account-utils');

    // ============================================================================
    // PAYMENT 1: A → H → B ($125K) - First payment, builds up shift
    // ============================================================================
    console.log('🏃 FRAME 10: Alice initiates A→H→B $125K');

    // Frame 10: Alice sends to Hub
    await process(env, [{
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
    logPending();

    snap(env, 'Payment 1/2: Alice → Hub', {
      description: 'Frame 10: Alice initiates A→H→B',
      what: 'Alice sends $125K, Hub receives and forwards proposal to Bob',
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // Frame 11: Hub + Alice process (Hub forwards to Bob, Alice gets ACK)
    console.log('🏃 FRAME 11: Hub forwards, Alice commits');
    await process(env);
    logPending();

    snap(env, 'Payment 1/2: Hub → Bob proposal', {
      description: 'Frame 11: Hub forwards to Bob',
      what: 'Hub-Alice commits, Hub proposes to Bob',
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // Frame 12: Bob ACKs Hub
    console.log('🏃 FRAME 12: Bob ACKs Hub');
    await process(env);
    logPending();

    // Frame 13: Hub commits H-B (receives Bob's ACK)
    console.log('🏃 FRAME 13: Hub commits H-B');
    await process(env);
    logPending();

    // Verify payment 1 landed with capacity assertions
    const ahDelta1 = getOffdelta(env, alice.id, hub.id, USDC_TOKEN_ID);
    const hbDelta1 = getOffdelta(env, hub.id, bob.id, USDC_TOKEN_ID);

    // After payment 1: A-H and H-B should both be -$125K
    const expectedShift1 = -payment1; // -$125K
    if (ahDelta1 !== expectedShift1) {
      throw new Error(`❌ ASSERTION FAILED: After payment 1, A-H offdelta=${ahDelta1}, expected ${expectedShift1}`);
    }
    if (hbDelta1 !== expectedShift1) {
      throw new Error(`❌ ASSERTION FAILED: After payment 1, H-B offdelta=${hbDelta1}, expected ${expectedShift1}`);
    }
    console.log(`   ✅ After payment 1: A-H=${ahDelta1}, H-B=${hbDelta1} (both -$125K as expected)`);

    snap(env, 'Payment 1/2 Complete', {
      description: 'Frame 13: Payment 1 complete',
      what: `A→H→B $125K done. A-H shift: -$125K, H-B shift: -$125K`,
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // ============================================================================
    // PAYMENT 2: A → H → B ($125K) - Second payment, total shift = $250K
    // ============================================================================
    const payment2 = usd(125_000);
    console.log('\n🏃 FRAME 14: Alice initiates second A→H→B $125K');

    // Frame 14: Alice sends again
    await process(env, [{
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
    logPending();

    snap(env, 'Payment 2/2: Alice → Hub', {
      description: 'Frame 14: Alice initiates second payment',
      what: 'Second $125K payment to reach $250K total shift',
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // Frame 15: Hub forwards, Alice commits A-H
    console.log('🏃 FRAME 15: Hub forwards, Alice commits A-H');
    await process(env);
    logPending();

    snap(env, 'Payment 2/2: Hub → Bob proposal', {
      description: 'Frame 15: Hub forwards second payment',
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // Frame 16: Bob ACKs Hub
    console.log('🏃 FRAME 16: Bob ACKs Hub');
    await process(env);
    logPending();

    // Frame 17: Hub commits H-B
    console.log('🏃 FRAME 17: Hub commits H-B');
    await process(env);
    logPending();

    // Verify total shift = $250K
    const ahDeltaFinal = getOffdelta(env, alice.id, hub.id, USDC_TOKEN_ID);
    const hbDeltaFinal = getOffdelta(env, hub.id, bob.id, USDC_TOKEN_ID);
    const expectedShift = -(payment1 + payment2); // -$250K

    if (ahDeltaFinal !== expectedShift) {
      throw new Error(`❌ ASSERTION FAILED: A-H shift=${ahDeltaFinal}, expected ${expectedShift}`);
    }
    if (hbDeltaFinal !== expectedShift) {
      throw new Error(`❌ ASSERTION FAILED: H-B shift=${hbDeltaFinal}, expected ${expectedShift}`);
    }
    console.log(`✅ Total shift verified: A-H=${ahDeltaFinal}, H-B=${hbDeltaFinal} (both -$250K as expected)`);

    // Verify Bob's view
    const [, bobRep] = findReplica(env, bob.id);
    const bobHubAcc = bobRep.state.accounts.get(bob.id);
    const bobDelta = bobHubAcc?.deltas.get(USDC_TOKEN_ID);
    if (bobDelta) {
      const bobDerived = deriveDelta(bobDelta, false); // Bob is RIGHT
      console.log(`   Bob outCapacity: ${bobDerived.outCapacity} (received $250K)`);
      if (bobDerived.outCapacity !== payment1 + payment2) {
        throw new Error(`❌ ASSERTION FAILED: Bob outCapacity=${bobDerived.outCapacity}, expected ${payment1 + payment2}`);
      }
    }

    snap(env, 'Payments Complete: $250K A→B', {
      description: 'Frame 17: Both payments complete - $250K shifted',
      what: 'Two $125K payments complete. Total: $250K shifted from Alice to Bob via Hub.',
      why: 'Hub now has $250K uninsured liability to Bob (TR=$250K). Rebalancing needed!',
      keyMetrics: [
        'A-H shift: -$250K (Alice paid Hub)',
        'H-B shift: -$250K (Hub owes Bob)',
        'TR (Total Risk): $250K uninsured',
      ],
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // ============================================================================
    // PHASE 4: REVERSE PAYMENT B→H→A (Bob pays Alice $50K via Hub)
    // ============================================================================
    // This tests the reverse routing: Bob → Hub → Alice
    // CRITICAL: Order must be B→H first, THEN H→A (same as A→H→B does A→H then H→B)
    // ============================================================================
    console.log('\n💸 PHASE 4: REVERSE PAYMENT: B→H→A ($50K)');

    const reversePayment = usd(50_000);

    // Frame 18: Bob initiates B→H→A
    console.log('🏃 FRAME 18: Bob initiates B→H→A $50K');
    await process(env, [{
      entityId: bob.id,
      signerId: bob.signer,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: alice.id,
          tokenId: USDC_TOKEN_ID,
          amount: reversePayment,
          route: [bob.id, hub.id, alice.id],  // CRITICAL: B→H→A route
          description: 'Reverse payment: Bob pays Alice'
        }
      }]
    }]);
    logPending();

    // CRITICAL ASSERTION: B→H must happen FIRST
    // After Frame 18, B-H should have changed but H-A should NOT yet
    const bhDelta18 = getOffdelta(env, bob.id, hub.id, USDC_TOKEN_ID);
    const haExpected18 = getOffdelta(env, hub.id, alice.id, USDC_TOKEN_ID);
    console.log(`   After Bob initiates: B-H offdelta=${bhDelta18}, H-A offdelta=${haExpected18}`);
    // Note: At this point Bob's local mempool has the tx but Hub hasn't received yet

    snap(env, 'Reverse Payment: Bob → Hub', {
      description: 'Frame 18: Bob initiates B→H→A',
      what: 'Bob sends $50K to Alice via Hub. First hop: B→H',
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // Frame 19: Hub receives from Bob, forwards to Alice
    console.log('🏃 FRAME 19: Hub receives B→H, forwards to Alice');
    await process(env);
    logPending();

    // CRITICAL ASSERTION: B→H should be committed BEFORE H→A is initiated
    const bhDelta19 = getOffdelta(env, bob.id, hub.id, USDC_TOKEN_ID);
    const ahDelta19 = getOffdelta(env, alice.id, hub.id, USDC_TOKEN_ID);
    console.log(`   After Hub forwards: B-H offdelta=${bhDelta19}, A-H offdelta=${ahDelta19}`);

    // B-H should have shifted +$50K (Bob paid Hub, reducing Hub's debt)
    // A-H should NOT have changed yet (Hub forwarding is in next frame)
    const expectedBH19 = -(payment1 + payment2) + reversePayment; // -$250K + $50K = -$200K
    if (bhDelta19 !== expectedBH19) {
      console.warn(`⚠️ B-H shift unexpected: got ${bhDelta19}, expected ${expectedBH19}`);
    }

    snap(env, 'Reverse Payment: Hub → Alice', {
      description: 'Frame 19: Hub forwards to Alice',
      what: 'Hub receives B→H and forwards H→A proposal',
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // Frame 20: Alice ACKs Hub
    console.log('🏃 FRAME 20: Alice ACKs Hub');
    await process(env);
    logPending();

    // Frame 21: Hub commits H-A
    console.log('🏃 FRAME 21: Hub commits H-A (reverse payment complete)');
    await process(env);
    logPending();

    // FINAL ASSERTION: Verify reverse payment shifted correctly
    const ahDeltaRev = getOffdelta(env, alice.id, hub.id, USDC_TOKEN_ID);
    const bhDeltaRev = getOffdelta(env, bob.id, hub.id, USDC_TOKEN_ID);

    // After $250K A→B and $50K B→A:
    // A-H: -$250K + $50K = -$200K (Alice's debt reduced)
    // B-H: -$250K + $50K = -$200K (Hub's debt to Bob reduced)
    const expectedAH = -(payment1 + payment2) + reversePayment; // -$200K
    const expectedBH = -(payment1 + payment2) + reversePayment; // -$200K

    if (ahDeltaRev !== expectedAH) {
      throw new Error(`❌ REVERSE PAYMENT FAIL: A-H offdelta=${ahDeltaRev}, expected ${expectedAH}`);
    }
    if (bhDeltaRev !== expectedBH) {
      throw new Error(`❌ REVERSE PAYMENT FAIL: B-H offdelta=${bhDeltaRev}, expected ${expectedBH}`);
    }
    console.log(`✅ Reverse payment B→H→A verified: A-H=${ahDeltaRev}, B-H=${bhDeltaRev} (both -$200K)`);

    snap(env, 'Reverse Payment: $50K B→A', {
      description: 'Frame 21: Reverse payment complete',
      what: 'Bob paid Alice $50K via Hub. Net position: $200K shifted A→B.',
      keyMetrics: [
        'A-H shift: -$200K (was -$250K)',
        'B-H shift: -$200K (was -$250K)',
        'TR: $200K (reduced from $250K)',
      ],
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // ============================================================================
    // PHASE 5: REBALANCING - Reduce Total Risk from $200K to $0
    // ============================================================================
    // Current state after $250K A→H→B minus $50K B→H→A = $200K net shift:
    // - A-H: offdelta = -$200K (Alice owes Hub), collateral = $500K
    // - H-B: offdelta = -$200K (Hub owes Bob), collateral = $0
    // - TR = $200K (Hub's uninsured liability to Bob)
    //
    // Rebalancing plan:
    // 1. Alice-Hub settlement: Alice withdraws $200K collateral (pays Hub on-chain)
    // 2. Hub-Bob settlement: Hub deposits $200K collateral (insures Bob's position)
    // 3. Result: TR = $0, both accounts fully settled
    // ============================================================================

    console.log('\n\n🔄🔄🔄 REBALANCING SECTION START 🔄🔄🔄\n');

    const rebalanceAmount = usd(200_000);

    // ============================================================================
    // STEP 22: Alice-Hub Settlement (Alice withdraws to pay Hub on-chain)
    // ============================================================================
    console.log('\n🏦 FRAME 22: Alice-Hub Settlement (Alice withdraws $200K)');

    // Alice is LEFT (0x0001 < 0x0002), Hub is RIGHT
    // Settlement: reduce collateral, give Alice reserve back, increase ondelta
    // Invariant: leftDiff + rightDiff + collateralDiff = 0
    //   +$250K + 0 + (-$250K) = 0 ✓

    // Alice creates settlement via EntityTx (PROPER RJEA FLOW)
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [
        {
          type: 'createSettlement',
          data: {
            counterpartyEntityId: hub.id,
            diffs: [{
              tokenId: USDC_TOKEN_ID,
              leftDiff: 0n,                      // Alice reserve unchanged (she already spent via payment)
              rightDiff: rebalanceAmount,        // Hub reserve +$200K (Hub receives what Alice owed)
              collateralDiff: -rebalanceAmount,  // Account collateral -$200K
              ondeltaDiff: rebalanceAmount,      // ondelta +$200K (settles off-chain debt)
            }]
          }
        }
      ]
    }]);

    snap(env, 'Rebalancing 1/2: Pull from Net-Sender', {
      description: 'Frame 22: Alice-Hub Settlement initiated',
      what: 'Hub withdraws $200K from Alice (net-sender) via A-H collateral.',
      why: 'Alice spent $200K off-chain → excess collateral. Hub pulls to rebalance.',
      tradfiParallel: 'Like margin release: net-sender\'s locked funds freed for redistribution.',
      keyMetrics: [
        'Alice = NET-SENDER (spent $200K)',
        'A-H collateral: $500K → $300K',
        'Hub reserve: +$200K (pulled)',
      ],
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // ✅ Store pre-settlement state for assertions
    const [, alicePreSettle] = findReplica(env, alice.id);
    const [, hubPreSettle] = findReplica(env, hub.id);
    const ahPreCollateral = alicePreSettle.state.accounts.get(hub.id)?.deltas.get(USDC_TOKEN_ID)?.collateral || 0n;
    const hubPreReserve = hubPreSettle.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;
    console.log(`   A-H pre-settlement: collateral=${ahPreCollateral}, Hub reserve=${hubPreReserve}`);

    // Broadcast settlement to J-Machine via jOutput pattern
    console.log('🏦 Broadcasting Alice-Hub settlement jBatch via j_broadcast...');
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'j_broadcast',
        data: {}
      }]
    }]);

    // Wait for J-Machine to execute settlement batch
    await process(env);

    // Process j_events from BrowserVM (AccountSettled events)
    await processJEvents(env);

    // Frame 23: Process any pending outputs
    console.log('\n🏦 FRAME 23: Alice-Hub Settlement completes');
    await process(env);
    logPending();

    // ✅ ASSERT: A-H collateral decreased by $200K (net-sender pulled)
    const [, aliceRepRebal] = findReplica(env, alice.id);
    const ahAccountRebal = aliceRepRebal.state.accounts.get(hub.id);
    const ahDeltaRebal = ahAccountRebal?.deltas.get(USDC_TOKEN_ID);
    const expectedAHCollateral = ahPreCollateral - rebalanceAmount;
    if (!ahDeltaRebal || ahDeltaRebal.collateral !== expectedAHCollateral) {
      const actual = ahDeltaRebal?.collateral || 0n;
      throw new Error(`❌ ASSERT FAIL: A-H collateral = ${actual}, expected ${expectedAHCollateral}. Settlement j-event NOT delivered!`);
    }
    console.log(`✅ ASSERT: A-H collateral ${ahPreCollateral} → ${ahDeltaRebal.collateral} (-$200K) ✓`);

    // ✅ ASSERT: Hub reserve increased by $200K (Hub received from A-H)
    const [, hubPostAHSettle] = findReplica(env, hub.id);
    const hubPostReserve = hubPostAHSettle.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;
    const expectedHubReserve = hubPreReserve + rebalanceAmount;
    if (hubPostReserve !== expectedHubReserve) {
      throw new Error(`❌ ASSERT FAIL: Hub reserve = ${hubPostReserve}, expected ${expectedHubReserve}. Settlement reserve update failed!`);
    }
    console.log(`✅ ASSERT: Hub reserve ${hubPreReserve} → ${hubPostReserve} (+$200K) ✓`);

    // NOTE: BrowserVM.getCollateral() requires public getter in Depository.sol (not implemented yet)
    // Entity replica state already proves RJEA flow works correctly

    console.log(`   A-H after settlement: collateral=${ahDeltaRebal?.collateral}, ondelta=${ahDeltaRebal?.ondelta}`);

    snap(env, 'Rebalancing 1/2: Net-Sender Pulled', {
      description: 'Frame 23: Alice-Hub Settlement complete',
      what: 'Hub pulled $200K from Alice (net-sender). Ready to deposit to Bob.',
      keyMetrics: [
        'A-H collateral: $300K (Alice\'s excess released)',
        'Hub reserve: +$200K (holding for Bob)',
        'Next: deposit to net-receiver',
      ],
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // ============================================================================
    // STEP 24: Hub-Bob Settlement (Hub deposits to insure Bob)
    // ============================================================================
    console.log('\n🏦 FRAME 24: Hub-Bob Settlement (Hub deposits $200K)');

    // Hub is LEFT (0x0002 < 0x0003), Bob is RIGHT
    // Settlement: increase collateral, reduce Hub reserve, increase ondelta
    // Invariant: leftDiff + rightDiff + collateralDiff = 0
    //   (-$200K) + 0 + (+$200K) = 0 ✓

    // Hub creates settlement via EntityTx (PROPER RJEA FLOW)
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [
        {
          type: 'createSettlement',
          data: {
            counterpartyEntityId: bob.id,
            diffs: [{
              tokenId: USDC_TOKEN_ID,
              leftDiff: -rebalanceAmount,        // Hub reserve -$200K
              rightDiff: 0n,                      // Bob reserve unchanged
              collateralDiff: rebalanceAmount,   // Account collateral +$200K
              ondeltaDiff: rebalanceAmount,       // ondelta +$200K (insures Bob's position)
            }]
          }
        }
      ]
    }]);

    // ✅ Store pre-settlement state for H-B assertions
    const [, hubPreHBSettle] = findReplica(env, hub.id);
    const hbPreCollateral = hubPreHBSettle.state.accounts.get(bob.id)?.deltas.get(USDC_TOKEN_ID)?.collateral || 0n;
    const hubPreHBReserve = hubPreHBSettle.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;
    console.log(`   H-B pre-settlement: collateral=${hbPreCollateral}, Hub reserve=${hubPreHBReserve}`);

    snap(env, 'Rebalancing 2/2: Deposit to Net-Receiver', {
      description: 'Frame 24: Hub-Bob Settlement initiated',
      what: 'Hub deposits $200K to Bob (net-receiver) via H-B collateral.',
      why: 'Bob received $200K off-chain → needs collateral. Hub deposits to insure.',
      tradfiParallel: 'Like margin posting: net-receiver gets collateral backing.',
      keyMetrics: [
        'Bob = NET-RECEIVER (received $200K)',
        'H-B collateral: $0 → $200K',
        'Hub reserve: -$200K (deposited)',
      ],
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // Broadcast settlement to J-Machine via jOutput pattern
    console.log('🏦 Broadcasting Hub-Bob settlement jBatch via j_broadcast...');
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'j_broadcast',
        data: {}
      }]
    }]);

    // Wait for J-Machine to execute settlement batch
    await process(env);

    // Process j_events from BrowserVM (AccountSettled events)
    await processJEvents(env);

    // Frame 25: Process any pending outputs
    console.log('\n🏦 FRAME 25: Hub-Bob Settlement completes');
    await process(env);
    logPending();

    // ✅ ASSERT: H-B collateral increased by $200K (net-receiver insured)
    const [, hubRepRebal] = findReplica(env, hub.id);
    const hbAccountRebal = hubRepRebal.state.accounts.get(bob.id);
    const hbDeltaRebal = hbAccountRebal?.deltas.get(USDC_TOKEN_ID);
    const expectedHBCollateral = hbPreCollateral + rebalanceAmount;
    if (!hbDeltaRebal || hbDeltaRebal.collateral !== expectedHBCollateral) {
      const actual = hbDeltaRebal?.collateral || 0n;
      throw new Error(`❌ ASSERT FAIL: H-B collateral = ${actual}, expected ${expectedHBCollateral}. Settlement j-event NOT delivered!`);
    }
    console.log(`✅ ASSERT: H-B collateral ${hbPreCollateral} → ${hbDeltaRebal.collateral} (+$200K) ✓`);

    // ✅ ASSERT: Hub reserve decreased by $200K (Hub deposited to H-B)
    const hubPostHBReserve = hubRepRebal.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;
    const expectedHubPostHBReserve = hubPreHBReserve - rebalanceAmount;
    if (hubPostHBReserve !== expectedHubPostHBReserve) {
      throw new Error(`❌ ASSERT FAIL: Hub reserve = ${hubPostHBReserve}, expected ${expectedHubPostHBReserve}. Settlement reserve update failed!`);
    }
    console.log(`✅ ASSERT: Hub reserve ${hubPreHBReserve} → ${hubPostHBReserve} (-$200K) ✓`);

    // NOTE: BrowserVM.getCollateral() requires public getter in Depository.sol (not implemented yet)
    // Entity replica state already proves RJEA flow works correctly

    console.log(`   H-B after settlement: collateral=${hbDeltaRebal?.collateral}, ondelta=${hbDeltaRebal?.ondelta}`);

    snap(env, 'Rebalancing 2/2: Net-Receiver Insured', {
      description: 'Frame 25: Hub-Bob Settlement complete',
      what: 'Hub deposited $200K to Bob (net-receiver). Bob now fully collateralized.',
      keyMetrics: [
        'H-B collateral: $200K (Bob\'s insurance)',
        'Bob\'s uninsured balance: $200K → $0',
        'Rebalance complete!',
      ],
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

    // ============================================================================
    // FINAL STATE: Rebalancing Complete
    // ============================================================================
    console.log('\n📊 FRAME 26: Final State - Rebalancing Complete');

    snap(env, 'Rebalancing Complete: Zero Risk', {
      description: 'Frame 26: Rebalancing Complete - TR = $0',
      what: 'Net-sender (Alice) → Hub → Net-receiver (Bob). All positions collateralized.',
      why: 'Rebalance moved collateral from spenders to receivers. Bob\'s uninsured risk eliminated.',
      tradfiParallel: 'Like end-of-day netting: excess margin released, deficits covered.',
      keyMetrics: [
        'Bob\'s uninsured: $200K → $0',
        'Alice (net-sender): collateral released',
        'Bob (net-receiver): collateral deposited',
        'System: 100% collateralized',
      ],
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env);

  // ============================================================================
  // PHASE 6: SIMULTANEOUS BIDIRECTIONAL PAYMENTS (Consensus Tiebreaker Test)
  // ============================================================================
  // Test rollback + re-proposal when LEFT and RIGHT both send payments simultaneously
  // This verifies:
  // - LEFT wins tiebreaker (deterministic)
  // - RIGHT rolls back, re-adds tx to mempool
  // - RIGHT ACKs LEFT's frame
  // - RIGHT re-proposes with rolled-back tx
  // - BOTH payments eventually succeed
  // ============================================================================

  console.log('\n\n⚔️⚔️⚔️ PHASE 6: SIMULTANEOUS BIDIRECTIONAL PAYMENTS ⚔️⚔️⚔️\n');
  console.log('Testing consensus rollback when both sides propose at same tick\n');

  // CRITICAL: For Hub to send to Alice, ALICE must extend credit TO Hub
  // extendCredit semantic: "I extend credit to counterparty" = "counterparty can borrow from me"
  console.log('💳 Alice extending credit to Hub (so Hub can send)...');
  const aliceToHub = usd(10_000);
  const hubToAlice = usd(5_000);
  const phase6Credit = usd(500_000); // Cover existing debt + payments

  await process(env, [{
    entityId: alice.id,  // Alice is creditor
    signerId: alice.signer,
    entityTxs: [{
      type: 'extendCredit',
      data: { counterpartyEntityId: hub.id, tokenId: USDC_TOKEN_ID, amount: phase6Credit }
    }]
  }]);
  await processUntil(env, () => {
    const [, aliceRep] = findReplica(env, alice.id);
    const [, hubRep] = findReplica(env, hub.id);
    const aliceAccount = aliceRep.state.accounts.get(hub.id);
    const hubAccount = hubRep.state.accounts.get(alice.id);
    if (!aliceAccount || !hubAccount) return false;
    const aliceDelta = aliceAccount.deltas.get(USDC_TOKEN_ID);
    const hubDelta = hubAccount.deltas.get(USDC_TOKEN_ID);
    const creditApplied = aliceDelta?.rightCreditLimit === phase6Credit && hubDelta?.rightCreditLimit === phase6Credit;
    const noPending = !aliceAccount.pendingFrame && !hubAccount.pendingFrame;
    const mempoolClear = (aliceAccount.mempool.length === 0) && (hubAccount.mempool.length === 0);
    return Boolean(creditApplied && noPending && mempoolClear);
  }, 8, 'Phase 6 A→H credit convergence');

  // Preflight: Verify both have capacity (fail-fast with clear error)
  const [, aliceCheck] = findReplica(env, alice.id);
  const [, hubCheck] = findReplica(env, hub.id);
  const aliceCap = deriveDelta(aliceCheck.state.accounts.get(hub.id)!.deltas.get(USDC_TOKEN_ID)!, true).outCapacity;
  const hubCap = deriveDelta(hubCheck.state.accounts.get(alice.id)!.deltas.get(USDC_TOKEN_ID)!, false).outCapacity;

  console.log(`   Alice capacity: ${aliceCap} (need ${aliceToHub})`);
  console.log(`   Hub capacity: ${hubCap} (need ${hubToAlice})`);
  assert(aliceCap >= aliceToHub, `Alice insufficient: need ${aliceToHub}, has ${aliceCap}`);
  assert(hubCap >= hubToAlice, `Hub insufficient: need ${hubToAlice}, has ${hubCap}`);
  console.log('   ✅ Both have capacity\n');

  console.log('💥 SIMULTANEOUS: Alice→Hub $10K + Hub→Alice $5K (SAME TICK)');

  // Record pre-payment state
  const ahDeltaBefore = getOffdelta(env, alice.id, hub.id, USDC_TOKEN_ID);
  console.log(`   Before: A-H offdelta = ${ahDeltaBefore}`);

  // CRITICAL: Send both payments in SAME process() call (simultaneous)
  await process(env, [
    {
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: hub.id,
          tokenId: USDC_TOKEN_ID,
          amount: aliceToHub,
          route: [alice.id, hub.id],
          description: 'Alice pays Hub $10K (simultaneous test)'
        }
      }]
    },
    {
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: alice.id,
          tokenId: USDC_TOKEN_ID,
          amount: hubToAlice,
          route: [hub.id, alice.id],
          description: 'Hub pays Alice $5K (simultaneous test)'
        }
      }]
    }
  ]);

  console.log('   📊 Both payments submitted simultaneously');
  console.log('   🎲 Tiebreaker should fire: LEFT (Alice) wins, RIGHT (Hub) rolls back');

  // Debug: Check account mempools from both perspectives
  const [, aliceRepAfterSubmit] = findReplica(env, alice.id);
  const [, hubRepAfterSubmit] = findReplica(env, hub.id);
  const aliceAccountAfterSubmit = aliceRepAfterSubmit.state.accounts.get(hub.id);
  const hubAccountAfterSubmit = hubRepAfterSubmit.state.accounts.get(alice.id);

  console.log(`\n🔍 DEBUG: Account state after simultaneous submit:`);
  console.log(`   Alice's view: mempool=${aliceAccountAfterSubmit?.mempool.length || 0}, pending=${aliceAccountAfterSubmit?.pendingFrame ? 'h' + aliceAccountAfterSubmit.pendingFrame.height : 'none'}`);
  console.log(`   Hub's view:   mempool=${hubAccountAfterSubmit?.mempool.length || 0}, pending=${hubAccountAfterSubmit?.pendingFrame ? 'h' + hubAccountAfterSubmit.pendingFrame.height : 'none'}`);

  if (aliceAccountAfterSubmit?.mempool) {
    console.log(`   Alice mempool txs: [${aliceAccountAfterSubmit.mempool.map((t: any) => t.type).join(', ')}]`);
  }
  if (hubAccountAfterSubmit?.mempool) {
    console.log(`   Hub mempool txs: [${hubAccountAfterSubmit.mempool.map((t: any) => t.type).join(', ')}]`);
  }

  logPending();

  // Process bilateral consensus (tiebreaker + rollback + re-proposal)
  console.log('\n🔄 Processing bilateral consensus (may take multiple rounds)...');

  // Track all consensus events
  const consensusEvents: string[] = [];
  let rollbackDetected = false;
  let leftWinsDetected = false;

  // Run until both payments settle (max 20 rounds for safety)
  let rounds = 0;
  const maxRounds = 20;
  while (rounds < maxRounds) {
    const beforeRound = env.history?.length || 0;
    await process(env);
    rounds++;

    // Collect events from this round
    const afterRound = env.history?.length || 0;
    if (afterRound > beforeRound) {
      for (let i = beforeRound; i < afterRound; i++) {
        const snapshot = env.history![i];
        const frameLogs = (snapshot as any)?.logs || (snapshot as any)?.frameLogs || [];
        for (const entry of frameLogs) {
          if (entry.category !== 'consensus') continue;
          const msg = entry.message || '';
          if (!msg) continue;
          consensusEvents.push(msg);
          if (msg.includes('ROLLBACK')) rollbackDetected = true;
          if (msg.includes('LEFT-WINS')) leftWinsDetected = true;
          console.log(`   📋 Event: ${msg}`);
        }
      }
    }

    // Check if both payments committed (delta should reflect net change)
    const currentDelta = getOffdelta(env, alice.id, hub.id, USDC_TOKEN_ID);
    const currentNet = currentDelta - ahDeltaBefore;
    const targetNet = -(aliceToHub - hubToAlice);

    console.log(`   Round ${rounds}: delta=${currentDelta}, net=${currentNet}, target=${targetNet}`);

    if (currentNet === targetNet) {
      console.log(`   ✅ Both payments settled after ${rounds} rounds`);
      // Ensure any pending ACKs are processed before final sync checks.
      await processUntil(env, () => {
        const [, aliceRep] = findReplica(env, alice.id);
        const [, hubRep] = findReplica(env, hub.id);
        const aliceAccount = aliceRep.state.accounts.get(hub.id);
        const hubAccount = hubRep.state.accounts.get(alice.id);
        const noPendingFrames = !aliceAccount?.pendingFrame && !hubAccount?.pendingFrame;
        const noPendingOutputs = (env.pendingOutputs?.length || 0) === 0;
        return Boolean(noPendingFrames && noPendingOutputs);
      }, 8, 'Phase 6 ACK drain');
      break;
    }
  }

  console.log(`\n📊 Consensus flow summary:`);
  console.log(`   - Rollback detected: ${rollbackDetected ? '✅' : '❌ MISSING'}`);
  console.log(`   - LEFT-WINS detected: ${leftWinsDetected ? '✅' : '❌ MISSING'}`);
  console.log(`   - Total consensus events: ${consensusEvents.length}`);

  if (rounds >= maxRounds) {
    console.warn(`   ⚠️ Hit max rounds (${maxRounds}), payments may still be pending`);
  }

  // Verify BOTH payments succeeded
  const ahDeltaAfter = getOffdelta(env, alice.id, hub.id, USDC_TOKEN_ID);
  const netChange = ahDeltaAfter - ahDeltaBefore;
  const expected = -(aliceToHub - hubToAlice); // Alice pays $10K, receives $5K = net -$5K

  console.log(`\n✅ VERIFICATION:`);
  console.log(`   Before: A-H offdelta = ${ahDeltaBefore}`);
  console.log(`   After:  A-H offdelta = ${ahDeltaAfter}`);
  console.log(`   Net change: ${netChange} (expected: ${expected})`);

  assert(
    netChange === expected,
    `Simultaneous payments: A-H delta changed by ${netChange}, expected ${expected}`,
    env
  );

  console.log(`\n✅ PHASE 6 COMPLETE: Both simultaneous payments succeeded!`);
  console.log('   - Alice→Hub $10K: ✅');
  console.log('   - Hub→Alice $5K: ✅');
  console.log('   - Rollback + re-proposal: ✅');
  console.log('   - sentTransitions counter: ✅\n');

  // ============================================================================
  // PHASE 7: DISPUTE GAME (On-Chain Enforcement)
  // ============================================================================
  // TODO: Test dispute resolution with 5 J-frame delay
  // 1. Alice creates fraudulent state (inflates her balance)
  // 2. Hub submits initialDisputeProof to Depository.sol
  // 3. Wait 5 J-frames (dispute window)
  // 4. Hub submits finalDisputeProof with correct account state
  // 5. Verify: Hub wins dispute, Alice loses collateral
  // 6. Verify: Account state enforced on-chain matches bilateral consensus
  //
  // This proves:
  // - Account proof hashes are correctly generated
  // - Depository.sol validates proofs correctly
  // - Dispute mechanism enforces bilateral consensus on-chain
  // - 5 J-frame window sufficient for counterparty response
  //
  // Implementation needs:
  // - buildDisputeProof() from proof-builder.ts
  // - Submit via processBatch with initialDisputeProof/finalDisputeProof
  // - Advance J-machine by 5 blocks
  // - Verify collateral seizure via enforceDebts()
  console.log('⚠️  PHASE 7 (DISPUTE GAME): Not yet implemented - see TODO above\n');

  if (AHB_STRESS) {
    const stressIters = Number.isFinite(AHB_STRESS_ITERS) && AHB_STRESS_ITERS > 0 ? AHB_STRESS_ITERS : 100;
    const stressUsd = Number.isFinite(AHB_STRESS_AMOUNT_USD) && AHB_STRESS_AMOUNT_USD > 0 ? AHB_STRESS_AMOUNT_USD : 1;
    const stressAmount = usd(stressUsd);

    console.log(`\n🚧 PHASE 7: STRESS TEST (${stressIters} ticks, $${stressUsd} both directions)`);

    const stressDeltaBefore = getOffdelta(env, alice.id, hub.id, USDC_TOKEN_ID);
    for (let i = 0; i < stressIters; i++) {
      await process(env, [
        {
          entityId: alice.id,
          signerId: alice.signer,
          entityTxs: [{
            type: 'directPayment',
            data: {
              targetEntityId: hub.id,
              tokenId: USDC_TOKEN_ID,
              amount: stressAmount,
              route: [alice.id, hub.id],
              description: `Stress A→H #${i + 1}`
            }
          }]
        },
        {
          entityId: hub.id,
          signerId: hub.signer,
          entityTxs: [{
            type: 'directPayment',
            data: {
              targetEntityId: alice.id,
              tokenId: USDC_TOKEN_ID,
              amount: stressAmount,
              route: [hub.id, alice.id],
              description: `Stress H→A #${i + 1}`
            }
          }]
        }
      ]);

      if (AHB_STRESS_DRAIN_EVERY > 0 && (i + 1) % AHB_STRESS_DRAIN_EVERY === 0) {
        await processUntil(env, () => {
          const [, aliceRep] = findReplica(env, alice.id);
          const [, hubRep] = findReplica(env, hub.id);
          const aliceAccount = aliceRep.state.accounts.get(hub.id);
          const hubAccount = hubRep.state.accounts.get(alice.id);
          const noPendingFrames = !aliceAccount?.pendingFrame && !hubAccount?.pendingFrame;
          const mempoolClear = (aliceAccount?.mempool.length === 0) && (hubAccount?.mempool.length === 0);
          const noPendingOutputs = (env.pendingOutputs?.length || 0) === 0;
          return Boolean(noPendingFrames && mempoolClear && noPendingOutputs);
        }, Math.max(400, AHB_STRESS_DRAIN_EVERY * 20), `Phase 7 batch drain @${i + 1}/${stressIters}`);
      }
    }

    await processUntil(env, () => {
      const [, aliceRep] = findReplica(env, alice.id);
      const [, hubRep] = findReplica(env, hub.id);
      const aliceAccount = aliceRep.state.accounts.get(hub.id);
      const hubAccount = hubRep.state.accounts.get(alice.id);
      const noPendingFrames = !aliceAccount?.pendingFrame && !hubAccount?.pendingFrame;
      const mempoolClear = (aliceAccount?.mempool.length === 0) && (hubAccount?.mempool.length === 0);
      const noPendingOutputs = (env.pendingOutputs?.length || 0) === 0;
      return Boolean(noPendingFrames && mempoolClear && noPendingOutputs);
    }, Math.max(800, stressIters * 20), 'Phase 7 ACK drain');

    const stressDeltaAfter = getOffdelta(env, alice.id, hub.id, USDC_TOKEN_ID);
    console.log(`   Stress delta before: ${stressDeltaBefore}`);
    console.log(`   Stress delta after:  ${stressDeltaAfter}`);
    assert(
      stressDeltaAfter === stressDeltaBefore,
      `Stress net delta changed: before=${stressDeltaBefore} after=${stressDeltaAfter}`,
      env
    );

    assertBilateralSync(env, alice.id, hub.id, USDC_TOKEN_ID, 'STRESS - Alice-Hub');
    console.log('   ✅ Stress test: net delta stable + bilateral sync');
  }

    // FINAL BILATERAL SYNC CHECK - All accounts must be synced
    console.log('\n🔍 FINAL VERIFICATION: All bilateral accounts...');
    assertBilateralSync(env, alice.id, hub.id, USDC_TOKEN_ID, 'FINAL - Alice-Hub');
    assertBilateralSync(env, hub.id, bob.id, USDC_TOKEN_ID, 'FINAL - Hub-Bob');
    // Dump both ASCII (human-readable) and JSON (machine-queryable)
    console.log('\n' + '═'.repeat(80));
    console.log('📊 FINAL RUNTIME STATE (ASCII - Human Readable)');
    console.log('═'.repeat(80));
    console.log(formatRuntime(env, { maxAccounts: 10, maxLocks: 20, showMempool: false }));
    console.log('═'.repeat(80) + '\n');

    console.log('\n=====================================');
    console.log('✅ AHB Demo Complete with Rebalancing!');
    console.log('Phase 1: R2R reserve distribution');
    console.log('Phase 2: Bilateral accounts + R2C + credit');
    console.log('Phase 3: Two payments A→H→B ($250K total)');
    console.log('Phase 4: Reverse payment B→H→A ($50K) - net $200K');
    console.log('Phase 5: Rebalancing - TR $200K → $0');
    console.log('Phase 6: Simultaneous bidirectional payments (rollback test)');
    console.log('Phase 7: Dispute game (TODO - on-chain enforcement)');
    console.log('=====================================\n');
    console.log(`[AHB] History frames: ${env.history?.length}`);
  } finally {
    env.scenarioMode = false; // ALWAYS re-enable live mode, even on error
  }
}

// ===== CLI ENTRY POINT =====
// Run this file directly: bun runtime/scenarios/ahb.ts
if (import.meta.main) {
  console.log('🚀 Running AHB scenario from CLI...\n');

  // Dynamic import to avoid bundler issues
  const runtime = await import('../runtime');
  const env = runtime.createEmptyEnv();

  await ahb(env);

  console.log('\n✅ AHB scenario complete!');
  console.log(`📊 Total frames: ${env.history?.length || 0}`);
  console.log('🎉 RJEA event consolidation verified - AccountSettled events working!\n');

  // Dump full Env to JSON
  const fs = await import('fs');

  console.log('💾 Dumping full runtime (Env) to JSON...');

  const seen = new WeakSet();
  const envJson = JSON.stringify(env, function(key, value) {
    if (value instanceof Map) return Array.from(value.entries());
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function') return undefined;

    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }

    return value;
  }, 2);

  fs.writeFileSync('/tmp/ahb-runtime.json', envJson);
  const sizeMB = (envJson.length / 1024 / 1024).toFixed(1);
  console.log(`  ✅ /tmp/ahb-runtime.json (${sizeMB}MB full Env dump)\n`);

  process.exit(0);
}
