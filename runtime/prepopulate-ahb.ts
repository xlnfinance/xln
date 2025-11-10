/**
 * Alice-Hub-Bob (AHB) Demo: Step-by-step collateral & settlement flows
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

import type { Env, EntityInput, AccountMachine, EnvSnapshot, EntityReplica } from './types';
import { applyRuntimeInput } from './runtime';
import { createNumberedEntity } from './entity-factory';
import { getAvailableJurisdictions } from './evm';
import { createDemoDelta } from './account-utils';
import { buildEntityProfile } from './gossip-helper';
import { cloneEntityReplica } from './state-helpers';
import type { Profile } from './gossip';

const USDC_TOKEN_ID = 1;
const DECIMALS = 18n;
const ONE_TOKEN = 10n ** DECIMALS;

const usd = (amount: number | bigint) => BigInt(amount) * ONE_TOKEN;

type ReplicaEntry = [string, EntityReplica];

function findReplica(env: Env, entityId: string): ReplicaEntry {
  const entry = Array.from(env.replicas.entries()).find(([key]) => key.startsWith(entityId + ':'));
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
    requestedRebalance: new Map(),
  };

  replica.state.accounts.set(counterpartyId, accountMachine);
}

function ensureReserves(replica: EntityReplica, reserveAmount: bigint) {
  if (!replica.state.reserves) {
    replica.state.reserves = new Map();
  }
  replica.state.reserves.set(String(USDC_TOKEN_ID), reserveAmount);
}

function setReservesAndAccounts(
  env: Env,
  entityId: string,
  reserves: bigint,
  accounts: Array<{
    counterpartyId: string;
    ownCredit: bigint;
    peerCredit: bigint;
    collateral: bigint;
    delta: bigint;
  }>,
) {
  const [, replica] = findReplica(env, entityId);
  ensureReserves(replica, reserves);

  for (const acc of accounts) {
    upsertAccount(
      replica,
      acc.counterpartyId,
      acc.ownCredit,
      acc.peerCredit,
      acc.collateral,
      acc.delta,
    );
  }

  if (env.gossip) {
    env.gossip.announce(buildEntityProfile(replica.state));
  }
}

interface FrameSubtitle {
  title: string;           // Short header (e.g., "Reserve-to-Reserve Transfer")
  what: string;            // What's happening technically
  why: string;             // Why this matters
  tradfiParallel: string;  // Traditional finance equivalent
  keyMetrics?: string[];   // Optional: bullet points of key numbers
}

function pushSnapshot(env: Env, description: string, subtitle: FrameSubtitle) {
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
    subtitle, // NEW: Fed Chair educational content
    ...(gossipSnapshot ? { gossip: gossipSnapshot } : {}),
  };

  if (!env.history) {
    env.history = [];
  }

  env.history.push(snapshot);
  console.log(`📸 Snapshot: ${description}`);
}

export async function prepopulateAHB(env: Env, processUntilEmpty: (env: Env, inputs?: EntityInput[]) => Promise<any>): Promise<void> {
  console.log('🎬 Starting Alice-Hub-Bob (AHB) Demo');
  console.log('=====================================');
  console.log('Educational flow demonstrating:');
  console.log('  • Reserve-to-Reserve (R2R) transfers');
  console.log('  • Reserve-to-Collateral (R2C) prefunding');
  console.log('  • Off-chain ondelta changes (bilateral netting)');
  console.log('  • Collateral-to-Reserve (C2R) withdrawals');
  console.log('=====================================\n');

  const jurisdictions = await getAvailableJurisdictions();
  const arrakis = jurisdictions.find(j => j.name.toLowerCase() === 'arrakis');

  if (!arrakis) {
    throw new Error('Arrakis jurisdiction not found');
  }

  console.log(`📋 Jurisdiction: ${arrakis.name}`);

  // ============================================================================
  // STEP 0: Create entities
  // ============================================================================
  console.log('\n📦 Creating entities: Alice, Hub, Bob...');

  const entityNames = ['Alice', 'Hub', 'Bob'];
  const entities: Array<{id: string, signer: string, name: string}> = [];
  const createEntityTxs = [];

  for (let i = 0; i < 3; i++) {
    const name = entityNames[i];
    const signer = `s${i + 1}`;

    try {
      const { config, entityNumber, entityId } = await createNumberedEntity(
        name,
        [signer],
        1n,
        arrakis
      );

      entities.push({ id: entityId, signer, name });
      console.log(`  ✓ ${name}: Entity #${entityNumber}`);

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
      console.error(`  ❌ Failed to create ${name}:`, error);
      const entityNumber = i + 1;
      const entityId = '0x' + entityNumber.toString(16).padStart(64, '0');
      entities.push({ id: entityId, signer, name });

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
      console.log(`  ⚠️ Using fallback ID for ${name}`);
    }
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
  // STEP 1: Initial State - Hub funded with 100 USDC
  // ============================================================================
  console.log('\n💰 FRAME 1: Initial State - Hub Reserve Funding');

  setReservesAndAccounts(env, hub.id, usd(100), []);
  setReservesAndAccounts(env, alice.id, usd(0), []);
  setReservesAndAccounts(env, bob.id, usd(0), []);

  pushSnapshot(env, 'Initial State: Hub Funded', {
    title: 'Initial Liquidity Provision',
    what: 'Hub entity receives 100 USDC reserve balance on Depository.sol (on-chain)',
    why: 'Reserve balances are the source of liquidity for off-chain bilateral accounts. Think of this as the hub depositing cash into its custody account.',
    tradfiParallel: 'Like a correspondent bank depositing USD reserves at the Federal Reserve to enable wire transfers',
    keyMetrics: [
      'Hub Reserve: 100 USDC',
      'Alice Reserve: 0 USDC',
      'Bob Reserve: 0 USDC',
    ]
  });

  // ============================================================================
  // STEP 2: Hub R2R → Alice (30 USDC)
  // ============================================================================
  console.log('\n🔄 FRAME 2: Hub → Alice Reserve Transfer (30 USDC)');

  // Open accounts first
  await processUntilEmpty(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'openAccount',
      data: { targetEntityId: alice.id }
    }]
  }]);

  // Setup state: Hub transferred 30 to Alice
  setReservesAndAccounts(env, hub.id, usd(70), [
    { counterpartyId: alice.id, ownCredit: 0n, peerCredit: 0n, collateral: 0n, delta: 0n }
  ]);
  setReservesAndAccounts(env, alice.id, usd(30), [
    { counterpartyId: hub.id, ownCredit: 0n, peerCredit: 0n, collateral: 0n, delta: 0n }
  ]);

  pushSnapshot(env, 'Hub → Alice: 30 USDC Reserve Transfer', {
    title: 'Reserve-to-Reserve Transfer (R2R)',
    what: 'Hub calls Depository.reserveToReserve(Alice, 30 USDC). On-chain balance update: Hub -= 30, Alice += 30',
    why: 'R2R transfers are the simplest form of value movement - pure on-chain settlement with no bilateral account involved yet.',
    tradfiParallel: 'Like a Fedwire transfer: instant, final, on-chain settlement between reserve accounts',
    keyMetrics: [
      'Hub Reserve: 70 USDC (-30)',
      'Alice Reserve: 30 USDC (+30)',
      'Gas cost: ~50k (single EVM call)',
    ]
  });

  // ============================================================================
  // STEP 3: Hub R2R → Bob (20 USDC)
  // ============================================================================
  console.log('\n🔄 FRAME 3: Hub → Bob Reserve Transfer (20 USDC)');

  await processUntilEmpty(env, [{
    entityId: hub.id,
    signerId: hub.signer,
    entityTxs: [{
      type: 'openAccount',
      data: { targetEntityId: bob.id }
    }]
  }]);

  setReservesAndAccounts(env, hub.id, usd(50), [
    { counterpartyId: alice.id, ownCredit: 0n, peerCredit: 0n, collateral: 0n, delta: 0n },
    { counterpartyId: bob.id, ownCredit: 0n, peerCredit: 0n, collateral: 0n, delta: 0n }
  ]);
  setReservesAndAccounts(env, bob.id, usd(20), [
    { counterpartyId: hub.id, ownCredit: 0n, peerCredit: 0n, collateral: 0n, delta: 0n }
  ]);

  pushSnapshot(env, 'Hub → Bob: 20 USDC Reserve Transfer', {
    title: 'Second R2R Transfer',
    what: 'Hub calls Depository.reserveToReserve(Bob, 20 USDC). Same mechanism as previous transfer.',
    why: 'Now Hub has distributed 50 USDC total (30 to Alice, 20 to Bob) while retaining 50 USDC for further operations.',
    tradfiParallel: 'Hub acts like a treasury distributing funds to subsidiaries via wire transfers',
    keyMetrics: [
      'Hub Reserve: 50 USDC (-20)',
      'Bob Reserve: 20 USDC (+20)',
      'Total distributed: 50 USDC',
    ]
  });

  // ============================================================================
  // STEP 4: Alice prefunds account (10 reserve → collateral)
  // ============================================================================
  console.log('\n🔒 FRAME 4: Alice Prefunds Account with Hub (10 USDC)');

  setReservesAndAccounts(env, alice.id, usd(20), [
    { counterpartyId: hub.id, ownCredit: usd(50), peerCredit: usd(50), collateral: usd(10), delta: usd(10) }
  ]);
  setReservesAndAccounts(env, hub.id, usd(50), [
    { counterpartyId: alice.id, ownCredit: usd(50), peerCredit: usd(50), collateral: usd(10), delta: -usd(10) },
    { counterpartyId: bob.id, ownCredit: 0n, peerCredit: 0n, collateral: 0n, delta: 0n }
  ]);

  pushSnapshot(env, 'Alice → Hub: 10 USDC Reserve to Collateral', {
    title: 'Reserve-to-Collateral Prefunding (R2C)',
    what: 'Alice calls Depository.prefundAccount(Hub, 10 USDC). Moves funds from Alice reserve into bilateral account collateral. Ondelta = +10 (Alice is "left" entity)',
    why: 'Collateral enables off-chain bilateral settlement. Like Lightning channels, but WITH credit extension beyond collateral (unique to XLN).',
    tradfiParallel: 'Like posting margin at a clearinghouse before trading derivatives. Collateral backs off-chain netting, reducing settlement frequency.',
    keyMetrics: [
      'Alice Reserve: 20 USDC (-10)',
      'Alice↔Hub Collateral: 10 USDC',
      'Ondelta: +10 (Alice funded)',
      'Credit limits: 50 USDC each',
    ]
  });

  // ============================================================================
  // STEP 5: Bob prefunds account (15 reserve → collateral)
  // ============================================================================
  console.log('\n🔒 FRAME 5: Bob Prefunds Account with Hub (15 USDC)');

  setReservesAndAccounts(env, bob.id, usd(5), [
    { counterpartyId: hub.id, ownCredit: usd(50), peerCredit: usd(50), collateral: usd(15), delta: -usd(15) }
  ]);
  setReservesAndAccounts(env, hub.id, usd(50), [
    { counterpartyId: alice.id, ownCredit: usd(50), peerCredit: usd(50), collateral: usd(10), delta: -usd(10) },
    { counterpartyId: bob.id, ownCredit: usd(50), peerCredit: usd(50), collateral: usd(15), delta: usd(15) }
  ]);

  pushSnapshot(env, 'Bob → Hub: 15 USDC Reserve to Collateral', {
    title: 'Second R2C Prefunding',
    what: 'Bob calls Depository.prefundAccount(Hub, 15 USDC). Bob is "right" entity (entityId > Hub), so ondelta = +15 from Hub perspective.',
    why: 'Both Alice and Bob now have bilateral accounts with Hub, each backed by collateral. This enables off-chain payment routing.',
    tradfiParallel: 'Both parties posted margin. Now they can net trades off-chain, settling only final positions periodically (like CME FX netting).',
    keyMetrics: [
      'Bob Reserve: 5 USDC (-15)',
      'Hub↔Bob Collateral: 15 USDC',
      'Ondelta: +15 (Hub perspective)',
      'Total locked collateral: 25 USDC',
    ]
  });

  // ============================================================================
  // STEP 6: Alice ↔ Hub off-chain payment (ondelta change -5)
  // ============================================================================
  console.log('\n⚡ FRAME 6: Alice → Hub Off-Chain Payment (5 USDC)');

  setReservesAndAccounts(env, alice.id, usd(20), [
    { counterpartyId: hub.id, ownCredit: usd(50), peerCredit: usd(50), collateral: usd(10), delta: usd(5) }
  ]);
  setReservesAndAccounts(env, hub.id, usd(50), [
    { counterpartyId: alice.id, ownCredit: usd(50), peerCredit: usd(50), collateral: usd(10), delta: -usd(5) },
    { counterpartyId: bob.id, ownCredit: usd(50), peerCredit: usd(50), collateral: usd(15), delta: usd(15) }
  ]);

  pushSnapshot(env, 'Alice → Hub: 5 USDC Off-Chain (Ondelta)', {
    title: 'Off-Chain Bilateral Netting',
    what: 'Alice sends 5 USDC to Hub off-chain. NO on-chain transaction! Ondelta changes from +10 to +5. Both parties sign new AccountFrame.',
    why: 'This is the magic: instant, zero-gas payments via bilateral state updates. Ondelta tracks net position. Can go negative (credit extension!).',
    tradfiParallel: 'Like continuous net settlement (CNS) in securities clearing: trade all day, settle net position once. Or SWIFT gpi bilateral netting.',
    keyMetrics: [
      'Ondelta: +10 → +5 (-5 change)',
      'Gas cost: 0 (off-chain)',
      'Latency: <100ms (bilateral agreement)',
      'Collateral unchanged: 10 USDC',
    ]
  });

  // ============================================================================
  // STEP 7: Bob ↔ Hub off-chain payment (ondelta change +8)
  // ============================================================================
  console.log('\n⚡ FRAME 7: Hub → Bob Off-Chain Payment (8 USDC)');

  setReservesAndAccounts(env, bob.id, usd(5), [
    { counterpartyId: hub.id, ownCredit: usd(50), peerCredit: usd(50), collateral: usd(15), delta: -usd(23) }
  ]);
  setReservesAndAccounts(env, hub.id, usd(50), [
    { counterpartyId: alice.id, ownCredit: usd(50), peerCredit: usd(50), collateral: usd(10), delta: -usd(5) },
    { counterpartyId: bob.id, ownCredit: usd(50), peerCredit: usd(50), collateral: usd(15), delta: usd(23) }
  ]);

  pushSnapshot(env, 'Hub → Bob: 8 USDC Off-Chain (Ondelta)', {
    title: 'Credit Extension Beyond Collateral',
    what: 'Hub sends 8 USDC to Bob. Ondelta: +15 → +23. CRITICAL: Ondelta (+23) exceeds collateral (15)! This is credit extension.',
    why: 'XLN\'s killer feature: collateral bounds MAX exposure, but credit can extend beyond. If Hub defaults, Bob loses max 15 USDC (collateral), not 23.',
    tradfiParallel: 'Like a credit line secured by partial collateral. Federal Reserve Daylight Overdrafts work similarly: banks can overdraw (credit) with collateral caps.',
    keyMetrics: [
      'Ondelta: +15 → +23 (+8 change)',
      'Collateral: 15 USDC (unchanged)',
      'Credit exposure: 23 USDC (8 beyond collateral)',
      'Hub\'s risk: Limited to 15 USDC',
    ]
  });

  // ============================================================================
  // STEP 8: Alice withdraws collateral (settlement)
  // ============================================================================
  console.log('\n💸 FRAME 8: Alice Closes Account (Collateral → Reserve)');

  setReservesAndAccounts(env, alice.id, usd(25), [
    { counterpartyId: hub.id, ownCredit: usd(50), peerCredit: usd(50), collateral: usd(0), delta: usd(0) }
  ]);
  setReservesAndAccounts(env, hub.id, usd(45), [
    { counterpartyId: alice.id, ownCredit: usd(50), peerCredit: usd(50), collateral: usd(0), delta: usd(0) },
    { counterpartyId: bob.id, ownCredit: usd(50), peerCredit: usd(50), collateral: usd(15), delta: usd(23) }
  ]);

  pushSnapshot(env, 'Alice Closes Account: Collateral → Reserve Settlement', {
    title: 'Cooperative Settlement (Collateral-to-Reserve)',
    what: 'Alice & Hub call Depository.settle() with signed SettlementDiff. Ondelta (+5) determines distribution: Alice gets 5, Hub gets 5 back to reserves. Collateral released.',
    why: 'Settlements are how bilateral accounts close. Ondelta determines final payout. This is the "cash out" moment - converting off-chain positions to on-chain reserves.',
    tradfiParallel: 'Like closing a margin account at a brokerage: net position (ondelta) determines who gets what from the posted collateral.',
    keyMetrics: [
      'Alice Reserve: 20 → 25 (+5 from ondelta)',
      'Hub Reserve: 50 → 45 (-5 settled)',
      'Collateral released: 10 USDC',
      'Account closed (ondelta = 0)',
    ]
  });

  // ============================================================================
  // STEP 9: Final state summary
  // ============================================================================
  console.log('\n📊 FRAME 9: Final State Summary');

  pushSnapshot(env, 'Final State: AHB Demo Complete', {
    title: 'End State: Mixed Reserve & Collateral Positions',
    what: 'Alice: 25 USDC reserve (closed account). Hub: 45 USDC reserve + 15 collateral with Bob (ondelta +23). Bob: 5 USDC reserve + account with Hub.',
    why: 'This demonstrates the full cycle: R2R funding → R2C collateral → off-chain netting → C2R settlement. Hub still has active credit exposure to Bob.',
    tradfiParallel: 'Alice "withdrew" like closing a brokerage account. Hub-Bob relationship remains active, like an open credit line with outstanding balance.',
    keyMetrics: [
      'Alice: 25 USDC reserve (no accounts)',
      'Hub: 45 USDC reserve + 1 active account',
      'Bob: 5 USDC reserve + 1 active account',
      'Outstanding credit: 8 USDC (Hub → Bob)',
      'Total system reserves: 75 USDC',
      'Total locked collateral: 15 USDC',
    ]
  });

  console.log('\n=====================================');
  console.log('✅ AHB Demo Complete!');
  console.log('9 frames captured for time machine playback');
  console.log('Use arrow keys to step through the demo');
  console.log('=====================================\n');
}
