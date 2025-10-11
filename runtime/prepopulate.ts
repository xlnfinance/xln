/**
 * Prepopulate XLN with H-shaped network topology
 * Creates 10 entities: 2 hubs (E1-E2) and 8 users (E3-E10)
 * Visual structure: H-shaped for clean 1px=$1 bars visualization
 */

import type { Env, EntityInput, AccountMachine, EnvSnapshot, EntityReplica } from './types';
import { applyRuntimeInput } from './runtime';
import { createNumberedEntity } from './entity-factory';
import { getAvailableJurisdictions } from './evm';
import { createDemoDelta } from './account-utils';
import { buildEntityProfile } from './gossip-helper';
import { cloneEntityReplica } from './state-helpers';
import type { Profile } from './gossip';

const USDC_TOKEN_ID = 1; // Token 1 = USDC (fixed from incorrect token 2)
const DECIMALS = 18n;
const ONE_TOKEN = 10n ** DECIMALS;

type AccountProfile = NonNullable<Profile['accounts']>[number];

const usd = (amount: number | bigint) => BigInt(amount) * ONE_TOKEN;

type ReplicaEntry = [string, EntityReplica];

function findReplica(env: Env, entityId: string): ReplicaEntry {
  const entry = Array.from(env.replicas.entries()).find(([key]) => key.startsWith(entityId + ':'));
  if (!entry) {
    throw new Error(`PREPOPULATE: Replica for entity ${entityId} not found`);
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

    const clonedAccounts: AccountProfile[] = profile.accounts
      ? profile.accounts.map((account): AccountProfile => {
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

function upsertAccount(
  replica: EntityReplica,
  counterpartyId: string,
  ownCreditLimit: bigint,
  peerCreditLimit: bigint,
  collateral: bigint,
  deltaValue: bigint,
) {
  const accountMachine: AccountMachine = {
    counterpartyEntityId: counterpartyId,
    mempool: [],
    currentFrame: {
      height: 0,
      timestamp: 0,
      accountTxs: [],
      prevFrameHash: '',
      tokenIds: [USDC_TOKEN_ID],
      deltas: [deltaValue],
      stateHash: ''
    },
    sentTransitions: 0,
    ackedTransitions: 0,
    deltas: new Map([[USDC_TOKEN_ID, (() => {
      const delta = createDemoDelta(USDC_TOKEN_ID, collateral, deltaValue);
      delta.leftCreditLimit = ownCreditLimit;
      delta.rightCreditLimit = peerCreditLimit;
      return delta;
    })()]]),
    globalCreditLimits: {
      ownLimit: ownCreditLimit,
      peerLimit: peerCreditLimit,
    },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    sendCounter: 0,
    receiveCounter: 0,
    proofHeader: {
      fromEntity: replica.state.entityId,
      toEntity: counterpartyId,
      cooperativeNonce: 0,
      disputeNonce: 0,
    },
    proofBody: {
      tokenIds: [USDC_TOKEN_ID],
      deltas: [deltaValue],
    },
    frameHistory: [],
    pendingWithdrawals: new Map(),
          requestedRebalance: new Map(), // Phase 2: C→R withdrawal tracking
  };

  replica.state.accounts.set(counterpartyId, accountMachine);
}

function ensureReserves(replica: EntityReplica, reserveAmount: bigint) {
  if (!replica.state.reserves) {
    replica.state.reserves = new Map();
  }
  replica.state.reserves.set(String(USDC_TOKEN_ID), reserveAmount);
}

function ensureMutualCredit(
  env: Env,
  leftEntityId: string,
  rightEntityId: string,
  options: {
    leftCredit: bigint;
    rightCredit: bigint;
    leftCollateral: bigint;
    rightCollateral: bigint;
    leftReserve: bigint;
    rightReserve: bigint;
    delta?: bigint;
  },
) {
  const [leftKey, leftReplica] = findReplica(env, leftEntityId);
  const [rightKey, rightReplica] = findReplica(env, rightEntityId);

  const deltaValue = options.delta ?? 0n;

  upsertAccount(leftReplica, rightEntityId, options.leftCredit, options.rightCredit, options.leftCollateral, deltaValue);
  upsertAccount(rightReplica, leftEntityId, options.rightCredit, options.leftCredit, options.rightCollateral, -deltaValue);

  ensureReserves(leftReplica, options.leftReserve);
  ensureReserves(rightReplica, options.rightReserve);

  if (env.gossip) {
    env.gossip.announce(buildEntityProfile(leftReplica.state));
    env.gossip.announce(buildEntityProfile(rightReplica.state));
  }

  console.log(`🤝 Ensured mutual credit: ${leftKey.slice(0, 10)}… ↔ ${rightKey.slice(0, 10)}…`);
}

function pushFinalSnapshot(env: Env, description: string) {
  const gossipSnapshot = cloneProfilesForSnapshot(env);

  const snapshot: EnvSnapshot = {
    height: env.height,
    timestamp: Date.now(),
    replicas: new Map(
      Array.from(env.replicas.entries()).map(([key, replica]) => [key, cloneEntityReplica(replica)]),
    ),
    runtimeInput: {
      runtimeTxs: [],
      entityInputs: [],
    },
    runtimeOutputs: [],
    description,
    ...(gossipSnapshot ? { gossip: gossipSnapshot } : {}),
  };

  if (!env.history) {
    env.history = [];
  }

  env.history.push(snapshot);
}

export async function prepopulate(env: Env, processUntilEmpty: (env: Env, inputs?: EntityInput[]) => Promise<any>): Promise<void> {
  console.log('🌐 Starting XLN Prepopulation');
  console.log('================================');
  console.log('Creating H-shaped network topology:');
  console.log('  • 2 Hubs (E1, E2) - connected crossbar');
  console.log('  • 4 Users (E3-E6) - split between hubs');
  console.log('    - E3, E4 → Hub E1');
  console.log('    - E5, E6 → Hub E2');
  console.log('  Visual: Clean H-shape with 6 entities total');
  console.log('================================\n');

  // Load jurisdiction configuration using the browser-compatible function
  const jurisdictions = await getAvailableJurisdictions();
  const arrakis = jurisdictions.find(j => j.name.toLowerCase() === 'arrakis');

  if (!arrakis) {
    throw new Error('Arrakis jurisdiction not found in available jurisdictions');
  }

  console.log(`📋 Using jurisdiction: ${arrakis.name}`);
  console.log(`  ├─ EntityProvider: ${arrakis.entityProviderAddress}`);
  console.log(`  └─ Depository: ${arrakis.depositoryAddress}`);

  // Step 1: Create 6 entities by getting proper entity IDs from blockchain
  console.log('📦 Step 1: Creating 6 entities with blockchain-assigned IDs...');
  console.log('  Each entity will get sequential ID from the blockchain');

  const entities: Array<{id: string, signer: string, isHub: boolean}> = [];
  const createEntityTxs = [];

  for (let i = 1; i <= 6; i++) {
    const signer = `s${i}`;
    const isHub = i <= 2; // Only first 2 entities are hubs (H-shaped topology)
    const entityName = isHub ? `Hub ${i}` : `User ${i}`;

    // Create numbered entity through blockchain to get proper ID
    try {
      const { config, entityNumber, entityId } = await createNumberedEntity(
        entityName,
        [signer],  // Single validator
        1n,        // Threshold of 1
        arrakis    // Jurisdiction
      );

      entities.push({ id: entityId, signer, isHub });
      console.log(`  ✓ Created ${entityName}: Entity #${entityNumber} (${entityId.slice(0, 10)}...)`);

      // Add to batch for import
      createEntityTxs.push({
        type: 'importReplica' as const,
        entityId,
        signerId: signer,
        data: {
          isProposer: true,
          config
        }
      });
    } catch (error) {
      console.error(`  ❌ Failed to create ${entityName}:`, error);
      // For demo/testing, fall back to simple sequential IDs if blockchain fails
      const entityNumber = i;
      const entityId = '0x' + entityNumber.toString(16).padStart(64, '0');
      entities.push({ id: entityId, signer, isHub });

      createEntityTxs.push({
        type: 'importReplica' as const,
        entityId,
        signerId: signer,
        data: {
          isProposer: true,
          config: {
            mode: 'proposer-based' as const,
            threshold: 1n,
            validators: [signer],
            shares: { [signer]: 1n },
            jurisdiction: arrakis
          }
        }
      });
      console.log(`  ⚠️ Using fallback ID for ${entityName}: Entity #${entityNumber}`);
    }
  }

  // Import all entities in one batch
  await applyRuntimeInput(env, {
    runtimeTxs: createEntityTxs,
    entityInputs: []
  });

  console.log(`\n  ✅ Imported ${entities.length} entities`);
  entities.forEach((e) => {
    const entityNum = parseInt(e.id.slice(2), 16);  // Extract number from hex ID
    console.log(`    • Entity #${entityNum}: ${e.isHub ? 'HUB' : 'User'} (signer: ${e.signer})`);
  });

  console.log('\n📡 Step 2: Connecting the two hubs (H crossbar)...');

  // Step 2: Connect Hub 1 and Hub 2 (the crossbar of the H)
  const hub1 = entities[0];
  const hub2 = entities[1];

  if (!hub1 || !hub2) {
    throw new Error('Failed to create hubs');
  }

  // Hub1 opens account with Hub2
  await processUntilEmpty(env, [{
    entityId: hub1.id,
    signerId: hub1.signer,
    entityTxs: [{
      type: 'openAccount',
      data: { targetEntityId: hub2.id }
    }]
  }]);

  const hub1Num = parseInt(hub1.id.slice(2), 16);
  const hub2Num = parseInt(hub2.id.slice(2), 16);
  console.log(`  🔗 Hub E${hub1Num} ←→ Hub E${hub2Num} connected (H crossbar)`);

  console.log('\n👥 Step 3: Connecting users to hubs (H vertical bars)...');

  // Step 3: Connect users to hubs - Vertical H shape
  // Layout sorts by: degree DESC, then entityId ASC
  // After sorting (assuming entities created as E1, E2, E3, E4, E5, E6):
  //   sorted[0] = E1 (hub, left) - degree 3
  //   sorted[1] = E2 (hub, right) - degree 3
  //   sorted[2] = E3 (user, top-left) - degree 1
  //   sorted[3] = E4 (user, top-right) - degree 1
  //   sorted[4] = E5 (user, bottom-left) - degree 1
  //   sorted[5] = E6 (user, bottom-right) - degree 1
  //
  // For H pattern:
  //   E3 (top-left) ──── E1 (hub left)
  //   E5 (bottom-left) ─ E1 (hub left)
  //   E4 (top-right) ─── E2 (hub right)
  //   E6 (bottom-right) ─ E2 (hub right)

  const users = entities.slice(2); // [E3, E4, E5, E6]

  // Alternate users between hubs: E3→hub1, E4→hub2, E5→hub1, E6→hub2
  for (const [i, user] of users.entries()) {
    const hub = (i % 2 === 0) ? hub1 : hub2; // Even index → hub1, odd → hub2

    // User opens account with hub
    await processUntilEmpty(env, [{
      entityId: user.id,
      signerId: user.signer,
      entityTxs: [{
        type: 'openAccount',
        data: { targetEntityId: hub.id }
      }]
    }]);

    const userNum = parseInt(user.id.slice(2), 16);
    const hubNum = parseInt(hub.id.slice(2), 16);
    console.log(`  👤 User E${userNum} → Hub E${hubNum} connected (vertical bar)`);
  }

  console.log('\n🎯 Step 4: Setting hub profiles with lower fees...');

  // Step 4: Update hub profiles with lower routing fees
  for (const hub of [hub1, hub2]) {
    const hubNum = parseInt(hub.id.slice(2), 16);

    // Send profile update to set hub capabilities and lower fees
    await processUntilEmpty(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'profile-update',
        data: {
          profile: {
            entityId: hub.id,
            name: `Hub ${hubNum}`,
            bio: `Professional routing hub with high capacity and low fees`,
            isHub: true,
            routingFeePPM: 50, // Lower fee for hubs (0.005%)
            baseFee: 0n,
          }
        }
      }]
    }]);

    console.log(`  💰 Hub E${hubNum} - routing fee: 50 PPM (0.005%)`);
  }

  console.log('\n🏦 Step 5: Seeding mutual credit, collateral, and reserves...');

  const HUB_CREDIT = usd(250_000);
  const HUB_COLLATERAL = usd(120_000);
  const HUB_RESERVE = usd(420_000);
  const USER_CREDIT = usd(90_000);
  const USER_COLLATERAL = usd(25_000);
  const USER_RESERVE = usd(80_000);

  // Crossbar between hubs: balanced channel with substantial collateral
  ensureMutualCredit(env, hub1.id, hub2.id, {
    leftCredit: HUB_CREDIT,
    rightCredit: HUB_CREDIT,
    leftCollateral: HUB_COLLATERAL,
    rightCollateral: HUB_COLLATERAL,
    leftReserve: HUB_RESERVE,
    rightReserve: HUB_RESERVE,
    delta: 0n,
  });

  // Vertical bars: users lean on hubs for inbound credit
  users.forEach((user, index) => {
    const hub = index % 2 === 0 ? hub1 : hub2;
    const skew = index % 2 === 0 ? -usd(5_000) : usd(7_500);
    ensureMutualCredit(env, hub.id, user.id, {
      leftCredit: HUB_CREDIT,
      rightCredit: USER_CREDIT,
      leftCollateral: HUB_COLLATERAL,
      rightCollateral: USER_COLLATERAL,
      leftReserve: HUB_RESERVE,
      rightReserve: USER_RESERVE,
      delta: skew,
    });
  });

  console.log('🗂️ Capturing final snapshot for time machine playback...');
  pushFinalSnapshot(env, 'Prepopulate seeded H-topology');

  console.log('\n================================');
  console.log('✅ Prepopulation Complete!');
  console.log('\nH-shaped network topology created:');
  console.log('  • 2 Hubs connected (H crossbar)');
  console.log('  • 4 Users: 2 per hub (H vertical bars)');
  console.log('  • Total accounts: 5 (1 hub-to-hub + 4 user-to-hub)');
  console.log('  • Topology: Clean 6-entity visualization (perfect number)');
  console.log('\nYou can now:');
  console.log('  1. View clean H-shaped topology in bird view');
  console.log('  2. Send payments between any entities');
  console.log('  3. Payments will route through hubs automatically');
  console.log('================================\n');
}

