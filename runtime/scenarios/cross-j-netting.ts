/**
 * Two-jurisdiction RCPAN netting experiment.
 *
 * This is intentionally an in-memory economic experiment, not a bridge E2E.
 * It uses the real Account direct-payment transition for both legs of every
 * transfer and keeps both bilateral Accounts open across the whole workload.
 *
 * Run manually with:
 *   bun runtime/scenarios/cross-j-netting.ts
 */

import { applyAccountTx } from '../account/tx';
import { deriveAccountWatchSeed } from '../account/watch-seed';
import type { AccountMachine } from '../types';
import { createDefaultDelta } from '../validation-utils';

const TOKEN_ID = 1;
const TRANSFER_AMOUNT = 100n;
const TRANSFER_COUNT = 100;
const COLLATERAL = 1_000_000n;
const SETTLEMENT_THRESHOLD = 2_500n;

const USER_A = `0x${'11'.repeat(32)}`;
const USER_B = `0x${'12'.repeat(32)}`;
const HUB_A = `0x${'21'.repeat(32)}`;
const HUB_B = `0x${'22'.repeat(32)}`;

type Direction = 'A_TO_B' | 'B_TO_A';

type Workload = {
  name: string;
  forwardTransfers: number;
  reverseTransfers: number;
};

type ExperimentResult = {
  pattern: string;
  transfers: number;
  grossVolume: bigint;
  forwardVolume: bigint;
  reverseVolume: bigint;
  expectedNet: bigint;
  accountANet: bigint;
  accountBNet: bigint;
  peakUnsettledExposure: bigint;
  simulatedSettlements: number;
  isolatedSettlements: number;
  compression: number;
  nettingEfficiencyBps: number;
};

const workloads: Workload[] = [
  { name: '50/50 balanced', forwardTransfers: 50, reverseTransfers: 50 },
  { name: '60/40 moderate', forwardTransfers: 60, reverseTransfers: 40 },
  { name: '80/20 imbalanced', forwardTransfers: 80, reverseTransfers: 20 },
  { name: '100/0 directional', forwardTransfers: 100, reverseTransfers: 0 },
];

const abs = (value: bigint): bigint => value < 0n ? -value : value;

const assertInvariant = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`CROSS_J_NETTING_INVARIANT_FAILED: ${message}`);
};

const createFundedAccount = (leftEntity: string, rightEntity: string, label: string): AccountMachine => {
  assertInvariant(leftEntity.toLowerCase() < rightEntity.toLowerCase(), `${label}: entities must be canonical left/right`);
  const delta = createDefaultDelta(TOKEN_ID);
  delta.collateral = COLLATERAL;
  // Split the collateral baseline evenly. With zero credit, this gives each
  // side collateral-backed outbound capacity and keeps the experiment fully
  // collateralized while traffic moves the shared delta in either direction.
  delta.ondelta = COLLATERAL / 2n;

  return {
    leftEntity,
    rightEntity,
    status: 'active',
    mempool: [],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      accountStateRoot: `0x${'00'.repeat(32)}`,
      stateHash: '',
      deltas: [],
      byLeft: true,
    },
    deltas: new Map([[TOKEN_ID, delta]]),
    locks: new Map(),
    swapOffers: new Map(),
    pulls: new Map(),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    leftJObservations: [],
    rightJObservations: [],
    jEventChain: [],
    lastFinalizedJHeight: 0,
    watchSeed: deriveAccountWatchSeed({
      runtimeSeed: `cross-j-netting:${label}`,
      entityId: leftEntity,
      counterpartyId: rightEntity,
      timestamp: 0,
    }),
    proofHeader: { fromEntity: leftEntity, toEntity: rightEntity, nextProofNonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    jNonce: 0,
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
  };
};

const applyPayment = async (
  account: AccountMachine,
  payer: string,
  receiver: string,
  amount: bigint,
): Promise<void> => {
  const byLeft = payer.toLowerCase() === account.leftEntity.toLowerCase();
  assertInvariant(
    byLeft || payer.toLowerCase() === account.rightEntity.toLowerCase(),
    `payer ${payer} is not an Account participant`,
  );
  const result = await applyAccountTx(account, {
    type: 'direct_payment',
    data: {
      tokenId: TOKEN_ID,
      amount,
      fromEntityId: payer,
      toEntityId: receiver,
      description: 'cross-j-netting-experiment',
    },
  }, byLeft);
  assertInvariant(result.success, result.error || 'direct payment rejected');
};

const deterministicDirections = (workload: Workload): Direction[] => {
  const directions: Direction[] = [];
  let forwardRemaining = workload.forwardTransfers;
  let reverseRemaining = workload.reverseTransfers;
  // Evenly interleave reverse traffic without randomness. This exposes peak
  // unsettled inventory under a stable, reproducible workload.
  for (let index = 0; index < TRANSFER_COUNT; index += 1) {
    const chooseForward = forwardRemaining > 0 && (
      reverseRemaining === 0 ||
      forwardRemaining * Math.max(1, workload.reverseTransfers) >=
        reverseRemaining * Math.max(1, workload.forwardTransfers)
    );
    if (chooseForward) {
      directions.push('A_TO_B');
      forwardRemaining -= 1;
    } else {
      directions.push('B_TO_A');
      reverseRemaining -= 1;
    }
  }
  assertInvariant(forwardRemaining === 0 && reverseRemaining === 0, `${workload.name}: workload generation mismatch`);
  return directions;
};

const runWorkload = async (workload: Workload): Promise<ExperimentResult> => {
  assertInvariant(
    workload.forwardTransfers + workload.reverseTransfers === TRANSFER_COUNT,
    `${workload.name}: expected ${TRANSFER_COUNT} transfers`,
  );
  const accountA = createFundedAccount(USER_A, HUB_A, 'jurisdiction-a');
  const accountB = createFundedAccount(USER_B, HUB_B, 'jurisdiction-b');
  let unsettledExposure = 0n;
  let peakUnsettledExposure = 0n;
  let simulatedSettlements = 0;

  for (const direction of deterministicDirections(workload)) {
    if (direction === 'A_TO_B') {
      await applyPayment(accountA, USER_A, HUB_A, TRANSFER_AMOUNT);
      await applyPayment(accountB, HUB_B, USER_B, TRANSFER_AMOUNT);
      unsettledExposure += TRANSFER_AMOUNT;
    } else {
      await applyPayment(accountA, HUB_A, USER_A, TRANSFER_AMOUNT);
      await applyPayment(accountB, USER_B, HUB_B, TRANSFER_AMOUNT);
      unsettledExposure -= TRANSFER_AMOUNT;
    }
    peakUnsettledExposure = peakUnsettledExposure > abs(unsettledExposure)
      ? peakUnsettledExposure
      : abs(unsettledExposure);
    if (abs(unsettledExposure) >= SETTLEMENT_THRESHOLD) {
      simulatedSettlements += 1;
      unsettledExposure = 0n;
    }
  }
  if (unsettledExposure !== 0n) simulatedSettlements += 1;
  // Count one final checkpoint for a completely netted workload so comparison
  // with independently finalized transfers remains finite and conservative.
  if (simulatedSettlements === 0) simulatedSettlements = 1;

  const forwardVolume = BigInt(workload.forwardTransfers) * TRANSFER_AMOUNT;
  const reverseVolume = BigInt(workload.reverseTransfers) * TRANSFER_AMOUNT;
  const grossVolume = forwardVolume + reverseVolume;
  const expectedNet = forwardVolume - reverseVolume;
  const accountANet = -(accountA.deltas.get(TOKEN_ID)?.offdelta ?? 0n);
  const accountBNet = accountB.deltas.get(TOKEN_ID)?.offdelta ?? 0n;

  assertInvariant(accountANet === expectedNet, `${workload.name}: Account A net ${accountANet} != ${expectedNet}`);
  assertInvariant(accountBNet === expectedNet, `${workload.name}: Account B net ${accountBNet} != ${expectedNet}`);
  assertInvariant(accountANet === accountBNet, `${workload.name}: jurisdiction legs diverged`);
  const accountATotalDelta = (accountA.deltas.get(TOKEN_ID)?.ondelta ?? 0n) + (accountA.deltas.get(TOKEN_ID)?.offdelta ?? 0n);
  const accountBTotalDelta = (accountB.deltas.get(TOKEN_ID)?.ondelta ?? 0n) + (accountB.deltas.get(TOKEN_ID)?.offdelta ?? 0n);
  assertInvariant(
    accountATotalDelta >= 0n && accountATotalDelta <= COLLATERAL,
    `${workload.name}: Account A escaped fully collateralized range`,
  );
  assertInvariant(
    accountBTotalDelta >= 0n && accountBTotalDelta <= COLLATERAL,
    `${workload.name}: Account B escaped fully collateralized range`,
  );

  const nettingEfficiencyBps = grossVolume === 0n
    ? 0
    : Number((grossVolume - abs(expectedNet)) * 10_000n / grossVolume);
  const isolatedSettlements = TRANSFER_COUNT;
  const compression = simulatedSettlements === 0
    ? isolatedSettlements
    : isolatedSettlements / simulatedSettlements;

  return {
    pattern: workload.name,
    transfers: TRANSFER_COUNT,
    grossVolume,
    forwardVolume,
    reverseVolume,
    expectedNet,
    accountANet,
    accountBNet,
    peakUnsettledExposure,
    simulatedSettlements,
    isolatedSettlements,
    compression,
    nettingEfficiencyBps,
  };
};

const formatBps = (bps: number): string => `${(bps / 100).toFixed(2)}%`;
const formatCompression = (value: number): string => `${value.toFixed(1)}x`;

export const runCrossJurisdictionNettingExperiment = async (): Promise<ExperimentResult[]> => {
  const results: ExperimentResult[] = [];
  for (const workload of workloads) results.push(await runWorkload(workload));

  console.log('\nTWO-JURISDICTION RCPAN NETTING EXPERIMENT');
  console.log(`transfer=${TRANSFER_AMOUNT} count=${TRANSFER_COUNT} collateral/account=${COLLATERAL} threshold=${SETTLEMENT_THRESHOLD}`);
  console.table(results.map(result => ({
    pattern: result.pattern,
    transfers: result.transfers,
    gross: result.grossVolume.toString(),
    net: result.expectedNet.toString(),
    peakExposure: result.peakUnsettledExposure.toString(),
    settlements: result.simulatedSettlements,
    compression: formatCompression(result.compression),
    netting: formatBps(result.nettingEfficiencyBps),
  })));

  return results;
};

if (import.meta.main) {
  await runCrossJurisdictionNettingExperiment();
}
