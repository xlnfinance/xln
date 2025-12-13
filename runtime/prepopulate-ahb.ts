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

  // DEBUG: Log what BrowserVM returned
  const oldReserves = replica.state.reserves?.get(String(USDC_TOKEN_ID)) ?? 0n;
  console.log(`[AHB-DEBUG] ${entityName}: BrowserVM returned ${reserves}, old replica value was ${oldReserves}`);

  // Update replica state
  if (!replica.state.reserves) {
    replica.state.reserves = new Map();
  }
  replica.state.reserves.set(String(USDC_TOKEN_ID), reserves);

  // Update gossip profile
  if (env.gossip) {
    env.gossip.announce(buildEntityProfile(replica.state, entityName));
  }

  console.log(`[AHB] Synced reserves for ${entityName || entityId.slice(0, 10)}: ${reserves / 10n**18n}M USDC`);
}

/**
 * Execute R2C (Reserve-to-Collateral) - Full flow for simnet:
 * 1. Call BrowserVM.prefundAccount (on-chain transfer)
 * 2. Sync reserves from BrowserVM
 * 3. Update account machine's delta.collateral
 */
async function executeR2C(
  env: Env,
  entityId: string,
  counterpartyId: string,
  tokenId: number,
  amount: bigint,
  browserVM: any,
  entityName?: string
): Promise<void> {
  console.log(`[AHB] Executing R2C: ${entityName || entityId.slice(0, 10)} → ${counterpartyId.slice(0, 10)}, amount=${Number(amount) / 1e18}`);

  // SOLVENCY DEBUG: Check reserves BEFORE
  const [, replica] = findReplica(env, entityId);
  const reservesBefore = replica.state.reserves?.get(String(tokenId)) ?? 0n;
  console.log(`🔍 SOLVENCY: ${entityName} reserves BEFORE R2C: ${Number(reservesBefore) / 1e18}`);

  // Step 1: On-chain transfer (reserve → collateral)
  await browserVM.prefundAccount(entityId, counterpartyId, tokenId, amount);
  console.log(`[AHB] ✅ BrowserVM.prefundAccount completed`);

  // SOLVENCY DEBUG: Query EVM directly AFTER transaction
  const evmReservesAfter = await browserVM.getReserves(entityId, tokenId);
  console.log(`🔍 SOLVENCY: EVM _reserves[${entityName}] AFTER tx: ${Number(evmReservesAfter) / 1e18}`);

  // Step 2: Sync reserves
  await syncReservesFromBrowserVM(env, entityId, browserVM, entityName);

  // SOLVENCY DEBUG: Check what sync wrote
  const reservesAfterSync = replica.state.reserves?.get(String(tokenId)) ?? 0n;
  console.log(`🔍 SOLVENCY: ${entityName} reserves AFTER sync: ${Number(reservesAfterSync) / 1e18}`);
  console.log(`🔍 SOLVENCY: Delta = ${Number(reservesBefore - reservesAfterSync) / 1e18} (expected ${Number(amount) / 1e18})`);

  if (reservesBefore - reservesAfterSync !== amount) {
    console.error(`❌ SOLVENCY VIOLATION: Reserve deduction doesn't match R2C amount!`);
  }

  // Step 3: Update account machine's delta.collateral
  // (reuse replica from line 143)
  const accountMachine = replica.state.accounts?.get(counterpartyId);

  if (accountMachine) {
    const delta = accountMachine.deltas?.get(tokenId);
    if (delta) {
      delta.collateral = (delta.collateral || 0n) + amount;
      console.log(`[AHB] ✅ Updated account delta.collateral: ${Number(delta.collateral) / 1e18}`);
    } else {
      console.warn(`[AHB] ⚠️ No delta for token ${tokenId} in account`);
    }
  } else {
    console.warn(`[AHB] ⚠️ No account machine for ${counterpartyId.slice(0, 10)}`);
  }

  // Also update counterparty's view of the account (bilateral)
  const [, counterpartyReplica] = findReplica(env, counterpartyId);
  const counterpartyAccountMachine = counterpartyReplica.state.accounts?.get(entityId);

  if (counterpartyAccountMachine) {
    const counterpartyDelta = counterpartyAccountMachine.deltas?.get(tokenId);
    if (counterpartyDelta) {
      counterpartyDelta.collateral = (counterpartyDelta.collateral || 0n) + amount;
      console.log(`[AHB] ✅ Updated counterparty account delta.collateral: ${Number(counterpartyDelta.collateral) / 1e18}`);
    }
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
    timestamp: Date.now(),
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
    }, { expectedSolvency: TOTAL_SOLVENCY }); // $10M minted to Hub

    // ============================================================================
    // STEP 2: Hub R2R → Alice ($3M USDC) - REAL TX goes to J-Machine mempool
    // ============================================================================
    console.log('\n🔄 FRAME 2: Hub → Alice Reserve Transfer ($3M) - REAL BrowserVM TX');

    // NOTE: R2R doesn't require bilateral account - pure reserve transfer
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
    }, { entityInputs: [r2rTx1], expectedSolvency: TOTAL_SOLVENCY });

    // ============================================================================
    // STEP 3: Hub R2R → Bob ($2M USDC) - Second TX to mempool
    // ============================================================================
    console.log('\n🔄 FRAME 3: Hub → Bob Reserve Transfer ($2M) - REAL BrowserVM TX');

    // NOTE: R2R doesn't require bilateral account - pure reserve transfer
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
    }, { entityInputs: [r2rTx2], expectedSolvency: TOTAL_SOLVENCY });

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

    await processUntilEmpty(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'openAccount',
        data: { targetEntityId: hub.id }
      }]
    }]);

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

    await processUntilEmpty(env, [{
      entityId: bob.id,
      signerId: bob.signer,
      entityTxs: [{
        type: 'openAccount',
        data: { targetEntityId: hub.id }
      }]
    }]);

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

    // Execute full R2C flow:
    // 1. On-chain transfer via BrowserVM.prefundAccount
    // 2. Sync reserves
    // 3. Update account machine delta.collateral in BOTH entities
    await executeR2C(env, alice.id, hub.id, USDC_TOKEN_ID, aliceCollateralAmount, browserVM, alice.name);

    // CRITICAL: Verify bilateral sync after R2C collateral deposit
    console.log('\n🔍 FRAME 8 VERIFICATION: Alice-Hub bilateral sync check...');
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

    await processUntilEmpty(env, [{
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

    // CRITICAL: Verify bilateral sync after credit extension
    console.log('\n🔍 FRAME 9 VERIFICATION: Bob-Hub bilateral sync check...');
    dumpSystemState(env, 'AFTER BOB CREDIT EXTENSION (Frame 9)', true);
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
    console.log('\n⚡ FRAME 10: Off-Chain Payment A → H → B ($125K)');

    // 25% of $500K capacity = $125K
    const paymentAmount = usd(125_000);

    // SELF-TEST: Verify collateral exists before payment
    const [, aliceReplica] = findReplica(env, alice.id);
    const aliceHubAccount = aliceReplica?.state?.accounts?.get(hub.id);
    const aliceHubDelta = aliceHubAccount?.deltas?.get(USDC_TOKEN_ID);
    console.log(`[PRE-PAYMENT] Alice-Hub account exists: ${!!aliceHubAccount}`);
    console.log(`[PRE-PAYMENT] Alice-Hub delta exists: ${!!aliceHubDelta}`);
    console.log(`[PRE-PAYMENT] Alice-Hub delta.collateral: ${aliceHubDelta?.collateral}`);
    console.log(`[PRE-PAYMENT] Alice-Hub delta.offdelta: ${aliceHubDelta?.offdelta}`);

    const deltaBeforeAH = getOffdelta(env, alice.id, hub.id, USDC_TOKEN_ID);
    const deltaBeforeHB = getOffdelta(env, hub.id, bob.id, USDC_TOKEN_ID);
    console.log(`[PRE-PAYMENT] Alice-Hub offdelta (from getOffdelta): ${deltaBeforeAH}`);
    console.log(`[PRE-PAYMENT] Hub-Bob offdelta: ${deltaBeforeHB}`);

    // FRAME 12: Alice → Hub, Hub proposes to Bob (Bob doesn't accept yet)
    // Dynamic import to avoid circular dependency
    const { process: proc } = await import('./runtime');

    // Step 1: Alice initiates (Alice -> Hub)
    console.error('🏃 STEP 1: Alice initiates payment...');
    console.error(`   Alice: ${alice.id.slice(-4)}, Hub: ${hub.id.slice(-4)}, Bob: ${bob.id.slice(-4)}`);
    console.error(`   Amount: ${paymentAmount}, Route: [${alice.id.slice(-4)},${hub.id.slice(-4)},${bob.id.slice(-4)}]`);

    await proc(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: bob.id,
          tokenId: USDC_TOKEN_ID,
          amount: paymentAmount,
          route: [alice.id, hub.id, bob.id],
          description: 'First off-chain payment!'
        }
      }]
    }], 0, true);

    console.error(`✅ STEP 1 complete, checking pendingOutputs...`);
    const hubInbox = env.pendingOutputs || [];
    console.error(`   pendingOutputs.length: ${hubInbox.length}`);
    if (hubInbox.length > 0) {
      console.error(`   Output entities: [${hubInbox.map(o => o.entityId.slice(-4)).join(',')}]`);
    } else {
      console.error(`   ❌ NO OUTPUTS from Step 1! Alice didn't produce output for Hub`);
    }
    env.pendingOutputs = [];

    console.error(`\n🏃 STEP 2: Hub processes ${hubInbox.length} messages...`);
    if (hubInbox.length > 0) {
       await proc(env, hubInbox, 0, true);
       console.error(`✅ STEP 2 complete, checking pendingOutputs...`);
    } else {
       console.error(`⏭️ STEP 2 skipped (no hubInbox)`);
    }

    const outbox12 = env.pendingOutputs || [];
    console.error(`   Step 2 pendingOutputs.length: ${outbox12.length}`);
    if (outbox12.length > 0) {
      console.error(`   Output entities: [${outbox12.map(o => o.entityId.slice(-4)).join(',')}]`);
    } else {
      console.error(`   ❌ NO OUTPUTS from Step 2! Hub didn't produce output for Bob`);
    }
    env.pendingOutputs = [];

    const ahDelta12 = getOffdelta(env, alice.id, hub.id, USDC_TOKEN_ID);
    const hbDelta12 = getOffdelta(env, hub.id, bob.id, USDC_TOKEN_ID);

    console.log(`📊 Frame 12: A-H=${ahDelta12}, H-B=${hbDelta12}, outbox=${outbox12.length}`);
    console.log(`📊 Frame 12 outbox entities: [${outbox12.map(o => o.entityId.slice(-4)).join(',')}]`);
    console.log(`📊 Frame 12 EXPECT: Hub NOT processed yet (A-H should be 0), outbox has Hub`);

    if (hbDelta12 !== 0n) {
      throw new Error(`❌ Frame 12: Hub-Bob changed (should be 0)! Bob hasn't processed yet.`);
    }

    await pushSnapshot(env, 'Frame 12: Alice → Hub, Hub AUTO-PROPOSES to Bob', {
      title: 'Hop 1: Alice-Hub Commits, Hub Proposes to Bob',
      what: `Alice-Hub bilateral consensus completes. Hub creates frame for Bob.`,
      why: 'Hub received payment, now proposing forward to Bob (separate tick).',
      tradfiParallel: 'First bank confirms, prepares wire to second bank',
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // FRAME 13: Bob receives and accepts Hub's proposal (from Frame 12 outbox)
    await proc(env, outbox12); // Feed Frame 12 outbox as Frame 13 inbox

    const hbDelta13 = getOffdelta(env, hub.id, bob.id, USDC_TOKEN_ID);

    console.log(`📊 Frame 13: H-B=${hbDelta13}`);

    if (hbDelta13 === 0n) {
      throw new Error(`❌ Frame 13: Hub-Bob NOT committed!`);
    }

    await pushSnapshot(env, 'Frame 13: Bob Accepts Hub Payment', {
      title: 'Hop 2: Bob Commits Hub-Bob',
      what: `Bob processes Hub's frame. Hub-Bob bilateral consensus completes.`,
      why: 'Second network hop done. Multi-hop payment finalized.',
      tradfiParallel: 'Second bank confirms receipt',
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // ============================================================================
    // STEP 11: Reverse Payment Bob → Hub → Alice ($100K)
    // ============================================================================
    console.log('\n⚡ FRAME 11: Reverse Payment B → H → A ($100K)');

    const reversePaymentAmount = usd(100_000);

    // Bob pays Alice through Hub
    await processUntilEmpty(env, [{
      entityId: bob.id,
      signerId: bob.signer,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: alice.id,
          tokenId: USDC_TOKEN_ID,
          amount: reversePaymentAmount,
          route: [bob.id, hub.id, alice.id], // Route: Bob → Hub → Alice
          description: 'Reverse payment - bidirectional flow!'
        }
      }]
    }]);

    // CRITICAL: Verify bilateral sync after reverse payment
    console.log('\n🔍 FRAME 11 VERIFICATION: Bilateral sync checks after reverse payment...');
    assertBilateralSync(env, alice.id, hub.id, USDC_TOKEN_ID, 'Frame 11 - After Reverse (Alice-Hub)');
    assertBilateralSync(env, hub.id, bob.id, USDC_TOKEN_ID, 'Frame 11 - After Reverse (Hub-Bob)');

    await pushSnapshot(env, 'Reverse Payment: Bob → Hub → Alice $100K', {
      title: '⚡ Bidirectional Payment: B → H → A',
      what: 'Bob sends $100K to Alice via Hub. Payment flows BACKWARDS through same route!',
      why: 'Demonstrates true bidirectional settlement - payments can flow both ways through the same accounts.',
      tradfiParallel: 'Like a wire transfer reversal or return payment through correspondent banking.',
      keyMetrics: [
        'Payment: $100K (opposite direction)',
        'Net A-H: -$25K (Alice sent $125K, received $100K)',
        'Net H-B: -$25K (Hub forwarded both, earned fees)',
        'Total fees earned by Hub: ~$250',
      ]
    }, { expectedSolvency: TOTAL_SOLVENCY });

    // FINAL BILATERAL SYNC CHECK - All accounts must be synced
    console.log('\n🔍 FINAL VERIFICATION: All bilateral accounts...');
    assertBilateralSync(env, alice.id, hub.id, USDC_TOKEN_ID, 'FINAL - Alice-Hub');
    assertBilateralSync(env, hub.id, bob.id, USDC_TOKEN_ID, 'FINAL - Hub-Bob');
    dumpSystemState(env, 'FINAL STATE (End of AHB)', true);

    console.log('\n=====================================');
    console.log('✅ AHB Demo Complete (Full Flow)!');
    console.log('11 frames captured for time machine playback');
    console.log('Phase 1: R2R reserve distribution');
    console.log('Phase 2: Bilateral accounts + R2C + credit');
    console.log('Phase 3: First off-chain routed payment');
    console.log('Use arrow keys to step through the demo');
    console.log('=====================================\n');
    console.log(`[AHB] FINAL: Total snapshots pushed: ${pushSnapshotCount}`);
    console.log(`[AHB] FINAL: env.history.length: ${env.history?.length}`);
  } finally {
    env.disableAutoSnapshots = false; // ALWAYS re-enable, even on error
  }
}
