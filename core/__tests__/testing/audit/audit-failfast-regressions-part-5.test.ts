import { describe, expect, spyOn, test } from 'bun:test';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { readEntityFrameEventMessages } from '../../../entity/frame-events';

import { x25519 } from '@noble/curves/ed25519.js';

import {
  applyAccountInput,
  getIncomingAccountDeadlineViolation,
  HTLC_ENFORCEMENT_RESERVE_MS,
  isHtlcSecretEnforcementWindowClosed,
  proposeAccountFrame,
} from '../../../account/consensus/index';

import { computeAccountStateRoot, computeAccountStateRootCold } from '../../../account/commitment/state-root';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';

import { resolveCertifiedAccountCounterpartyProposer } from '../../../runtime/delivery/topology/account-counterparty-route';

import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey, signAccountFrame } from '../../../account/crypto';

import { deriveAccountWatchSeed } from '../../../protocol/identity/account-watch-seed';

import { applyAccountTx } from '../../../account/tx/apply';


import { handleHtlcLock } from '../../../account/tx/handlers/htlc/lock';

import { handleHtlcResolve } from '../../../account/tx/handlers/htlc/resolve';

import { createSettlementWorkspaceHash } from '../../../account/tx/handlers/settlement/transition';

import { hashHtlcSecret } from '../../../protocol/htlc/utils';

import { buildHashLadderProof, revealHashLadder } from '../../../protocol/htlc/hash-ladder';

import {
  encryptBytesForValidatorManifest,
  type MultiRecipientCiphertext,
} from '../../../protocol/htlc/multi-recipient';

import { checkAutoRebalance, handleRequestCollateral } from '../../../account/tx/handlers/rebalance/request-collateral';

import { handleSwapOffer } from '../../../account/tx/handlers/swap/offer/index';

import { computeFrameHash, MAX_ACCOUNT_FRAME_TXS } from '../../../account/consensus/frame/hash';

import { resolveAutoRebalanceFeePolicy, runPostFrameAutoRebalanceCheck } from '../../../account/consensus/helpers';

import { HTLC, LIMITS } from '../../../config/constants';

import { executeCrontab, initCrontab } from '../../../entity/scheduler';
import { HTLC_SECRET_ACK_TIMEOUT_MS } from '../../../entity/tx/j-events-htlc/route-lifecycle';

import { encodeBoard, generateLazyEntityId, generateNumberedEntityId, hashBoard } from '../../../entity/factory';

import { isLeftEntity } from '../../../entity/id';

import {
  CROSS_J_PENDING_FILL_ACK_TTL_MS,
  MAX_PENDING_CROSS_J_FILL_ACKS,
  applyEntityInput,
} from '../../../entity/consensus/index';
import { applyEntityFrameWithMaterializedTestInfraContext } from '../../helpers/entity-frame';

import { createEntityFrameHash } from '../../../entity/consensus/frame';

import { buildSignedEntityCommand, prepareLocallyAuthoredEntityTxs } from '../../../entity/command';

import { signedEntityCommandTx } from '../../../entity/command/command-codec';

import { buildCollectiveEntityProposalTx } from '../../../entity/auth/authorization';

import { generateProposalId } from '../../../entity/tx/processing/proposals';

import { buildEntityHashesToSign } from '../../../entity/consensus/input/hanko-witness';

import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeCanonicalEntityConsensusStateHashCold,
  computeEntityAccountValueHash,
  computeEntityFrameAuthorityRoot,
} from '../../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';

import {
  assertCrossJurisdictionOrderAdmissible,
  findCrossJurisdictionBookAdmissionForAck,
} from '../../../orderbook/cross-j/orderbook';

import {
  buildCrossJurisdictionMarketOffer,
  getCrossJurisdictionBookAdmissionError,
  mergeCrossJurisdictionBookAdmission,
} from '../../../extensions/cross-j/orderbook';

import {
  buildCrossJurisdictionPullBinding,
  buildCrossJurisdictionCloseProof,
  buildCrossJurisdictionPullReveal,
  buildPreparedCrossJurisdictionRoute,
  deriveCrossJurisdictionPrivateSeed,
  withCanonicalCrossJurisdictionRouteHash,
} from '../../../extensions/cross-j/index';

import { applyEntityTx } from '../../../entity/tx/apply';

import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../../../entity/tx/handlers/account-cross-j-followups';

import { buildCrossJurisdictionEntityOutput } from '../../../entity/tx/j-events-htlc/cross-j-outputs';

import { handleHtlcOnionAdvance } from '../../../entity/tx/handlers/htlc/onion-advance';

import {
  handleAdmitCrossJurisdictionBookOrderEntityTx,
  handleCrossJurisdictionBookOrderRemovedEntityTx,
} from '../../../entity/tx/handlers/cross-j/book-order';

import type { SwapOfferEvent } from '../../../entity/tx/handlers/account/index';

import { handleDisputeFinalize, handleDisputeStart, handlePrepareDispute } from '../../../entity/tx/handlers/dispute/index';

import { handleJAbortSentBatch } from '../../../entity/tx/handlers/j-batch/j-abort-sent-batch';

import { handleJRebroadcast } from '../../../entity/tx/handlers/j-batch/j-rebroadcast';

import { handleSetHubConfigEntityTx, handleSetRebalancePolicyEntityTx } from '../../../entity/tx/handlers/account/lifecycle/admin';

import { buildSettlementHankoDraft, processCommittedSettlementTransitionFollowup } from '../../../entity/tx/handlers/payments/settle';

import { applyJEvent } from '../../../entity/tx/j-events';

import { applyJEventRange, buildJEventRangeData } from '../../helpers/j-history';

import { applyFinalizedAccountJEvents } from '../../../account/tx/handlers/j-events/finality';

import { queueCrossJurisdictionSalvageFromFinalizedArguments } from '../../../entity/tx/j-events-htlc';

import {
  canonicalDisputeFinalizationEvidenceHash,
  canonicalJurisdictionEventsHash,
  getJEventJurisdictionRef,
} from '../../../jurisdiction/machine/event-observation';

import { getRuntimeJurisdictionHeight } from '../../../jurisdiction/machine/history/height';

import { recordValidatorJHistory } from '../../../jurisdiction/machine/local-history';

import { buildLocalJPrefixAttestation } from '../../../jurisdiction/machine/history/j-prefix-consensus';

import { createEmptyBatch, encodeJBatch } from '../../../jurisdiction/machine/batch';

import {
  getCertifiedBoardNodeStore,
  resolveCertifiedRegisteredBoardHash,
  resolveObserverCertifiedBoardRecord,
} from '../../../jurisdiction/machine/board-registry';

import {
  applyCommand,
  createBook,
  getBookOrder,
  getStaticSwapTokenDimensions,
  getSwapLotScale,
  getSwapPairDimensions,
  ORDERBOOK_PRICE_SCALE,
  SWAP_LOT_SCALE,
  type OrderbookExtState,
} from '../../../orderbook';

import {
  createEmptyEnv,
  processRuntime,
  registerEntityRuntimeHint,
  sendEntityInput,
  validateRuntimeInputAdmission,
} from '../../../runtime';

import { createJReplica } from '../../../scenarios/harness/boot';

import { applyMergedEntityInputs, RuntimeEntityInputApplyError } from '../../../runtime/mempool/entity-inputs';

import { MalformedEntityFrameInputError } from '../../../entity/tx/processing/invariant-errors';

import { applyStorageChanges } from '../../../runtime/observability/env-events';

import { submitRuntimeJOutbox } from '../../../runtime/j-submit/j-submit';

import { registerStructuredLogSink } from '../../../support/logger';

import { buildJSubmitAttemptId, registerPendingCommittedJOutbox } from '../../../runtime/j-submit/j-submit-state';

import { buffersEqual, safeStringify } from '../../../protocol/serialization';

import type { ProofBodyStruct } from '../../../protocol/dispute/proof-body';

import { projectAccountDoc } from '../../../storage/read/projections';

import { createDefaultDelta } from '../../../account/state/delta';

import { createEntityFrameCandidateState } from '../../../entity/state-clone';

import {
  buildAccountProofBody,
  createDisputeProofHashWithNonce,
  hashProofBodyStruct,
} from '../../../protocol/dispute/proof-builder';

import { encodeSignedHanko } from '../../../hanko/codec';

import { resolveHankoBoardDelays } from '../../../hanko/claims';

import { verifyHankoForHash } from '../../../hanko/signing';
import { attachAccountDraftHankosAsEntity } from '../../../qa/account/draft';


import { computeHtlcEnvelopeContextHash, computeHtlcSecretOfferContextHash } from '../../../protocol/htlc/codec/envelope';

import { buildHtlcOnionAdvanceTx } from '../../../entity/paybook/onion-advance';
import { hashEncryptedHtlcLayer } from '../../../protocol/htlc/codec/onion-layer';

import { encodeHtlcSecretOffer, encodeOnionLayer } from '../../../protocol/htlc/codec/onion';


import { handleMeshBootstrapLoopError } from '../../../orchestrator/mesh/mesh-bootstrap-fail-fast';

import { fitCrossAmountsToOrderbook } from '../../../orchestrator/mm-node';
import {
  clearReplayOutputSignerHints,
  installReplayOutputSignerHints,
  resolveEntityProposerId,
} from '../../../runtime/delivery/entity-output-signer';

import { QUOTE_EXPIRY_MS } from '../../../types/finance/rebalance';

import type { AccountFrame, AccountInput, AccountReplica, AccountState, AccountTx } from '../../../types/account';
import type { ConsensusConfig, EntityInput, EntityReplica, EntityState, JurisdictionConfig } from '../../../entity/types';
import type { RuntimeReplica, RuntimeTx } from '../../../runtime/types';
import type { JInput } from '../../../jurisdiction/machine/input';
import type { CrossJurisdictionSwapRoute } from '../../../types/cross-jurisdiction';
import type { DisputeFinalizationEvidence, JurisdictionEvent } from '../../../types/jurisdiction-events';
import type { EntityTx } from '../../../types/entity-tx';

import { installCanonicalRegisteredBoardAuthority } from '../../helpers/registration-evidence';
import { exactFillRatioToUint16 } from '../../../orderbook/swap-execution';

import { ethers } from 'ethers';
import {
  isProposedAccountFrame,
  proposeAccountFrameMessage,
} from '../../../account/consensus/result';

const makeSingleSignerConfig = (): EntityState['config'] => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: ['1'],
  shares: { '1': 1n },
  jurisdiction: {
    name: 'AuditTestnet',
    chainId: 31337,
    depositoryAddress: `0x${'dd'.repeat(20)}`,
    entityProviderAddress: `0x${'ee'.repeat(20)}`,
  },
});

const makeSingleSignerConfigFor = (signerId: string): EntityState['config'] => ({
  mode: 'proposer-based',
  threshold: 1n,
  validators: [signerId],
  shares: { [signerId]: 1n },
  jurisdiction: {
    name: 'AuditTestnet',
    chainId: 31337,
    depositoryAddress: `0x${'dd'.repeat(20)}`,
    entityProviderAddress: `0x${'ee'.repeat(20)}`,
  },
});

const installSingleSignerBoard = (env: RuntimeReplica, state: EntityState, slot = '1'): string => {
  const seed = env.runtimeSeed;
  if (!seed) throw new Error('TEST_RUNTIME_SEED_REQUIRED');
  const signerId = deriveSignerAddressSync(seed, slot).toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync(seed, slot));
  state.config = makeSingleSignerConfigFor(signerId);
  return signerId;
};

const hex20 = (byte: string): string => `0x${byte.repeat(byte.length === 2 ? 20 : 40)}`;

const hexBytes = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')}`;

const HANKO_DELAYS = resolveHankoBoardDelays();

const hashHankoBoard = (threshold: number, boardEntityIds: string[], weights: number[]): string => {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return ethers
    .keccak256(
      abiCoder.encode(
        ['tuple(uint16,bytes32[],uint16[],uint32,uint32,uint32)'],
        [[threshold, boardEntityIds, weights, 0, 0, 0]],
      ),
    )
    .toLowerCase();
};

const signedHankoForTest = (
  hash: string,
  privateKeys: readonly Uint8Array[],
  placeholders: readonly string[],
  claims: readonly [string, readonly bigint[], readonly bigint[], bigint][],
): string =>
  encodeSignedHanko({
    digest: hash,
    privateKeys,
    placeholders: placeholders.map(value => value as `0x${string}`),
    claims: claims.map(([entityId, entityIndexes, weights, threshold]) => ({
      entityId: entityId as `0x${string}`,
      entityIndexes,
      weights,
      threshold,
      ...HANKO_DELAYS,
    })),
  });

const makeEmptyProofBody = () => ({
  watchSeed: `0x${'f1'.repeat(32)}`,
  leftResponseSeconds: 10,
  rightResponseSeconds: 10,
  offdeltas: [],
  tokenIds: [],
  transformers: [],
});

const makeProposalAccount = (mempool: AccountTx[], leftEntity: string, rightEntity: string): AccountReplica => {
  return {
    state: {
      leftEntity,
      rightEntity,
      domain: { chainId: 31337, depositoryAddress: `0x${'dd'.repeat(20)}` },
      watchSeed: deriveAccountWatchSeed({
        runtimeSeed: 'audit-failfast-test-helper',
        entityId: leftEntity,
        counterpartyId: rightEntity,
      }),
      deltas: PersistentAccountStateMap.empty('deltas'),
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
    mempool: [...mempool],
    currentFrame: {
      height: 0,
      timestamp: 0,
      jHeight: 0,
      accountTxs: [],
      prevFrameHash: '',
      accountStateRoot: `0x${'00'.repeat(32)}`,
      deltas: [],
      stateHash: '',
      byLeft: true,
    },
    currentHeight: 0,
    rollbackCount: 0,
    proofHeader: { fromEntity: leftEntity, toEntity: rightEntity, nextProofNonce: 0 },
    pendingWithdrawals: PersistentAccountStateMap.empty('pendingWithdrawals'),
    shadow: {
      rebalance: {
        policy: PersistentAccountStateMap.empty('rebalanceShadowPolicy'),
        submittedAtByToken: PersistentAccountStateMap.empty('rebalanceShadowSubmitted'),
      },
    },
  };
};

const setSyntheticPendingAccountProposal = (
  account: AccountReplica,
  accountTxs: AccountTx[],
  timestamp: number,
): void => {
  const pendingFrame = {
    ...account.currentFrame,
    height: account.currentHeight + 1,
    timestamp,
    accountTxs: structuredClone(accountTxs),
    prevFrameHash: account.currentHeight === 0 ? 'genesis' : account.currentFrame.stateHash,
    stateHash: `0x${'f0'.repeat(32)}`,
  };
  account.pendingFrame = pendingFrame;
  account.pendingAccountInput = {
    kind: 'ack_frame',
    fromEntityId: account.proofHeader.fromEntity,
    toEntityId: account.proofHeader.toEntity,
    domain: structuredClone(account.state.domain),
    disputeConfig: structuredClone(account.state.disputeConfig),
    proposal: { frame: structuredClone(pendingFrame) },
  };
};

const makeIncomingAccountFrame = (
  account: AccountReplica,
  tx: AccountTx,
  byLeft: boolean,
  timestamp = 10_000,
  jHeight = 1,
): AccountFrame => ({
  ...account.currentFrame,
  height: account.currentHeight + 1,
  timestamp,
  jHeight,
  accountTxs: [tx],
  byLeft,
});

const attachSigningReplica = (env: ReturnType<typeof createEmptyEnv>, entityId: string, signerId: string): void => {
  const config = makeSingleSignerConfigFor(signerId);
  const jurisdiction = config.jurisdiction!;
  if (!env.state.jReplicas.has('__audit_test__')) {
    env.state.jReplicas.set('__audit_test__', {
      name: '__audit_test__',
      chainId: jurisdiction.chainId,
      rpcs: [],
      contracts: { depository: jurisdiction.depositoryAddress, entityProvider: jurisdiction.entityProviderAddress },
      contracts: {
        depository: jurisdiction.depositoryAddress,
        entityProvider: jurisdiction.entityProviderAddress,
        account: hex20('98'),
        deltaTransformer: hex20('99'),
      },
      blockNumber: 0n,
      stateRoot: null,
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      watcherConfirmationDepth: 0,
      position: { x: 0, y: 0, z: 0 },
    });
  }
  env.state.eReplicas.set(`${entityId}:${signerId}`, {
    entityId,
    signerId,
    entityEncPubKey: '',
    mempool: [],
    isProposer: true,
    state: {
      ...makeEntityState(entityId),
      config,
    },
  } satisfies EntityReplica);
};

const registerLazySigner = (seed: string, signerSlot: string): { signerId: string; entityId: string } => {
  const signerId = deriveSignerAddressSync(seed, signerSlot);
  const privateKey = deriveSignerKeySync(seed, signerSlot);
  registerSignerKey(seed, signerId, privateKey);
  return {
    signerId,
    entityId: generateLazyEntityId([signerId], 1n).toLowerCase(),
  };
};

const ensureCanonicalCommandBoardAuthority = async (env: RuntimeReplica, state: EntityState): Promise<void> => {
  const boardHash = hashBoard(encodeBoard(state.config, env)).toLowerCase();
  if (state.entityId.toLowerCase() === boardHash) return;
  const jurisdiction = state.config.jurisdiction;
  if (!jurisdiction) throw new Error(`TEST_ENTITY_JURISDICTION_REQUIRED:${state.entityId}`);
  const existing = resolveObserverCertifiedBoardRecord(state, getCertifiedBoardNodeStore(env), state.entityId);
  if (existing) {
    if (existing.boardHash !== boardHash) {
      throw new Error(`TEST_ENTITY_BOARD_AUTHORITY_CONFLICT:${existing.boardHash}:${boardHash}`);
    }
    return;
  }
  let replica = Array.from(env.state.jReplicas.values()).find(
    candidate =>
      candidate.chainId === jurisdiction.chainId &&
      (candidate.contracts?.depository?.toLowerCase()
        || candidate.depositoryAddress?.toLowerCase()) === jurisdiction.depositoryAddress.toLowerCase() &&
      (candidate.contracts?.entityProvider?.toLowerCase()
        || candidate.entityProviderAddress?.toLowerCase()) === jurisdiction.entityProviderAddress.toLowerCase(),
  );
  if (!replica) {
    replica = createJReplica(env, jurisdiction.name, jurisdiction.depositoryAddress);
    replica.chainId = jurisdiction.chainId;
    replica.contracts = { ...replica.contracts, depository: jurisdiction.depositoryAddress };
    replica.contracts = { ...replica.contracts, entityProvider: jurisdiction.entityProviderAddress };
  }
  replica.contracts = {
    depository: jurisdiction.depositoryAddress,
    entityProvider: jurisdiction.entityProviderAddress,
    account: replica.contracts?.account || hex20('98'),
    deltaTransformer: replica.contracts?.deltaTransformer || hex20('99'),
  };
  replica.watcherConfirmationDepth = 0;
  await installCanonicalRegisteredBoardAuthority(env, jurisdiction, state, boardHash);
};

const buildQuorumAuthorizedFrameTxs = async (
  env: RuntimeReplica,
  state: EntityState,
  collectiveTxs: EntityTx[],
  frameTimestamp: number = env.state.timestamp,
): Promise<EntityTx[]> => {
  await ensureCanonicalCommandBoardAuthority(env, state);
  const [proposer, ...otherValidators] = state.config.validators;
  if (!proposer) throw new Error('TEST_ENTITY_PROPOSER_REQUIRED');
  const proposalTx = buildCollectiveEntityProposalTx(proposer, collectiveTxs);
  if (proposalTx.type !== 'propose') throw new Error('TEST_ENTITY_PROPOSAL_TX_INVALID');
  const proposalId = generateProposalId(env, proposalTx.data.action, proposer.toLowerCase(), {
    ...state,
    timestamp: frameTimestamp,
  });
  const frameTxs = [signedEntityCommandTx(buildSignedEntityCommand(env, state, proposer, [proposalTx]))];
  let approvedPower = state.config.shares[proposer] ?? 0n;
  for (const validator of otherValidators) {
    if (approvedPower >= state.config.threshold) break;
    const voteTx: EntityTx = {
      type: 'vote',
      data: { proposalId, voter: validator, choice: 'yes' },
    };
    frameTxs.push(signedEntityCommandTx(buildSignedEntityCommand(env, state, validator, [voteTx])));
    approvedPower += state.config.shares[validator] ?? 0n;
  }
  if (approvedPower < state.config.threshold) {
    throw new Error(`TEST_ENTITY_PROPOSAL_QUORUM_UNAVAILABLE:${approvedPower}:${state.config.threshold}`);
  }
  return frameTxs;
};

const prepareJEventInput = (
  env: ReturnType<typeof createEmptyEnv>,
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
  const eventsHash = canonicalJurisdictionEventsHash(input.events);
  const jurisdictionRef = input.jurisdictionRef ?? getJEventJurisdictionRef(undefined);
  const disputeFinalizationEvidenceHash = input.disputeFinalizationEvidence?.length
    ? canonicalDisputeFinalizationEvidenceHash(input.disputeFinalizationEvidence)
    : undefined;
  return {
    jurisdictionRef,
    eventsHash,
    ...(disputeFinalizationEvidenceHash ? { disputeFinalizationEvidenceHash } : {}),
  };
};

const makeReplicaMissingPrevFrameHash = (): EntityReplica => ({
  entityId: `0x${'11'.repeat(32)}`,
  signerId: '1',
  entityEncPubKey: '',
  mempool: [],
  isProposer: true,
  state: {
    entityId: `0x${'11'.repeat(32)}`,
    height: 1,
    timestamp: 0,
    nonces: new Map(),
    proposals: new Map(),
    config: makeSingleSignerConfig(),
    reserves: new Map(),
    accounts: PersistentEntityAccountMap.empty(
      `0x${'11'.repeat(32)}`,
      computeEntityAccountValueHash,
    ),
    deferredAccountProposals: new Map(),
    lastFinalizedJHeight: 0,
    profile: {
      name: 'Audit Entity',
      isHub: false,
      avatar: '',
      bio: '',
      website: '',
    },
    paybook: { entries: new Map(), feesEarned: 0n },
    swapTradingPairs: [],
    crontabState: initCrontab(),
  },
});

const makeEntityState = (entityId: string): EntityState => ({
  entityId,
  entityEncryptionPublicKey: `0x${'44'.repeat(32)}`,
  height: 0,
  timestamp: 1_000,
  nonces: new Map(),
  proposals: new Map(),
  config: makeSingleSignerConfig(),
  reserves: new Map(),
  accounts: PersistentEntityAccountMap.empty(entityId, computeEntityAccountValueHash),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  profile: {
    name: 'Audit Entity',
    isHub: false,
    avatar: '',
    bio: '',
    website: '',
  },
  paybook: { entries: new Map(), feesEarned: 0n },
  swapTradingPairs: [],
  crontabState: initCrontab(),
});

const makeDisputeFinalizedFixture = (seed: string, finalProofbody: ProofBodyStruct) => {
  const entityId = `0x${'12'.repeat(32)}`;
  const counterpartyId = `0x${'34'.repeat(32)}`;
  const state = makeEntityState(entityId);
  const account = makeProposalAccount([], entityId, counterpartyId);
  account.state.watchSeed = finalProofbody.watchSeed;
  account.state.disputeConfig = {
    leftResponseSeconds: Number(finalProofbody.leftResponseSeconds),
    rightResponseSeconds: Number(finalProofbody.rightResponseSeconds),
  };
  if (finalProofbody.tokenIds.length === finalProofbody.offdeltas.length) {
    account.state.deltas = PersistentAccountStateMap.fromEntries(
      'deltas',
      finalProofbody.tokenIds.map((rawTokenId, index) => {
        const tokenId = Number(rawTokenId);
        return [tokenId, {
          ...createDefaultDelta(tokenId),
          offdelta: finalProofbody.offdeltas[index]!,
        }] as const;
      }),
    );
  }
  const finalProofbodyHash = hashProofBodyStruct(finalProofbody);
  account.activeDispute = {
    startedByLeft: true,
    initialProposerIsLeft: true,
    disputeTimeout: 1700000123,
        disputeStartTimestamp: 1700000000,
    initialProofbodyHash: finalProofbodyHash,
    initialNonce: 7,
    finalizeQueued: true,
  } as AccountState['activeDispute'];
  return {
    account,
    counterpartyId,
    env: (() => {
      const env = createEmptyEnv(seed);
      attachSigningReplica(env, entityId, '1');
      return env;
    })(),
    event: {
      type: 'DisputeFinalized',
      data: {
        sender: entityId,
        counterentity: counterpartyId,
        initialNonce: '7',
        initialProofbodyHash: finalProofbodyHash,
        finalProofbodyHash,
        finalizationEvidenceHash: ethers.ZeroHash,
        finalProofbody,
      },
    } satisfies JurisdictionEvent,
    finalProofbodyHash,
    state,
  };
};

const applyDisputeFinalizedFixture = async (
  fixture: ReturnType<typeof makeDisputeFinalizedFixture>,
  evidence: DisputeFinalizationEvidence[] = [],
) => {
  fixture.state.accounts = fixture.state.accounts.updated(fixture.counterpartyId, fixture.account);
  return applyJEventRange(
    fixture.state,
    {
      from: '1',
      observedAt: 22,
      blockNumber: 22,
      blockHash: `0x${'99'.repeat(32)}`,
      transactionHash: `0x${'88'.repeat(32)}`,
      event: fixture.event,
      jurisdictionRef: getJEventJurisdictionRef(fixture.state.config.jurisdiction),
      ...(evidence.length > 0
        ? {
            disputeFinalizationEvidence: evidence,
            disputeFinalizationEvidenceHash: canonicalDisputeFinalizationEvidenceHash(evidence),
          }
        : {}),
    },
    fixture.env,
  );
};

const sealAuditJSubmitAttempts = (env: RuntimeReplica, inputs: JInput[]): void => {
  for (const input of inputs) {
    for (const jTx of input.jTxs) {
      if (jTx.type !== 'batch' || !jTx.data.runtimeSubmitAttempt) continue;
      const signerId = String(jTx.data.signerId || '');
      const batchGeneration = 1;
      const attemptId = buildJSubmitAttemptId({
        jurisdictionName: input.jurisdictionName,
        entityId: jTx.entityId,
        signerId,
        entityNonce: Number(jTx.data.entityNonce),
        batchGeneration,
        batchHash: String(jTx.data.batchHash || ''),
        attemptNumber: jTx.data.runtimeSubmitAttempt.attemptNumber,
      });
      jTx.data.batchGeneration = batchGeneration;
      jTx.data.runtimeSubmitAttempt = {
        ...jTx.data.runtimeSubmitAttempt,
        attemptId,
        batchGeneration,
      };
      const existing = Array.from(env.state.eReplicas.values()).find(
        replica =>
          replica.entityId.toLowerCase() === jTx.entityId.toLowerCase() &&
          replica.signerId.toLowerCase() === signerId.toLowerCase(),
      );
      const state = existing?.state ?? makeEntityState(jTx.entityId);
      state.jBatchState = {
        batch: createEmptyBatch(),
        jurisdiction: null,
        lastBroadcast: jTx.timestamp,
        broadcastCount: batchGeneration,
        failedAttempts: 0,
        status: 'sent',
        sentBatch: {
          batch: structuredClone(jTx.data.batch),
          batchHash: String(jTx.data.batchHash || ''),
          encodedBatch: String(jTx.data.encodedBatch || '0x'),
          entityNonce: Number(jTx.data.entityNonce),
          firstSubmittedAt: jTx.data.runtimeSubmitAttempt.attemptedAt,
          lastSubmittedAt: jTx.data.runtimeSubmitAttempt.attemptedAt,
          submitAttempts: jTx.data.runtimeSubmitAttempt.attemptNumber,
        },
      };
      const replica =
        existing ??
        ({
          entityId: jTx.entityId,
          signerId,
          entityEncPubKey: '',
          mempool: [],
          isProposer: true,
          state,
        } as EntityReplica);
      replica.jSubmitState = {
        jurisdictionName: input.jurisdictionName,
        batchHash: String(jTx.data.batchHash || ''),
        entityNonce: Number(jTx.data.entityNonce),
        batchGeneration,
        submitAttempts: jTx.data.runtimeSubmitAttempt.attemptNumber,
        lastSubmittedAt: jTx.data.runtimeSubmitAttempt.attemptedAt,
      };
      env.state.eReplicas.set(`${jTx.entityId}:${signerId}`, replica);
    }
  }
  registerPendingCommittedJOutbox(env, inputs);
};

const submitAuditRuntimeJOutbox = async (
  env: RuntimeReplica,
  inputs: JInput[],
  deps: Parameters<typeof submitRuntimeJOutbox>[2],
): Promise<void> => {
  sealAuditJSubmitAttempts(env, inputs);
  await submitRuntimeJOutbox(env, inputs, deps);
};

describe('audit fail-fast regressions', () => {
  test('Entity flush does not re-carry LEFT winning proposal after simultaneous-frame collision', async () => {
    const seed = 'entity-flush-simultaneous-left-winner';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.state.timestamp = 10_000;

    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);

    const leftAccount = makeProposalAccount(
      [{ type: 'add_delta', data: { tokenId: 1 } }],
      left.entityId,
      right.entityId,
    );
    const rightAccount = makeProposalAccount(
      [{ type: 'add_delta', data: { tokenId: 2 } }],
      left.entityId,
      right.entityId,
    );
    rightAccount.proofHeader = {
      fromEntity: right.entityId,
      toEntity: left.entityId,
      nextProofNonce: 0,
    };

    const leftProposal = await proposeAccountFrame(createAccountConsensusContext(env), leftAccount, env.state.timestamp);
    const rightProposal = await proposeAccountFrame(createAccountConsensusContext(env), rightAccount, env.state.timestamp);
    if (!isProposedAccountFrame(leftProposal)) {
      throw new Error(`LEFT_SIMULTANEOUS_PROPOSAL_FAILED:${proposeAccountFrameMessage(leftProposal) ?? 'missing input'}`);
    }
    if (!isProposedAccountFrame(rightProposal)) {
      throw new Error(`RIGHT_SIMULTANEOUS_PROPOSAL_FAILED:${proposeAccountFrameMessage(rightProposal) ?? 'missing input'}`);
    }
    const leftInput = await attachAccountDraftHankosAsEntity(env, left.entityId, left.signerId, leftProposal);
    const rightInput = await attachAccountDraftHankosAsEntity(env, right.entityId, right.signerId, rightProposal);
    if (leftInput.kind !== 'ack_frame') throw new Error('LEFT_SIMULTANEOUS_ACK_FRAME_REQUIRED');
    // This collision begins after LEFT has already emitted its signed proposal.
    // Persist the same witnesses that Entity finalization would attach before
    // the peer's competing frame can arrive.
    leftAccount.pendingAccountInput = structuredClone(leftInput);
    leftAccount.currentFrameHanko = leftInput.proposal.frameHanko;
    leftAccount.currentDisputeProofHanko = leftInput.proposal.disputeHanko?.hanko;

    const leftState = makeEntityState(left.entityId);
    leftState.config = makeSingleSignerConfigFor(left.signerId);
    leftState.accounts = leftState.accounts.updated(right.entityId, leftAccount);
    const applied = await applyEntityFrameWithMaterializedTestInfraContext(
      env,
      leftState,
      [
        {
          type: 'accountInput',
          data: rightInput,
        },
      ],
      env.state.timestamp,
    );

    const accountOutputs = applied.outputs
      .flatMap(output => output.entityTxs ?? [])
      .filter((tx): tx is Extract<EntityTx, { type: 'accountInput' }> => tx.type === 'accountInput');
    expect(accountOutputs).toHaveLength(0);
    expect(applied.newState.accounts.get(right.entityId)?.pendingFrame?.stateHash).toBe(
      leftAccount.pendingFrame?.stateHash,
    );
  });

  test('failed proposal keeps queued txs, including late arrivals, instead of wiping the mempool', async () => {
    const seed = 'account-proposal-failure-retains-mempool';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.state.timestamp = 1_000;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const firstTx: AccountTx = { type: 'add_delta', data: { tokenId: 1 } };
    const lateTx: AccountTx = { type: 'add_delta', data: { tokenId: 2 } };
    const accountMachine = makeProposalAccount([firstTx], left.entityId, right.entityId);
    attachSigningReplica(env, accountMachine.proofHeader.fromEntity, left.signerId);
    const signingJurisdiction = Array.from(env.state.jReplicas.values()).find(
      replica =>
        replica.chainId === accountMachine.state.domain.chainId &&
        replica.contracts?.depository?.toLowerCase() === accountMachine.state.domain.depositoryAddress.toLowerCase(),
    );
    if (!signingJurisdiction?.contracts) throw new Error('TEST_SIGNING_JURISDICTION_MISSING');
    delete signingJurisdiction.contracts.deltaTransformer;

    queueMicrotask(() => {
      accountMachine.mempool.push(lateTx);
    });

    await expect(proposeAccountFrame(createAccountConsensusContext(env), accountMachine, env.state.timestamp)).rejects.toThrow(
      'DISPUTE_PROOF_BUILD_FAILED: JURISDICTION_DURABLE_STACK_DELTA_TRANSFORMER_MISSING',
    );
    expect(accountMachine.pendingFrame).toBeUndefined();
    expect(accountMachine.mempool).toHaveLength(2);
    expect(accountMachine.mempool).toEqual([firstTx, lateTx]);
  });

  test('DisputeFinalized retires an invalidated sealed batch and requeues its remaining operations', async () => {
    const entityId = `0x${'12'.repeat(32)}`;
    const counterpartyId = `0x${'34'.repeat(32)}`;
    const state = makeEntityState(entityId);
    const account = makeProposalAccount([], entityId, counterpartyId);
    const finalProofbody: ProofBodyStruct = {
      watchSeed: account.state.watchSeed,
      leftResponseSeconds: account.state.disputeConfig.leftResponseSeconds,
      rightResponseSeconds: account.state.disputeConfig.rightResponseSeconds,
      offdeltas: [50n],
      tokenIds: [1n],
      transformers: [],
    };
    const finalProofbodyHash = hashProofBodyStruct(finalProofbody);
    account.state.deltas = account.state.deltas.updated(1, {
      tokenId: 1,
      collateral: 100n,
      ondelta: 25n,
      offdelta: 50n,
      leftCreditLimit: 0n,
      rightCreditLimit: 0n,
      leftAllowance: 5n,
      rightAllowance: 7n,
      leftHold: 11n,
      rightHold: 13n,
    });
    account.activeDispute = {
      startedByLeft: true,
      initialProposerIsLeft: true,
      disputeTimeout: 1700000123,
        disputeStartTimestamp: 1700000000,
      initialProofbodyHash: finalProofbodyHash,
      initialNonce: 7,
      finalizeQueued: true,
    } as AccountState['activeDispute'];
    // Prime the incremental trie before the jurisdiction event mutates the
    // same Delta objects in place. Dispute finalization must invalidate it.
    computeAccountStateRoot(account.state);
    state.accounts = state.accounts.updated(counterpartyId, account);
    state.jBatchState = {
      batch: {
        ...createEmptyBatch(),
        // Fill the editable draft to the 50-op contract limit. The sealed
        // batch below still has two valid operations after finality scrubs its
        // stale finalize; recovery must preserve both batches separately.
        reserveToReserve: Array.from({ length: 16 }, (_, index) => ({
          receivingEntity: `0x${'55'.repeat(31)}${index.toString(16).padStart(2, '0')}`,
          tokenId: 1,
          amount: 1n,
        })),
        revealSecrets: Array.from({ length: 32 }, (_, index) => ({
          transformer: `0x${'66'.repeat(20)}`,
          secret: `0x${index.toString(16).padStart(64, '0')}`,
        })),
        hashLadderRegistrations: [{
          counterpartyEntity: counterpartyId,
          targetRole: true,
          fullHash: `0x${'01'.repeat(32)}`,
          partialRoot: `0x${'02'.repeat(32)}`,
          witness: {
            fillRatio: 1,
            fullSecret: `0x${'00'.repeat(32)}`,
            reveals: Array(4).fill(`0x${'00'.repeat(32)}`) as [string, string, string, string],
          },
        }],
        disputeFinalizations: [
          {
            counterentity: counterpartyId,
            initialNonce: 7,
            finalNonce: 7,
            proposerIsLeft: true,
            initialProofbodyHash: finalProofbodyHash,
            finalProofbody,
            starterArguments: '0x',
            otherArguments: '0x',
            sig: '0x',
            startedByLeft: true,
            cooperative: false,
          },
        ],
      },
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'sent',
      sentBatch: {
        batch: {
          ...createEmptyBatch(),
          reserveToReserve: [
            {
              receivingEntity: `0x${'56'.repeat(32)}`,
              tokenId: 1,
              amount: 25n,
            },
          ],
          hashLadderRegistrations: [{
            counterpartyEntity: counterpartyId,
            targetRole: true,
            fullHash: `0x${'01'.repeat(32)}`,
            partialRoot: `0x${'02'.repeat(32)}`,
            witness: {
              fillRatio: 1,
              fullSecret: `0x${'00'.repeat(32)}`,
              reveals: Array(4).fill(`0x${'00'.repeat(32)}`) as [string, string, string, string],
            },
          }],
          disputeFinalizations: [
            {
              counterentity: counterpartyId,
              initialNonce: 7,
              finalNonce: 7,
              proposerIsLeft: true,
              initialProofbodyHash: finalProofbodyHash,
              finalProofbody,
              starterArguments: '0x',
              otherArguments: '0x',
              sig: '0x',
              startedByLeft: true,
              cooperative: false,
            },
          ],
        },
        batchHash: `0x${'78'.repeat(32)}`,
        encodedBatch: '0x',
        entityNonce: 7,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
        submitAttempts: 1,
      },
      entityNonce: 6,
    } as EntityState['jBatchState'];

    const env = createEmptyEnv('dispute-finalize-scrub-seed');
    attachSigningReplica(env, entityId, '1');
    const disputeFinalizedEvent: JurisdictionEvent = {
      type: 'DisputeFinalized',
      data: {
        sender: counterpartyId,
        counterentity: entityId,
        initialNonce: 7,
        initialProofbodyHash: finalProofbodyHash,
        finalProofbodyHash,
        finalizationEvidenceHash: ethers.ZeroHash,
        finalProofbody,
      },
    };
    const disputeFinalizationEvidence: DisputeFinalizationEvidence[] = [
      {
        sender: counterpartyId,
        counterentity: entityId,
        initialNonce: '7',
        finalNonce: '7',
        initialProofbodyHash: finalProofbodyHash,
        finalProofbodyHash,
        proposerIsLeft: true,
        leftArguments: '0x',
        rightArguments: '0x',
        startedByLeft: true,
        starterInitialArguments: '0x',
        starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
        sig: '0x',
      },
    ];
    const signedDisputeFinalized = prepareJEventInput(env, entityId, '1', {
      blockNumber: 22,
      blockHash: `0x${'99'.repeat(32)}`,
      transactionHash: `0x${'88'.repeat(32)}`,
      events: [disputeFinalizedEvent],
      disputeFinalizationEvidence,
      jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
    });
    const sealedBatchBefore = encodeJBatch(state.jBatchState.sentBatch!.batch);
    state.jBatchState.sentBatch!.encodedBatch = sealedBatchBefore;
    const clonedSealedBatch = createEntityFrameCandidateState(state).jBatchState!.sentBatch!.batch;
    expect(safeStringify(clonedSealedBatch)).toBe(safeStringify(state.jBatchState.sentBatch!.batch));
    const finalized = await applyJEventRange(
      state,
      {
        from: '1',
        observedAt: 2000,
        blockNumber: 22,
        blockHash: `0x${'99'.repeat(32)}`,
        transactionHash: `0x${'88'.repeat(32)}`,
        ...signedDisputeFinalized,
        event: disputeFinalizedEvent,
        disputeFinalizationEvidence,
      },
      env,
    );

    expect(finalized.newState.accounts.get(counterpartyId)?.activeDispute).toBeUndefined();
    expect(finalized.newState.jBatchState?.batch.disputeFinalizations.length).toBe(0);
    // Registry publication is independent of dispute lifetime. Recovery keeps
    // one exact reveal while deduping the copy present in both draft and sent.
    expect(finalized.newState.jBatchState?.batch.hashLadderRegistrations).toHaveLength(1);
    expect(finalized.newState.jBatchState?.batch.reserveToReserve).toHaveLength(16);
    expect(finalized.newState.jBatchState?.recoveryBatches?.[0]?.reserveToReserve).toEqual([
      {
        receivingEntity: `0x${'56'.repeat(32)}`,
        tokenId: 1,
        amount: 25n,
      },
    ]);
    expect(finalized.newState.jBatchState?.recoveryBatches?.[0]?.hashLadderRegistrations).toHaveLength(1);
    expect(finalized.newState.jBatchState?.sentBatch).toBeUndefined();
    expect(finalized.newState.jBatchState?.status).toBe('accumulating');
    expect(finalized.outputs.filter(output =>
      output.entityId.toLowerCase() === entityId.toLowerCase()
      && output.entityTxs?.some(tx => tx.type === 'j_broadcast'),
    )).toHaveLength(1);
    expect(state.jBatchState?.sentBatch?.encodedBatch).toBe(sealedBatchBefore);
    expect(encodeJBatch(state.jBatchState!.sentBatch!.batch)).toBe(sealedBatchBefore);
    const finalizedDelta = finalized.newState.accounts.get(counterpartyId)?.state.deltas.get(1);
    expect(finalizedDelta?.collateral).toBe(0n);
    expect(finalizedDelta?.ondelta).toBe(0n);
    expect(finalizedDelta?.offdelta).toBe(0n);
    expect(finalizedDelta?.leftAllowance).toBe(0n);
    expect(finalizedDelta?.rightAllowance).toBe(0n);
    expect(finalized.newState.accounts.get(counterpartyId)?.state.jNonce).toBe(8);
    const finalizedAccount = finalized.newState.accounts.get(counterpartyId);
    if (!finalizedAccount) throw new Error('FINALIZED_ACCOUNT_MISSING');
    expect(computeAccountStateRoot(finalizedAccount.state)).toBe(computeAccountStateRootCold(finalizedAccount.state));
  });

  test('DisputeFinalized rejects missing signed final body before mutating account state', async () => {
    const finalProofbody: ProofBodyStruct = {
      watchSeed: `0x${'f1'.repeat(32)}`,
      leftResponseSeconds: 10,
      rightResponseSeconds: 10,
      offdeltas: [50n],
      tokenIds: [1n],
      transformers: [],
    };
    const fixture = makeDisputeFinalizedFixture('dispute-finalized-body-missing', finalProofbody);
    delete (fixture.event.data as { finalProofbody?: ProofBodyStruct }).finalProofbody;
    fixture.account.state.deltas = fixture.account.state.deltas.updated(1, {
      ...createDefaultDelta(1),
      collateral: 100n,
      offdelta: 50n,
    });
    const stateBefore = safeStringify(fixture.state);

    await expect(applyDisputeFinalizedFixture(fixture)).rejects.toThrow('J_EVENT_PROOFBODY');
    expect(safeStringify(fixture.state)).toBe(stateBefore);
  });

  test('DisputeFinalized rejects an oversized nonce before mutating account state', async () => {
    const finalProofbody: ProofBodyStruct = {
      watchSeed: `0x${'f1'.repeat(32)}`,
      leftResponseSeconds: 10,
      rightResponseSeconds: 10,
      offdeltas: [50n],
      tokenIds: [1n],
      transformers: [],
    };
    const fixture = makeDisputeFinalizedFixture(
      'dispute-finalized-nonce-boundary',
      finalProofbody,
    );
    fixture.event.data.initialNonce = '9007199254740993';
    const stateBefore = safeStringify(fixture.state);

    await expect(applyDisputeFinalizedFixture(fixture)).rejects.toThrow(
      'J_EVENT_DISPUTE_INITIAL_NONCE_INVALID:9007199254740993',
    );
    expect(safeStringify(fixture.state)).toBe(stateBefore);
  });

  test('selected equal-nonce LEFT finality adopts N instead of inventing N+1', async () => {
    const finalProofbody: ProofBodyStruct = {
      watchSeed: `0x${'f1'.repeat(32)}`,
      leftResponseSeconds: 10,
      rightResponseSeconds: 10,
      offdeltas: [50n],
      tokenIds: [1n],
      transformers: [],
    };
    const fixture = makeDisputeFinalizedFixture('selected-equal-nonce-left-finality', finalProofbody);
    fixture.account.activeDispute!.initialProposerIsLeft = false;
    fixture.account.activeDispute!.selectedCounterNonce = 7;
    fixture.account.activeDispute!.selectedCounterProposerIsLeft = true;
    fixture.account.activeDispute!.selectedCounterProofbodyHash = fixture.finalProofbodyHash;
    const evidence: DisputeFinalizationEvidence[] = [{
      sender: fixture.state.entityId,
      counterentity: fixture.counterpartyId,
      initialNonce: '7',
      finalNonce: '7',
      proposerIsLeft: true,
      initialProofbodyHash: fixture.finalProofbodyHash,
      finalProofbodyHash: fixture.finalProofbodyHash,
      leftArguments: '0x',
      rightArguments: '0x',
      startedByLeft: true,
      sig: '0x',
    }];

    const finalized = await applyDisputeFinalizedFixture(fixture, evidence);
    expect(finalized.newState.accounts.get(fixture.counterpartyId)!.state.jNonce).toBe(7);
  });

  test('DisputeFinalized rejects malformed token/offdelta shape instead of clearing every delta', async () => {
    const malformedProofbody: ProofBodyStruct = {
      watchSeed: `0x${'f1'.repeat(32)}`,
      leftResponseSeconds: 10,
      rightResponseSeconds: 10,
      offdeltas: [],
      tokenIds: [1n],
      transformers: [],
    };
    const fixture = makeDisputeFinalizedFixture('dispute-finalized-body-shape', malformedProofbody);
    fixture.account.state.deltas = fixture.account.state.deltas.updated(1, {
      ...createDefaultDelta(1),
      collateral: 100n,
      offdelta: 50n,
    });

    await expect(applyDisputeFinalizedFixture(fixture)).rejects.toThrow('J_EVENT_DISPUTE_FINAL_PROOFBODY_INVALID');
  });

  test('DisputeFinalized clears every frozen proof token and retires offchain fields', async () => {
    const finalProofbody: ProofBodyStruct = {
      watchSeed: `0x${'f1'.repeat(32)}`,
      leftResponseSeconds: 10,
      rightResponseSeconds: 10,
      offdeltas: [50n, 75n],
      tokenIds: [1n, 2n],
      transformers: [],
    };
    const fixture = makeDisputeFinalizedFixture('dispute-finalized-exact-token-cleanup', finalProofbody);
    fixture.account.state.deltas = fixture.account.state.deltas.updated(1, {
      ...createDefaultDelta(1),
      collateral: 100n,
      offdelta: 50n,
    });
    fixture.account.state.deltas = fixture.account.state.deltas.updated(2, {
      ...createDefaultDelta(2),
      collateral: 200n,
      ondelta: -9n,
      offdelta: 75n,
      leftHold: 3n,
      rightHold: 5n,
      leftAllowance: 7n,
      rightAllowance: 11n,
    });

    const finalized = await applyDisputeFinalizedFixture(fixture);
    const account = finalized.newState.accounts.get(fixture.counterpartyId)!;
    expect(account.state.deltas.get(1)).toMatchObject({ collateral: 0n, ondelta: 0n, offdelta: 0n });
    expect(account.state.deltas.get(2)).toMatchObject({
      collateral: 0n,
      ondelta: 0n,
      offdelta: 0n,
      leftHold: 0n,
      rightHold: 0n,
      leftAllowance: 0n,
      rightAllowance: 0n,
    });
    expect(Object.hasOwn(account, 'disputeProofBodiesByHash')).toBeFalse();
    expect(Object.hasOwn(account, 'disputeProofNoncesByHash')).toBeFalse();
    expect(Object.hasOwn(account, 'disputeArgumentSnapshotsByHash')).toBeFalse();
    const persisted = projectAccountDoc(account);
    expect(Object.hasOwn(persisted, 'disputeProofBodiesByHash')).toBeFalse();
    expect(Object.hasOwn(persisted, 'disputeProofNoncesByHash')).toBeFalse();
    expect(Object.hasOwn(persisted, 'disputeArgumentSnapshotsByHash')).toBeFalse();
  });

  test('DisputeFinalized invalidates a competing settlement workspace and its deferred retry', async () => {
    const finalProofbody: ProofBodyStruct = {
      watchSeed: `0x${'f2'.repeat(32)}`,
      leftResponseSeconds: 10,
      rightResponseSeconds: 10,
      offdeltas: [50n],
      tokenIds: [1n],
      transformers: [],
    };
    const fixture = makeDisputeFinalizedFixture('dispute-finalized-settlement-race', finalProofbody);
    fixture.account.state.deltas = fixture.account.state.deltas.updated(1, {
      ...createDefaultDelta(1),
      collateral: 100n,
      offdelta: 50n,
      leftCreditLimit: 100n,
      rightCreditLimit: 100n,
    });
    const upsertTx: AccountTx = {
      type: 'settle_transition',
      data: {
        kind: 'upsert',
        revision: 1,
        ops: [{ type: 'r2r', tokenId: 1, amount: 4n }],
        executorIsLeft: true,
      },
    };
    expect((await applyAccountTx(fixture.account, upsertTx, true, 1_000)).ok).toBe(true);
    fixture.account.state.settlementWorkspace!.leftHanko = '0x1234';
    fixture.account.state.settlementWorkspace!.nonceAtSign = 8;
    fixture.account.state.settlementWorkspace!.settlementHash = `0x${'81'.repeat(32)}`;
    fixture.account.mempool.push(structuredClone(upsertTx));
    fixture.state.deferredAccountProposals = new Map([
      [fixture.counterpartyId, fixture.account.state.settlementWorkspace!.workspaceHash],
    ]);
    expect(fixture.account.state.deltas.get(1)?.leftHold).toBe(4n);

    const finalized = await applyDisputeFinalizedFixture(fixture);
    const account = finalized.newState.accounts.get(fixture.counterpartyId)!;
    expect(account.state.settlementWorkspace).toBeUndefined();
    expect(account.state.deltas.get(1)?.leftHold).toBe(0n);
    expect(account.mempool.some(tx => tx.type === 'settle_transition')).toBe(false);
    expect(finalized.newState.deferredAccountProposals?.has(fixture.counterpartyId)).toBe(false);
  });

  test('disputeFinalize waits for on-chain DisputeStarted before drafting a finalization', async () => {
    const starterId = `0x${'41'.repeat(32)}`;
    const finalizerId = `0x${'42'.repeat(32)}`;
    const state = makeEntityState(finalizerId);
    const account = makeProposalAccount([], starterId, finalizerId);
    const initialProof = buildAccountProofBody(account, '');
    account.activeDispute = {
      startedByLeft: true,
      initialProofbodyHash: initialProof.proofBodyHash,
      initialNonce: 1,
      disputeTimeout: 1700000100,
        disputeStartTimestamp: 1700000000,
      jNonce: 0,
      starterInitialArguments: '0x',
      starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
      observedOnChain: false,
      finalizeQueued: false,
    };
    state.accounts = state.accounts.updated(starterId, account);

    const env = createEmptyEnv('placeholder-dispute-finalize-runtime');
    env.quietRuntimeLogs = true;

    const { newState } = await handleDisputeFinalize(
      state,
      {
        type: 'disputeFinalize',
        data: { counterpartyEntityId: starterId },
      },
      env,
    );

    expect(newState.jBatchState?.batch.disputeFinalizations ?? []).toEqual([]);
    expect(newState.accounts.get(starterId)?.activeDispute?.finalizeQueued).toBe(false);
    expect(readEntityFrameEventMessages(newState).join('\n'))
      .toContain('blocked until DisputeStarted is observed on-chain');
  });

  test('disputeFinalize uses signed counter-proof and counter starter arguments when a newer proof is available', async () => {
    const starterId = `0x${'21'.repeat(32)}`;
    const finalizerId = `0x${'22'.repeat(32)}`;
    const depositoryAddress = hex20('1');
    const state = makeEntityState(finalizerId);
    state.config = {
      ...state.config,
      jurisdiction: {
        name: 'Testnet',
        depositoryAddress,
        entityProviderAddress: hex20('2'),
        chainId: 31337,
      },
    } as EntityState['config'];
    const account = makeProposalAccount([], starterId, finalizerId);
    account.state.domain = { chainId: 31337, depositoryAddress };
    account.proofHeader = { fromEntity: starterId, toEntity: finalizerId, nextProofNonce: 2 };
    account.state.deltas = account.state.deltas.updated(1, { ...createDefaultDelta(1), offdelta: 50n });

    const initialProof = buildAccountProofBody(account, '');
    account.state.deltas = account.state.deltas.updated(1, { ...createDefaultDelta(1), offdelta: 75n });
    const counterProof = buildAccountProofBody(account, '');
    account.counterpartyDisputeProofBodyHash = counterProof.proofBodyHash;
    account.counterpartyDisputeProofNonce = 2;
    account.counterpartyDisputeProofProposerIsLeft = true;
    account.counterpartyDisputeProofHanko = '0x1234';
    account.counterpartyDisputeHash = createDisputeProofHashWithNonce(
      account.state,
      counterProof.proofBodyHash,
      { chainId: 31337, depositoryAddress },
      2,
      true,
    );
    account.activeDispute = {
      startedByLeft: true,
      initialProposerIsLeft: true,
      initialProofbodyHash: initialProof.proofBodyHash,
      initialNonce: 1,
      disputeTimeout: 1700000100,
        disputeStartTimestamp: 1700000000,
      jNonce: 0,
      starterInitialArguments: '0x1111',
      starterCounterArguments: '0x2222',
      starterCounterProofCommitment: ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint256', 'bool', 'bytes32'],
          [2, true, counterProof.proofBodyHash],
        ),
      ),
      observedOnChain: true,
      finalizeQueued: false,
    };
    state.accounts = state.accounts.updated(starterId, account);

    const env = createEmptyEnv('counter-finalize-runtime');
    env.quietRuntimeLogs = true;
    env.lastJBlock = 1;
    env.state.jReplicas.set('Testnet', {
      name: 'Testnet',
      blockNumber: 1n,
      stateRoot: new Uint8Array(32),
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      watcherConfirmationDepth: 0,
      position: { x: 0, y: 0, z: 0 },
      depositoryAddress,
      entityProviderAddress: hex20('2'),
      contracts: {
        account: hex20('3'),
        depository: depositoryAddress,
        entityProvider: hex20('2'),
        deltaTransformer: hex20('4'),
      },
      rpcs: ['http://localhost:8545'],
      chainId: 31337,
    });

    const { newState } = await handleDisputeFinalize(
      state,
      {
        type: 'disputeFinalize',
        data: { counterpartyEntityId: starterId },
      },
      env,
    );

    const finalization = newState.jBatchState?.batch.disputeFinalizations[0];
    expect(finalization).toBeDefined();
    expect(finalization?.initialNonce).toBe(1);
    expect(finalization?.finalNonce).toBe(2);
    expect(finalization?.sig).toBe('0x1234');
    expect(finalization?.initialProofbodyHash).toBe(initialProof.proofBodyHash);
    expect(finalization?.finalProofbody.offdeltas).toEqual([75n]);
    expect(finalization?.finalProofbody.tokenIds).toEqual([1n]);
    expect(finalization?.starterArguments).toBe('0x2222');
    expect(finalization?.otherArguments).toBe('0x');
    expect(newState.accounts.get(starterId)?.activeDispute?.finalizeQueued).toBe(true);
  });

  test('auto-approved settlement nonce outranks stale high-nonce dispute proofs', async () => {
    const seed = 'auto-settlement-nonce-bumps-proof';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    const user = registerLazySigner(seed, '1');
    const hub = registerLazySigner(seed, '2');
    attachSigningReplica(env, user.entityId, user.signerId);
    attachSigningReplica(env, hub.entityId, hub.signerId);

    const depositoryAddress = hex20('1');
    const userState = makeEntityState(user.entityId);
    userState.config = {
      ...makeSingleSignerConfigFor(user.signerId),
      jurisdiction: {
        name: 'Testnet',
        depositoryAddress,
        entityProviderAddress: hex20('2'),
        chainId: 31337,
      },
    } as EntityState['config'];

    const account = makeProposalAccount([], user.entityId, hub.entityId);
    account.state.jNonce = 1;
    account.proofHeader = { fromEntity: user.entityId, toEntity: hub.entityId, nextProofNonce: 50 };
    account.state.deltas = account.state.deltas.updated(1, { ...createDefaultDelta(1), collateral: 10n });

    const transition: AccountTx = {
      type: 'settle_transition',
      data: {
        kind: 'upsert',
        revision: 1,
        ops: [{ type: 'c2r', tokenId: 1, amount: 1n }],
        executorIsLeft: true,
      },
    };
    const applied = await applyAccountTx(account, transition, false, 1_000);
    expect(applied.ok).toBe(true);
    const candidateState = createEntityFrameCandidateState(userState);
    const result = await processCommittedSettlementTransitionFollowup(
      account,
      transition,
      {
        ...account.currentFrame,
        height: 1,
        timestamp: 1_000,
        accountTxs: [transition],
      },
      false,
      hub.entityId,
      candidateState,
      env,
    );

    expect(result.outputs).toEqual([]);
    expect(result.accountTxs).toEqual([]);
    expect(candidateState.deferredAccountProposals?.get(hub.entityId)).toBe(account.state.settlementWorkspace?.workspaceHash);
    expect(buildSettlementHankoDraft(account, candidateState, hub.entityId, env).tx).toMatchObject({
      type: 'settle_transition',
      data: {
        kind: 'hanko',
        settlementNonce: 50,
        postProof: { nonce: 51 },
      },
    });
    expect(account.state.settlementWorkspace?.nonceAtSign).toBeUndefined();
    expect(account.state.settlementWorkspace?.postSettlementDisputeProof).toBeUndefined();
  });

  test('settlement finalization activates post-settlement dispute hash atomically', () => {
    const leftId = `0x${'31'.repeat(32)}`;
    const rightId = `0x${'32'.repeat(32)}`;
    const depositoryAddress = hex20('1');
    const account = makeProposalAccount([], leftId, rightId);
    account.proofHeader = { fromEntity: leftId, toEntity: rightId, nextProofNonce: 2 };
    account.state.deltas = account.state.deltas.updated(1, { ...createDefaultDelta(1), offdelta: 50n });

    const postProof = buildAccountProofBody(account, '');
    const postDisputeHash = createDisputeProofHashWithNonce(
      account.state,
      postProof.proofBodyHash,
      { chainId: 31337, depositoryAddress },
      2,
      true,
    );
    account.counterpartyDisputeHash = `0x${'aa'.repeat(32)}`;
    account.state.settlementWorkspace = {
      workspaceHash: '',
      ops: [],
      lastModifiedByLeft: true,
      status: 'submitted',
      revision: 1,
      createdAt: 1,
      lastUpdatedAt: 2,
      executorIsLeft: true,
      nonceAtSign: 1,
      leftHanko: '0x11',
      rightHanko: '0x22',
      postSettlementDisputeProof: {
        leftHanko: '0x33',
        rightHanko: '0x44',
        disputeHash: postDisputeHash,
        proofBodyHash: postProof.proofBodyHash,
        nonce: 2,
      },
    };
    account.state.settlementWorkspace.workspaceHash = createSettlementWorkspaceHash(account.state, account.state.settlementWorkspace);

    const settledEvent: JurisdictionEvent = {
      type: 'AccountSettled',
      data: {
        leftEntity: leftId,
        rightEntity: rightId,
        tokenId: 1,
        leftReserve: '0',
        rightReserve: '0',
        collateral: '125',
        ondelta: '0',
        nonce: 1,
      },
    };
    applyFinalizedAccountJEvents(account, rightId, [settledEvent], '');
    account.state.lastFinalizedJHeight = 7;

    expect(account.state.settlementWorkspace).toBeUndefined();
    expect(account.currentDisputeHash).toBe(postDisputeHash);
    expect(account.counterpartyDisputeHash).toBe(postDisputeHash);
    expect(account.currentDisputeProofBodyHash).toBe(postProof.proofBodyHash);
    expect(account.counterpartyDisputeProofBodyHash).toBe(postProof.proofBodyHash);
    expect(account.currentDisputeProofNonce).toBe(2);
    expect(account.state.jNonce).toBe(1);
  });

  test('disputeStart rejects unsupported counter argument override instead of silently ignoring it', async () => {
    const entityId = `0x${'31'.repeat(32)}`;
    const counterpartyId = `0x${'32'.repeat(32)}`;
    const env = createEmptyEnv('dispute-start-counter-override');
    const state = makeEntityState(entityId);

    await expect(
      handleDisputeStart(
        state,
        {
          type: 'disputeStart',
          data: {
            counterpartyEntityId: counterpartyId,
            starterCounterArguments: '0x1234',
            starterCounterProofCommitment: ethers.ZeroHash,
          },
        },
        env,
      ),
    ).rejects.toThrow('DISPUTE_INCREMENTED_ARGUMENT_OVERRIDE_UNSUPPORTED');
  });

  test('j_rebroadcast resubmits the exact sent batch without mutating ops', async () => {
    const entityId = `0x${'ab'.repeat(32)}`;
    const counterpartyId = `0x${'cd'.repeat(32)}`;
    const state = makeEntityState(entityId);
    state.config = {
      ...state.config,
      jurisdiction: {
        name: 'Testnet',
        depositoryAddress: hex20('1'),
        entityProviderAddress: hex20('2'),
        chainId: 31337,
      },
    } as EntityState['config'];
    state.jBatchState = {
      batch: createEmptyBatch(),
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'sent',
      sentBatch: {
        batch: {
          ...createEmptyBatch(),
          reserveToReserve: [
            {
              receivingEntity: `0x${'ef'.repeat(32)}`,
              tokenId: 1,
              amount: 10n,
            },
          ],
          disputeFinalizations: [
            {
              counterentity: counterpartyId,
              initialNonce: 3,
              finalNonce: 3,
              initialProofbodyHash: `0x${'11'.repeat(32)}`,
              finalProofbody: makeEmptyProofBody(),
              starterArguments: '0x',
              otherArguments: '0x',
              sig: '0x',
              startedByLeft: true,
              cooperative: false,
            },
          ],
        },
        batchHash: `0x${'22'.repeat(32)}`,
        encodedBatch: '0x1234',
        entityNonce: 9,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
        submitAttempts: 1,
      },
      entityNonce: 8,
    } as EntityState['jBatchState'];

    const env = createEmptyEnv('j-rebroadcast-scrub-seed');
    env.activeJurisdiction = 'Testnet';
    env.state.jReplicas.set('Testnet', {
      name: 'Testnet',
      blockNumber: 0n,
      stateRoot: new Uint8Array(32),
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      watcherConfirmationDepth: 0,
      position: { x: 0, y: 0, z: 0 },
      depositoryAddress: hex20('1'),
      entityProviderAddress: hex20('2'),
      contracts: {
        account: hex20('3'),
        depository: hex20('1'),
        entityProvider: hex20('2'),
        deltaTransformer: hex20('4'),
      },
      rpcs: ['http://localhost:8545'],
      chainId: 31337,
    });

    const result = await handleJRebroadcast(state, { type: 'j_rebroadcast', data: {} }, env);

    expect(result.jOutputs.length).toBe(1);
    const rebroadcast = result.jOutputs[0]?.jTxs[0];
    expect(rebroadcast?.type).toBe('batch');
    if (rebroadcast?.type === 'batch') {
      expect(rebroadcast.data.batch.disputeFinalizations.length).toBe(1);
      expect(rebroadcast.data.batch.reserveToReserve.length).toBe(1);
    }
    expect(result.newState.jBatchState?.sentBatch?.batch.disputeFinalizations.length).toBe(1);
  });

  test('j_rebroadcast refuses a terminally failed sent batch instead of retrying the same bad tx', async () => {
    const entityId = `0x${'ae'.repeat(32)}`;
    const state = makeEntityState(entityId);
    state.jBatchState = {
      batch: createEmptyBatch(),
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 1,
      failedAttempts: 0,
      status: 'sent',
      sentBatch: {
        batch: {
          ...createEmptyBatch(),
          reserveToReserve: [
            {
              receivingEntity: `0x${'ef'.repeat(32)}`,
              tokenId: 1,
              amount: 10n,
            },
          ],
        },
        batchHash: `0x${'22'.repeat(32)}`,
        encodedBatch: '0x1234',
        entityNonce: 9,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
        submitAttempts: 1,
      },
      entityNonce: 8,
    } as EntityState['jBatchState'];
    const signerId = state.config.validators[0]!;
    const failure = {
      message: 'J_SUBMIT_FATAL: staticCall revert: E3()',
      failedAt: 1001,
      failure: {
        category: 'Contradiction' as const,
        code: 'J_SUBMIT_FATAL',
        message: 'J_SUBMIT_FATAL: staticCall revert: E3()',
        retryable: false,
        fatal: true,
      },
    };
    const replica: EntityReplica = {
      entityId,
      signerId,
      entityEncPubKey: '',
      state,
      mempool: [],
      isProposer: true,
      jSubmitState: {
        jurisdictionName: 'Testnet',
        batchHash: state.jBatchState.sentBatch!.batchHash,
        entityNonce: state.jBatchState.sentBatch!.entityNonce,
        batchGeneration: state.jBatchState.broadcastCount,
        submitAttempts: 1,
        lastSubmittedAt: 1000,
        lastFailure: failure,
        terminalFailure: failure,
        lastResultAttemptId: `0x${'33'.repeat(32)}`,
        lastResultAt: 1001,
        lastResultOutcome: 'terminalFailure',
        lastResultFingerprint: 'terminal-result-fingerprint',
      },
    };

    await expect(
      applyEntityInput(createEmptyEnv('j-rebroadcast-terminal-failure'), replica, {
        entityId,
        signerId,
        entityTxs: [{ type: 'j_rebroadcast', data: {} }],
      }),
    ).rejects.toThrow(/Cannot rebroadcast terminal J-submit/);
  });

  test('htlc_lock refuses to add more than the configured per-account cap', async () => {
    const accountMachine = {
      state: {
        deltas: new Map(),
        locks: new Map(Array.from({ length: LIMITS.MAX_ACCOUNT_HTLC_LOCKS }, (_, index) => [String(index), {}])),
      },
      currentHeight: 0,
    };

    const result = await handleHtlcLock(
      accountMachine as Parameters<typeof handleHtlcLock>[0],
      {
        type: 'htlc_lock',
        data: {
          lockId: `0x${'11'.repeat(32)}`,
          hashlock: `0x${'11'.repeat(32)}`,
          timelock: 1_000_000n,
          revealBeforeHeight: 100,
          amount: 1n,
          tokenId: 1,
        },
      },
      true,
      {
        committedTimestamp: 0,
        enforcementTimestamp: 0,
        enforcementJHeight: 1,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.rejection.message).toContain(`max ${LIMITS.MAX_ACCOUNT_HTLC_LOCKS}`);
    expect(accountMachine.state.locks.size).toBe(LIMITS.MAX_ACCOUNT_HTLC_LOCKS);
  });

  test('cross-j committed cross_pull_close followup rejects malformed binary instead of skipping it', () => {
    const env = createEmptyEnv('cross-pull-close-invalid-binary');
    const sourceUser = `0x${'10'.repeat(32)}`;
    const sourceHub = `0x${'20'.repeat(32)}`;
    const targetHub = `0x${'30'.repeat(32)}`;
    const targetUser = `0x${'40'.repeat(32)}`;
    const sourceState = makeEntityState(sourceHub);
    sourceState.crossJurisdictionSwaps = new Map([
      [
        'cross-invalid-binary',
        {
          orderId: 'cross-invalid-binary',
          makerEntityId: sourceUser,
          hubEntityId: sourceHub,
          source: {
            jurisdiction: 'eth',
            entityId: sourceUser,
            counterpartyEntityId: sourceHub,
            tokenId: 1,
            amount: 1_000n,
          },
          target: {
            jurisdiction: 'tron',
            entityId: targetHub,
            counterpartyEntityId: targetUser,
            tokenId: 1,
            amount: 1_000n,
          },
          sourcePull: {
            pullId: 'source-pull',
            tokenId: 1,
            amount: 1_000n,
            signedAmount: 1_000n,
            fullHash: `0x${'aa'.repeat(32)}`,
            partialRoot: `0x${'bb'.repeat(32)}`,
          },
          targetPull: {
            pullId: 'target-pull',
            tokenId: 1,
            amount: 1_000n,
            signedAmount: 1_000n,
            fullHash: `0x${'cc'.repeat(32)}`,
            partialRoot: `0x${'dd'.repeat(32)}`,
          },
          status: 'partially_filled',
          cumulativeFillRatio: 1,
          fillSeq: 1,
          createdAt: 1,
          updatedAt: 1,
          expiresAt: 60_000,
        } satisfies CrossJurisdictionSwapRoute,
      ],
    ]);

    expect(() =>
      applyCommittedCrossJurisdictionAccountTxFollowup(
        env,
        sourceState,
        sourceUser,
        {
          type: 'cross_pull_close',
          data: {
            pullId: 'source-pull',
            binary: '0x1234',
            proof: {
              orderId: 'cross-invalid-binary', routeHash: `0x${'ee'.repeat(32)}`,
              sourcePullId: 'source-pull', targetPullId: 'target-pull', fillRatio: 1,
              cumulativeSourceAmount: 1n, cumulativeTargetAmount: 1n,
              binaryHash: `0x${'ff'.repeat(32)}`, closeMode: 'partial_cancel_remainder',
            },
          },
        },
        [],
      ),
    ).toThrow();
  });

  test('cross-j source fill ack routes book removal to canonical sibling owner', async () => {
    const env = createEmptyEnv('cross-book-owner-removal');
    const sourceSigner = deriveSignerAddressSync('cross-book-owner-removal', 'source');
    const targetSigner = deriveSignerAddressSync('cross-book-owner-removal', 'target');
    const sourceUser = `0x${'10'.repeat(32)}`;
    const sourceHub = `0x${'20'.repeat(32)}`;
    const targetHub = `0x${'30'.repeat(32)}`;
    const orderId = 'cross-owner-full-fill';
    const pairId = 'cross:stack:1:0xdep:1/stack:2:0xdep:1';
    const namespacedOrderId = `${sourceUser}:${orderId}`;

    const sourceState = makeEntityState(sourceHub);
    sourceState.config = makeSingleSignerConfigFor(sourceSigner);
    const route: CrossJurisdictionSwapRoute = {
      orderId,
      bookOwnerEntityId: targetHub,
      venueId: pairId,
      makerEntityId: sourceUser,
      hubEntityId: sourceHub,
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      targetHubSignerId: targetSigner,
      bookHubSignerId: targetSigner,
      source: {
        jurisdiction: 'stack:2:0xdep',
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: 1_000n,
      },
      target: {
        jurisdiction: 'stack:1:0xdep',
        entityId: targetHub,
        counterpartyEntityId: `0x${'40'.repeat(32)}`,
        tokenId: 1,
        amount: 1_000n,
      },
      status: 'partially_filled',
      fillSeq: 1,
      fillNumerator: 1n,
      fillDenominator: 1_000n,
      cumulativeFillRatio: exactFillRatioToUint16({ numerator: 1n, denominator: 1_000n }),
      filledSourceAmount: 1n,
      filledTargetAmount: 1n,
      createdAt: 1,
      updatedAt: 1,
    };
    sourceState.crossJurisdictionSwaps = new Map([[orderId, route]]);

    let book = createBook({ bucketWidthTicks: 10_000n, maxOrders: 10_000, stpPolicy: 1 });
    book = applyCommand(book, {
      kind: 0,
      ownerId: sourceUser,
      orderId: namespacedOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 10_000n,
      qtyLots: 1n,
    }).state;
    const targetState = makeEntityState(targetHub);
    targetState.config = makeSingleSignerConfigFor(targetSigner);
    targetState.orderbookExt = {
      books: new Map([[pairId, book]]),
      orderPairs: new Map([[namespacedOrderId, [pairId]]]),
      pairDimensions: new Map([[
        pairId,
        getSwapPairDimensions(1, getStaticSwapTokenDimensions(route.source.tokenId, route.target.tokenId)),
      ]]),
      referrals: new Map(),
      hubProfile: {
        entityId: targetHub,
        name: 'Target hub',
        spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
        referenceTokenId: 1,
        minTradeSize: 0n,
        supportedPairs: [pairId],
      },
    } satisfies OrderbookExtState;
    env.state.eReplicas.set(`${sourceHub}:${sourceSigner}`, {
      entityId: sourceHub,
      signerId: sourceSigner,
      entityEncPubKey: '',
      mempool: [],
      isProposer: true,
      state: sourceState,
    } satisfies EntityReplica);
    env.state.eReplicas.set(`${targetHub}:${targetSigner}`, {
      entityId: targetHub,
      signerId: targetSigner,
      entityEncPubKey: '',
      mempool: [],
      isProposer: true,
      state: targetState,
    } satisfies EntityReplica);
    const outputs: EntityInput[] = [];
    const ackTx: Extract<AccountTx, { type: 'cross_swap_fill_ack' }> = {
      type: 'cross_swap_fill_ack',
      data: {
        offerId: orderId,
        fillSeq: 1,
        incrementalSourceAmount: 0n,
        incrementalTargetAmount: 0n,
        cumulativeSourceAmount: 1n,
        cumulativeTargetAmount: 1n,
        cumulativeFillRatio: exactFillRatioToUint16({ numerator: 1n, denominator: 1_000n }),
        fillNumerator: 1n,
        fillDenominator: 1_000n,
        cancelRemainder: true,
      },
    };
    const sourceCandidate = createEntityFrameCandidateState(sourceState);
    const applied = applyCommittedCrossJurisdictionAccountTxFollowup(env, sourceCandidate, sourceUser, ackTx, outputs);

    expect(applied).toBe(true);
    const removal = outputs.find(
      output => output.entityId === targetHub && output.entityTxs?.[0]?.type === 'removeCrossJurisdictionBookOrder',
    );
    expect(removal?.signerId).toBe(targetSigner);
    expect(removal?.entityTxs?.[0]).toMatchObject({
      type: 'removeCrossJurisdictionBookOrder',
      data: {
        orderId,
        sourceEntityId: sourceUser,
        reason: 'fill_ack_closed',
      },
    });
    expect((removal?.entityTxs?.[0] as any)?.data?.route?.orderId).toBe(orderId);

    const removed = await applyEntityTx(env, createEntityFrameCandidateState(targetState), removal!.entityTxs![0]!);
    const nextBook = removed.newState.orderbookExt?.books.get(pairId);
    expect(nextBook ? getBookOrder(nextBook, namespacedOrderId) : null).toBeNull();
  });

  test('cross-j book-owner fill ack routes admitted remote order to source hub', async () => {
    const env = createEmptyEnv('cross-book-owner-fill-notice');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const lot = SWAP_LOT_SCALE;
    const wethAmount = 30n * 10n ** 18n;
    const usdcAmount = 75_000n * 10n ** 6n;
    const sourceHubIdentity = registerLazySigner('cross-book-owner-fill-notice', '1');
    const bookOwnerIdentity = registerLazySigner('cross-book-owner-fill-notice', '2');
    const sourceHub = sourceHubIdentity.entityId;
    const bookOwnerHub = bookOwnerIdentity.entityId;
    const remoteMaker = `0x${'31'.repeat(32)}`;
    const remoteTargetUser = `0x${'32'.repeat(32)}`;
    const localTaker = `0x${'33'.repeat(32)}`;
    const localTargetUser = `0x${'34'.repeat(32)}`;
    const sourceJurisdiction = 'stack:31338:0x2222222222222222222222222222222222222222';
    const bookOwnerJurisdiction = 'stack:31337:0x1111111111111111111111111111111111111111';
    const pairId = `cross:${sourceJurisdiction}:2/${bookOwnerJurisdiction}:1`;
    const sourceHubSigner = sourceHubIdentity.signerId;
    const bookOwnerSigner = bookOwnerIdentity.signerId;
    const collisionSigner = '3';
    attachSigningReplica(env, sourceHub, sourceHubSigner);
    const makeCanonicalAccount = (selfId: string, counterpartyId: string): AccountReplica => {
      const [leftEntity, rightEntity] =
        selfId.toLowerCase() < counterpartyId.toLowerCase() ? [selfId, counterpartyId] : [counterpartyId, selfId];
      const account = makeProposalAccount([], leftEntity, rightEntity);
      account.proofHeader = { fromEntity: selfId, toEntity: counterpartyId, nextProofNonce: 0 };
      return account;
    };
    env.gossip = {
      getProfiles: () => [
        {
          entityId: localTaker,
          metadata: { board: { validators: [{ signerId: 'local-taker-cross-source-signer' }] } },
        },
        {
          entityId: remoteMaker,
          metadata: { board: { validators: [{ signerId: 'remote-maker-cross-source-signer' }] } },
        },
      ],
    } as RuntimeReplica['gossip'];

    const buildRoute = (
      orderId: string,
      sourceJurisdiction: string,
      sourceEntityId: string,
      sourceHubId: string,
      sourceTokenId: number,
      sourceAmount: bigint,
      targetJurisdiction: string,
      targetHubId: string,
      targetUserId: string,
      targetTokenId: number,
      targetAmount: bigint,
    ): CrossJurisdictionSwapRoute => {
      const prepared = buildPreparedCrossJurisdictionRoute(
        {
          orderId,
          makerEntityId: sourceEntityId,
          hubEntityId: bookOwnerHub,
          bookOwnerEntityId: bookOwnerHub,
          venueId: pairId,
          sourceSignerId: `${orderId}-source-signer`,
          sourceHubSignerId: sourceHubId === sourceHub ? sourceHubSigner : bookOwnerSigner,
          targetHubSignerId: targetHubId === bookOwnerHub ? bookOwnerSigner : 'target-hub-signer',
          targetSignerId: `${orderId}-target-signer`,
          bookHubSignerId: bookOwnerSigner,
          sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
          targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
          source: {
            jurisdiction: sourceJurisdiction,
            entityId: sourceEntityId,
            counterpartyEntityId: sourceHubId,
            tokenId: sourceTokenId,
            amount: sourceAmount,
          },
          target: {
            jurisdiction: targetJurisdiction,
            entityId: targetHubId,
            counterpartyEntityId: targetUserId,
            tokenId: targetTokenId,
            amount: targetAmount,
          },
          status: 'resting',
          createdAt: env.state.timestamp,
          updatedAt: env.state.timestamp,
          expiresAt: env.state.timestamp + 60_000,
        },
        { runtimeSeed: 'cross-book-owner-fill-notice', now: env.state.timestamp },
      );
      return { ...prepared, status: 'resting', updatedAt: env.state.timestamp };
    };

    const makerRoute = withCanonicalCrossJurisdictionRouteHash({
      ...buildRoute(
        'remote-maker-cross',
        sourceJurisdiction,
        remoteMaker,
        sourceHub,
        2,
        wethAmount,
        bookOwnerJurisdiction,
        bookOwnerHub,
        remoteTargetUser,
        1,
        usdcAmount,
      ),
      sourceHubSignerId: 'committed-source-hub-route',
      routeHash: undefined,
    });
    const takerRoute = withCanonicalCrossJurisdictionRouteHash({
      ...buildRoute(
        'local-taker-cross',
        bookOwnerJurisdiction,
        localTaker,
        bookOwnerHub,
        1,
        usdcAmount,
        sourceJurisdiction,
        sourceHub,
        localTargetUser,
        2,
        wethAmount,
      ),
      routeHash: undefined,
    });

    const sourceState = makeEntityState(sourceHub);
    sourceState.config = makeSingleSignerConfigFor(sourceHubSigner);
    sourceState.config = {
      ...sourceState.config,
      validators: [sourceHubSigner],
      shares: { [sourceHubSigner]: 1n },
      jurisdiction: {
        ...sourceState.config.jurisdiction,
        name: 'Source book stack',
        chainId: 31338,
        depositoryAddress: `0x${'22'.repeat(20)}`,
      },
    };
    sourceState.crossJurisdictionSwaps = new Map([[makerRoute.orderId, makerRoute]]);
    const makerSourceAccount = makeCanonicalAccount(sourceHub, remoteMaker);
    makerSourceAccount.state.swapOffers = makerSourceAccount.state.swapOffers.updated(makerRoute.orderId, {
      offerId: makerRoute.orderId,
      giveTokenId: makerRoute.source.tokenId,
      giveTokenDecimals: getStaticSwapTokenDimensions(
        makerRoute.source.tokenId,
        makerRoute.target.tokenId,
      ).giveTokenDecimals,
      giveAmount: makerRoute.source.amount,
      quantizedGive: makerRoute.source.amount,
      wantTokenId: makerRoute.target.tokenId,
      wantTokenDecimals: getStaticSwapTokenDimensions(
        makerRoute.source.tokenId,
        makerRoute.target.tokenId,
      ).wantTokenDecimals,
      wantAmount: makerRoute.target.amount,
      maxFee: 0n,
      minNetReceive: makerRoute.target.amount,
      quantizedWant: makerRoute.target.amount,
      makerIsLeft: makerSourceAccount.state.leftEntity.toLowerCase() === remoteMaker.toLowerCase(),
      timeInForce: 0,
      createdHeight: 1,
      priceTicks: 25_000_000n,
      crossJurisdiction: makerRoute,
    });
    sourceState.accounts = sourceState.accounts.updated(remoteMaker, makerSourceAccount);

    const bookOwnerState = makeEntityState(bookOwnerHub);
    bookOwnerState.config = makeSingleSignerConfigFor(bookOwnerSigner);
    bookOwnerState.config = {
      ...bookOwnerState.config,
      jurisdiction: {
        ...bookOwnerState.config.jurisdiction,
        name: 'Book owner stack',
        chainId: 31337,
        depositoryAddress: `0x${'11'.repeat(20)}`,
      },
    };
    const makerAdmission = mergeCrossJurisdictionBookAdmission(bookOwnerState, makerRoute, env.state.timestamp);
    makerAdmission.status = 'admitted';
    makerAdmission.admittedAt = env.state.timestamp;
    bookOwnerState.crossJurisdictionSwaps?.set(makerRoute.orderId, makerRoute);

    const makerMeta = buildCrossJurisdictionMarketOffer(
      {
        offerId: makerRoute.orderId,
        accountId: remoteMaker,
        makerIsLeft: true,
        fromEntity: remoteMaker,
        toEntity: sourceHub,
        createdHeight: 1,
        giveTokenId: makerRoute.source.tokenId,
        giveAmount: makerRoute.source.amount,
        wantTokenId: makerRoute.target.tokenId,
        wantAmount: makerRoute.target.amount,
        timeInForce: 0,
        priceTicks: 25_000_000n,
        crossJurisdiction: makerRoute,
      },
      bookOwnerHub,
    );
    expect(makerMeta).not.toBeNull();
    let book = createBook({ bucketWidthTicks: 10_000n, maxOrders: 10_000, stpPolicy: 1 });
    // USD admission intentionally has no oracle/static substitution. Seed the
    // canonical local price through a real crossed trade, then place the test
    // liquidity; assigning lastTradePriceTicks directly would bypass the path
    // this regression is supposed to exercise.
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'price-maker',
      orderId: 'price-ask',
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 25_000_000n,
      qtyLots: 1n,
    }).state;
    book = applyCommand(book, {
      kind: 0,
      ownerId: 'price-taker',
      orderId: 'price-buy',
      side: 0,
      tif: 1,
      postOnly: false,
      priceTicks: 25_000_000n,
      qtyLots: 1n,
    }).state;
    book = applyCommand(book, {
      kind: 0,
      ownerId: makerMeta!.makerId,
      orderId: `${remoteMaker}:${makerRoute.orderId}`,
      side: makerMeta!.side,
      tif: 0,
      postOnly: false,
      priceTicks: makerMeta!.priceTicks,
      qtyLots: makerMeta!.baseAmount / lot,
    }).state;
    bookOwnerState.orderbookExt = {
      // Cross-j venue identity and local USD reference identity are separate
      // keys even though this fixture uses the same executed WETH/USDC book.
      books: new Map([[pairId, book], ['1/2', book]]),
      orderPairs: new Map([[`${remoteMaker}:${makerRoute.orderId}`, [pairId]]]),
      pairDimensions: new Map([
        [pairId, getSwapPairDimensions(1, getStaticSwapTokenDimensions(2, 1))],
        ['1/2', getSwapPairDimensions(1, getStaticSwapTokenDimensions(2, 1))],
      ]),
      referrals: new Map(),
      hubProfile: {
        entityId: bookOwnerHub,
        name: 'Book owner hub',
        spreadDistribution: { makerBps: 0, takerBps: 10_000, hubBps: 0, makerReferrerBps: 0, takerReferrerBps: 0 },
        referenceTokenId: 1,
        minTradeSize: 0n,
        supportedPairs: [pairId],
      },
    } satisfies OrderbookExtState;

    const takerAccount = makeCanonicalAccount(bookOwnerHub, localTaker);
    takerAccount.state.swapOffers = takerAccount.state.swapOffers.updated(takerRoute.orderId, {
      offerId: takerRoute.orderId,
      giveTokenId: takerRoute.source.tokenId,
      giveTokenDecimals: getStaticSwapTokenDimensions(
        takerRoute.source.tokenId,
        takerRoute.target.tokenId,
      ).giveTokenDecimals,
      giveAmount: takerRoute.source.amount,
      quantizedGive: takerRoute.source.amount,
      wantTokenId: takerRoute.target.tokenId,
      wantTokenDecimals: getStaticSwapTokenDimensions(
        takerRoute.source.tokenId,
        takerRoute.target.tokenId,
      ).wantTokenDecimals,
      wantAmount: takerRoute.target.amount,
      maxFee: 0n,
      minNetReceive: takerRoute.target.amount,
      quantizedWant: takerRoute.target.amount,
      makerIsLeft: takerAccount.state.leftEntity.toLowerCase() === localTaker.toLowerCase(),
      timeInForce: 0,
      createdHeight: 2,
      priceTicks: 25_000_000n,
      crossJurisdiction: takerRoute,
    });
    bookOwnerState.accounts = bookOwnerState.accounts.updated(localTaker, takerAccount);

    const collisionOwner = `0x${'35'.repeat(32)}`;
    const collisionState = makeEntityState(collisionOwner);
    collisionState.config = makeSingleSignerConfigFor(collisionSigner);
    const collisionAccount = makeCanonicalAccount(collisionOwner, remoteMaker);
    collisionAccount.state.swapOffers = collisionAccount.state.swapOffers.updated(makerRoute.orderId, {
      offerId: makerRoute.orderId,
      giveTokenId: makerRoute.source.tokenId,
      giveTokenDecimals: getStaticSwapTokenDimensions(
        makerRoute.source.tokenId,
        makerRoute.target.tokenId,
      ).giveTokenDecimals,
      giveAmount: makerRoute.source.amount,
      quantizedGive: makerRoute.source.amount,
      wantTokenId: makerRoute.target.tokenId,
      wantTokenDecimals: getStaticSwapTokenDimensions(
        makerRoute.source.tokenId,
        makerRoute.target.tokenId,
      ).wantTokenDecimals,
      wantAmount: makerRoute.target.amount,
      maxFee: 0n,
      minNetReceive: makerRoute.target.amount,
      quantizedWant: makerRoute.target.amount,
      makerIsLeft: collisionAccount.state.leftEntity.toLowerCase() === remoteMaker.toLowerCase(),
      timeInForce: 0,
      createdHeight: 1,
      priceTicks: 25_000_000n,
      crossJurisdiction: makerRoute,
    });
    collisionState.accounts = collisionState.accounts.updated(remoteMaker, collisionAccount);
    env.state.eReplicas.set(`${collisionOwner}:${collisionSigner}`, {
      entityId: collisionOwner,
      signerId: collisionSigner,
      entityEncPubKey: '',
      mempool: [],
      isProposer: true,
      state: collisionState,
    } satisfies EntityReplica);
    env.state.eReplicas.set(`${sourceHub}:${sourceHubSigner}`, {
      entityId: sourceHub,
      signerId: sourceHubSigner,
      entityEncPubKey: '',
      mempool: [],
      isProposer: true,
      state: sourceState,
    } satisfies EntityReplica);
    env.state.eReplicas.set(`${bookOwnerHub}:${bookOwnerSigner}`, {
      entityId: bookOwnerHub,
      signerId: bookOwnerSigner,
      entityEncPubKey: '',
      mempool: [],
      isProposer: true,
      state: bookOwnerState,
    } satisfies EntityReplica);

    const takerAdmissionTxs: EntityTx[] = [
      {
        type: 'admitCrossJurisdictionBookOrder',
        data: { route: takerRoute, reason: 'atomic_account_pair_committed' },
      },
    ];

    const matched = await applyEntityFrameWithMaterializedTestInfraContext(
      env,
      bookOwnerState,
      await buildQuorumAuthorizedFrameTxs(env, bookOwnerState, takerAdmissionTxs),
    );

    const sourceNotice = matched.outputs.find(
      output =>
        output.entityId.toLowerCase() === sourceHub.toLowerCase() &&
        output.entityTxs?.[0]?.type === 'crossJurisdictionFillNotice',
    );
    expect(sourceNotice?.signerId).toBe('committed-source-hub-route');
    expect(sourceNotice?.entityTxs?.[0]).toMatchObject({
      type: 'crossJurisdictionFillNotice',
      data: {
        orderId: makerRoute.orderId,
        pairId,
      },
    });
    const collisionNotice = matched.outputs.find(
      output =>
        output.entityId.toLowerCase() === collisionOwner.toLowerCase() &&
        output.entityTxs?.[0]?.type === 'crossJurisdictionFillNotice',
    );
    expect(collisionNotice).toBeUndefined();

    const sourceApplied = await applyEntityFrameWithMaterializedTestInfraContext(env, sourceState, [
      {
        type: 'runtimeOutput',
        data: {
          protocol: 'cross-j',
          sourceEntityId: bookOwnerHub,
          sourceSignerId: bookOwnerSigner,
          targetEntityId: sourceHub,
          entityTxs: sourceNotice!.entityTxs!,
        },
      },
    ]);
    const sourceAccount = sourceApplied.newState.accounts.get(remoteMaker);
    const queuedAck = [...(sourceAccount?.mempool ?? []), ...(sourceAccount?.pendingFrame?.accountTxs ?? [])].find(
      tx => tx.type === 'cross_swap_fill_ack' && tx.data.offerId === makerRoute.orderId,
    );
    expect(queuedAck).toBeDefined();
  });

  test('cross-j local fill ack stays on the local source offer when an admission key collides', async () => {
    const env = createEmptyEnv('cross-local-fill-ack-admission-collision');
    env.state.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const lot = SWAP_LOT_SCALE;
    const sourceHub = `0x${'36'.repeat(32)}`;
    const user = `0x${'37'.repeat(32)}`;
    const targetHub = `0x${'38'.repeat(32)}`;
    const targetUser = `0x${'39'.repeat(32)}`;
    const wrongHub = `0x${'3a'.repeat(32)}`;
    const orderId = 'local-offer-admission-collision';
    const pairId = 'cross:base:2/tron:1';
    const runtimeSeed = env.runtimeSeed;
    if (!runtimeSeed) throw new Error('TEST_RUNTIME_SEED_REQUIRED');
    const userSignerId = deriveSignerAddressSync(runtimeSeed, '2').toLowerCase();
    registerSignerKey(runtimeSeed, userSignerId, deriveSignerKeySync(runtimeSeed, '2'));
    attachSigningReplica(env, user, userSignerId);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId,
        makerEntityId: user,
        hubEntityId: sourceHub,
        bookOwnerEntityId: sourceHub,
        venueId: pairId,
        sourceSignerId: userSignerId,
        sourceHubSignerId: 'source-hub-signer',
        targetHubSignerId: 'target-hub-signer',
        targetSignerId: 'target-user-signer',
        bookHubSignerId: 'source-hub-signer',
        sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        source: {
          jurisdiction: 'base',
          entityId: user,
          counterpartyEntityId: sourceHub,
          tokenId: 2,
          amount: 10n * lot,
        },
        target: {
          jurisdiction: 'tron',
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 25_000n * lot,
        },
        status: 'resting',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: env.state.timestamp + 60_000,
      },
      { runtimeSeed: 'cross-local-fill-ack-admission-collision', now: env.state.timestamp },
    );
    const restingRoute = { ...route, status: 'resting' as const, updatedAt: env.state.timestamp };
    const sourceState = makeEntityState(sourceHub);
    installSingleSignerBoard(env, sourceState);
    sourceState.crossJurisdictionSwaps = new Map([[orderId, restingRoute]]);
    const account = makeProposalAccount([], sourceHub, user);
    account.state.swapOffers = account.state.swapOffers.updated(orderId, {
      offerId: orderId,
      giveTokenId: restingRoute.source.tokenId,
      giveTokenDecimals: getStaticSwapTokenDimensions(
        restingRoute.source.tokenId,
        restingRoute.target.tokenId,
      ).giveTokenDecimals,
      giveAmount: restingRoute.source.amount,
      quantizedGive: restingRoute.source.amount,
      wantTokenId: restingRoute.target.tokenId,
      wantTokenDecimals: getStaticSwapTokenDimensions(
        restingRoute.source.tokenId,
        restingRoute.target.tokenId,
      ).wantTokenDecimals,
      wantAmount: restingRoute.target.amount,
      maxFee: 0n,
      minNetReceive: restingRoute.target.amount,
      quantizedWant: restingRoute.target.amount,
      makerIsLeft: account.state.leftEntity.toLowerCase() === user.toLowerCase(),
      timeInForce: 0,
      createdHeight: 1,
      priceTicks: 25_000_000n,
      crossJurisdiction: restingRoute,
    });
    sourceState.accounts = sourceState.accounts.updated(user, account);

    const conflictingRoute = buildPreparedCrossJurisdictionRoute(
      {
        orderId,
        makerEntityId: user,
        hubEntityId: wrongHub,
        bookOwnerEntityId: wrongHub,
        venueId: pairId,
        sourceSignerId: userSignerId,
        sourceHubSignerId: 'wrong-hub-signer',
        targetHubSignerId: 'target-hub-signer',
        targetSignerId: 'target-user-signer',
        bookHubSignerId: 'wrong-hub-signer',
        sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        source: {
          jurisdiction: 'base',
          entityId: user,
          counterpartyEntityId: wrongHub,
          tokenId: 2,
          amount: 10n * lot,
        },
        target: {
          jurisdiction: 'tron',
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 25_000n * lot,
        },
        status: 'resting',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
        expiresAt: env.state.timestamp + 60_000,
      },
      {
        runtimeSeed: 'cross-local-fill-ack-admission-collision-conflict',
        now: env.state.timestamp,
      },
    );
    const conflictingAdmission = mergeCrossJurisdictionBookAdmission(sourceState, conflictingRoute, env.state.timestamp);
    conflictingAdmission.status = 'admitted';
    conflictingAdmission.admittedAt = env.state.timestamp;

    const fillNoticeTxs: EntityTx[] = [
      {
        type: 'crossJurisdictionFillNotice',
        data: {
          orderId,
          fillSeq: 1,
          incrementalSourceAmount: restingRoute.source.amount,
          incrementalTargetAmount: restingRoute.target.amount,
          cumulativeSourceAmount: restingRoute.source.amount,
          cumulativeTargetAmount: restingRoute.target.amount,
          cumulativeFillRatio: 65_535,
          fillNumerator: 1n,
          fillDenominator: 1n,
          pairId,
        },
      },
    ];
    const applied = await applyEntityFrameWithMaterializedTestInfraContext(
      env,
      sourceState,
      await buildQuorumAuthorizedFrameTxs(env, sourceState, fillNoticeTxs),
    );

    const wrongHubNotice = applied.outputs.find(
      output =>
        output.entityId.toLowerCase() === wrongHub.toLowerCase() &&
        output.entityTxs?.[0]?.type === 'crossJurisdictionFillNotice',
    );
    expect(wrongHubNotice).toBeUndefined();
    const queuedAck = [
      ...(applied.newState.accounts.get(user)?.mempool ?? []),
      ...(applied.newState.accounts.get(user)?.pendingFrame?.accountTxs ?? []),
    ].find(tx => tx.type === 'cross_swap_fill_ack' && tx.data.offerId === orderId);
    expect(queuedAck).toBeDefined();
  });
});
