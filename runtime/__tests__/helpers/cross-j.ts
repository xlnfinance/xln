import { deriveAccountWatchSeed } from '../../account/watch-seed';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey, signAccountFrame } from '../../account/crypto';
import { buildCrossJurisdictionPullBinding } from '../../extensions/cross-j/index';
import { buildCrossJurisdictionBookAdmissionReceipt } from '../../extensions/cross-j/orderbook';
import { getJurisdictionStackId } from '../../jurisdiction/jurisdiction-runtime';
import {
  buildJEventObservationDigest,
  canonicalDisputeFinalizationEvidenceHash,
  canonicalJurisdictionEventsHash,
  getJEventJurisdictionRef,
} from '../../jurisdiction/event-observation';
import type {
  AccountMachine,
  ConsensusConfig,
  CrossJurisdictionSwapRoute,
  EntityReplica,
  EntityState,
  Env,
  DisputeFinalizationEvidence,
  JurisdictionConfig,
  JurisdictionEvent,
} from '../../types';
import { createDefaultDelta } from '../../validation-utils';

export const addr = (byte: string): string => `0x${byte.repeat(20)}`;
export const entity = (byte: string): string => `0x${byte.repeat(32)}`;
export const secret = (byte: string): string => `0x${byte.repeat(32)}`;
export const partialBinary = (ratio: number): string =>
  `0x${ratio.toString(16).padStart(4, '0')}${[secret('a1'), secret('a2'), secret('a3'), secret('a4')].map(node => node.slice(2)).join('')}`;

export const makeJurisdiction = (name: string, chainId: number, depByte: string, epByte: string): JurisdictionConfig => ({
  name,
  address: `rpc://${name}`,
  chainId,
  blockTimeMs: 1_000,
  depositoryAddress: addr(depByte),
  entityProviderAddress: addr(epByte),
});

export const jref = (jurisdiction: JurisdictionConfig): string => getJurisdictionStackId(jurisdiction);

export const registerTestSigner = (env: Env, seed: string, slot = '1'): string => {
  env.runtimeSeed = seed;
  const signerId = deriveSignerAddressSync(seed, slot);
  registerSignerKey(signerId, deriveSignerKeySync(seed, slot));
  return signerId;
};

export const signJEventObservation = (
  env: Env,
  entityId: string,
  signerId: string,
  input: {
    blockNumber: number;
    blockHash: string;
    transactionHash: string;
    events: JurisdictionEvent[];
    disputeFinalizationEvidence?: DisputeFinalizationEvidence[];
    jurisdictionRef?: string;
  },
): { jurisdictionRef: string; eventsHash: string; signature: string; disputeFinalizationEvidenceHash?: string } => {
  const matchingReplica = Array.from(env.eReplicas.values()).find((replica) =>
    replica.entityId.toLowerCase() === entityId.toLowerCase() &&
    replica.signerId.toLowerCase() === signerId.toLowerCase());
  const jurisdictionRef = input.jurisdictionRef ?? getJEventJurisdictionRef(matchingReplica?.state.config.jurisdiction);
  const eventsHash = canonicalJurisdictionEventsHash(input.events);
  const disputeFinalizationEvidenceHash = input.disputeFinalizationEvidence?.length
    ? canonicalDisputeFinalizationEvidenceHash(input.disputeFinalizationEvidence)
    : undefined;
  const signature = signAccountFrame(
    env,
    signerId,
    buildJEventObservationDigest({
      entityId,
      jurisdictionRef,
      signerId,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      eventsHash,
      ...(disputeFinalizationEvidenceHash ? { disputeFinalizationEvidenceHash } : {}),
    }),
  );
  return {
    jurisdictionRef,
    eventsHash,
    signature,
    ...(disputeFinalizationEvidenceHash ? { disputeFinalizationEvidenceHash } : {}),
  };
};

export const makeConfig = (signerId: string, jurisdiction: JurisdictionConfig): ConsensusConfig => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [signerId],
  shares: { [signerId]: 1n },
  jurisdiction,
});

export const makeAccount = (selfId: string, counterpartyId: string): AccountMachine => {
  const [leftEntity, rightEntity] = selfId.toLowerCase() < counterpartyId.toLowerCase()
    ? [selfId, counterpartyId]
    : [counterpartyId, selfId];
  const delta = createDefaultDelta(1);
  delta.leftCreditLimit = 10n ** 30n;
  delta.rightCreditLimit = 10n ** 30n;
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
    deltas: new Map([[1, delta]]),
    locks: new Map(),
    swapOffers: new Map(),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    leftJObservations: [],
    rightJObservations: [],
    jEventChain: [],
    lastFinalizedJHeight: 0,
    watchSeed: deriveAccountWatchSeed({
      runtimeSeed: 'cross-j-test-helper',
      entityId: leftEntity,
      counterpartyId: rightEntity,
      timestamp: 0,
    }),
    proofHeader: { fromEntity: selfId, toEntity: counterpartyId, nextProofNonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    jNonce: 0,
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
  };
};

export const makeState = (
  entityId: string,
  signerId: string,
  jurisdiction: JurisdictionConfig,
  counterpartyId?: string,
): EntityState => ({
  entityId,
  height: 1,
  timestamp: 1_000,
  nonces: new Map(),
  messages: [],
  proposals: new Map(),
  config: makeConfig(signerId, jurisdiction),
  reserves: new Map(),
  accounts: counterpartyId ? new Map([[counterpartyId, makeAccount(entityId, counterpartyId)]]) : new Map(),
  lastFinalizedJHeight: 0,
  jBlockObservations: [],
  jBlockChain: [],
  entityEncPubKey: `0x${'aa'.repeat(32)}`,
  entityEncPrivKey: `0x${'bb'.repeat(32)}`,
  profile: { name: '', isHub: false, avatar: '', bio: '', website: '' },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
  crossJurisdictionSwaps: new Map(),
  swapTradingPairs: [],
  pendingSwapFillRatios: new Map(),
});

export const addReplica = (env: Env, state: EntityState, signerId: string, isProposer = true): void => {
  env.eReplicas.set(`${state.entityId}:${signerId}`, {
    entityId: state.entityId,
    signerId,
    state,
    mempool: [],
    isProposer,
  } as EntityReplica);
};

export const installJurisdictions = (env: Env, ...jurisdictions: JurisdictionConfig[]): void => {
  for (const jurisdiction of jurisdictions) {
    env.jReplicas.set(jurisdiction.name, {
      name: jurisdiction.name,
      chainId: jurisdiction.chainId,
      rpcs: [jurisdiction.address],
      depositoryAddress: jurisdiction.depositoryAddress,
      entityProviderAddress: jurisdiction.entityProviderAddress,
      blockTimeMs: jurisdiction.blockTimeMs,
      defaultDisputeDelayBlocks: 5,
    } as any);
  }
};

export const targetReceiptFor = (
  route: CrossJurisdictionSwapRoute,
  committedAt = 1_000,
) =>
  buildCrossJurisdictionBookAdmissionReceipt(
    route,
    'target',
    {
      type: 'pull_lock',
      data: {
        pullId: route.targetPull!.pullId,
        tokenId: route.targetPull!.tokenId,
        amount: route.targetPull!.signedAmount,
        revealedUntilTimestamp: route.targetPull!.revealedUntilTimestamp,
        fullHash: route.targetPull!.fullHash,
        partialRoot: route.targetPull!.partialRoot,
        crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'),
      },
    },
    route.target.entityId,
    route.target.counterpartyEntityId,
    committedAt,
  );
