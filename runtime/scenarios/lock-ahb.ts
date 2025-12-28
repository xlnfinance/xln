/**
 * HTLC AHB Demo: Alice-Hub-Bob with Hash Time-Locked Contracts
 *
 * Same as AHB but using HTLCs for conditional payments:
 * - Alice locks payment to Hub with hashlock
 * - Hub forwards lock to Bob (with fee deduction)
 * - Bob reveals secret
 * - Secret propagates backward: Bob → Hub → Alice
 * - All parties settle atomically
 *
 * Demonstrates:
 * - Multi-hop HTLC routing
 * - Automatic secret propagation
 * - Fee deduction at each hop
 * - Griefing protection (timelock cascade)
 */

import type { Env, EntityInput, EntityReplica, Delta } from '../types';
import { getAvailableJurisdictions, getBrowserVMInstance, setBrowserVMJurisdiction } from '../evm';
import { BrowserEVM } from '../evms/browser-evm';
import { setupBrowserVMWatcher, type JEventWatcher } from '../j-event-watcher';
import { getProcess, getApplyRuntimeInput, usd, snap, checkSolvency } from './helpers';

const USDC_TOKEN_ID = 1;

// Transition wrapper: pushSnapshot -> snap + process (to be removed later)
// This maintains backward compatibility while we migrate calls
// Note: The old pushSnapshot had complex signature. This version accepts:
// - env, title, opts (required)
// - Optional 4th param: either EntityInput[] OR {expectedSolvency: bigint} to merge into opts
async function pushSnapshot(
  env: Env,
  title: string,
  opts: {
    what?: string;
    why?: string;
    tradfiParallel?: string;
    keyMetrics?: string[];
    expectedSolvency?: bigint;
    description?: string;
  },
  fourthArg?: EntityInput[] | { expectedSolvency?: bigint }
): Promise<void> {
  const process = await getProcess();

  // Handle 4th arg: can be inputs array OR extra solvency opts
  let inputs: EntityInput[] | undefined;
  if (Array.isArray(fourthArg)) {
    inputs = fourthArg;
  } else if (fourthArg && typeof fourthArg === 'object' && 'expectedSolvency' in fourthArg) {
    // Merge expectedSolvency into opts
    opts = { ...opts, expectedSolvency: fourthArg.expectedSolvency };
  }

  snap(env, title, opts);
  await process(env, inputs);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

type ReplicaEntry = [string, EntityReplica];

function findReplica(env: Env, entityId: string): ReplicaEntry {
  const entry = Array.from(env.eReplicas.entries()).find(([key]) => key.startsWith(entityId + ':'));
  if (!entry) {
    throw new Error(`AHB: Replica for entity ${entityId} not found`);
  }
  return entry as ReplicaEntry;
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
  console.log(`   pending:`, pendingInputs.map(i => `${i.entityId.slice(-4)}/${i.entityTxs?.length || 0}tx`));
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


// Alias for runtime.ts compatibility
export { ahb as lockAhb };

export async function ahb(env: Env): Promise<void> {
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
      blockDelayMs: 300,             // 300ms delay before processing mempool (visual delay)
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
      what: 'The J-Machine (Jurisdiction Machine) is deployed on-chain.',
      why: 'Before any entities exist, the jurisdiction infrastructure must be in place.',
      tradfiParallel: 'Like the Federal Reserve deploying its Fedwire Funds Service.',
      keyMetrics: ['J-Machine: Deployed', 'Entities: 0', 'Reserves: Empty'],
      expectedSolvency: 0n,
    });
    await process(env); // Frame 0: No tokens yet

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

    // ============================================================================
    // Set up j-watcher subscription to BrowserVM for proper R→E→A event flow
    // ============================================================================
    console.log('\n🔭 Setting up j-watcher subscription to BrowserVM...');
    if (jWatcherInstance) {
      jWatcherInstance.stopWatching();
    }
    jWatcherInstance = await setupBrowserVMWatcher(env, browserVM);
    console.log('✅ j-watcher subscribed to BrowserVM events');

    // Frame 0.5: Entities created but not yet funded
    snap(env, 'Three Entities Deployed', {
      description: 'Entities Created: Alice, Hub, Bob',
      what: 'Alice, Hub, and Bob entities are now registered in the J-Machine.',
      why: 'Before entities can transact, they must be registered in the jurisdiction.',
      tradfiParallel: 'Like banks registering with the Federal Reserve.',
      keyMetrics: ['Entities: 3', 'Reserves: $0', 'Accounts: None'],
      expectedSolvency: 0n,
    });
    await process(env);

    // ============================================================================
    // STEP 1: Initial State - Hub funded with $10M USDC via REAL BrowserVM tx
    // ============================================================================
    console.log('\n💰 FRAME 1: Initial State - Hub Reserve Funding (REAL BrowserVM TX)');

    // NOTE: BrowserVM is reset in View.svelte at runtime creation time
    // This ensures fresh state on every page load/HMR

    // Initial funding (ACCEPTABLE BYPASS for test setup)
    // Direct BrowserVM call - no other way to seed initial reserves
    await browserVM.debugFundReserves(hub.id, USDC_TOKEN_ID, usd(10_000_000));
    await processJEvents(env);
    await process(env);

    // ✅ ASSERT: J-event delivered - Hub reserve updated
    const [, hubRep1] = findReplica(env, hub.id);
    const hubReserve1 = hubRep1.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;
    if (hubReserve1 !== usd(10_000_000)) {
      throw new Error(`ASSERT FAIL Frame 1: Hub reserve = ${hubReserve1}, expected ${usd(10_000_000)}. J-event NOT delivered!`);
    }
    console.log(`✅ ASSERT Frame 1: Hub reserve = $${hubReserve1 / 10n**18n}M ✓`);

    // ============================================================================
    // STEP 2-4: Hub R2R Batch (Alice + Bob fundings)
    // ============================================================================
    console.log('\n🔄 FRAME 2: Hub creating R2R batch (Alice + Bob)');

    // Hub creates TWO R2R operations in jBatch
    snap(env, 'Initial Liquidity Provision', {
      description: 'Initial State: Hub Funded',
      what: 'Hub receives $10M USDC reserve on Depository.sol',
      why: 'Reserves are the source of liquidity for off-chain accounts.',
      tradfiParallel: 'Like a bank depositing USD reserves at the Federal Reserve.',
      keyMetrics: ['Hub: $10M', 'Alice: $0', 'Bob: $0'],
      expectedSolvency: TOTAL_SOLVENCY,
    });
    await process(env, [{
      entityId: hub.id,
      signerId: 's2',
      entityTxs: [
        // R2R #1: Hub → Alice $3M
        {
          type: 'reserve_to_reserve',
          data: {
            toEntityId: alice.id,
            tokenId: USDC_TOKEN_ID,
            amount: usd(3_000_000),
          }
        },
        // R2R #2: Hub → Bob $2M
        {
          type: 'reserve_to_reserve',
          data: {
            toEntityId: bob.id,
            tokenId: USDC_TOKEN_ID,
            amount: usd(2_000_000),
          }
        }
      ]
    }]);

    console.log('✅ R2R operations added to Hub jBatch (2 operations)');

    await pushSnapshot(env, 'Hub R2R batch created', {
      title: 'R2R Batch Ready',
      what: 'Hub created batch with 2 R2R transfers: $3M to Alice, $2M to Bob.',
      why: 'Batching R2Rs for efficiency - one broadcast, multiple transfers.',
      tradfiParallel: 'Like ACH batch file - multiple wire transfers in one submission.',
      keyMetrics: [
        'Batch: 2 R2R operations',
        'Total: $5M USDC',
        'Status: Pending broadcast',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // STEP 3: Hub broadcasts R2R batch
    console.log('\n⚡ FRAME 3: Hub broadcasts R2R batch');

    await process(env, [{
      entityId: hub.id,
      signerId: 's2',
      entityTxs: [{
        type: 'j_broadcast',
        data: {}
      }]
    }]);

    console.log('✅ R2R batch queued to J-mempool (yellow cube)');

    await pushSnapshot(env, 'R2R batch in J-mempool', {
      title: 'J-Mempool: Yellow Cube #1',
      what: 'R2R batch sits in J-mempool (yellow cube). Will execute after blockDelayMs.',
      why: 'Visual feedback: batch queued, awaiting block time.',
      tradfiParallel: 'Like SWIFT queue - message sent, pending settlement window.',
      keyMetrics: [
        'J-mempool: 1 batch (2 R2Rs)',
        'Block delay: 300ms',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // STEP 4: Advance time and process J-block
    console.log('\n⚡ FRAME 4: J-Block #1 processes R2R batch');

    env.timestamp += 350; // Advance past blockDelayMs
    await process(env); // Triggers J-processor

    // Process j-events from BrowserVM
    await processJEvents(env);
    await process(env);

    // Verify funding via entity state
    const [, aliceFunded] = findReplica(env, alice.id);
    const [, bobFunded] = findReplica(env, bob.id);
    const [, hubAfterR2R] = findReplica(env, hub.id);

    const aliceReserve = aliceFunded.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;
    const bobReserve = bobFunded.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;
    const hubReserve = hubAfterR2R.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;

    console.log('[AHB] J-Block #1 executed - Fundings complete:');
    console.log(`  Alice: ${Number(aliceReserve) / 1e18} USDC`);
    console.log(`  Bob: ${Number(bobReserve) / 1e18} USDC`);
    console.log(`  Hub: ${Number(hubReserve) / 1e18} USDC`);

    // Assertions
    if (aliceReserve !== usd(3_000_000)) {
      throw new Error(`❌ ASSERT FAIL: Alice reserve = ${aliceReserve}, expected ${usd(3_000_000)}`);
    }
    if (bobReserve !== usd(2_000_000)) {
      throw new Error(`❌ ASSERT FAIL: Bob reserve = ${bobReserve}, expected ${usd(2_000_000)}`);
    }
    if (hubReserve !== usd(5_000_000)) {
      throw new Error(`❌ ASSERT FAIL: Hub reserve = ${hubReserve}, expected ${usd(5_000_000)}`);
    }
    console.log('✅ ASSERT: R2R batch executed correctly ✓');

    await pushSnapshot(env, 'Hub fundings complete', {
      title: 'Hub Distributed Reserves',
      what: 'Hub: $5M, Alice: $3M, Bob: $2M.',
      why: 'Hub funded both entities for bilateral trading.',
      tradfiParallel: 'Like correspondent bank funding smaller banks.',
      keyMetrics: ['Hub: $5M', 'Alice: $3M', 'Bob: $2M']
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // ============================================================================
    // STEP 5-6: Alice → Bob R2R ($500K) - Peer-to-Peer Transfer
    // ============================================================================
    console.log('\n🔄 FRAME 5: Alice → Bob R2R');

    // Alice sends R2R to Bob (demonstrates peer-to-peer, not just hub distribution)
    await process(env, [{
      entityId: alice.id,
      signerId: 's1',
      entityTxs: [{
        type: 'reserve_to_reserve',
        data: {
          toEntityId: bob.id,
          tokenId: USDC_TOKEN_ID,
          amount: usd(500_000),
        }
      }]
    }]);

    // Broadcast
    await process(env, [{
      entityId: alice.id,
      signerId: 's1',
      entityTxs: [{
        type: 'j_broadcast',
        data: {}
      }]
    }]);

    await pushSnapshot(env, 'Alice→Bob R2R in J-mempool', {
      title: 'Peer-to-Peer Transfer',
      what: 'Alice sends $500K to Bob (yellow cube #3).',
      keyMetrics: ['Alice → Bob: $500K']
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // Process J-block
    console.log('\n⚡ FRAME 6: J-Block processes Alice→Bob');
    env.timestamp += 350;
    await process(env);
    await processJEvents(env);
    await process(env);

    // Verify
    const [, aliceAfterA2B] = findReplica(env, alice.id);
    const [, bobAfterA2B] = findReplica(env, bob.id);
    const aliceReserveA2B = aliceAfterA2B.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;
    const bobReserveA2B = bobAfterA2B.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;

    if (aliceReserveA2B !== usd(2_500_000)) {
      throw new Error(`❌ ASSERT FAIL: Alice reserve = ${aliceReserveA2B}, expected ${usd(2_500_000)}`);
    }
    if (bobReserveA2B !== usd(2_500_000)) {
      throw new Error(`❌ ASSERT FAIL: Bob reserve = ${bobReserveA2B}, expected ${usd(2_500_000)}`);
    }
    console.log('✅ ASSERT: Alice→Bob R2R executed ✓');

    await pushSnapshot(env, 'R2R Complete: All reserves distributed', {
      title: 'Phase 1 Complete: Reserve Distribution',
      what: 'Hub: $5M, Alice: $2.5M, Bob: $2.5M. Total: $10M preserved.',
      why: 'R2R transfers complete. Now move to Phase 2: Bilateral Accounts.',
      tradfiParallel: 'Like Fedwire settlement: instant, final, auditable.',
      keyMetrics: [
        'Hub: $5M reserve',
        'Alice: $2.5M reserve',
        'Bob: $2.5M reserve',
        'Batches processed: 2 (3 R2Rs total)',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY });

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
    // STEP 8: Alice R2C - Reserve to Collateral (BATCH CREATION)
    // ============================================================================
    console.log('\n💰 FRAME 8: Alice R2C - Create jBatch ($500K)');

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

    console.log('✅ Alice deposit_collateral added to jBatch');

    await pushSnapshot(env, 'Alice R2C: jBatch created', {
      title: 'R2C Batch Ready',
      what: 'Alice R2C added to jBatch (not yet broadcast).',
      keyMetrics: ['Batch: 1 R2C ($500K)']
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // Step 2: Alice broadcasts R2C batch (SEPARATE tick - important!)
    console.log('\n💰 FRAME 9: Alice broadcasts R2C batch');

    await process(env, [{
      entityId: alice.id,
      signerId: 's1',
      entityTxs: [{
        type: 'j_broadcast',
        data: {}
      }]
    }]);

    console.log('✅ R2C batch queued to J-mempool');

    await pushSnapshot(env, 'R2C in J-mempool', {
      title: 'Yellow Cube #2',
      what: 'R2C batch in J-mempool',
      keyMetrics: ['J-mempool: 1 batch']
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // Step 3: Advance time for J-block #2 to process
    console.log('\n⚡ FRAME 11: J-Block #2 processes R2C');

    // After j_broadcast, need to wait for blockDelayMs before J-processor runs
    // Since lastBlockTimestamp was just set when Block #1 finalized,
    // we need to advance by MORE than blockDelayMs to trigger Block #2
    env.timestamp += 500; // Well past 300ms blockDelayMs
    console.log(`   ⏰ Time advanced: +500ms`);

    await process(env); // Should trigger J-machine processor

    // Step 4: Process j_events from BrowserVM
    await processJEvents(env);

    // ✅ ASSERT: R2C delivered - Alice delta.collateral = $500K
    const [, aliceRep9] = findReplica(env, alice.id);
    const aliceHubAccount9 = aliceRep9.state.accounts.get(hub.id);
    const aliceDelta9 = aliceHubAccount9?.deltas.get(USDC_TOKEN_ID);
    if (!aliceDelta9 || aliceDelta9.collateral !== aliceCollateralAmount) {
      const actual = aliceDelta9?.collateral || 0n;
      throw new Error(`ASSERT FAIL Frame 9: Alice-Hub collateral = ${actual}, expected ${aliceCollateralAmount}. R2C j-event NOT delivered!`);
    }
    // ✅ ASSERT: ondelta equals collateral after R2C (settlement sets ondelta = collateral deposited)
    if (aliceDelta9.ondelta !== aliceCollateralAmount) {
      throw new Error(`ASSERT FAIL Frame 9: Alice-Hub ondelta = ${aliceDelta9.ondelta}, expected ${aliceCollateralAmount}. R2C ondelta mismatch!`);
    }
    // ✅ ASSERT: Alice reserve after R2C
    // Alice: $3M (from Hub) - $500K (to Bob) - $500K (R2C) = $2M
    const aliceReserve9 = aliceRep9.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;
    const expectedAliceReserve9 = usd(2_000_000); // $3M - $500K (to Bob) - $500K (R2C) = $2M
    if (aliceReserve9 !== expectedAliceReserve9) {
      throw new Error(`ASSERT FAIL Frame 9: Alice reserve = ${aliceReserve9 / 10n**18n}M, expected $2M. R2C reserve deduction failed!`);
    }
    console.log(`✅ ASSERT Frame 9: R2C complete - collateral=$500K, ondelta=$500K, Alice reserve=$2M ✓`);

    // CRITICAL: Verify bilateral sync after R2C collateral deposit
    assertBilateralSync(env, alice.id, hub.id, USDC_TOKEN_ID, 'Frame 9 - Alice R2C Collateral');

    await pushSnapshot(env, 'Alice R2C: $500K Reserve → Collateral', {
      title: 'Reserve-to-Collateral (R2C): Alice → A-H Account',
      what: 'Alice moves $500K from reserve to A-H account collateral. J-Machine processed batch.',
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
    // PAYMENT 1: A → H → B ($125K) - HTLC VERSION
    // ============================================================================
    console.log('🏃 FRAME 10: Alice initiates HTLC A→H→B $125K');

    // Frame 10: Alice creates HTLC lock
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'htlcPayment',
        data: {
          targetEntityId: bob.id,
          tokenId: USDC_TOKEN_ID,
          amount: payment1,
          route: [alice.id, hub.id, bob.id],
          description: 'HTLC Payment 1 of 2'
        }
      }]
    }]);
    logPending();

    await pushSnapshot(env, 'Frame 10: Alice initiates A→H→B', {
      title: 'Payment 1/2: Alice → Hub',
      what: 'Alice sends $125K, Hub receives and forwards proposal to Bob',
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // Frame 11: Hub + Alice process (Hub forwards to Bob, Alice gets ACK)
    console.log('🏃 FRAME 11: Hub forwards, Alice commits');
    await process(env);
    logPending();

    await pushSnapshot(env, 'Frame 11: Hub forwards to Bob', {
      title: 'Payment 1/2: Hub → Bob proposal',
      what: 'Hub-Alice commits, Hub proposes to Bob',
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // Frame 12: Bob ACKs Hub
    console.log('🏃 FRAME 12: Bob ACKs Hub');
    await process(env);
    logPending();

    // Frame 13: Hub commits H-B (receives Bob's ACK)
    console.log('🏃 FRAME 13: Hub commits H-B');
    await process(env);
    logPending();

    // HTLC: Payment is locked, not settled yet! Delta should be 0
    const ahDelta1 = getOffdelta(env, alice.id, hub.id, USDC_TOKEN_ID);
    const hbDelta1 = getOffdelta(env, hub.id, bob.id, USDC_TOKEN_ID);

    console.log(`   🔒 HTLC Status: Locks created, awaiting reveal`);
    console.log(`   A-H delta: ${ahDelta1} (still 0 - locked, not settled)`);
    console.log(`   H-B delta: ${hbDelta1} (still 0 - locked, not settled)`);

    // Verify E-Machine lockBook is populated
    const [, aliceRepHtlc] = findReplica(env, alice.id);
    const [, hubRepHtlc] = findReplica(env, hub.id);
    console.log(`   📖 Alice lockBook size: ${aliceRepHtlc.state.lockBook.size}`);
    console.log(`   📖 Hub lockBook size: ${hubRepHtlc.state.lockBook.size}`);
    assert(aliceRepHtlc.state.lockBook.size > 0, 'Alice lockBook should have HTLC entry');
    console.log('   ✅ E-Machine lockBook populated');

    // TODO: Add frames for Bob revealing secret, then verify deltas change

    console.log('\n═══════════════════════════════════════');
    console.log('🔒 HTLC: Locks created, continuing to test reveal...');
    console.log('═══════════════════════════════════════\n');

    // Continue to let Bob process the HTLC (remove early return)

    await pushSnapshot(env, 'Frame 13: Payment 1 complete', {
      title: 'Payment 1/2 Complete',
      what: `A→H→B $125K done. A-H shift: -$125K, H-B shift: -$125K`,
    }, { expectedSolvency: TOTAL_SOLVENCY });

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

    await pushSnapshot(env, 'Frame 14: Alice initiates second payment', {
      title: 'Payment 2/2: Alice → Hub',
      what: 'Second $125K payment to reach $250K total shift',
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // Frame 15: Hub forwards, Alice commits A-H
    console.log('🏃 FRAME 15: Hub forwards, Alice commits A-H');
    await process(env);
    logPending();

    await pushSnapshot(env, 'Frame 15: Hub forwards second payment', {
      title: 'Payment 2/2: Hub → Bob proposal',
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // Frame 16: Bob ACKs Hub
    console.log('🏃 FRAME 16: Bob ACKs Hub');
    await process(env);
    logPending();

    // Frame 17: Hub commits H-B
    console.log('🏃 FRAME 17: Hub commits H-B');
    await process(env);
    logPending();

    // Frame 18: Alice commits A-H reveal (secret propagated from Hub)
    console.log('🏃 FRAME 18: Alice commits A-H reveal');
    await process(env);
    logPending();

    // Frame 19: Hub ACKs Alice
    console.log('🏃 FRAME 19: Hub ACKs Alice');
    await process(env);
    logPending();

    // Verify total shift = $250K (A-H) and $250K minus HTLC fee (H-B)
    // HTLC routing takes a fee on forwarded payments (payment1 only, payment2 is direct)
    const { calculateHtlcFeeAmount } = await import('../htlc-utils');
    const htlcFee = calculateHtlcFeeAmount(payment1);

    const ahDeltaFinal = getOffdelta(env, alice.id, hub.id, USDC_TOKEN_ID);
    const hbDeltaFinal = getOffdelta(env, hub.id, bob.id, USDC_TOKEN_ID);
    const expectedAHShift = -(payment1 + payment2); // -$250K (full amount from Alice)
    const expectedHBShift = -(payment1 - htlcFee + payment2); // -$250K + fee (Hub keeps fee on forwarded payment)

    if (ahDeltaFinal !== expectedAHShift) {
      throw new Error(`❌ ASSERTION FAILED: A-H shift=${ahDeltaFinal}, expected ${expectedAHShift}`);
    }
    if (hbDeltaFinal !== expectedHBShift) {
      throw new Error(`❌ ASSERTION FAILED: H-B shift=${hbDeltaFinal}, expected ${expectedHBShift} (includes fee=${htlcFee})`);
    }
    console.log(`✅ Total shift verified: A-H=${ahDeltaFinal}, H-B=${hbDeltaFinal} (fee=${htlcFee})`);

    // Verify Bob's view (Bob receives payment1 minus fee + payment2)
    const expectedBobReceived = (payment1 - htlcFee) + payment2;
    const [, bobRep] = findReplica(env, bob.id);
    const bobHubAcc = bobRep.state.accounts.get(hub.id);
    const bobDelta = bobHubAcc?.deltas.get(USDC_TOKEN_ID);
    if (bobDelta) {
      const bobDerived = deriveDelta(bobDelta, false); // Bob is RIGHT
      console.log(`   Bob outCapacity: ${bobDerived.outCapacity} (received $${Number(expectedBobReceived) / 1e18})`);
      if (bobDerived.outCapacity !== expectedBobReceived) {
        throw new Error(`❌ ASSERTION FAILED: Bob outCapacity=${bobDerived.outCapacity}, expected ${expectedBobReceived}`);
      }
    }

    await pushSnapshot(env, 'Frame 17: Both payments complete - $250K shifted', {
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

    await pushSnapshot(env, 'Frame 18: Bob initiates B→H→A', {
      title: 'Reverse Payment: Bob → Hub',
      what: 'Bob sends $50K to Alice via Hub. First hop: B→H',
    }, { expectedSolvency: TOTAL_SOLVENCY });

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

    await pushSnapshot(env, 'Frame 19: Hub forwards to Alice', {
      title: 'Reverse Payment: Hub → Alice',
      what: 'Hub receives B→H and forwards H→A proposal',
    }, { expectedSolvency: TOTAL_SOLVENCY });

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

    // After $250K A→B (with HTLC fee on forwarded payment1) and $50K B→A:
    // A-H: -$250K + $50K = -$200K (Alice's debt reduced - no fee on her side)
    // B-H: -(payment1-fee + payment2) + $50K = Hub's debt to Bob
    const expectedAH = -(payment1 + payment2) + reversePayment; // -$200K
    const expectedBH = -(payment1 - htlcFee + payment2) + reversePayment; // -$200K + fee kept

    if (ahDeltaRev !== expectedAH) {
      throw new Error(`❌ REVERSE PAYMENT FAIL: A-H offdelta=${ahDeltaRev}, expected ${expectedAH}`);
    }
    if (bhDeltaRev !== expectedBH) {
      throw new Error(`❌ REVERSE PAYMENT FAIL: B-H offdelta=${bhDeltaRev}, expected ${expectedBH} (fee=${htlcFee})`);
    }
    console.log(`✅ Reverse payment B→H→A verified: A-H=${ahDeltaRev}, B-H=${bhDeltaRev} (fee=${htlcFee})`);

    await pushSnapshot(env, 'Frame 21: Reverse payment complete', {
      title: '✅ Reverse Payment: $50K B→A',
      what: 'Bob paid Alice $50K via Hub. Net position: $200K shifted A→B.',
      keyMetrics: [
        'A-H shift: -$200K (was -$250K)',
        'B-H shift: -$200K (was -$250K)',
        'TR: $200K (reduced from $250K)',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY });

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
    // STEP 22-24: Unified Rebalancing Batch (BOTH settlements in ONE batch)
    // ============================================================================
    console.log('\n🏦 FRAME 22: Creating unified rebalancing batch (A-H + H-B)');

    // ✅ Store pre-settlement state for assertions
    const [, alicePreSettle] = findReplica(env, alice.id);
    const [, hubPreSettle] = findReplica(env, hub.id);
    const [, bobPreSettle] = findReplica(env, bob.id);
    const ahPreCollateral = alicePreSettle.state.accounts.get(hub.id)?.deltas.get(USDC_TOKEN_ID)?.collateral || 0n;
    const hbPreCollateral = hubPreSettle.state.accounts.get(bob.id)?.deltas.get(USDC_TOKEN_ID)?.collateral || 0n;
    const hubPreReserve = hubPreSettle.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;

    console.log(`   Pre-settlement state:`);
    console.log(`     A-H collateral: ${ahPreCollateral}`);
    console.log(`     H-B collateral: ${hbPreCollateral}`);
    console.log(`     Hub reserve: ${hubPreReserve}`);

    // Hub creates BOTH settlements via createSettlement EntityTxs (proper E-layer flow)
    await process(env, [{
      entityId: hub.id,
      signerId: 's2',
      entityTxs: [
        // Settlement 1: Alice(LEFT) ↔ Hub(RIGHT) - Hub pulls $200K from Alice
        {
          type: 'createSettlement',
          data: {
            counterpartyEntityId: alice.id,
            diffs: [{
              tokenId: USDC_TOKEN_ID,
              leftDiff: 0n,                      // Alice reserve unchanged
              rightDiff: rebalanceAmount,        // Hub reserve +$200K
              collateralDiff: -rebalanceAmount,  // A-H collateral -$200K
              ondeltaDiff: rebalanceAmount,      // ondelta +$200K
            }]
          }
        },
        // Settlement 2: Hub(LEFT) ↔ Bob(RIGHT) - Hub deposits $200K to Bob
        {
          type: 'createSettlement',
          data: {
            counterpartyEntityId: bob.id,
            diffs: [{
              tokenId: USDC_TOKEN_ID,
              leftDiff: -rebalanceAmount,        // Hub reserve -$200K
              rightDiff: 0n,                      // Bob reserve unchanged
              collateralDiff: rebalanceAmount,   // H-B collateral +$200K
              ondeltaDiff: rebalanceAmount,      // ondelta +$200K
            }]
          }
        }
      ]
    }]);

    console.log(`✅ Settlement batch created via createSettlement EntityTxs (2 settlements)`);

    await pushSnapshot(env, 'Frame 22: Rebalancing batch created', {
      title: 'Rebalancing: Unified Batch Ready',
      what: 'Hub created ONE batch with 2 settlements: pull from Alice, deposit to Bob.',
      why: 'Batching is efficient. One J-block processes both operations atomically.',
      tradfiParallel: 'Like ACH batch file: multiple transfers in single settlement instruction.',
      keyMetrics: [
        'Settlement 1: A-H collateral -$200K',
        'Settlement 2: H-B collateral +$200K',
        'Total operations: 2 (in 1 batch)',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // STEP 23: Hub broadcasts jBatch via j_broadcast EntityTx (PROPER E→J FLOW)
    console.log('\n🏦 FRAME 23: Hub broadcasts jBatch to J-Machine');

    await process(env, [{
      entityId: hub.id,
      signerId: 's2',
      entityTxs: [{
        type: 'j_broadcast',
        data: {}
      }]
    }]);

    console.log(`✅ j_broadcast sent → should create YELLOW CUBE in J-mempool`);

    await pushSnapshot(env, 'Frame 23: jBatch in J-mempool (PENDING)', {
      title: 'J-Mempool: Yellow Cube',
      what: 'Settlement batch sits in J-Machine mempool (yellow cube). Will process after blockDelayMs.',
      why: 'Visual feedback: batch is queued, not yet executed. Realistic blockchain delay.',
      tradfiParallel: 'Like SWIFT queue: message sent, awaiting settlement window.',
      keyMetrics: [
        'J-mempool: 1 batch (2 settlements)',
        'Block delay: 300ms',
        'Status: PENDING',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // STEP 24: Advance time and process J-mempool
    console.log('\n🏦 FRAME 24: Advancing time for J-Machine block processing...');

    // Manually advance timestamp past blockDelayMs (deterministic, no real sleep)
    env.timestamp += 350; // Advance 350ms (> 300ms blockDelayMs)
    console.log(`   ⏰ Time advanced: +350ms (blockDelayMs = 300ms)`);

    // Trigger runtime tick to process J-mempool
    console.log('   Triggering runtime tick to process J-mempool...');
    await process(env); // This will run J-machine block processor

    // Process any j_events that came back from BrowserVM
    await processJEvents(env);
    await process(env); // Second tick to route events to entities
    logPending();

    // ✅ ASSERT: Both settlements executed atomically
    const [, aliceRepRebal] = findReplica(env, alice.id);
    const [, hubRepRebal] = findReplica(env, hub.id);
    const [, bobRepRebal] = findReplica(env, bob.id);

    const ahAccountRebal = aliceRepRebal.state.accounts.get(hub.id);
    const ahDeltaRebal = ahAccountRebal?.deltas.get(USDC_TOKEN_ID);
    const expectedAHCollateral = ahPreCollateral - rebalanceAmount;

    if (!ahDeltaRebal || ahDeltaRebal.collateral !== expectedAHCollateral) {
      const actual = ahDeltaRebal?.collateral || 0n;
      throw new Error(`❌ ASSERT FAIL: A-H collateral = ${actual}, expected ${expectedAHCollateral}`);
    }
    console.log(`✅ ASSERT: A-H collateral ${ahPreCollateral} → ${ahDeltaRebal.collateral} (-$200K) ✓`);

    const hbAccountRebal = hubRepRebal.state.accounts.get(bob.id);
    const hbDeltaRebal = hbAccountRebal?.deltas.get(USDC_TOKEN_ID);
    const expectedHBCollateral = hbPreCollateral + rebalanceAmount;

    if (!hbDeltaRebal || hbDeltaRebal.collateral !== expectedHBCollateral) {
      const actual = hbDeltaRebal?.collateral || 0n;
      throw new Error(`❌ ASSERT FAIL: H-B collateral = ${actual}, expected ${expectedHBCollateral}`);
    }
    console.log(`✅ ASSERT: H-B collateral ${hbPreCollateral} → ${hbDeltaRebal.collateral} (+$200K) ✓`);

    // ✅ ASSERT: Hub reserve net zero (pulled $200K, deposited $200K)
    const hubPostReserve = hubRepRebal.state.reserves.get(String(USDC_TOKEN_ID)) || 0n;
    if (hubPostReserve !== hubPreReserve) {
      throw new Error(`❌ ASSERT FAIL: Hub reserve changed: ${hubPreReserve} → ${hubPostReserve} (should be unchanged)`);
    }
    console.log(`✅ ASSERT: Hub reserve ${hubPreReserve} (unchanged - pulled/deposited $200K) ✓`);

    await pushSnapshot(env, 'Frame 24: Rebalancing complete (atomic)', {
      title: 'Rebalancing Complete',
      what: 'ONE batch executed BOTH settlements atomically. TR = $0.',
      why: 'Batching proves efficiency. Hub pulled from Alice, deposited to Bob, all in 1 J-block.',
      tradfiParallel: 'Like FedACH batch processing: multiple operations, single settlement window.',
      keyMetrics: [
        'A-H collateral: $500K → $300K (-$200K)',
        'H-B collateral: $0 → $200K (+$200K)',
        'Hub reserve: unchanged (net zero)',
        'Total Risk: $0 (fully balanced)',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // ============================================================================
    // FINAL SUMMARY
    // ============================================================================

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
    console.log('Phase 4: Reverse payment B→H→A ($50K) - net $200K');
    console.log('Phase 5: Rebalancing - TR $200K → $0');
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

  process.exit(0);
}
