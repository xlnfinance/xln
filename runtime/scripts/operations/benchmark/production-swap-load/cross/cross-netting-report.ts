/** Versioned evidence and invariant math for the production cross-j netting experiment. */

import {
  requireBoundaryInteger,
  requireBoundaryRecord,
  requireExactBoundaryKeys,
} from '../../../../../protocol/boundary-validation';

export const CROSS_NETTING_REPORT_SCHEMA = 'xln-cross-j-netting-experiment-v1' as const;

export type CrossNettingDirection = 'A_TO_B' | 'B_TO_A';
export type CrossNettingStage = 'baseline' | 'post_trade' | 'accumulated' | 'rebalance_requested' | 'finalized';

export type CrossNettingAccountReplicaSnapshot = Readonly<{
  currentHeight: number;
  ondelta: string;
  offdelta: string;
  collateral: string;
  leftHold: string;
  rightHold: string;
  requestedRebalance: string;
  requestId: string;
  requestPolicyVersion: number;
  requestFeeTokenId: number;
  requestFeePaid: string;
  submittedAt: number;
  pendingFrame: boolean;
  pendingFrameHeight: number | null;
  pendingFrameTxTypes: readonly string[];
  pullCount: number;
}>;

export type CrossNettingAccountPairSnapshot = Readonly<{
  userEntityId: string;
  hubEntityId: string;
  tokenId: number;
  userIsLeft: boolean;
  policySoftLimit: string;
  policyHardLimit: string;
  policyMaxFee: string;
  hubFeePolicyVersion: number;
  hubBaseFee: string;
  hubLiquidityFeeBps: string;
  hubGasFee: string;
  user: CrossNettingAccountReplicaSnapshot;
  hub: CrossNettingAccountReplicaSnapshot;
}>;

export type CrossNettingMarketMakerPairSnapshot = Readonly<{
  marketMakerEntityId: string;
  hubEntityId: string;
  tokenId: number;
  marketMakerIsLeft: boolean;
  policySoftLimit: string;
  policyHardLimit: string;
  policyMaxFee: string;
  hubFeePolicyVersion: number;
  hubBaseFee: string;
  hubLiquidityFeeBps: string;
  hubGasFee: string;
  marketMaker: CrossNettingAccountReplicaSnapshot;
  hub: CrossNettingAccountReplicaSnapshot;
}>;

export type CrossNettingHubSnapshot = Readonly<{
  entityId: string;
  runtimeId: string;
  tokenId: number;
  reserve: string;
  lastFinalizedJHeight: number;
  oldestRetainedJHeight: number;
  accountSettledEventCount: number;
  currentR2CCount: number;
  sentR2CCount: number;
  recoveryR2CCount: number;
}>;

export type CrossNettingStateSnapshot = Readonly<{
  stage: CrossNettingStage;
  sequence: number;
  jurisdictionA: CrossNettingAccountPairSnapshot;
  jurisdictionB: CrossNettingAccountPairSnapshot;
  marketMakerA: CrossNettingMarketMakerPairSnapshot;
  marketMakerB: CrossNettingMarketMakerPairSnapshot;
  hubA: CrossNettingHubSnapshot;
  hubB: CrossNettingHubSnapshot;
}>;

export type CrossNettingTradeEvidence = Readonly<{
  sequence: number;
  direction: CrossNettingDirection;
  orderId: string;
  sourceRouteStatus: 'settled';
  targetRouteStatus: 'settled';
  filledSourceAmount: string;
  filledTargetAmount: string;
  economicCompletionElapsedMs: number;
  after: CrossNettingStateSnapshot;
}>;

export type CrossNettingConfig = Readonly<{
  jurisdictionA: string;
  jurisdictionB: string;
  tokenId: number;
  tokenSymbol: string;
  tokenDecimals: number;
  feeTokenId: number;
  swapFeeBps: number;
  forwardTrades: number;
  reverseTrades: number;
  marketMakerLevel: number;
  manualSoftLimit: string;
  manualHardLimit: string;
}>;

export type CrossNettingMetrics = Readonly<{
  tradeCount: number;
  forwardVolume: string;
  reverseVolume: string;
  grossVolume: string;
  expectedNetA: string;
  expectedNetB: string;
  observedNetA: string;
  observedNetB: string;
  observedMarketMakerNetA: string;
  observedMarketMakerNetB: string;
  nettingEfficiencyBps: number;
  collateralIncreaseA: string;
  collateralIncreaseB: string;
  reserveDecreaseA: string;
  reserveDecreaseB: string;
  physicalSettlementVolume: string;
}>;

export type CrossNettingInvariant = Readonly<{
  name: string;
  passed: true;
  evidence: string;
}>;

export type CrossNettingReport = Readonly<{
  schema: typeof CROSS_NETTING_REPORT_SCHEMA;
  completionAuthority: 'committed_routes_accounts_and_jurisdiction_finality';
  config: CrossNettingConfig;
  baseline: CrossNettingStateSnapshot;
  trades: readonly CrossNettingTradeEvidence[];
  accumulated: CrossNettingStateSnapshot;
  rebalanceRequested: CrossNettingStateSnapshot;
  finalized: CrossNettingStateSnapshot;
  metrics: CrossNettingMetrics;
  invariants: readonly CrossNettingInvariant[];
}>;

export type CrossNettingEvidence = Omit<CrossNettingReport, 'schema' | 'completionAuthority' | 'metrics' | 'invariants'>;

const signedDecimal = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value)) throw new Error(code);
  return value;
};

const nonNegativeDecimal = (value: unknown, code: string): string => {
  const decoded = signedDecimal(value, code);
  if (BigInt(decoded) < 0n) throw new Error(code);
  return decoded;
};

const text = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
};

const string = (value: unknown, code: string): string => {
  if (typeof value !== 'string') throw new Error(code);
  return value;
};

const bool = (value: unknown, code: string): boolean => {
  if (typeof value !== 'boolean') throw new Error(code);
  return value;
};

const decodeAccountReplica = (value: unknown, code: string): CrossNettingAccountReplicaSnapshot => {
  const raw = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(raw, [
    'currentHeight', 'ondelta', 'offdelta', 'collateral', 'leftHold', 'rightHold',
    'requestedRebalance', 'requestId', 'requestPolicyVersion', 'requestFeeTokenId',
    'requestFeePaid', 'submittedAt', 'pendingFrame', 'pendingFrameHeight',
    'pendingFrameTxTypes', 'pullCount',
  ], [], `${code}_FIELDS`);
  const pendingFrame = bool(raw['pendingFrame'], `${code}_PENDING_FRAME`);
  const pendingFrameHeight = raw['pendingFrameHeight'] === null
    ? null
    : requireBoundaryInteger(raw['pendingFrameHeight'], `${code}_PENDING_FRAME_HEIGHT`, 1);
  if (!Array.isArray(raw['pendingFrameTxTypes'])) throw new Error(`${code}_PENDING_FRAME_TX_TYPES`);
  const pendingFrameTxTypes = raw['pendingFrameTxTypes'].map((value, index) =>
    text(value, `${code}_PENDING_FRAME_TX_TYPE_${index}`)
  );
  if (pendingFrame !== (pendingFrameHeight !== null) ||
      pendingFrame !== (pendingFrameTxTypes.length > 0)) {
    throw new Error(`${code}_PENDING_FRAME_DETAILS_MISMATCH`);
  }
  return {
    currentHeight: requireBoundaryInteger(raw['currentHeight'], `${code}_HEIGHT`),
    ondelta: signedDecimal(raw['ondelta'], `${code}_ONDELTA`),
    offdelta: signedDecimal(raw['offdelta'], `${code}_OFFDELTA`),
    collateral: nonNegativeDecimal(raw['collateral'], `${code}_COLLATERAL`),
    leftHold: nonNegativeDecimal(raw['leftHold'], `${code}_LEFT_HOLD`),
    rightHold: nonNegativeDecimal(raw['rightHold'], `${code}_RIGHT_HOLD`),
    requestedRebalance: nonNegativeDecimal(raw['requestedRebalance'], `${code}_REQUESTED`),
    requestId: string(raw['requestId'], `${code}_REQUEST_ID`),
    requestPolicyVersion: requireBoundaryInteger(raw['requestPolicyVersion'], `${code}_REQUEST_POLICY`),
    requestFeeTokenId: requireBoundaryInteger(raw['requestFeeTokenId'], `${code}_REQUEST_FEE_TOKEN`),
    requestFeePaid: nonNegativeDecimal(raw['requestFeePaid'], `${code}_REQUEST_FEE_PAID`),
    submittedAt: requireBoundaryInteger(raw['submittedAt'], `${code}_SUBMITTED_AT`),
    pendingFrame,
    pendingFrameHeight,
    pendingFrameTxTypes,
    pullCount: requireBoundaryInteger(raw['pullCount'], `${code}_PULLS`),
  };
};

const decodeAccountPair = (value: unknown, code: string): CrossNettingAccountPairSnapshot => {
  const raw = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(raw, [
    'userEntityId', 'hubEntityId', 'tokenId', 'userIsLeft', 'policySoftLimit',
    'policyHardLimit', 'policyMaxFee', 'hubFeePolicyVersion', 'hubBaseFee',
    'hubLiquidityFeeBps', 'hubGasFee', 'user', 'hub',
  ], [], `${code}_FIELDS`);
  return {
    userEntityId: text(raw['userEntityId'], `${code}_USER_ID`),
    hubEntityId: text(raw['hubEntityId'], `${code}_HUB_ID`),
    tokenId: requireBoundaryInteger(raw['tokenId'], `${code}_TOKEN`, 1),
    userIsLeft: bool(raw['userIsLeft'], `${code}_USER_SIDE`),
    policySoftLimit: nonNegativeDecimal(raw['policySoftLimit'], `${code}_POLICY_SOFT`),
    policyHardLimit: nonNegativeDecimal(raw['policyHardLimit'], `${code}_POLICY_HARD`),
    policyMaxFee: nonNegativeDecimal(raw['policyMaxFee'], `${code}_POLICY_MAX_FEE`),
    hubFeePolicyVersion: requireBoundaryInteger(raw['hubFeePolicyVersion'], `${code}_HUB_POLICY_VERSION`, 1),
    hubBaseFee: nonNegativeDecimal(raw['hubBaseFee'], `${code}_HUB_BASE_FEE`),
    hubLiquidityFeeBps: nonNegativeDecimal(raw['hubLiquidityFeeBps'], `${code}_HUB_LIQUIDITY_BPS`),
    hubGasFee: nonNegativeDecimal(raw['hubGasFee'], `${code}_HUB_GAS_FEE`),
    user: decodeAccountReplica(raw['user'], `${code}_USER`),
    hub: decodeAccountReplica(raw['hub'], `${code}_HUB`),
  };
};

const decodeMarketMakerPair = (value: unknown, code: string): CrossNettingMarketMakerPairSnapshot => {
  const raw = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(raw, [
    'marketMakerEntityId', 'hubEntityId', 'tokenId', 'marketMakerIsLeft', 'policySoftLimit',
    'policyHardLimit', 'policyMaxFee', 'hubFeePolicyVersion', 'hubBaseFee',
    'hubLiquidityFeeBps', 'hubGasFee', 'marketMaker', 'hub',
  ], [], `${code}_FIELDS`);
  return {
    marketMakerEntityId: text(raw['marketMakerEntityId'], `${code}_MM_ID`),
    hubEntityId: text(raw['hubEntityId'], `${code}_HUB_ID`),
    tokenId: requireBoundaryInteger(raw['tokenId'], `${code}_TOKEN`, 1),
    marketMakerIsLeft: bool(raw['marketMakerIsLeft'], `${code}_MM_SIDE`),
    policySoftLimit: nonNegativeDecimal(raw['policySoftLimit'], `${code}_POLICY_SOFT`),
    policyHardLimit: nonNegativeDecimal(raw['policyHardLimit'], `${code}_POLICY_HARD`),
    policyMaxFee: nonNegativeDecimal(raw['policyMaxFee'], `${code}_POLICY_MAX_FEE`),
    hubFeePolicyVersion: requireBoundaryInteger(raw['hubFeePolicyVersion'], `${code}_HUB_POLICY_VERSION`, 1),
    hubBaseFee: nonNegativeDecimal(raw['hubBaseFee'], `${code}_HUB_BASE_FEE`),
    hubLiquidityFeeBps: nonNegativeDecimal(raw['hubLiquidityFeeBps'], `${code}_HUB_LIQUIDITY_BPS`),
    hubGasFee: nonNegativeDecimal(raw['hubGasFee'], `${code}_HUB_GAS_FEE`),
    marketMaker: decodeAccountReplica(raw['marketMaker'], `${code}_MM`),
    hub: decodeAccountReplica(raw['hub'], `${code}_HUB`),
  };
};

const decodeHub = (value: unknown, code: string): CrossNettingHubSnapshot => {
  const raw = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(raw, [
    'entityId', 'runtimeId', 'tokenId', 'reserve', 'lastFinalizedJHeight',
    'oldestRetainedJHeight', 'accountSettledEventCount', 'currentR2CCount',
    'sentR2CCount', 'recoveryR2CCount',
  ], [], `${code}_FIELDS`);
  return {
    entityId: text(raw['entityId'], `${code}_ENTITY`),
    runtimeId: text(raw['runtimeId'], `${code}_RUNTIME`),
    tokenId: requireBoundaryInteger(raw['tokenId'], `${code}_TOKEN`, 1),
    reserve: nonNegativeDecimal(raw['reserve'], `${code}_RESERVE`),
    lastFinalizedJHeight: requireBoundaryInteger(raw['lastFinalizedJHeight'], `${code}_J_HEIGHT`),
    oldestRetainedJHeight: requireBoundaryInteger(raw['oldestRetainedJHeight'], `${code}_OLDEST_J_HEIGHT`),
    accountSettledEventCount: requireBoundaryInteger(raw['accountSettledEventCount'], `${code}_EVENTS`),
    currentR2CCount: requireBoundaryInteger(raw['currentR2CCount'], `${code}_CURRENT_R2C`),
    sentR2CCount: requireBoundaryInteger(raw['sentR2CCount'], `${code}_SENT_R2C`),
    recoveryR2CCount: requireBoundaryInteger(raw['recoveryR2CCount'], `${code}_RECOVERY_R2C`),
  };
};

const STAGES: readonly CrossNettingStage[] = [
  'baseline', 'post_trade', 'accumulated', 'rebalance_requested', 'finalized',
];

const decodeSnapshot = (value: unknown, code: string): CrossNettingStateSnapshot => {
  const raw = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(raw, [
    'stage', 'sequence', 'jurisdictionA', 'jurisdictionB', 'marketMakerA',
    'marketMakerB', 'hubA', 'hubB',
  ], [], `${code}_FIELDS`);
  if (!STAGES.includes(raw['stage'] as CrossNettingStage)) throw new Error(`${code}_STAGE`);
  return {
    stage: raw['stage'] as CrossNettingStage,
    sequence: requireBoundaryInteger(raw['sequence'], `${code}_SEQUENCE`),
    jurisdictionA: decodeAccountPair(raw['jurisdictionA'], `${code}_ACCOUNT_A`),
    jurisdictionB: decodeAccountPair(raw['jurisdictionB'], `${code}_ACCOUNT_B`),
    marketMakerA: decodeMarketMakerPair(raw['marketMakerA'], `${code}_MM_ACCOUNT_A`),
    marketMakerB: decodeMarketMakerPair(raw['marketMakerB'], `${code}_MM_ACCOUNT_B`),
    hubA: decodeHub(raw['hubA'], `${code}_HUB_A`),
    hubB: decodeHub(raw['hubB'], `${code}_HUB_B`),
  };
};

const decodeTrade = (value: unknown, index: number): CrossNettingTradeEvidence => {
  const code = `CROSS_NETTING_TRADE_${index}`;
  const raw = requireBoundaryRecord(value, code);
  requireExactBoundaryKeys(raw, [
    'sequence', 'direction', 'orderId', 'sourceRouteStatus', 'targetRouteStatus',
    'filledSourceAmount', 'filledTargetAmount', 'economicCompletionElapsedMs', 'after',
  ], [], `${code}_FIELDS`);
  if (raw['direction'] !== 'A_TO_B' && raw['direction'] !== 'B_TO_A') throw new Error(`${code}_DIRECTION`);
  if (raw['sourceRouteStatus'] !== 'settled' || raw['targetRouteStatus'] !== 'settled') {
    throw new Error(`${code}_ROUTE_STATUS`);
  }
  return {
    sequence: requireBoundaryInteger(raw['sequence'], `${code}_SEQUENCE`, 1),
    direction: raw['direction'],
    orderId: text(raw['orderId'], `${code}_ORDER_ID`),
    sourceRouteStatus: 'settled',
    targetRouteStatus: 'settled',
    filledSourceAmount: nonNegativeDecimal(raw['filledSourceAmount'], `${code}_SOURCE_AMOUNT`),
    filledTargetAmount: nonNegativeDecimal(raw['filledTargetAmount'], `${code}_TARGET_AMOUNT`),
    economicCompletionElapsedMs: requireBoundaryInteger(raw['economicCompletionElapsedMs'], `${code}_ELAPSED`, 1),
    after: decodeSnapshot(raw['after'], `${code}_AFTER`),
  };
};

const decodeConfig = (value: unknown): CrossNettingConfig => {
  const raw = requireBoundaryRecord(value, 'CROSS_NETTING_CONFIG');
  requireExactBoundaryKeys(raw, [
    'jurisdictionA', 'jurisdictionB', 'tokenId', 'tokenSymbol', 'tokenDecimals',
    'feeTokenId', 'swapFeeBps', 'forwardTrades',
    'reverseTrades', 'marketMakerLevel', 'manualSoftLimit', 'manualHardLimit',
  ], [], 'CROSS_NETTING_CONFIG_FIELDS');
  return {
    jurisdictionA: text(raw['jurisdictionA'], 'CROSS_NETTING_CONFIG_JURISDICTION_A'),
    jurisdictionB: text(raw['jurisdictionB'], 'CROSS_NETTING_CONFIG_JURISDICTION_B'),
    tokenId: requireBoundaryInteger(raw['tokenId'], 'CROSS_NETTING_CONFIG_TOKEN', 1),
    tokenSymbol: text(raw['tokenSymbol'], 'CROSS_NETTING_CONFIG_SYMBOL'),
    tokenDecimals: requireBoundaryInteger(raw['tokenDecimals'], 'CROSS_NETTING_CONFIG_DECIMALS'),
    feeTokenId: requireBoundaryInteger(raw['feeTokenId'], 'CROSS_NETTING_CONFIG_FEE_TOKEN', 1),
    swapFeeBps: requireBoundaryInteger(raw['swapFeeBps'], 'CROSS_NETTING_CONFIG_SWAP_FEE'),
    forwardTrades: requireBoundaryInteger(raw['forwardTrades'], 'CROSS_NETTING_CONFIG_FORWARD'),
    reverseTrades: requireBoundaryInteger(raw['reverseTrades'], 'CROSS_NETTING_CONFIG_REVERSE'),
    marketMakerLevel: requireBoundaryInteger(raw['marketMakerLevel'], 'CROSS_NETTING_CONFIG_LEVEL', 1),
    manualSoftLimit: nonNegativeDecimal(raw['manualSoftLimit'], 'CROSS_NETTING_CONFIG_SOFT'),
    manualHardLimit: nonNegativeDecimal(raw['manualHardLimit'], 'CROSS_NETTING_CONFIG_HARD'),
  };
};

const accountReplicaEqual = (
  left: CrossNettingAccountReplicaSnapshot,
  right: CrossNettingAccountReplicaSnapshot,
): boolean =>
  left.currentHeight === right.currentHeight &&
  left.ondelta === right.ondelta && left.offdelta === right.offdelta &&
  left.collateral === right.collateral && left.leftHold === right.leftHold &&
  left.rightHold === right.rightHold && left.requestedRebalance === right.requestedRebalance &&
  left.requestId === right.requestId &&
  left.requestPolicyVersion === right.requestPolicyVersion &&
  left.requestFeeTokenId === right.requestFeeTokenId && left.requestFeePaid === right.requestFeePaid &&
  left.pullCount === right.pullCount;

const normalizedUserSpend = (pair: CrossNettingAccountPairSnapshot): bigint => {
  const offdelta = BigInt(pair.user.offdelta);
  return pair.userIsLeft ? -offdelta : offdelta;
};

const normalizedMarketMakerSpend = (pair: CrossNettingMarketMakerPairSnapshot): bigint => {
  const offdelta = BigInt(pair.marketMaker.offdelta);
  return pair.marketMakerIsLeft ? -offdelta : offdelta;
};

const requireInvariant = (name: string, condition: boolean, evidence: string): CrossNettingInvariant => {
  if (!condition) throw new Error(`CROSS_NETTING_INVARIANT_FAILED:${name}:${evidence}`);
  return { name, passed: true, evidence };
};

const nonNegativeDifference = (after: string, before: string, code: string): bigint => {
  const difference = BigInt(after) - BigInt(before);
  if (difference < 0n) throw new Error(`${code}:${difference}`);
  return difference;
};

const calculateMetrics = (evidence: CrossNettingEvidence): CrossNettingMetrics => {
  let forwardVolume = 0n;
  let reverseVolume = 0n;
  let forwardTargetVolume = 0n;
  let reverseTargetVolume = 0n;
  for (const trade of evidence.trades) {
    if (trade.direction === 'A_TO_B') {
      forwardVolume += BigInt(trade.filledSourceAmount);
      forwardTargetVolume += BigInt(trade.filledTargetAmount);
    } else {
      reverseVolume += BigInt(trade.filledSourceAmount);
      reverseTargetVolume += BigInt(trade.filledTargetAmount);
    }
  }
  const grossVolume = forwardVolume + reverseVolume;
  // Same-token cross-j MM quotes still carry spread. A->B consumes A and
  // delivers B; B->A consumes B and delivers A, so the legs have distinct nets.
  const expectedNetA = forwardVolume - reverseTargetVolume;
  const expectedNetB = forwardTargetVolume - reverseVolume;
  const observedNetA = normalizedUserSpend(evidence.accumulated.jurisdictionA) -
    normalizedUserSpend(evidence.baseline.jurisdictionA);
  const observedNetB = normalizedUserSpend(evidence.baseline.jurisdictionB) -
    normalizedUserSpend(evidence.accumulated.jurisdictionB);
  const observedMarketMakerNetA = normalizedMarketMakerSpend(evidence.accumulated.marketMakerA) -
    normalizedMarketMakerSpend(evidence.baseline.marketMakerA);
  const observedMarketMakerNetB = normalizedMarketMakerSpend(evidence.baseline.marketMakerB) -
    normalizedMarketMakerSpend(evidence.accumulated.marketMakerB);
  const collateralIncreaseA = nonNegativeDifference(
    evidence.finalized.jurisdictionA.user.collateral,
    evidence.accumulated.jurisdictionA.user.collateral,
    'CROSS_NETTING_COLLATERAL_A_REGRESSION',
  );
  const collateralIncreaseB = nonNegativeDifference(
    evidence.finalized.jurisdictionB.user.collateral,
    evidence.accumulated.jurisdictionB.user.collateral,
    'CROSS_NETTING_COLLATERAL_B_REGRESSION',
  );
  const reserveDecreaseA = nonNegativeDifference(
    evidence.accumulated.hubA.reserve,
    evidence.finalized.hubA.reserve,
    'CROSS_NETTING_RESERVE_A_INCREASE',
  );
  const reserveDecreaseB = nonNegativeDifference(
    evidence.accumulated.hubB.reserve,
    evidence.finalized.hubB.reserve,
    'CROSS_NETTING_RESERVE_B_INCREASE',
  );
  const nettingEfficiencyBps = grossVolume === 0n
    ? 0
    : Number(((grossVolume - (expectedNetA < 0n ? -expectedNetA : expectedNetA)) * 10_000n) / grossVolume);
  return {
    tradeCount: evidence.trades.length,
    forwardVolume: forwardVolume.toString(),
    reverseVolume: reverseVolume.toString(),
    grossVolume: grossVolume.toString(),
    expectedNetA: expectedNetA.toString(),
    expectedNetB: expectedNetB.toString(),
    observedNetA: observedNetA.toString(),
    observedNetB: observedNetB.toString(),
    observedMarketMakerNetA: observedMarketMakerNetA.toString(),
    observedMarketMakerNetB: observedMarketMakerNetB.toString(),
    nettingEfficiencyBps,
    collateralIncreaseA: collateralIncreaseA.toString(),
    collateralIncreaseB: collateralIncreaseB.toString(),
    reserveDecreaseA: reserveDecreaseA.toString(),
    reserveDecreaseB: reserveDecreaseB.toString(),
    physicalSettlementVolume: (collateralIncreaseA + collateralIncreaseB).toString(),
  };
};

const assertSnapshotPair = (snapshot: CrossNettingStateSnapshot, label: string): CrossNettingInvariant[] => [
  requireInvariant(`${label}_account_a_replicas`, accountReplicaEqual(snapshot.jurisdictionA.user, snapshot.jurisdictionA.hub), 'user and hub replicas agree'),
  requireInvariant(`${label}_account_b_replicas`, accountReplicaEqual(snapshot.jurisdictionB.user, snapshot.jurisdictionB.hub), 'user and hub replicas agree'),
  requireInvariant(`${label}_mm_account_a_replicas`, accountReplicaEqual(snapshot.marketMakerA.marketMaker, snapshot.marketMakerA.hub), 'market maker and hub replicas agree'),
  requireInvariant(`${label}_mm_account_b_replicas`, accountReplicaEqual(snapshot.marketMakerB.marketMaker, snapshot.marketMakerB.hub), 'market maker and hub replicas agree'),
];

const assertQuiescent = (snapshot: CrossNettingStateSnapshot, label: string): CrossNettingInvariant => {
  const userReplicas = [
    snapshot.jurisdictionA.user, snapshot.jurisdictionA.hub,
    snapshot.jurisdictionB.user, snapshot.jurisdictionB.hub,
  ];
  const allReplicas = [
    ...userReplicas,
    snapshot.marketMakerA.marketMaker, snapshot.marketMakerA.hub,
    snapshot.marketMakerB.marketMaker, snapshot.marketMakerB.hub,
  ];
  const clean = userReplicas.every(replica =>
    replica.leftHold === '0' && replica.rightHold === '0' && replica.pullCount === 0
  ) && allReplicas.every(replica => !replica.pendingFrame);
  return requireInvariant(
    `${label}_quiescent`,
    clean,
    'user holds and pulls are empty; no user or market-maker replica has a pending frame',
  );
};

const assertTradeSequence = (evidence: CrossNettingEvidence): CrossNettingInvariant => {
  const valid = evidence.trades.every((trade, index) =>
    trade.sequence === index + 1 && trade.after.stage === 'post_trade' &&
    trade.after.sequence === trade.sequence && BigInt(trade.filledSourceAmount) > 0n &&
    BigInt(trade.filledTargetAmount) > 0n
  );
  return requireInvariant('trade_sequence', valid, 'contiguous positive settled full fills');
};

const stableSnapshotIdentity = (
  baseline: CrossNettingStateSnapshot,
  candidate: CrossNettingStateSnapshot,
): boolean =>
  baseline.jurisdictionA.userEntityId === candidate.jurisdictionA.userEntityId &&
  baseline.jurisdictionA.hubEntityId === candidate.jurisdictionA.hubEntityId &&
  baseline.jurisdictionB.userEntityId === candidate.jurisdictionB.userEntityId &&
  baseline.jurisdictionB.hubEntityId === candidate.jurisdictionB.hubEntityId &&
  baseline.marketMakerA.marketMakerEntityId === candidate.marketMakerA.marketMakerEntityId &&
  baseline.marketMakerA.hubEntityId === candidate.marketMakerA.hubEntityId &&
  baseline.marketMakerB.marketMakerEntityId === candidate.marketMakerB.marketMakerEntityId &&
  baseline.marketMakerB.hubEntityId === candidate.marketMakerB.hubEntityId &&
  baseline.hubA.entityId === candidate.hubA.entityId &&
  baseline.hubB.entityId === candidate.hubB.entityId &&
  baseline.hubA.runtimeId === candidate.hubA.runtimeId &&
  baseline.hubB.runtimeId === candidate.hubB.runtimeId &&
  baseline.jurisdictionA.tokenId === candidate.jurisdictionA.tokenId &&
  baseline.jurisdictionB.tokenId === candidate.jurisdictionB.tokenId &&
  baseline.marketMakerA.tokenId === candidate.marketMakerA.tokenId &&
  baseline.marketMakerB.tokenId === candidate.marketMakerB.tokenId &&
  baseline.hubA.tokenId === candidate.hubA.tokenId &&
  baseline.hubB.tokenId === candidate.hubB.tokenId;

const buildInvariants = (
  evidence: CrossNettingEvidence,
  metrics: CrossNettingMetrics,
): CrossNettingInvariant[] => {
  const expectedTrades = evidence.config.forwardTrades + evidence.config.reverseTrades;
  const actualForward = evidence.trades.filter(trade => trade.direction === 'A_TO_B').length;
  const actualReverse = evidence.trades.filter(trade => trade.direction === 'B_TO_A').length;
  const manualPoliciesCommitted = [
    evidence.baseline.jurisdictionA,
    evidence.baseline.jurisdictionB,
    evidence.baseline.marketMakerA,
    evidence.baseline.marketMakerB,
    evidence.accumulated.jurisdictionA,
    evidence.accumulated.jurisdictionB,
    evidence.accumulated.marketMakerA,
    evidence.accumulated.marketMakerB,
  ].every(pair =>
    pair.policySoftLimit === evidence.config.manualSoftLimit &&
    pair.policyHardLimit === evidence.config.manualHardLimit &&
    pair.policySoftLimit === pair.policyHardLimit
  );
  const noAccumulationSettlement =
    evidence.accumulated.jurisdictionA.user.collateral === evidence.baseline.jurisdictionA.user.collateral &&
    evidence.accumulated.jurisdictionB.user.collateral === evidence.baseline.jurisdictionB.user.collateral &&
    evidence.accumulated.marketMakerA.marketMaker.collateral === evidence.baseline.marketMakerA.marketMaker.collateral &&
    evidence.accumulated.marketMakerB.marketMaker.collateral === evidence.baseline.marketMakerB.marketMaker.collateral &&
    evidence.accumulated.hubA.reserve === evidence.baseline.hubA.reserve &&
    evidence.accumulated.hubB.reserve === evidence.baseline.hubB.reserve &&
    evidence.accumulated.hubA.accountSettledEventCount === evidence.baseline.hubA.accountSettledEventCount &&
    evidence.accumulated.hubB.accountSettledEventCount === evidence.baseline.hubB.accountSettledEventCount;
  const accumulationR2CCount = [evidence.accumulated.hubA, evidence.accumulated.hubB]
    .reduce((total, hub) => total + hub.currentR2CCount + hub.sentR2CCount + hub.recoveryR2CCount, 0);
  const finalizedR2CCount = [evidence.finalized.hubA, evidence.finalized.hubB]
    .reduce((total, hub) => total + hub.currentR2CCount + hub.sentR2CCount + hub.recoveryR2CCount, 0);
  const finalizedSettlementEventDelta =
    evidence.finalized.hubA.accountSettledEventCount - evidence.accumulated.hubA.accountSettledEventCount +
    evidence.finalized.hubB.accountSettledEventCount - evidence.accumulated.hubB.accountSettledEventCount;
  const finalityWindowsCoverExperiment =
    evidence.finalized.hubA.oldestRetainedJHeight <= evidence.accumulated.hubA.lastFinalizedJHeight + 1 &&
    evidence.finalized.hubB.oldestRetainedJHeight <= evidence.accumulated.hubB.lastFinalizedJHeight + 1;
  const physicalSettlement = BigInt(metrics.physicalSettlementVolume);
  const requestedA = BigInt(evidence.rebalanceRequested.jurisdictionA.user.requestedRebalance) > 0n;
  const requestedNet = BigInt(requestedA ? metrics.expectedNetA : metrics.expectedNetB);
  const absoluteRequestedNet = requestedNet < 0n ? -requestedNet : requestedNet;
  return [
    requireInvariant('manual_mode',
      evidence.config.manualSoftLimit === evidence.config.manualHardLimit && manualPoliciesCommitted,
      'configured and observed user and market-maker policies have soft limit equal to hard limit'),
    requireInvariant('configured_trade_count', evidence.trades.length === expectedTrades, `${evidence.trades.length}/${expectedTrades}`),
    requireInvariant('configured_directions',
      actualForward === evidence.config.forwardTrades && actualReverse === evidence.config.reverseTrades,
      `forward=${actualForward}/${evidence.config.forwardTrades} reverse=${actualReverse}/${evidence.config.reverseTrades}`),
    requireInvariant('separate_fee_token', evidence.config.feeTokenId !== evidence.config.tokenId,
      `bridgeToken=${evidence.config.tokenId} feeToken=${evidence.config.feeTokenId}`),
    requireInvariant('two_jurisdictions', evidence.config.jurisdictionA !== evidence.config.jurisdictionB,
      `${evidence.config.jurisdictionA} -> ${evidence.config.jurisdictionB}`),
    requireInvariant('single_hub_runtime', evidence.baseline.hubA.runtimeId === evidence.baseline.hubB.runtimeId,
      `runtime=${evidence.baseline.hubA.runtimeId}`),
    requireInvariant('zero_swap_fee', evidence.config.swapFeeBps === 0, `swapFeeBps=${evidence.config.swapFeeBps}`),
    assertTradeSequence(evidence),
    requireInvariant('stable_snapshot_identity', [
      ...evidence.trades.map(trade => trade.after),
      evidence.accumulated, evidence.rebalanceRequested, evidence.finalized,
    ].every(snapshot => stableSnapshotIdentity(evidence.baseline, snapshot)), 'entities, hubs, and token ids remain fixed'),
    ...assertSnapshotPair(evidence.baseline, 'baseline'),
    ...assertSnapshotPair(evidence.accumulated, 'accumulated'),
    ...assertSnapshotPair(evidence.rebalanceRequested, 'rebalance_requested'),
    ...assertSnapshotPair(evidence.finalized, 'finalized'),
    assertQuiescent(evidence.accumulated, 'accumulated'),
    assertQuiescent(evidence.finalized, 'finalized'),
    requireInvariant('no_settlement_during_accumulation', noAccumulationSettlement, 'collateral and finalized event counts unchanged'),
    requireInvariant('no_r2c_during_accumulation', accumulationR2CCount === 0,
      `r2cOperations=${accumulationR2CCount}`),
    requireInvariant('no_pending_request_before_trigger',
      evidence.accumulated.jurisdictionA.user.requestedRebalance === '0' &&
      evidence.accumulated.jurisdictionB.user.requestedRebalance === '0' &&
      evidence.accumulated.marketMakerA.marketMaker.requestedRebalance === '0' &&
      evidence.accumulated.marketMakerB.marketMaker.requestedRebalance === '0',
      'all user and market-maker accumulated requests are zero'),
    requireInvariant('observed_net_matches_fills',
      metrics.observedNetA === metrics.expectedNetA && metrics.observedNetB === metrics.expectedNetB,
      `expectedA=${metrics.expectedNetA} observedA=${metrics.observedNetA} expectedB=${metrics.expectedNetB} observedB=${metrics.observedNetB}`),
    requireInvariant('user_mm_accounting_conservation',
      BigInt(metrics.observedNetA) + BigInt(metrics.observedMarketMakerNetA) === 0n &&
      BigInt(metrics.observedNetB) + BigInt(metrics.observedMarketMakerNetB) === 0n,
      `userA=${metrics.observedNetA} mmA=${metrics.observedMarketMakerNetA} userB=${metrics.observedNetB} mmB=${metrics.observedMarketMakerNetB}`),
    requireInvariant('nonzero_net',
      BigInt(metrics.expectedNetA) !== 0n || BigInt(metrics.expectedNetB) !== 0n,
      `netA=${metrics.expectedNetA} netB=${metrics.expectedNetB}`),
    requireInvariant('request_committed',
      [evidence.rebalanceRequested.jurisdictionA.user, evidence.rebalanceRequested.jurisdictionB.user]
        .filter(replica => BigInt(replica.requestedRebalance) > 0n)
        .every((replica, _index, requested) => {
          const pair = replica === evidence.rebalanceRequested.jurisdictionA.user
            ? evidence.rebalanceRequested.jurisdictionA
            : evidence.rebalanceRequested.jurisdictionB;
          return replica.requestPolicyVersion === pair.hubFeePolicyVersion &&
            replica.requestId.length > 0 && replica.requestFeeTokenId === evidence.config.feeTokenId &&
            BigInt(replica.requestFeePaid) > 0n &&
            requested.length === 1;
        }) &&
      [evidence.rebalanceRequested.jurisdictionA.user, evidence.rebalanceRequested.jurisdictionB.user]
        .filter(replica => BigInt(replica.requestedRebalance) > 0n).length === 1,
      'exactly one jurisdiction has a committed, fee-backed collateral request'),
    requireInvariant('request_cleared',
      evidence.finalized.jurisdictionA.user.requestedRebalance === '0' &&
      evidence.finalized.jurisdictionB.user.requestedRebalance === '0',
      'both finalized requests are zero'),
    requireInvariant('finality_window_complete', finalityWindowsCoverExperiment,
      'final retained J-block windows include every post-accumulation block'),
    requireInvariant('one_account_settled_event', finalizedSettlementEventDelta === 1,
      `eventDelta=${finalizedSettlementEventDelta}`),
    requireInvariant('r2c_batches_drained', finalizedR2CCount === 0, `r2cOperations=${finalizedR2CCount}`),
    requireInvariant('physical_settlement_equals_requested_leg_net', physicalSettlement === absoluteRequestedNet,
      `physical=${physicalSettlement} requestedLegNet=${absoluteRequestedNet} gross=${metrics.grossVolume}`),
    requireInvariant('reserve_matches_collateral',
      metrics.reserveDecreaseA === metrics.collateralIncreaseA &&
      metrics.reserveDecreaseB === metrics.collateralIncreaseB,
      `reserveA=${metrics.reserveDecreaseA} collateralA=${metrics.collateralIncreaseA} reserveB=${metrics.reserveDecreaseB} collateralB=${metrics.collateralIncreaseB}`),
  ];
};

export const buildCrossNettingReport = (evidence: CrossNettingEvidence): CrossNettingReport => {
  if (evidence.baseline.stage !== 'baseline' || evidence.accumulated.stage !== 'accumulated' ||
      evidence.rebalanceRequested.stage !== 'rebalance_requested' || evidence.finalized.stage !== 'finalized') {
    throw new Error('CROSS_NETTING_REPORT_STAGE_ORDER_INVALID');
  }
  const metrics = calculateMetrics(evidence);
  const invariants = buildInvariants(evidence, metrics);
  return {
    schema: CROSS_NETTING_REPORT_SCHEMA,
    completionAuthority: 'committed_routes_accounts_and_jurisdiction_finality',
    ...evidence,
    metrics,
    invariants,
  };
};

export const decodeCrossNettingEvidence = (value: unknown): CrossNettingEvidence => {
  const raw = requireBoundaryRecord(value, 'CROSS_NETTING_EVIDENCE');
  requireExactBoundaryKeys(raw, [
    'config', 'baseline', 'trades', 'accumulated', 'rebalanceRequested', 'finalized',
  ], [], 'CROSS_NETTING_EVIDENCE_FIELDS');
  if (!Array.isArray(raw['trades'])) throw new Error('CROSS_NETTING_TRADES_INVALID');
  return {
    config: decodeConfig(raw['config']),
    baseline: decodeSnapshot(raw['baseline'], 'CROSS_NETTING_BASELINE'),
    trades: raw['trades'].map(decodeTrade),
    accumulated: decodeSnapshot(raw['accumulated'], 'CROSS_NETTING_ACCUMULATED'),
    rebalanceRequested: decodeSnapshot(raw['rebalanceRequested'], 'CROSS_NETTING_REQUESTED'),
    finalized: decodeSnapshot(raw['finalized'], 'CROSS_NETTING_FINALIZED'),
  };
};

const decodeMetrics = (value: unknown): CrossNettingMetrics => {
  const raw = requireBoundaryRecord(value, 'CROSS_NETTING_METRICS');
  requireExactBoundaryKeys(raw, [
    'tradeCount', 'forwardVolume', 'reverseVolume', 'grossVolume', 'expectedNetA', 'expectedNetB',
    'observedNetA', 'observedNetB', 'observedMarketMakerNetA', 'observedMarketMakerNetB',
    'nettingEfficiencyBps', 'collateralIncreaseA',
    'collateralIncreaseB', 'reserveDecreaseA', 'reserveDecreaseB', 'physicalSettlementVolume',
  ], [], 'CROSS_NETTING_METRICS_FIELDS');
  return {
    tradeCount: requireBoundaryInteger(raw['tradeCount'], 'CROSS_NETTING_METRICS_TRADES'),
    forwardVolume: nonNegativeDecimal(raw['forwardVolume'], 'CROSS_NETTING_METRICS_FORWARD'),
    reverseVolume: nonNegativeDecimal(raw['reverseVolume'], 'CROSS_NETTING_METRICS_REVERSE'),
    grossVolume: nonNegativeDecimal(raw['grossVolume'], 'CROSS_NETTING_METRICS_GROSS'),
    expectedNetA: signedDecimal(raw['expectedNetA'], 'CROSS_NETTING_METRICS_EXPECTED_NET_A'),
    expectedNetB: signedDecimal(raw['expectedNetB'], 'CROSS_NETTING_METRICS_EXPECTED_NET_B'),
    observedNetA: signedDecimal(raw['observedNetA'], 'CROSS_NETTING_METRICS_OBSERVED_A'),
    observedNetB: signedDecimal(raw['observedNetB'], 'CROSS_NETTING_METRICS_OBSERVED_B'),
    observedMarketMakerNetA: signedDecimal(raw['observedMarketMakerNetA'], 'CROSS_NETTING_METRICS_MM_OBSERVED_A'),
    observedMarketMakerNetB: signedDecimal(raw['observedMarketMakerNetB'], 'CROSS_NETTING_METRICS_MM_OBSERVED_B'),
    nettingEfficiencyBps: requireBoundaryInteger(raw['nettingEfficiencyBps'], 'CROSS_NETTING_METRICS_EFFICIENCY'),
    collateralIncreaseA: nonNegativeDecimal(raw['collateralIncreaseA'], 'CROSS_NETTING_METRICS_COLLATERAL_A'),
    collateralIncreaseB: nonNegativeDecimal(raw['collateralIncreaseB'], 'CROSS_NETTING_METRICS_COLLATERAL_B'),
    reserveDecreaseA: nonNegativeDecimal(raw['reserveDecreaseA'], 'CROSS_NETTING_METRICS_RESERVE_A'),
    reserveDecreaseB: nonNegativeDecimal(raw['reserveDecreaseB'], 'CROSS_NETTING_METRICS_RESERVE_B'),
    physicalSettlementVolume: nonNegativeDecimal(raw['physicalSettlementVolume'], 'CROSS_NETTING_METRICS_PHYSICAL'),
  };
};

const decodeInvariants = (value: unknown): CrossNettingInvariant[] => {
  if (!Array.isArray(value)) throw new Error('CROSS_NETTING_INVARIANTS_INVALID');
  return value.map((entry, index) => {
    const code = `CROSS_NETTING_INVARIANT_${index}`;
    const raw = requireBoundaryRecord(entry, code);
    requireExactBoundaryKeys(raw, ['name', 'passed', 'evidence'], [], `${code}_FIELDS`);
    if (raw['passed'] !== true) throw new Error(`${code}_FAILED`);
    return {
      name: text(raw['name'], `${code}_NAME`),
      passed: true,
      evidence: text(raw['evidence'], `${code}_EVIDENCE`),
    };
  });
};

export const decodeCrossNettingReport = (value: unknown): CrossNettingReport => {
  const raw = requireBoundaryRecord(value, 'CROSS_NETTING_REPORT');
  requireExactBoundaryKeys(raw, [
    'schema', 'completionAuthority', 'config', 'baseline', 'trades', 'accumulated',
    'rebalanceRequested', 'finalized', 'metrics', 'invariants',
  ], [], 'CROSS_NETTING_REPORT_FIELDS');
  if (raw['schema'] !== CROSS_NETTING_REPORT_SCHEMA ||
      raw['completionAuthority'] !== 'committed_routes_accounts_and_jurisdiction_finality') {
    throw new Error('CROSS_NETTING_REPORT_SCHEMA_INVALID');
  }
  const evidence = decodeCrossNettingEvidence({
    config: raw['config'], baseline: raw['baseline'], trades: raw['trades'],
    accumulated: raw['accumulated'], rebalanceRequested: raw['rebalanceRequested'],
    finalized: raw['finalized'],
  });
  const metrics = decodeMetrics(raw['metrics']);
  const invariants = decodeInvariants(raw['invariants']);
  const rebuilt = buildCrossNettingReport(evidence);
  if (JSON.stringify(metrics) !== JSON.stringify(rebuilt.metrics) ||
      JSON.stringify(invariants) !== JSON.stringify(rebuilt.invariants)) {
    throw new Error('CROSS_NETTING_REPORT_DERIVED_EVIDENCE_MISMATCH');
  }
  return rebuilt;
};
