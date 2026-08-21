import { deriveAccountWatchSeed } from '../../protocol/identity/account-watch-seed';
import { createEmptyAccountJClaimAccumulator } from '../../account/j-claims/j-claim-accumulator';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../account/crypto';
import {
  deriveEntityEncryptionPublicKey,
  provisionEntityEncryptionKey,
} from '../../entity/auth/crypto';
import { getJurisdictionStackId } from '../../jurisdiction/machine/jurisdiction-runtime';
import {
  canonicalDisputeFinalizationEvidenceHash,
  canonicalJurisdictionEventsHash,
  getJEventJurisdictionRef,
} from '../../jurisdiction/machine/event-observation';
import type { AccountReplica } from '../../types/account';
import type { ConsensusConfig, EntityReplica, EntityState, JurisdictionConfig } from '../../entity/types';
import type { RuntimeReplica } from '../../runtime/types';
import type { DisputeFinalizationEvidence, JurisdictionEvent } from '../../types/jurisdiction-events';
import { createDefaultDelta } from '../../account/state/delta';
import { hexlify } from 'ethers';
import { computeEntityAccountValueHash } from '../../entity/consensus/state-root';
import {
  EntityAccountCandidateMap,
  PersistentEntityAccountMap,
} from '../../entity/state/persistent-account-map';
import { PersistentAccountStateMap } from '../../account/state/persistent-state-map';

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

export const registerTestSigner = (env: RuntimeReplica, seed: string, slot = '1'): string => {
  env.runtimeSeed = seed;
  const signerId = deriveSignerAddressSync(seed, slot);
  registerSignerKey(seed, signerId, deriveSignerKeySync(seed, slot));
  return signerId;
};

export const prepareJEventInput = (
  env: RuntimeReplica,
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
): { jurisdictionRef: string; eventsHash: string; disputeFinalizationEvidenceHash?: string } => {
  const matchingReplica = Array.from(env.state.eReplicas.values()).find((replica) =>
    replica.entityId.toLowerCase() === entityId.toLowerCase() &&
    replica.signerId.toLowerCase() === signerId.toLowerCase());
  const jurisdictionRef = input.jurisdictionRef ?? getJEventJurisdictionRef(matchingReplica?.state.config.jurisdiction);
  const eventsHash = canonicalJurisdictionEventsHash(input.events);
  const disputeFinalizationEvidenceHash = input.disputeFinalizationEvidence?.length
    ? canonicalDisputeFinalizationEvidenceHash(input.disputeFinalizationEvidence)
    : undefined;
  return {
    jurisdictionRef,
    eventsHash,
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

export const makeAccount = (
  selfId: string,
  counterpartyId: string,
  jurisdiction: { chainId: number; depositoryAddress: string } = {
    chainId: 31_337,
    depositoryAddress: addr('dd'),
  },
): AccountReplica => {
  const [leftEntity, rightEntity] = selfId.toLowerCase() < counterpartyId.toLowerCase()
    ? [selfId, counterpartyId]
    : [counterpartyId, selfId];
  const delta = createDefaultDelta(1);
  delta.leftCreditLimit = 10n ** 30n;
  delta.rightCreditLimit = 10n ** 30n;
  return {
    state: {
      leftEntity,
      rightEntity,
      domain: {
        chainId: jurisdiction.chainId,
        depositoryAddress: jurisdiction.depositoryAddress,
      },
      watchSeed: deriveAccountWatchSeed({
        runtimeSeed: 'cross-j-test-helper',
        entityId: leftEntity,
        counterpartyId: rightEntity,
      }),
      deltas: PersistentAccountStateMap.fromEntries('deltas', [[1, delta]]),
      locks: PersistentAccountStateMap.empty('locks'),
      swapOffers: PersistentAccountStateMap.empty('swapOffers'),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      jNonce: 0,
      requestedRebalance: PersistentAccountStateMap.empty('requestedRebalance'),
      requestedRebalanceFeeState: PersistentAccountStateMap.empty('requestedRebalanceFeeState'),
    },
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
    currentHeight: 0,
    rollbackCount: 0,
    proofHeader: { fromEntity: selfId, toEntity: counterpartyId, nextProofNonce: 0 },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: { rebalance: {
      policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
      submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
    } },
  };
};

export const makeState = (
  entityId: string,
  signerId: string,
  jurisdiction: JurisdictionConfig,
  counterpartyId?: string,
): EntityState => {
  const entityEncryptionPrivateKey = hexlify(deriveSignerKeySync(entityId, 'entity-encryption'));
  let accounts = PersistentEntityAccountMap.empty(entityId, computeEntityAccountValueHash);
  if (counterpartyId) {
    const { chainId, depositoryAddress } = jurisdiction;
    if (!Number.isSafeInteger(chainId) || chainId === undefined || !depositoryAddress) {
      throw new Error(`CROSS_J_TEST_JURISDICTION_INCOMPLETE:${jurisdiction.name}`);
    }
    const account = makeAccount(entityId, counterpartyId, { chainId, depositoryAddress });
    accounts = accounts.updated(counterpartyId, account);
  }
  return {
    entityId,
    entityEncryptionPublicKey: deriveEntityEncryptionPublicKey(entityEncryptionPrivateKey, entityId),
    height: 1,
    prevFrameHash: `0x${'01'.repeat(32)}`,
    timestamp: 1_000,
    nonces: new Map(),
    proposals: new Map(),
    config: makeConfig(signerId, jurisdiction),
    reserves: new Map(),
    accounts,
    lastFinalizedJHeight: 0,
    profile: { name: '', isHub: false, avatar: '', bio: '', website: '' },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    lockBook: new Map(),
    crossJurisdictionSwaps: new Map(),
    swapTradingPairs: [],
  };
};

/** Entity-frame write overlay. Committed Patricia maps reject `.set` and in-place status edits. */
export const openWritableEntityAccounts = (state: EntityState): EntityAccountCandidateMap => {
  if (state.accounts instanceof EntityAccountCandidateMap) return state.accounts;
  const committed = state.accounts instanceof PersistentEntityAccountMap
    ? state.accounts
    : PersistentEntityAccountMap.fromMap(state.accounts, state.entityId, computeEntityAccountValueHash);
  const overlay = new EntityAccountCandidateMap(committed);
  state.accounts = overlay;
  return overlay;
};

export const addReplica = (env: RuntimeReplica, state: EntityState, signerId: string, isProposer = true): void => {
  provisionTestEntityEncryptionKey(env, state.entityId);
  env.state.eReplicas.set(`${state.entityId}:${signerId}`, {
    entityId: state.entityId,
    signerId,
    state,
    mempool: [],
    isProposer,
  } as EntityReplica);
};

export const provisionTestEntityEncryptionKey = (
  env: RuntimeReplica,
  entityId: string,
): string => provisionEntityEncryptionKey(
    env,
    entityId,
    hexlify(deriveSignerKeySync(entityId, 'entity-encryption')),
  );

export const installJurisdictions = (env: RuntimeReplica, ...jurisdictions: JurisdictionConfig[]): void => {
  for (const jurisdiction of jurisdictions) {
    env.state.jReplicas.set(jurisdiction.name, {
      name: jurisdiction.name,
      chainId: jurisdiction.chainId,
      rpcs: [jurisdiction.address],
      contracts: {
        depository: jurisdiction.depositoryAddress,
        entityProvider: jurisdiction.entityProviderAddress,
        account: addr('98'),
        deltaTransformer: addr('99'),
      },
      blockTimeMs: jurisdiction.blockTimeMs,
    } as any);
  }
};
