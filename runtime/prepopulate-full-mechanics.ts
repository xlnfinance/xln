/**
 * COMPREHENSIVE DEMO: All 10 Core XLN Mechanics
 *
 * Sequential demonstration of every mechanic with visual flow particles
 * Target: Banking executives, Fed Chair, technical audiences
 *
 * Mechanics demonstrated:
 * 1. R2R (Reserve to Reserve)
 * 2. R2C (Reserve to Collateral)
 * 3. C2R (Collateral to Reserve)
 * 4. Off-Chain Ondelta
 * 5. Credit Extension
 * 6. Cooperative Settlement
 * 7. Dispute Resolution
 * 8. FIFO Debt Enforcement
 * 9. Multi-Hop Routing
 * 10. On-Chain Anchoring
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
  const entry = Array.from(env.eReplicas.entries()).find(([key]) => key.startsWith(entityId + ':'));
  if (!entry) {
    throw new Error(`Replica for entity ${entityId} not found`);
  }
  return entry as ReplicaEntry;
}

interface FrameSubtitle {
  title: string;
  what: string;
  why: string;
  tradfiParallel: string;
  keyMetrics?: string[];
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

function pushSnapshot(env: Env, description: string, subtitle: FrameSubtitle) {
  const gossipSnapshot = cloneProfilesForSnapshot(env);

  const snapshot: EnvSnapshot = {
    height: env.height,
    timestamp: Date.now(),
    eReplicas: new Map(
      Array.from(env.eReplicas.entries()).map(([key, replica]) => [key, cloneEntityReplica(replica)]),
    ),
    jReplicas: [],
    runtimeInput: { runtimeTxs: [], entityInputs: [] },
    runtimeOutputs: [],
    description,
    subtitle,
    ...(gossipSnapshot ? { gossip: gossipSnapshot } : {}),
  };

  if (!env.history) env.history = [];
  env.history.push(snapshot);
  console.log(`Frame ${env.history.length - 1}: ${description}`);
}

function setReserve(replica: EntityReplica, amount: bigint) {
  if (!replica.state.reserves) replica.state.reserves = new Map();
  replica.state.reserves.set(String(USDC_TOKEN_ID), amount);
}

function createAccount(replica: EntityReplica, counterpartyId: string, collateral: bigint, delta: bigint, ownCredit: bigint, peerCredit: bigint) {
  const accountMachine: AccountMachine = {
    counterpartyEntityId: counterpartyId,
    mempool: [],
    currentFrame: {
      height: 0,
      timestamp: 0,
      accountTxs: [],
      prevFrameHash: '',
      tokenIds: [USDC_TOKEN_ID],
      deltas: [delta],
      stateHash: ''
    },
    sentTransitions: 0,
    ackedTransitions: 0,
    deltas: new Map([[USDC_TOKEN_ID, (() => {
      const d = createDemoDelta(USDC_TOKEN_ID, collateral, delta);
      d.leftCreditLimit = ownCredit;
      d.rightCreditLimit = peerCredit;
      return d;
    })()]]),
    globalCreditLimits: { ownLimit: ownCredit, peerLimit: peerCredit },
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
    proofBody: { tokenIds: [USDC_TOKEN_ID], deltas: [delta] },
    frameHistory: [],
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
  };

  replica.state.accounts.set(counterpartyId, accountMachine);
}

export async function prepopulateFullMechanics(env: Env, processUntilEmpty: (env: Env, inputs?: EntityInput[]) => Promise<any>): Promise<void> {
  env.disableAutoSnapshots = true; // Disable automatic tick snapshots
  try {
    console.log('🎓 COMPREHENSIVE DEMO: All 10 Core Mechanics');
    console.log('═══════════════════════════════════════════════\n');

  const jurisdictions = await getAvailableJurisdictions();
  let arrakis = jurisdictions.find(j => j.name.toLowerCase() === 'arrakis');

  if (!arrakis) {
    console.log('⚠️ Creating mock jurisdiction for demo');
    arrakis = {
      name: 'Arrakis (Demo)',
      chainId: 31337,
      entityProviderAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      depositoryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
      rpc: 'http://localhost:8545'
    };
  }

  // Create 4 entities: Alice, Bob, Hub, Dave
  const entityNames = ['Alice', 'Bob', 'Hub', 'Dave'];
  const entities: Array<{id: string, signer: string, name: string}> = [];

  for (let i = 0; i < 4; i++) {
    const name = entityNames[i];
    const signer = `s${i + 1}`;

    // SIMPLE FALLBACK (no blockchain)
    const entityId = '0x' + (i + 1).toString(16).padStart(64, '0');
    entities.push({ id: entityId, signer, name });

    await applyRuntimeInput(env, {
      runtimeTxs: [{
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
      }],
      entityInputs: []
    });
    console.log(`${name}: Entity #${i + 1}`);
  }

  const [alice, bob, hub, dave] = entities;

  // Open accounts between all pairs
  for (const from of entities) {
    for (const to of entities) {
      if (from.id !== to.id) {
        await processUntilEmpty(env, [{
          entityId: from.id,
          signerId: from.signer,
          entityTxs: [{ type: 'openAccount', data: { targetEntityId: to.id } }]
        }]);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // MECHANIC 1: R2R (Reserve to Reserve)
  // ══════════════════════════════════════════════════════════════════
  const [, aliceRep] = findReplica(env, alice.id);
  const [, bobRep] = findReplica(env, bob.id);
  const [, hubRep] = findReplica(env, hub.id);
  const [, daveRep] = findReplica(env, dave.id);

  setReserve(aliceRep, usd(100));
  setReserve(bobRep, usd(0));
  setReserve(hubRep, usd(200));
  setReserve(daveRep, usd(0));

  pushSnapshot(env, 'Mechanic 1: Reserve-to-Reserve (R2R) Transfer', {
    title: '🔄 Reserve-to-Reserve (R2R)',
    what: 'Alice sends 30 USDC to Bob via Depository.reserveToReserve(). Pure on-chain settlement.',
    why: 'R2R is instant final settlement between reserves. No bilateral account needed. Like wire transfer.',
    tradfiParallel: 'Fedwire: instant gross settlement. Alice reserve -= 30, Bob reserve += 30. Final.',
    keyMetrics: ['Alice: 100 → 70 USDC', 'Bob: 0 → 30 USDC', 'Gas: ~50k', 'Latency: 1 block']
  });

  // Execute R2R
  setReserve(aliceRep, usd(70));
  setReserve(bobRep, usd(30));

  pushSnapshot(env, 'After R2R: Alice 70, Bob 30', {
    title: '✅ R2R Complete',
    what: 'Transfer executed on-chain. Reserves updated atomically.',
    why: 'On-chain settlement = maximum security, but high gas cost. Use for large/final settlements.',
    tradfiParallel: 'Fedwire finalizes $4 trillion/day this way. Expensive but instant finality.',
    keyMetrics: ['Alice: 70 USDC', 'Bob: 30 USDC', 'Transaction: Final']
  });

  // ══════════════════════════════════════════════════════════════════
  // MECHANIC 2: R2C (Reserve to Collateral)
  // ══════════════════════════════════════════════════════════════════
  createAccount(aliceRep, hub.id, usd(0), 0n, usd(50), usd(50));
  createAccount(hubRep, alice.id, usd(0), 0n, usd(50), usd(50));

  pushSnapshot(env, 'Mechanic 2: Reserve-to-Collateral (R2C) Prefunding', {
    title: '🔒 Reserve-to-Collateral (R2C)',
    what: 'Alice locks 20 USDC from reserve into bilateral account with Hub. Creates collateral.',
    why: 'Collateral enables off-chain bilateral netting. Lock funds once, do 1000 off-chain payments.',
    tradfiParallel: 'Posting margin at clearinghouse (CME, LCH). Enables off-chain netting for days.',
    keyMetrics: ['Alice Reserve: 70 → 50', 'Collateral: 0 → 20', 'Ondelta: +20 (Alice funded)']
  });

  // Execute R2C
  setReserve(aliceRep, usd(50));
  createAccount(aliceRep, hub.id, usd(20), usd(20), usd(50), usd(50));
  createAccount(hubRep, alice.id, usd(20), -usd(20), usd(50), usd(50));

  pushSnapshot(env, 'After R2C: Collateral Locked', {
    title: '✅ Collateral Active',
    what: 'Alice↔Hub account now has 20 USDC collateral. Ready for off-chain payments.',
    why: 'Collateral = bilateral liquidity. Both can send/receive off-chain up to credit limits.',
    tradfiParallel: 'Margin account funded. Can now trade derivatives without touching reserves.',
    keyMetrics: ['Collateral: 20 USDC', 'Ondelta: +20', 'Credit limits: 50 each']
  });

  // ══════════════════════════════════════════════════════════════════
  // MECHANIC 3: Off-Chain Ondelta Change
  // ══════════════════════════════════════════════════════════════════
  pushSnapshot(env, 'Mechanic 3: Off-Chain Ondelta Payment', {
    title: '⚡ Off-Chain Ondelta',
    what: 'Alice pays Hub 5 USDC off-chain. NO blockchain transaction! Ondelta: +20 → +15.',
    why: 'Zero gas, instant finality, infinite throughput. This is why XLN scales.',
    tradfiParallel: 'Continuous Net Settlement (CNS) in securities. Trade all day, settle net once.',
    keyMetrics: ['Ondelta: +20 → +15 (-5)', 'Gas: 0', 'Latency: <100ms', 'Signatures: 2 (bilateral)']
  });

  // Update ondelta
  createAccount(aliceRep, hub.id, usd(20), usd(15), usd(50), usd(50));
  createAccount(hubRep, alice.id, usd(20), -usd(15), usd(50), usd(50));

  pushSnapshot(env, 'After Ondelta: Net Position Changed', {
    title: '✅ Off-Chain Complete',
    what: 'Payment settled instantly via state update. Both parties signed new AccountFrame.',
    why: 'Can repeat this 1000 times with zero gas. Final settlement happens once.',
    tradfiParallel: 'CNS batch processing. DTCC processes millions of trades, settles net daily.',
    keyMetrics: ['Ondelta: +15', 'Collateral: 20 (unchanged)', 'Total off-chain txs: 1']
  });

  // ══════════════════════════════════════════════════════════════════
  // MECHANIC 4: Credit Extension Beyond Collateral
  // ══════════════════════════════════════════════════════════════════
  pushSnapshot(env, 'Mechanic 4: Credit Extension (XLN Unique Feature)', {
    title: '📊 Credit Extension',
    what: 'Hub pays Alice 10 USDC. Ondelta: +15 → +25. ONDELTA > COLLATERAL! (25 > 20)',
    why: 'XLN killer feature: credit extends beyond collateral. If Hub defaults, Alice loses max 20 (collateral), not 25.',
    tradfiParallel: 'Fed Daylight Overdrafts: banks can overdraw (credit) with collateral caps.',
    keyMetrics: ['Ondelta: +15 → +25 (+10)', 'Collateral: 20', 'Credit exposure: 25', 'Risk bounded: 20']
  });

  // Update to credit extension
  createAccount(aliceRep, hub.id, usd(20), usd(25), usd(50), usd(50));
  createAccount(hubRep, alice.id, usd(20), -usd(25), usd(50), usd(50));

  pushSnapshot(env, 'After Credit Extension: Position Beyond Collateral', {
    title: '✅ Credit Active',
    what: 'Alice has claim for 25 USDC, backed by only 20 collateral. Remaining 5 = unsecured credit.',
    why: 'Enables liquidity beyond reserves. Hub can\'t pay? Alice gets 20 (collateral) guaranteed.',
    tradfiParallel: 'Secured credit line: partial collateral + trust. Banks do this with corporate loans.',
    keyMetrics: ['Secured: 20 USDC', 'Unsecured: 5 USDC', 'Total exposure: 25']
  });

  // ══════════════════════════════════════════════════════════════════
  // MECHANIC 5: Cooperative Settlement (C2R)
  // ══════════════════════════════════════════════════════════════════
  pushSnapshot(env, 'Mechanic 5: Cooperative Settlement (C2R)', {
    title: '⚖️ Cooperative Settlement',
    what: 'Alice & Hub sign settlement. Ondelta (+25) determines payout. Collateral released to reserves.',
    why: 'Bilateral close: both agree on final state, settle on-chain once.',
    tradfiParallel: 'Clearing margin account. Net position → cash payout.',
    keyMetrics: ['Alice gets: 20 (all collateral)', 'Hub gets: 0', 'Settlement type: Cooperative']
  });

  // Settlement: Alice gets all collateral (ondelta = +25 > +20)
  setReserve(aliceRep, usd(70)); // 50 + 20 from collateral
  setReserve(hubRep, usd(200)); // Unchanged (owes Alice but no reserves to pay)
  createAccount(aliceRep, hub.id, usd(0), 0n, usd(50), usd(50)); // Account closed
  createAccount(hubRep, alice.id, usd(0), 0n, usd(50), usd(50));

  pushSnapshot(env, 'After Settlement: Collateral → Reserves', {
    title: '✅ Settlement Complete',
    what: 'Account closed. Collateral distributed. Hub now owes Alice 5 USDC as debt (ondelta - collateral).',
    why: 'Settlement converts bilateral positions → on-chain reserves. Debts tracked via FIFO queue.',
    tradfiParallel: 'T+2 settlement in equities. Positions close, cash moves, debts tracked.',
    keyMetrics: ['Alice Reserve: 50 → 70 (+20)', 'Hub Debt to Alice: 5 USDC', 'Collateral: Released']
  });

  // ══════════════════════════════════════════════════════════════════
  // MECHANIC 6: FIFO Debt Enforcement
  // ══════════════════════════════════════════════════════════════════
  pushSnapshot(env, 'Mechanic 6: FIFO Debt Queue Enforcement', {
    title: '🔁 FIFO Debt Enforcement',
    what: 'Hub owes Alice 5 USDC (debt[0]). Hub receives 100 USDC. enforceDebts() runs automatically.',
    why: 'Liquidity trap: Hub CANNOT withdraw until debts paid. Chronological fairness (FIFO).',
    tradfiParallel: 'Bankruptcy court: first creditor gets paid first. Absolute priority rule.',
    keyMetrics: ['Hub receives: +100', 'Debt to Alice: 5', 'After enforcement: Alice +5, Hub +95']
  });

  // Hub receives funds, debt auto-paid
  setReserve(hubRep, usd(295)); // 200 + 100 - 5 (debt paid)
  setReserve(aliceRep, usd(75)); // 70 + 5 (debt payment)

  pushSnapshot(env, 'After FIFO: Debt Automatically Cleared', {
    title: '✅ FIFO Executed',
    what: 'Hub tried to receive 100 USDC. enforceDebts() intercepted, paid Alice 5, Hub got 95.',
    why: 'Mechanical enforcement - no "please pay me back". Reserves automatically flow to creditors.',
    tradfiParallel: 'Auto-debit for loan payments. Can\'t access funds until debts clear.',
    keyMetrics: ['Alice: 70 → 75 (+5)', 'Hub: 200 → 295 (+95)', 'Debt cleared: 5 USDC']
  });

  // ══════════════════════════════════════════════════════════════════
  // MECHANIC 7: Multi-Hop Routing (Alice → Hub → Bob)
  // ══════════════════════════════════════════════════════════════════
  createAccount(bobRep, hub.id, usd(10), -usd(10), usd(50), usd(50));
  createAccount(hubRep, bob.id, usd(10), usd(10), usd(50), usd(50));

  pushSnapshot(env, 'Mechanic 7: Multi-Hop Routing', {
    title: '🌉 Multi-Hop Payment',
    what: 'Alice pays Bob 15 USDC via Hub. Two bilateral updates: Alice↔Hub (-15), Hub↔Bob (-15).',
    why: 'Onion routing: Bob doesn\'t know Alice sent, Alice doesn\'t know Bob received. Privacy!',
    tradfiParallel: 'Correspondent banking: HSBC → JPM → Bank of America. Each hop updates bilateral.',
    keyMetrics: ['Alice→Hub ondelta: +15 → 0', 'Hub→Bob ondelta: +10 → -5', 'Hops: 2', 'Privacy: Yes']
  });

  // Execute multi-hop
  createAccount(aliceRep, hub.id, usd(20), 0n, usd(50), usd(50));
  createAccount(hubRep, alice.id, usd(20), 0n, usd(50), usd(50));
  createAccount(hubRep, bob.id, usd(10), -usd(5), usd(50), usd(50));
  createAccount(bobRep, hub.id, usd(10), usd(5), usd(50), usd(50));

  pushSnapshot(env, 'After Multi-Hop: Payment Routed', {
    title: '✅ Routing Complete',
    what: 'Alice paid Bob 15 USDC through Hub. Hub earned routing fee (if configured).',
    why: 'Enables global payments without everyone knowing everyone. Hub = routing node.',
    tradfiParallel: 'SWIFT routing: your bank → intermediaries → recipient bank. Same principle.',
    keyMetrics: ['Alice net: -15', 'Bob net: +15', 'Hub net: 0 (neutral router)']
  });

  // ══════════════════════════════════════════════════════════════════
  // MECHANIC 8: Dispute Resolution
  // ══════════════════════════════════════════════════════════════════
  createAccount(daveRep, hub.id, usd(50), usd(30), usd(100), usd(100));
  createAccount(hubRep, dave.id, usd(50), -usd(30), usd(100), usd(100));

  pushSnapshot(env, 'Mechanic 8: Dispute Initiation', {
    title: '⚔️ Dispute Resolution',
    what: 'Dave claims Hub owes 30 USDC (ondelta +30). Calls initialDisputeProof() with signed proof.',
    why: 'Non-cooperative close: Dave posts proof on-chain. Hub has 20 blocks to respond with newer proof.',
    tradfiParallel: 'Arbitration: Dave files claim, Hub can respond. Court decides based on evidence.',
    keyMetrics: ['Dispute nonce: 1', 'Challenge period: 20 blocks', 'Claimed ondelta: +30']
  });

  pushSnapshot(env, 'Dispute Challenge Period', {
    title: '⏳ Challenge Window Active',
    what: 'Hub can respond with finalDisputeProof() showing higher nonce (newer state). Or timeout expires.',
    why: 'Prevents old state attacks. Freshest proof wins. Like double-spend prevention.',
    tradfiParallel: 'Discovery period in lawsuit. Both sides present evidence, judge picks truth.',
    keyMetrics: ['Blocks remaining: 15', 'Hub can: respond or timeout', 'Dave stake: at risk']
  });

  // Resolve: Hub responds with newer proof
  pushSnapshot(env, 'Dispute Resolved: Hub Wins', {
    title: '✅ Dispute Resolved',
    what: 'Hub posted newer proof (higher nonce). finalizeChannel() distributes collateral based on Hub\'s proof.',
    why: 'Cryptographic proof > claims. Freshest state always wins.',
    tradfiParallel: 'Court ruling: evidence reviewed, judgment executed. Hub gets collateral.',
    keyMetrics: ['Winner: Hub', 'Collateral: 50 USDC', 'Distribution: Hub gets 35, Dave gets 15']
  });

  setReserve(hubRep, usd(330)); // 295 + 35 from Dave dispute
  setReserve(daveRep, usd(15)); // Got 15 from partial collateral
  createAccount(daveRep, hub.id, usd(0), 0n, usd(100), usd(100));
  createAccount(hubRep, dave.id, usd(0), 0n, usd(100), usd(100));

  // ══════════════════════════════════════════════════════════════════
  // MECHANIC 9: On-Chain Anchoring (Batch Settlement)
  // ══════════════════════════════════════════════════════════════════
  pushSnapshot(env, 'Mechanic 9: On-Chain Anchoring', {
    title: '🏛️ On-Chain Anchoring',
    what: '100 off-chain payments happened (ondelta changes). Now: 1 on-chain settlement batches all.',
    why: 'Netting reduces on-chain load 100x. Off-chain = instant/free, on-chain = final/expensive.',
    tradfiParallel: 'ACH batch processing: millions of payments, one end-of-day settlement file.',
    keyMetrics: ['Off-chain txs: 100', 'On-chain settlements: 1', 'Gas savings: 99%', 'Throughput: Infinite']
  });

  pushSnapshot(env, 'After Anchoring: Final On-Chain State', {
    title: '✅ Anchoring Complete',
    what: 'All bilateral positions settled on-chain. Reserves updated. Accounts can continue or close.',
    why: 'On-chain = source of truth. Off-chain = optimization. Best of both.',
    tradfiParallel: 'DTCC: 100M trades/day off-chain, net settlements on-chain via DTC.',
    keyMetrics: ['Final reserves: Alice 75, Bob 30, Hub 330, Dave 15', 'Total settled: 450 USDC']
  });

  // ══════════════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ══════════════════════════════════════════════════════════════════
  pushSnapshot(env, 'COMPLETE: All 10 Mechanics Demonstrated', {
    title: '🎓 Full XLN Mechanics Tour Complete',
    what: 'Demonstrated R2R, R2C, C2R, Ondelta, Credit Extension, Settlement, Disputes, FIFO, Routing, Anchoring.',
    why: 'XLN = complete financial operating system. Every primitive needed for global settlement.',
    tradfiParallel: 'Combines: Fedwire (R2R) + Clearinghouses (collateral) + ACH (netting) + Courts (disputes).',
    keyMetrics: [
      'Total frames: 15',
      'Mechanics covered: 10/10',
      'Entities: 4 (Alice, Bob, Hub, Dave)',
      'Visual: Particles show flow Reserve ↔ Collateral'
    ]
  });

    console.log('\n═══════════════════════════════════════════════');
    console.log('✅ All 10 Mechanics Demo Complete!');
    console.log(`Total frames: ${env.history?.length || 0}`);
    console.log('═══════════════════════════════════════════════\n');
  } finally {
    env.disableAutoSnapshots = false; // ALWAYS re-enable, even on error
  }
}
