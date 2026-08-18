import { describe, expect, spyOn, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { readEntityFrameEventMessages } from '../../../entity/frame-events';

import { x25519 } from '@noble/curves/ed25519.js';

import {
  applyAccountInput,
  getIncomingAccountDeadlineViolation,
  HTLC_ENFORCEMENT_RESERVE_MS,
  isHtlcSecretEnforcementWindowClosed,
  proposeAccountFrame,
  isWithinAccountFrameBounds,
} from '../../../account/consensus/index';

import { computeAccountStateRoot, computeAccountStateRootCold } from '../../../account/commitment/state-root';

import { resolveCertifiedAccountCounterpartyProposer } from '../../../runtime/delivery/topology/account-counterparty-route';

import { createEmptyAccountJClaimAccumulator } from '../../../account/j-claims/j-claim-accumulator';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey, signAccountFrame } from '../../../account/crypto';

import { deriveAccountWatchSeed } from '../../../protocol/identity/account-watch-seed';

import { applyAccountTx } from '../../../account/tx/apply';


import { handleHtlcLock } from '../../../account/tx/handlers/htlc/lock';

import { handleHtlcResolve } from '../../../account/tx/handlers/htlc/resolve';

import { createSettlementWorkspaceHash } from '../../../account/tx/handlers/settlement/transition';

import { hashHtlcSecret } from '../../../protocol/htlc/utils';
import { storageFailure } from '../../../protocol/errors/failure-taxonomy';

import { buildHashLadderProof, revealHashLadder } from '../../../protocol/htlc/hash-ladder';

import type { MultiRecipientCiphertext } from '../../../protocol/htlc/multi-recipient';

import { checkAutoRebalance, handleRequestCollateral } from '../../../account/tx/handlers/rebalance/request-collateral';

import { handleSwapOffer } from '../../../account/tx/handlers/swap/offer/index';

import { createFrameHash, MAX_ACCOUNT_FRAME_TXS } from '../../../account/consensus/frame/hash';

import { resolveAutoRebalanceFeePolicy, runPostFrameAutoRebalanceCheck } from '../../../account/consensus/helpers';

import { HTLC, LIMITS } from '../../../config/constants';

import {
  ACCOUNT_PENDING_RESEND_AFTER_MS,
  emitCommittedPendingFrameWarnings,
  executeCrontab,
  initCrontab,
} from '../../../entity/scheduler';
import { HTLC_SECRET_ACK_TIMEOUT_MS } from '../../../entity/tx/j-events-htlc/route-lifecycle';

import { encodeBoard, generateLazyEntityId, generateNumberedEntityId, hashBoard } from '../../../entity/factory';
import { provisionTestEntityEncryptionKey } from '../../helpers/cross-j';

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
  computeEntityFrameAuthorityRoot,
} from '../../../entity/consensus/state-root';

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

import { buildSettlementSealDraft, processCommittedSettlementTransitionFollowup } from '../../../entity/tx/handlers/payments/settle';

import { applyJEvent } from '../../../entity/tx/j-events';

import { applyJEventRange, buildJEventRangeData } from '../../helpers/j-history';

import { applyFinalizedAccountJEvents } from '../../../account/tx/handlers/j-events/finality';

import { queueCrossJurisdictionRevealPorts } from '../../../entity/tx/j-events-htlc';

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
  getStaticSwapTokenDimensions,
  getBookOrder,
  getSwapLotScale,
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
import { assertExternalEntityInputAllowed } from '../../../runtime/admit/entity-input-admission.ts';
import { createRuntimeEntityInputBatchContext } from '../../../runtime/admit/entity-input-contract.ts';
import { rejectMalformedEntityInput } from '../../../runtime/admit/entity-input-staging.ts';
import { discardRejectedEntityInput } from '../../../runtime/frame/intake/discard';

import { MalformedEntityFrameInputError } from '../../../entity/tx/processing/invariant-errors';

import { applyStorageChanges } from '../../../runtime/observability/env-events';
import {
  resolveDbPath,
  resolveHistoryViewDbPath,
  resolveRuntimeWalDbPath,
  resolveStorageDbPath,
} from '../../../storage/runtime-dbs';

import { submitRuntimeJOutbox } from '../../../runtime/j-submit/j-submit';

import { registerStructuredLogSink } from '../../../support/logger';

import { buildJSubmitAttemptId, registerPendingCommittedJOutbox } from '../../../runtime/j-submit/j-submit-state';

import { buffersEqual, safeStringify } from '../../../protocol/serialization';

import type { ProofBodyStruct } from '../../../protocol/dispute/proof-body';

import { hydrateAccountDocFromStorage, projectAccountDoc } from '../../../storage/read/projections';

import { validateStorageAccountDocValue } from '../../../storage/schema/authoritative-schema';

import { decodeValidatedBuffer, encodeBuffer } from '../../../storage/codec/codec';

import { createDefaultDelta } from '../../../account/state/delta';


import { buildDisputeArgumentsForSnapshot } from '../../../entity/dispute-arguments';
import {
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../../../protocol/dispute/arguments';

import {
  buildAccountProofBody,
  createDisputeProofHashWithNonce,
  hashProofBodyStruct,
} from '../../../protocol/dispute/proof-builder';

import { encodeSignedHanko } from '../../../hanko/codec';

import { resolveHankoBoardDelays } from '../../../hanko/claims';

import { signEntityHashes, verifyHankoForHash } from '../../../hanko/signing';

import { NobleCryptoProvider } from '../../../protocol/crypto/noble';

import { computeHtlcEnvelopeContextHash, computeHtlcSecretOfferContextHash } from '../../../protocol/htlc/codec/envelope';

import { encryptBytesForValidatorManifest } from '../../../protocol/htlc/multi-recipient';

import { buildHtlcOnionAdvanceTx } from '../../../entity/htlc/onion-advance';
import { hashEncryptedHtlcLayer } from '../../../protocol/htlc/codec/onion-layer';

import { encodeHtlcSecretOffer, encodeOnionLayer } from '../../../protocol/htlc/codec/onion';


import { handleMeshBootstrapLoopError } from '../../../orchestrator/mesh/mesh-bootstrap-fail-fast';

import { fitCrossAmountsToOrderbook } from '../../../orchestrator/mm-node';

import { cloneAccountReplica } from '../../../account/state/state-clone';
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

import { ethers } from 'ethers';

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
      deltas: new Map(),
      locks: new Map(),
      swapOffers: new Map(),
      leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
      rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
      lastFinalizedJHeight: 0,
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      jNonce: 0,
      requestedRebalance: new Map(),
      requestedRebalanceFeeState: new Map(),
    },
    status: 'active',
    mempool: [...mempool],
    swapOrderHistory: new Map(),
    swapClosedOrders: new Map(),
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
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: leftEntity, toEntity: rightEntity, nextProofNonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    pendingWithdrawals: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
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
    kind: 'frame',
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
      candidate.depositoryAddress?.toLowerCase() === jurisdiction.depositoryAddress.toLowerCase() &&
      candidate.entityProviderAddress?.toLowerCase() === jurisdiction.entityProviderAddress.toLowerCase(),
  );
  if (!replica) {
    replica = createJReplica(env, jurisdiction.name, jurisdiction.depositoryAddress);
    replica.chainId = jurisdiction.chainId;
    replica.contracts = { ...replica.contracts, depository: jurisdiction.depositoryAddress };
    replica.contracts = { ...replica.contracts, entityProvider: jurisdiction.entityProviderAddress };
  }
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
    accounts: new Map(),
    deferredAccountProposals: new Map(),
    lastFinalizedJHeight: 0,
    profile: {
      name: 'Audit Entity',
      isHub: false,
      avatar: '',
      bio: '',
      website: '',
    },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    lockBook: new Map(),
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
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  profile: {
    name: 'Audit Entity',
    isHub: false,
    avatar: '',
    bio: '',
    website: '',
  },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  lockBook: new Map(),
  swapTradingPairs: [],
  crontabState: initCrontab(),
});

const makeDisputeFinalizedFixture = (seed: string, finalProofbody: ProofBodyStruct, storeFinalProofbody: boolean) => {
  const entityId = `0x${'12'.repeat(32)}`;
  const counterpartyId = `0x${'34'.repeat(32)}`;
  const state = makeEntityState(entityId);
  const account = makeProposalAccount([], entityId, counterpartyId);
  const finalProofbodyHash = hashProofBodyStruct(finalProofbody);
  if (storeFinalProofbody) {
    account.disputeProofBodiesByHash = { [finalProofbodyHash]: finalProofbody };
  }
  account.activeDispute = {
    startedByLeft: true,
    disputeTimeout: 1700000123,
    disputeStartTimestamp: 1700000000,
    initialProofbodyHash: finalProofbodyHash,
    initialNonce: 7,
    finalizeQueued: true,
  } as AccountState['activeDispute'];
  state.accounts.set(counterpartyId, account);
  return {
    account,
    counterpartyId,
    env: createEmptyEnv(seed),
    event: {
      type: 'DisputeFinalized',
      data: {
        sender: entityId,
        counterentity: counterpartyId,
        initialNonce: 7,
        initialProofbodyHash: finalProofbodyHash,
        finalProofbodyHash,
        finalizationEvidenceHash: ethers.ZeroHash,
      },
    } satisfies JurisdictionEvent,
    finalProofbodyHash,
    state,
  };
};

const applyDisputeFinalizedFixture = async (fixture: ReturnType<typeof makeDisputeFinalizedFixture>) =>
  applyJEventRange(
    fixture.state,
    {
      from: '1',
      observedAt: 22,
      blockNumber: 22,
      blockHash: `0x${'99'.repeat(32)}`,
      transactionHash: `0x${'88'.repeat(32)}`,
      event: fixture.event,
      jurisdictionRef: getJEventJurisdictionRef(fixture.state.config.jurisdiction),
    },
    fixture.env,
  );

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
  test('jurisdiction-specific runtime height ignores higher sibling chain tip', () => {
    const env = createEmptyEnv('jurisdiction-height-specificity');
    env.activeJurisdiction = 'Tron';
    env.state.jReplicas = new Map([
      ['Testnet', { name: 'Testnet', blockNumber: 3145n }],
      ['Tron', { name: 'Tron', blockNumber: 5794n }],
    ] as any);

    expect(getRuntimeJurisdictionHeight(env, 0, 'Testnet')).toBe(3145);
    expect(getRuntimeJurisdictionHeight(env, 5794, 'Testnet')).toBe(3145);
    expect(getRuntimeJurisdictionHeight(env, 0, 'Tron')).toBe(5794);
    expect(getRuntimeJurisdictionHeight(env, 0)).toBe(5794);
  });

  test('cross-j system entity txs reject every raw ingress outside certified runtimeOutput', async () => {
    const env = createEmptyEnv('cross-j-intra-runtime-boundary');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const remoteRuntime = `0x${'99'.repeat(20)}`;
    const crossJEntityId = `0x${'11'.repeat(32)}`;
    const crossJSignerId = `0x${'01'.repeat(20)}`;

    expect(() => assertExternalEntityInputAllowed({
      from: remoteRuntime,
      entityId: crossJEntityId,
      signerId: crossJSignerId,
      entityTxs: [{
        type: 'registerCrossJurisdictionSwap',
        data: { route: {} },
      } as any],
    })).toThrow('RUNTIME_CROSS_J_EXTERNAL_INGRESS_FORBIDDEN');

    for (const entityId of [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`]) {
      expect(() => assertExternalEntityInputAllowed({
        entityId,
        signerId: `0x${'01'.repeat(20)}`,
        entityTxs: [{
          type: 'crossJurisdictionSalvage',
          data: {
            routeId: 'raw-local-salvage',
            binary: '0x01',
            fillRatio: 1,
            sourceEntityId: `0x${'11'.repeat(32)}`,
            sourceCounterpartyEntityId: `0x${'33'.repeat(32)}`,
          },
        }],
      })).toThrow('RUNTIME_CROSS_J_EXTERNAL_INGRESS_FORBIDDEN');
    }

    expect(() => assertExternalEntityInputAllowed({
      from: remoteRuntime,
      entityId: crossJEntityId,
      signerId: crossJSignerId,
      localRuntimeProtocol: 'cross-j',
      entityTxs: [{
        type: 'prepareCrossJurisdictionSwap',
        data: { route: {} },
      } as any],
    })).toThrow('RUNTIME_CROSS_J_EXTERNAL_INGRESS_FORBIDDEN');

    expect(() =>
      sendEntityInput(env, {
        entityId: `0x${'22'.repeat(32)}`,
        signerId: `0x${'02'.repeat(20)}`,
        entityTxs: [
          {
            type: 'registerCrossJurisdictionSwap',
            data: { route: {} },
          } as any,
        ],
      }),
    ).toThrow('ROUTE_TARGET_RUNTIME_UNKNOWN');

    registerEntityRuntimeHint(env, `0x${'22'.repeat(32)}`, remoteRuntime);
    expect(() =>
      sendEntityInput(env, {
        entityId: `0x${'22'.repeat(32)}`,
        entityTxs: [
          {
            type: 'registerCrossJurisdictionSwap',
            data: { route: {} },
          } as any,
        ],
      }),
    ).toThrow('CROSS_J_REMOTE_OUTPUT_FORBIDDEN');
  });

  test('live runtime discards remote cross-j ingress without retaining attacker bytes', async () => {
    const env = createEmptyEnv('cross-j-live-ingress-drop');
    env.scenarioMode = false;
    env.quietRuntimeLogs = true;
    const remoteRuntime = `0x${'99'.repeat(20)}`;

    await expect(
      processRuntime(env, [
        {
          from: remoteRuntime,
          entityId: `0x${'11'.repeat(32)}`,
          signerId: `0x${'01'.repeat(20)}`,
          entityTxs: [
            {
              type: 'prepareCrossJurisdictionSwap',
              data: { route: {} },
            } as any,
          ],
        },
      ]),
    ).resolves.toBe(env);

    expect(env.infrastructure?.halted).not.toBe(true);
    expect(env.infrastructure?.lifecyclePhase).not.toBe('halted');
    expect(env.runtimeMempool?.entityInputs).toHaveLength(0);
    expect(env.infrastructure?.securityIncidents).toBeUndefined();
  });

  test('runtime ingress retargets stale signer hints only when the local target entity has one replica', async () => {
    const env = createEmptyEnv('stale-signer-retarget');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const actualSignerId = `0x${'83'.repeat(20)}`;
    const entityId = generateLazyEntityId([actualSignerId], 1n).toLowerCase();
    const staleSignerId = `0xb262${'00'.repeat(18)}`;
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(actualSignerId);
    env.state.eReplicas.set(`${entityId}:${actualSignerId}`, {
      entityId,
      signerId: actualSignerId,
      entityEncPubKey: '',
      mempool: [],
      isProposer: true,
      state,
    });

    await expect(
      processRuntime(env, [
        {
          entityId,
          signerId: staleSignerId,
          entityTxs: [],
        },
      ]),
    ).resolves.toBe(env);
    expect(env.state.eReplicas.has(`${entityId}:${actualSignerId}`)).toBe(true);
  });

  test('runtime ingress rejects stale signer hints for tx-bearing inputs even with one local replica', async () => {
    const env = createEmptyEnv('stale-signer-tx-bearing');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const actualSignerId = `0x${'85'.repeat(20)}`;
    const entityId = generateLazyEntityId([actualSignerId], 1n).toLowerCase();
    const staleSignerId = `0x${'86'.repeat(20)}`;
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(actualSignerId);
    env.state.eReplicas.set(`${entityId}:${actualSignerId}`, {
      entityId,
      signerId: actualSignerId,
      entityEncPubKey: '',
      mempool: [],
      isProposer: true,
      state,
    });

    await expect(
      processRuntime(env, [
        {
          entityId,
          signerId: staleSignerId,
          entityTxs: [
            {
              type: 'openAccount',
              data: {
                targetEntityId: `0x${'87'.repeat(32)}`,
                tokenId: 1,
                creditAmount: 1n,
              },
            },
          ],
        },
      ]),
    ).rejects.toThrow('RUNTIME_REPLICA_NOT_FOUND');
  });

  test('live runtime drops a remote stale-signer input without halting', async () => {
    const env = createEmptyEnv('stale-signer-live-drop');
    env.scenarioMode = false;
    env.quietRuntimeLogs = true;
    const actualSignerId = `0x${'95'.repeat(20)}`;
    const entityId = generateLazyEntityId([actualSignerId], 1n).toLowerCase();
    const staleSignerId = `0x${'96'.repeat(20)}`;
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(actualSignerId);
    env.state.eReplicas.set(`${entityId}:${actualSignerId}`, {
      entityId,
      signerId: actualSignerId,
      entityEncPubKey: '',
      mempool: [],
      isProposer: true,
      state,
    });

    await expect(
      processRuntime(env, [
        {
          from: `0x${'94'.repeat(20)}`,
          entityId,
          signerId: staleSignerId,
          entityTxs: [
            {
              type: 'openAccount',
              data: {
                targetEntityId: `0x${'97'.repeat(32)}`,
                tokenId: 1,
                creditAmount: 1n,
              },
            },
          ],
        },
      ]),
    ).resolves.toBe(env);
    expect(env.runtimeMempool?.entityInputs).toHaveLength(0);
    expect(env.state.eReplicas.get(`${entityId}:${actualSignerId}`)?.state.accounts.size).toBe(0);
  });

  test('runtime discards only the malformed remote origin lane', () => {
    const entityInput = {
      entityId: `0x${'98'.repeat(32)}`,
      signerId: `0x${'99'.repeat(20)}`,
      entityTxs: [],
    };
    const runtimeInput = { runtimeTxs: [], entityInputs: [entityInput] };
    const localEnv = createEmptyEnv('local-provenance-must-not-discard');
    localEnv.scenarioMode = false;
    const cause = new MalformedEntityFrameInputError('openAccount', 'RUNTIME_REPLICA_NOT_FOUND: test');
    const localError = new RuntimeEntityInputApplyError(entityInput, false, cause);
    expect(discardRejectedEntityInput(localEnv, runtimeInput, localError, true)).toBeNull();

    const unroutableError = new RuntimeEntityInputApplyError(
      entityInput,
      false,
      cause,
      'unroutable-ingress',
    );
    expect(discardRejectedEntityInput(localEnv, runtimeInput, unroutableError, true))
      .toEqual({ runtimeTxs: [], entityInputs: [] });

    const sameReplicaLane = {
      ...entityInput,
      entityTxs: [{ type: 'openAccount', data: {
        targetEntityId: `0x${'95'.repeat(32)}`,
        tokenId: 1,
        creditAmount: 1n,
      } }],
    } as typeof entityInput;
    const otherReplicaLane = {
      ...entityInput,
      entityId: `0x${'94'.repeat(32)}`,
    };
    expect(discardRejectedEntityInput(
      localEnv,
      { runtimeTxs: [], entityInputs: [entityInput, sameReplicaLane, otherReplicaLane] },
      unroutableError,
      true,
    )?.entityInputs).toEqual([otherReplicaLane]);

    const remoteEntityInput = { ...entityInput, from: `0x${'97'.repeat(20)}` };
    const unrelatedInput = {
      ...entityInput,
      entityId: `0x${'96'.repeat(32)}`,
      from: `0x${'95'.repeat(20)}`,
    };
    const remoteEnv = createEmptyEnv('remote-provenance-may-discard');
    remoteEnv.scenarioMode = false;
    const remoteError = new RuntimeEntityInputApplyError(remoteEntityInput, false, cause);
    const retained = discardRejectedEntityInput(
      remoteEnv,
      { runtimeTxs: [], entityInputs: [remoteEntityInput, unrelatedInput] },
      remoteError,
      true,
    );
    expect(retained?.entityInputs).toEqual([unrelatedInput]);
  });

  test('invalid locally-authored ingress remains fail-fast', async () => {
    const env = createEmptyEnv('invalid-local-ingress-fail-fast');
    env.scenarioMode = false;
    env.quietRuntimeLogs = true;
    const entityId = `0x${'98'.repeat(32)}`;

    await expect(
      processRuntime(env, [
        {
          entityId,
          signerId: ' ',
          entityTxs: [
            {
              type: 'openAccount',
              data: {
                targetEntityId: `0x${'99'.repeat(32)}`,
                tokenId: 1,
                creditAmount: 1n,
              },
            },
          ],
        },
      ]),
    ).rejects.toThrow();
    expect(env.runtimeMempool?.entityInputs).toHaveLength(1);
  });

  test('malformed frames are isolated while invalid local schema remains fatal', async () => {
    const makeRuntime = (seed: string) => {
      const env = createEmptyEnv(seed);
      const storageBase = resolveDbPath(env);
      for (const path of [
        storageBase,
        `${storageBase}-events`,
        `${storageBase}-storage-next`,
        `${storageBase}-storage-rotation.json`,
        resolveDbPath(env, 'infra'),
        resolveStorageDbPath(env, 'current'),
        resolveStorageDbPath(env, 'previous'),
        resolveRuntimeWalDbPath(env),
        resolveHistoryViewDbPath(env),
      ]) rmSync(path, { recursive: true, force: true });
      env.scenarioMode = false;
      env.quietRuntimeLogs = true;
      const signerId = deriveSignerAddressSync(seed, '1').toLowerCase();
      registerSignerKey(env, signerId, deriveSignerKeySync(seed, '1'));
      const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
      const state = makeEntityState(entityId);
      state.config = makeSingleSignerConfigFor(signerId);
      state.entityEncryptionPublicKey = provisionTestEntityEncryptionKey(env, entityId);
      env.state.eReplicas.set(`${entityId}:${signerId}`, {
        entityId,
        signerId,
        mempool: [],
        isProposer: true,
        state,
      });
      return { env, entityId, signerId, state };
    };
    const invalidEntityTx = {
      type: 'definitely_unknown_entity_tx',
      data: {},
    } as any;

    const remote = makeRuntime('remote-handler-failure-drop');
    await expect(
      processRuntime(remote.env, [
        {
          from: `0x${'cd'.repeat(20)}`,
          entityId: remote.entityId,
          signerId: remote.signerId,
          entityTxs: [invalidEntityTx],
        } as any,
      ]),
    ).resolves.toBe(remote.env);
    const remoteRetryInputs = remote.env.runtimeMempool?.entityInputs ?? [];
    expect(
      remoteRetryInputs.flatMap(input => input.entityTxs?.map(tx => tx.type) ?? []),
    ).not.toContain('definitely_unknown_entity_tx');

    const local = makeRuntime('local-handler-failure-fatal');
    await expect(
      processRuntime(local.env, [
        {
          entityId: local.entityId,
          signerId: local.signerId,
          entityTxs: [invalidEntityTx],
        },
      ]),
    ).rejects.toThrow('EntityInput.entityTxs_0_TYPE_UNKNOWN:definitely_unknown_entity_tx');
    const localRetryTypes = (local.env.runtimeMempool?.entityInputs ?? [])
      .flatMap(input => input.entityTxs?.map(tx => tx.type) ?? []);
    expect(localRetryTypes).toContain('definitely_unknown_entity_tx');

    const rejectedLocal = makeRuntime('local-business-rejection-isolated');
    const rejectedFrameTxs = await buildQuorumAuthorizedFrameTxs(
      rejectedLocal.env,
      rejectedLocal.state,
      [
        { type: 'chatMessage', data: { message: 'candidate-only mutation' } } as any,
        {
          type: 'directPayment',
          data: {
            targetEntityId: `0x${'d3'.repeat(32)}`,
            tokenId: 1,
            amount: 1n,
            route: [],
          },
        } as any,
      ],
    );
    const rejectedStateBefore = safeStringify(rejectedLocal.state);
    await expect(
      processRuntime(rejectedLocal.env, [{
        entityId: rejectedLocal.entityId,
        signerId: rejectedLocal.signerId,
        entityTxs: rejectedFrameTxs,
      }]),
    ).resolves.toBe(rejectedLocal.env);
    const rejectedReplica = rejectedLocal.env.state.eReplicas.get(
      `${rejectedLocal.entityId}:${rejectedLocal.signerId}`,
    );
    expect(safeStringify(rejectedReplica?.state)).toBe(rejectedStateBefore);
    expect(readEntityFrameEventMessages(rejectedReplica!.state)).toEqual([]);
    expect(rejectedLocal.env.infrastructure?.halted).not.toBe(true);
    expect(rejectedLocal.env.runtimeMempool?.entityInputs).toEqual([]);

    const invariantLocal = makeRuntime('local-money-invariant-is-fatal');
    const invariantFrameTxs = await buildQuorumAuthorizedFrameTxs(
      invariantLocal.env,
      invariantLocal.state,
      [{
        type: 'placeSwapOffer',
        data: {
          counterpartyEntityId: `0x${'d4'.repeat(32)}`,
          offerId: 'missing-account-offer',
          giveTokenId: 1,
          giveAmount: 1n,
          wantTokenId: 2,
          wantAmount: 1n,
        },
      } as any],
    );
    await expect(
      processRuntime(invariantLocal.env, [{
        entityId: invariantLocal.entityId,
        signerId: invariantLocal.signerId,
        entityTxs: invariantFrameTxs,
      }]),
    ).rejects.toThrow('SWAP_REQUEST_ACCOUNT_MISSING:placeSwapOffer');
    expect(invariantLocal.env.infrastructure?.halted).toBe(true);

    const malformed = new RuntimeEntityInputApplyError(
      {
        from: `0x${'ce'.repeat(20)}`,
        entityId: remote.entityId,
        signerId: remote.signerId,
        entityTxs: [invalidEntityTx],
      } as any,
      false,
      new MalformedEntityFrameInputError('definitely_unknown_entity_tx', 'ENTITY_TX_UNHANDLED'),
    );
    expect(malformed.failureKind).toBe('malformed-ingress');
    expect(malformed.rejectionCode).toBe('ENTITY_TX_UNHANDLED');
    expect(malformed.isDiscardableIngress).toBe(true);

    const unroutableLocal = new RuntimeEntityInputApplyError(
      {
        entityId: remote.entityId,
        signerId: remote.signerId,
        entityTxs: [],
      },
      false,
      new Error('RUNTIME_ENTITY_INPUT_UNKNOWN_TARGET'),
      'unroutable-ingress',
    );
    expect(unroutableLocal.rejectionCode).toBe('unroutable-ingress');
    expect(unroutableLocal.isDiscardableIngress).toBe(true);
    const unroutableContext = createRuntimeEntityInputBatchContext([]);
    expect(rejectMalformedEntityInput(
      local.env,
      unroutableLocal,
      0,
      unroutableContext,
      { isReplay: false, routingDeps: {} as never },
    )).toBe(true);
    expect(unroutableContext.inputOutcomes[0]?.outcome).toEqual({
      kind: 'rejected',
      code: 'unroutable-ingress',
    });

    const storage = new RuntimeEntityInputApplyError(
      {
        from: `0x${'cf'.repeat(20)}`,
        entityId: remote.entityId,
        signerId: remote.signerId,
      },
      false,
      storageFailure('STORAGE_NODE_HASH_MISMATCH'),
    );
    expect(storage.failureKind).toBe('storage');
    expect(storage.isDiscardableIngress).toBe(false);

    const localBug = new RuntimeEntityInputApplyError(
      {
        from: `0x${'d0'.repeat(20)}`,
        entityId: remote.entityId,
        signerId: remote.signerId,
      },
      false,
      new TypeError('unexpected undefined state'),
    );
    expect(localBug.failureKind).toBe('local-bug');
    expect(localBug.isDiscardableIngress).toBe(false);

    const applyRemoteAgainstBrokenState = async (
      seed: string,
      failure: Error,
    ): Promise<RuntimeEntityInputApplyError> => {
      const broken = makeRuntime(seed);
      Object.defineProperty(broken.state, 'accounts', {
        configurable: true,
        get: () => {
          throw failure;
        },
      });
      try {
        await applyMergedEntityInputs(
          broken.env,
          [
            {
              from: `0x${'d3'.repeat(20)}`,
              entityId: broken.entityId,
              signerId: broken.signerId,
              entityTxs: [],
            },
          ],
          [],
          {
            isReplay: false,
            routingDeps: {
              ensureRuntimeInfrastructure: targetEnv => targetEnv.infrastructure!,
              enqueueRuntimeInputs: () => {},
              extractEntityId: replicaKey => replicaKey.split(':')[0] ?? '',
              hasLocalSignerForEntity: () => true,
              hasLocalSignerForEntitySigner: () => true,
              resolveSoleLocalSignerForEntity: () => broken.signerId,
              getP2P: () => null,
            },
          },
        );
      } catch (error) {
        expect(error).toBeInstanceOf(RuntimeEntityInputApplyError);
        return error as RuntimeEntityInputApplyError;
      }
      throw new Error('TEST_REMOTE_BROKEN_STATE_DID_NOT_FAIL');
    };
    expect(
      (await applyRemoteAgainstBrokenState('remote-storage-failure-fatal', storageFailure('STORAGE_NODE_HASH_MISMATCH')))
        .failureKind,
    ).toBe('storage');
    expect(
      (await applyRemoteAgainstBrokenState('remote-local-bug-fatal', new TypeError('unexpected undefined state')))
        .failureKind,
    ).toBe('local-bug');

    const invariant = makeRuntime('remote-business-rejection-discard');
    const authorizedInvariantTxs = await buildQuorumAuthorizedFrameTxs(invariant.env, invariant.state, [
      {
        type: 'directPayment',
        data: {
          targetEntityId: `0x${'d1'.repeat(32)}`,
          tokenId: 1,
          amount: 1n,
          route: [],
        },
      } as any,
    ]);
    await expect(
      processRuntime(invariant.env, [
        {
          from: `0x${'d2'.repeat(20)}`,
          entityId: invariant.entityId,
          signerId: invariant.signerId,
          entityTxs: authorizedInvariantTxs,
        },
      ]),
    ).resolves.toBe(invariant.env);
    expect(invariant.env.infrastructure?.halted).not.toBe(true);
    const invariantRetryTypes = (invariant.env.runtimeMempool?.entityInputs ?? [])
      .flatMap(input => input.entityTxs?.map(tx => tx.type) ?? []);
    expect(invariantRetryTypes).not.toContain('entityCommand');
  });

  test('local signer resolution prefers an available local signer over a stale configured validator', () => {
    const env = createEmptyEnv('local-signer-resolution-stale-config');
    env.scenarioMode = false;
    env.quietRuntimeLogs = true;
    const { entityId, signerId: actualSignerId } = registerLazySigner('local-signer-resolution-stale-config', 'actual');
    const staleConfigSignerId = `0x${'9c'.repeat(20)}`;
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(staleConfigSignerId);
    env.state.eReplicas.set(`${entityId}:${actualSignerId}`, {
      entityId,
      signerId: actualSignerId,
      entityEncPubKey: '',
      mempool: [],
      isProposer: false,
      state,
    });

    expect(resolveEntityProposerId(env, entityId, 'audit')).toBe(actualSignerId);
  });

  test('sparse WAL replay resolves an Account output from its atomically stored signer witness', () => {
    const env = createEmptyEnv('replay-output-signer-witness');
    const entityId = `0x${'a1'.repeat(32)}`;
    const signerId = `0x${'a2'.repeat(20)}`;

    installReplayOutputSignerHints(env, new Map([[entityId, signerId]]));
    expect(resolveEntityProposerId(env, entityId, 'replayed-account-output')).toBe(signerId);

    clearReplayOutputSignerHints(env);
    expect(() => resolveEntityProposerId(env, entityId, 'replayed-account-output')).toThrow('SIGNER_RESOLUTION_FAILED');
  });

  test('runtime input admission rejects tx-bearing stale signer before enqueue', () => {
    const env = createEmptyEnv('runtime-input-admission-stale-signer');
    env.infrastructure = { lifecyclePhase: 'running', loopActive: true };
    env.scenarioMode = false;
    env.quietRuntimeLogs = true;
    const { entityId, signerId } = registerLazySigner('runtime-input-admission-stale-signer', '1');
    const staleSignerId = `0x${'9d'.repeat(20)}`;
    attachSigningReplica(env, entityId, signerId);

    expect(() =>
      validateRuntimeInputAdmission(env, {
        runtimeTxs: [],
        entityInputs: [
          {
            entityId,
            signerId: staleSignerId,
            entityTxs: [
              {
                type: 'openAccount',
                data: {
                  targetEntityId: `0x${'9e'.repeat(32)}`,
                  tokenId: 1,
                  creditAmount: 1n,
                },
              },
            ],
          },
        ],
      }),
    ).toThrow('RUNTIME_REPLICA_NOT_FOUND');
    expect(env.runtimeMempool?.entityInputs.length).toBe(0);
  });

  test('hub mesh bootstrap loop fail-fasts unexpected errors instead of logging forever', () => {
    let cleared = 0;
    const exits: number[] = [];
    const logs: unknown[][] = [];

    const halted = handleMeshBootstrapLoopError(new Error('BROKEN_BOOTSTRAP_INVARIANT'), {
      nodeName: 'H1',
      clearLoop: () => {
        cleared += 1;
      },
      exit: code => {
        exits.push(code);
      },
      logError: (...args) => {
        logs.push(args);
      },
    });

    expect(halted).toBe(true);
    expect(cleared).toBe(1);
    expect(exits).toEqual([1]);
    expect(String(logs[0]?.[0] || '')).toContain('mesh bootstrap tick fatal');

    const ignored = handleMeshBootstrapLoopError(new Error('ECONNRESET: response ended prematurely'), {
      nodeName: 'H1',
      clearLoop: () => {
        cleared += 1;
      },
      exit: code => {
        exits.push(code);
      },
      logError: (...args) => {
        logs.push(args);
      },
    });

    expect(ignored).toBe(false);
    expect(cleared).toBe(1);
    expect(exits).toEqual([1]);
    expect(String(logs.at(-1)?.[0] || '')).toContain('mesh bootstrap transport retry');
  });

  test('runtime input admission accounts for importReplica earlier in the same batch', () => {
    const env = createEmptyEnv('runtime-input-admission-import-replica');
    env.infrastructure = { lifecyclePhase: 'running', loopActive: true };
    env.scenarioMode = false;
    env.quietRuntimeLogs = true;
    const entityId = `0x${'9f'.repeat(32)}`;
    const signerId = `0x${'a0'.repeat(20)}`;

    expect(() =>
      validateRuntimeInputAdmission(env, {
        runtimeTxs: [
          {
            type: 'importReplica',
            entityId,
            signerId,
            data: {
              config: makeSingleSignerConfigFor(signerId),
              isProposer: true,
            },
          },
        ],
        entityInputs: [
          {
            entityId,
            signerId,
            entityTxs: [],
          },
        ],
      }),
    ).not.toThrow();
  });

  test('cross-j salvage routes tx-bearing output to route target signer over stale gossip signer', () => {
    const env = createEmptyEnv('cross-j-salvage-route-signer');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.state.timestamp = 10_000;
    const sourceUser = `0x${'a1'.repeat(32)}`;
    const sourceHub = `0x${'a2'.repeat(32)}`;
    const targetHub = `0x${'a3'.repeat(32)}`;
    const targetUser = `0x${'a4'.repeat(32)}`;
    const sourceSigner = `0x${'b1'.repeat(20)}`;
    const sourceHubSigner = `0x${'b2'.repeat(20)}`;
    const targetHubSigner = `0x${'b3'.repeat(20)}`;
    const targetSigner = `0x${'b4'.repeat(20)}`;
    const staleGossipSigner = `0x${'b5'.repeat(20)}`;
    const sourceState = makeEntityState(sourceUser);
    sourceState.config = makeSingleSignerConfigFor(sourceSigner);
    sourceState.crossJurisdictionSwaps = new Map();
    attachSigningReplica(env, targetUser, targetSigner);
    (env as RuntimeReplica & { gossip?: { getProfiles: () => unknown[] } }).gossip = {
      getProfiles: () => [
        {
          entityId: targetUser,
          metadata: { board: { validators: [{ signerId: staleGossipSigner }] } },
        },
      ],
    };

    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'salvage-route-signer',
        sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        sourceSignerId: sourceSigner,
        sourceHubSignerId: sourceHubSigner,
        targetHubSignerId: targetHubSigner,
        targetSignerId: targetSigner,
        source: {
          jurisdiction: `stack:1:0x${'c1'.repeat(20)}`,
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: 100n,
        },
        target: {
          jurisdiction: `stack:2:0x${'c2'.repeat(20)}`,
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 2,
          amount: 200n,
        },
        status: 'resting',
        createdAt: env.state.timestamp,
        updatedAt: env.state.timestamp,
      },
      {
        runtimeSeed: 'cross-j-salvage-route-signer',
        now: env.state.timestamp,
      },
    );
    route.fillSeq = 1;
    route.cumulativeFillRatio = 0x1234;
    route.claimedRatio = 0x1234;
    route.fillNumerator = 0x1234n;
    route.fillDenominator = 65_535n;
    route.filledSourceAmount = (BigInt(route.source.amount) * 0x1234n) / 65_535n;
    route.filledTargetAmount = (BigInt(route.target.amount) * 0x1234n) / 65_535n;
    route.sourceClaimed = route.filledSourceAmount;
    route.targetClaimed = route.filledTargetAmount;
    route.status = 'partially_filled';
    sourceState.crossJurisdictionSwaps.set(route.orderId, route);

    const reveal = buildCrossJurisdictionPullReveal(
      route,
      0x1234,
      deriveCrossJurisdictionPrivateSeed('cross-j-salvage-route-signer', route),
    );
    const binary = reveal.binary;
    const revealEvent = {
      entity: sourceHub,
      counterpartyEntity: sourceUser,
      ladderHash: ethers.keccak256(ethers.solidityPacked(
        ['bytes32', 'bytes32'],
        [route.sourcePull!.fullHash, route.sourcePull!.partialRoot],
      )),
      fillRatio: 0x1234,
      fullSecret: reveal.fullSecret ?? `0x${'00'.repeat(32)}`,
      reveals: reveal.reveals ?? [
        `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`,
        `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`,
      ] as [string, string, string, string],
      targetRole: false,
    };
    const outputs: EntityInput[] = [];

    // The registry event is the only trigger: the source-user lane emits one
    // port instruction to the target lane named by the route, never to a stale
    // gossip-hinted signer.
    expect(
      queueCrossJurisdictionRevealPorts(
        sourceState,
        outputs,
        revealEvent,
        123,
      ),
    ).toBe(1);

    const salvageOutput = outputs.find(output => output.entityTxs?.some(tx => tx.type === 'crossJurisdictionSalvage'));
    expect(salvageOutput?.entityId).toBe(targetUser);
    expect(salvageOutput?.signerId).toBe(targetSigner);
    expect(salvageOutput?.signerId).not.toBe(staleGossipSigner);
    expect(
      (salvageOutput?.entityTxs?.[0]?.data as { binary?: string }).binary,
    ).toBe(binary);

    const observerWarnings: string[] = [];
    const unregisterSink = registerStructuredLogSink(event => {
      if (event.level === 'warn') observerWarnings.push(event.message);
    });
    try {
      const peerObserver = makeEntityState(sourceHub);
      const peerOutputs: EntityInput[] = [];
      expect(
        queueCrossJurisdictionRevealPorts(
          peerObserver,
          peerOutputs,
          revealEvent,
          123,
        ),
      ).toBe(0);
      expect(peerOutputs).toEqual([]);
    } finally {
      unregisterSink();
    }
    expect(observerWarnings).toEqual([]);
  });

  test('runtime ingress still rejects stale signer hints when local target signer is ambiguous', async () => {
    const env = createEmptyEnv('stale-signer-ambiguous');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const signerA = `0x${'a1'.repeat(20)}`;
    const signerB = `0x${'b1'.repeat(20)}`;
    const entityId = generateLazyEntityId([signerA, signerB], 2n).toLowerCase();
    const staleSignerId = `0x${'cc'.repeat(20)}`;
    const config: EntityState['config'] = {
      ...makeSingleSignerConfigFor(signerA),
      threshold: 2n,
      validators: [signerA, signerB],
      shares: { [signerA]: 1n, [signerB]: 1n },
    };
    for (const signerId of [signerA, signerB]) {
      const state = makeEntityState(entityId);
      state.config = structuredClone(config);
      env.state.eReplicas.set(`${entityId}:${signerId}`, {
        entityId,
        signerId,
        entityEncPubKey: '',
        mempool: [],
        isProposer: signerId === signerA,
        state,
      });
    }

    await expect(
      processRuntime(env, [
        {
          entityId,
          signerId: staleSignerId,
          entityTxs: [],
        },
      ]),
    ).rejects.toThrow('RUNTIME_REPLICA_NOT_FOUND');
  });

  test('rejects an oversized ingress atomically before it enters the Runtime mempool', async () => {
    const env = createEmptyEnv('audit-regression-seed');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;

    const inputs = Array.from({ length: 10001 }, (_, i) => ({
      entityId: `0x${i.toString(16).padStart(64, '0')}`,
      entityTxs: [],
    }));

    await expect(processRuntime(env, inputs))
      .rejects.toThrow('RUNTIME_MEMPOOL_CAPACITY_EXCEEDED:entityInputs:10001:10000');
    expect(env.state.height).toBe(0);
    expect(env.runtimeMempool?.entityInputs.length).toBe(0);
  });

  test('safeStringify throws instead of hashing a placeholder string', () => {
    expect(() => safeStringify({ bad: new Date(Number.NaN) })).toThrow('SAFE_STRINGIFY_FAILED');
  });

  test('hanko verification lets an already-verified child satisfy its parent threshold', async () => {
    const hash = `0x${'ab'.repeat(32)}`;
    const signerPrivateKey = deriveSignerKeySync('hanko-eoa-threshold-divergence', '1');
    const signerAddress = deriveSignerAddressSync('hanko-eoa-threshold-divergence', '1');
    const signerEntityId = ethers.zeroPadValue(signerAddress, 32).toLowerCase();
    const proposerAddress = deriveSignerAddressSync('hanko-eoa-threshold-divergence', '2');
    const proposerEntityId = ethers.zeroPadValue(proposerAddress, 32).toLowerCase();
    const nestedEntityId = hashHankoBoard(1, [signerEntityId], [1]);
    const rootEntityId = hashHankoBoard(60, [proposerEntityId, nestedEntityId], [40, 60]);
    const hanko = signedHankoForTest(
      hash,
      [signerPrivateKey],
      [proposerEntityId],
      [
        [nestedEntityId, [1n], [1n], 1n],
        [rootEntityId, [0n, 2n], [40n, 60n], 60n],
      ],
    );

    const result = await verifyHankoForHash(hanko, hash, rootEntityId);

    // The child claim independently reaches quorum from the real EOA. The
    // ordered parent may therefore count the child's configured board weight.
    expect(result.valid).toBe(true);
    expect(result.entityId).toBe(rootEntityId);
  });

  test('registered hanko verification accepts a board that matches local registered config', async () => {
    const hash = `0x${'bc'.repeat(32)}`;
    const env = createEmptyEnv('registered-hanko-board-positive');
    const signerPrivateKey = deriveSignerKeySync('registered-hanko-board-positive', '1');
    const signerAddress = deriveSignerAddressSync('registered-hanko-board-positive', '1').toLowerCase();
    const entityId = generateNumberedEntityId(42).toLowerCase();
    const jurisdiction = {
      name: 'Registered Hanko positive',
      address: 'http://127.0.0.1:8545',
      chainId: 31_337,
      depositoryAddress: `0x${'31'.repeat(20)}`,
      entityProviderAddress: `0x${'32'.repeat(20)}`,
      entityProviderDeploymentBlock: 4,
      registrationBlock: 5,
    } satisfies JurisdictionConfig;
    const config: ConsensusConfig = {
      mode: 'proposer-based',
      threshold: 1n,
      validators: [signerAddress],
      shares: { [signerAddress]: 1n },
      jurisdiction,
    };
    env.state.eReplicas.set(`${entityId}:${signerAddress}`, {
      entityId,
      signerId: signerAddress,
      entityEncPubKey: '',
      mempool: [],
      isProposer: true,
      state: { entityId, config },
    } as unknown as EntityReplica);
    const jReplica = createJReplica(env, jurisdiction.name, jurisdiction.depositoryAddress);
    jReplica.chainId = jurisdiction.chainId;
    jReplica.contracts = { ...jReplica.contracts, depository: jurisdiction.depositoryAddress };
    jReplica.contracts = { ...jReplica.contracts, entityProvider: jurisdiction.entityProviderAddress };
    jReplica.watcherConfirmationDepth = 0;
    const state = env.state.eReplicas.get(`${entityId}:${signerAddress}`)!.state;
    const boardHash = hashHankoBoard(1, [ethers.zeroPadValue(signerAddress, 32)], [1]);
    await installCanonicalRegisteredBoardAuthority(env, jurisdiction, state, boardHash);
    const hanko = signedHankoForTest(hash, [signerPrivateKey], [], [[entityId, [0n], [1n], 1n]]);

    const registeredBoardHash = resolveCertifiedRegisteredBoardHash(env, entityId, jurisdiction);
    const result = await verifyHankoForHash(
      hanko,
      hash,
      entityId,
      env,
      registeredBoardHash ? { registeredBoardHash } : undefined,
    );

    expect(registeredBoardHash).toBe(boardHash);
    expect(result.valid).toBe(true);
    expect(result.entityId?.toLowerCase()).toBe(entityId);
  });

  test('registered hanko verification rejects forged self-contained board without local board of record', async () => {
    const hash = `0x${'bd'.repeat(32)}`;
    const signerPrivateKey = deriveSignerKeySync('registered-hanko-board-missing', '1');
    const entityId = generateNumberedEntityId(43).toLowerCase();
    const hanko = signedHankoForTest(hash, [signerPrivateKey], [], [[entityId, [0n], [1n], 1n]]);

    const result = await verifyHankoForHash(hanko, hash, entityId);

    expect(result.valid).toBe(false);
    expect(result.entityId).toBeNull();
  });

  test('registered hanko verification rejects forged board even when signer is a real validator', async () => {
    const hash = `0x${'be'.repeat(32)}`;
    const env = createEmptyEnv('registered-hanko-board-mismatch');
    const signerPrivateKey = deriveSignerKeySync('registered-hanko-board-mismatch', '1');
    const signerAddress = deriveSignerAddressSync('registered-hanko-board-mismatch', '1').toLowerCase();
    const cosignerAddress = deriveSignerAddressSync('registered-hanko-board-mismatch', '2').toLowerCase();
    const entityId = generateNumberedEntityId(44).toLowerCase();
    const config: ConsensusConfig = {
      mode: 'proposer-based',
      threshold: 2n,
      validators: [signerAddress, cosignerAddress],
      shares: { [signerAddress]: 1n, [cosignerAddress]: 1n },
    };
    env.state.eReplicas.set(`${entityId}:${signerAddress}`, {
      entityId,
      signerId: signerAddress,
      entityEncPubKey: '',
      mempool: [],
      isProposer: true,
      state: { entityId, config },
    } as unknown as EntityReplica);
    const forgedHanko = signedHankoForTest(hash, [signerPrivateKey], [], [[entityId, [0n], [1n], 1n]]);

    const result = await verifyHankoForHash(forgedHanko, hash, entityId, env);

    expect(result.valid).toBe(false);
    expect(result.entityId).toBeNull();
  });

  test('j_event rejects non-validator signer ids before observation aggregation', async () => {
    const seed = 'j-event-non-validator';
    const env = createEmptyEnv(seed);
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(signerId);
    const event: JurisdictionEvent = {
      type: 'ReserveUpdated',
      data: {
        entity: state.entityId,
        tokenId: 1,
        newBalance: '100',
      },
    };
    const validRange = buildJEventRangeData(
      state,
      {
        from: signerId,
        jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
        observedAt: 1_000,
        blockNumber: 1,
        blockHash: `0x${'22'.repeat(32)}`,
        transactionHash: `0x${'33'.repeat(32)}`,
        event,
      },
      env,
    );

    await expect(
      applyJEvent(
        state,
        {
          ...validRange,
          from: 'not-a-validator',
        },
        env,
      ),
    ).rejects.toThrow('J_RANGE_NOT_ACTIVE_PROPOSER');
  });

  test('single-validator j_event observations must still be signed by the claimed signer', async () => {
    const seed = 'j-event-single-validator-signature';
    const env = createEmptyEnv(seed);
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(signerId);
    const event: JurisdictionEvent = {
      type: 'ReserveUpdated',
      data: { entity: entityId, tokenId: 1, newBalance: '100' },
    };
    const common = {
      from: signerId,
      jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
      observedAt: 1_000,
      blockNumber: 2,
      blockHash: `0x${'12'.repeat(32)}`,
      transactionHash: `0x${'13'.repeat(32)}`,
      event,
    };
    const signed = prepareJEventInput(env, entityId, signerId, {
      blockNumber: common.blockNumber,
      blockHash: common.blockHash,
      transactionHash: common.transactionHash,
      events: [event],
      jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
    });

    const unsignedSignature = buildJEventRangeData(state, { ...common, ...signed }, env);
    await expect(applyJEvent(state, { ...unsignedSignature, signature: '' }, env)).rejects.toThrow(
      'invalid proposer signature',
    );

    const result = await applyJEventRange(state, { ...common, ...signed }, env);
    expect(result.newState.jBlockChain.length).toBe(1);
    expect(result.newState.reserves.get(1)).toBe(100n);
  });

  test('AccountSettled applies explicit zero reserve instead of leaving stale local balance', async () => {
    const seed = 'account-settled-zero-reserve';
    const env = createEmptyEnv(seed);
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const counterpartyId = `0x${'42'.repeat(32)}`;
    let state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(signerId);
    const initialReserveEvent: JurisdictionEvent = {
      type: 'ReserveUpdated',
      data: {
        entity: entityId,
        tokenId: 1,
        newBalance: '777',
      },
    };
    const initialCommon = {
      from: signerId,
      observedAt: 1_000,
      blockNumber: 3,
      blockHash: `0x${'15'.repeat(32)}`,
      transactionHash: `0x${'18'.repeat(32)}`,
      event: initialReserveEvent,
    };
    const initialSigned = prepareJEventInput(env, entityId, signerId, {
      blockNumber: initialCommon.blockNumber,
      blockHash: initialCommon.blockHash,
      transactionHash: initialCommon.transactionHash,
      events: [initialReserveEvent],
      jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
    });
    state = (await applyJEventRange(state, { ...initialCommon, ...initialSigned }, env)).newState;
    expect(state.reserves.get(1)).toBe(777n);
    const event: JurisdictionEvent = {
      type: 'AccountSettled',
      data: {
        leftEntity: entityId,
        rightEntity: counterpartyId,
        tokenId: 1,
        leftReserve: '0',
        rightReserve: '12',
        collateral: '0',
        ondelta: '0',
        nonce: 1,
      },
    };
    const common = {
      from: signerId,
      observedAt: 1_000,
      blockNumber: 4,
      blockHash: `0x${'16'.repeat(32)}`,
      transactionHash: `0x${'17'.repeat(32)}`,
      event,
    };
    const signed = prepareJEventInput(env, entityId, signerId, {
      blockNumber: common.blockNumber,
      blockHash: common.blockHash,
      transactionHash: common.transactionHash,
      events: [event],
      jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
    });

    const result = await applyJEventRange(state, { ...common, ...signed }, env);

    expect(result.newState.reserves.get(1)).toBe(0n);
  });

  test('j_event auth rejects are fatal inside applyEntityTx', async () => {
    const seed = 'j-event-auth-reject-fatal';
    const env = createEmptyEnv(seed);
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(signerId);
    const event: JurisdictionEvent = {
      type: 'ReserveUpdated',
      data: { entity: entityId, tokenId: 1, newBalance: '100' },
    };
    const range = buildJEventRangeData(
      state,
      {
        from: signerId,
        jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
        observedAt: 3,
        blockNumber: 3,
        blockHash: `0x${'14'.repeat(32)}`,
        transactionHash: `0x${'15'.repeat(32)}`,
        event,
      },
      env,
    );

    await expect(
      applyEntityTx(env, state, {
        type: 'j_event',
        data: { ...range, signature: '' },
      }),
    ).rejects.toThrow('j_event rejected: invalid proposer signature');
  });

  test('swap requests fail loud when the target account is missing', async () => {
    const env = createEmptyEnv('swap-request-missing-account');
    const state = makeEntityState(`0x${'62'.repeat(32)}`);
    const missingCounterparty = `0x${'63'.repeat(32)}`;

    await expect(
      applyEntityTx(env, state, {
        type: 'placeSwapOffer',
        data: {
          counterpartyEntityId: missingCounterparty,
          offerId: 'missing-account-offer',
          giveTokenId: 1,
          giveAmount: 100n,
          wantTokenId: 2,
          wantAmount: 200n,
        },
      } as any),
    ).rejects.toThrow('SWAP_REQUEST_ACCOUNT_MISSING:placeSwapOffer');

    await expect(
      applyEntityTx(env, state, {
        type: 'proposeCancelSwap',
        data: {
          counterpartyEntityId: missingCounterparty,
          offerId: 'missing-account-offer',
        },
      } as any),
    ).rejects.toThrow('SWAP_REQUEST_ACCOUNT_MISSING:proposeCancelSwap');
  });

  test('direct payment rejects invalid route topology without an invariant halt', async () => {
    const env = createEmptyEnv('direct-payment-invalid-route');
    env.quietRuntimeLogs = true;
    const source = `0x${'64'.repeat(32)}`;
    const wrongStart = `0x${'65'.repeat(32)}`;
    const target = `0x${'66'.repeat(32)}`;
    const missingNextHop = `0x${'67'.repeat(32)}`;
    const wrongEnd = `0x${'68'.repeat(32)}`;
    const state = makeEntityState(source);
    const signerId = installSingleSignerBoard(env, state);

    expect(() =>
      prepareLocallyAuthoredEntityTxs(env, state, signerId, [
        {
          type: 'directPayment',
          data: { targetEntityId: target, tokenId: 1, amount: 100n, route: [] },
        },
      ]),
    ).toThrow('DIRECT_PAYMENT_ROUTE_REQUIRED');

    const expectRejected = async (tx: EntityTx, code: string): Promise<void> => {
      const result = await applyEntityTx(env, state, tx);
      expect(result.newState).toBe(state);
      expect(result.skippedError).toContain(code);
    };

    await expectRejected({
        type: 'directPayment',
        data: {
          targetEntityId: target,
          tokenId: 1,
          amount: 100n,
          route: [],
        },
      } as any, 'DIRECT_PAYMENT_ROUTE_REQUIRED');

    await expectRejected({
        type: 'directPayment',
        data: {
          targetEntityId: target,
          tokenId: 1,
          amount: 100n,
          route: [wrongStart, target],
        },
      } as any, 'DIRECT_PAYMENT_ROUTE_START_INVALID');

    await expectRejected({
        type: 'directPayment',
        data: {
          targetEntityId: target,
          tokenId: 1,
          amount: 100n,
          route: [source, wrongEnd],
        },
      } as any, 'DIRECT_PAYMENT_ROUTE_END_INVALID');

    await expectRejected({
        type: 'directPayment',
        data: { targetEntityId: target, tokenId: 1, amount: 100n, route: [source, target] },
      } as any, 'DIRECT_PAYMENT_DELIVERY_MODE_INVALID');

    await expectRejected({
        type: 'directPayment',
        data: {
          targetEntityId: target,
          tokenId: 1,
          amount: 100n,
          route: [source, missingNextHop, target],
          deliveryMode: 'trusted',
          trustedGatewayEntityId: missingNextHop,
        },
      } as any, 'DIRECT_PAYMENT_NEXT_HOP_ACCOUNT_MISSING');
  });

  test('entity frame aborts instead of partially committing after a skipped tx', async () => {
    const env = createEmptyEnv('entity-frame-atomicity');
    env.quietRuntimeLogs = true;
    const state = makeEntityState(`0x${'61'.repeat(32)}`);
    const signer = installSingleSignerBoard(env, state);
    const frameTimestamp = 1_000;

    const frameTxs = await buildQuorumAuthorizedFrameTxs(
      env,
      state,
      [
        { type: 'chatMessage', data: { message: 'first mutation' } } as any,
        { type: 'definitely_unknown_entity_tx', data: {} } as any,
        { type: 'chatMessage', data: { message: 'late mutation' } } as any,
      ],
      frameTimestamp,
    );
    env.overlay = new Map();
    if (env.infrastructure) env.infrastructure.currentStorageOverlayMarks = new Map();
    await expect(applyEntityFrameWithMaterializedTestInfraContext(env, state, frameTxs, frameTimestamp)).rejects.toThrow(
      'ENTITY_FRAME_TX_FAILED: type=definitely_unknown_entity_tx',
    );

    expect(readEntityFrameEventMessages(state)).toHaveLength(0);
    expect(state.nonces.has(signer)).toBe(false);
    expect(env.infrastructure?.currentStorageOverlayMarks ?? new Map()).toEqual(new Map());
  });

  test('entity frame keeps reducer storage changes local until exact commit', async () => {
    const env = createEmptyEnv('entity-frame-storage-commit-boundary');
    env.quietRuntimeLogs = true;
    env.state.timestamp = 1_000;
    const state = makeEntityState(`0x${'60'.repeat(32)}`);
    installSingleSignerBoard(env, state);
    const frameTxs = await buildQuorumAuthorizedFrameTxs(env, state, [
      { type: 'chatMessage', data: { message: 'commit-bound storage change' } } as any,
    ]);
    env.overlay = new Map();
    if (env.infrastructure) env.infrastructure.currentStorageOverlayMarks = new Map();

    const applied = await applyEntityFrameWithMaterializedTestInfraContext(env, state, frameTxs, env.state.timestamp);

    expect(readEntityFrameEventMessages(applied.newState)).toHaveLength(1);
    expect(applied.storageChanges).toContainEqual({ family: 'entity', entityId: state.entityId });
    expect(env.infrastructure?.currentStorageOverlayMarks ?? new Map()).toEqual(new Map());
  });

  test('cross-j remote route cannot seed missing sibling runtime hints before topology validation', async () => {
    const env = createEmptyEnv('cross-j-topology-hints');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const localRuntime = `0x${'10'.repeat(20)}`;
    const remoteRuntime = `0x${'20'.repeat(20)}`;
    env.runtimeId = localRuntime;
    const sourceSigner = `0x${'33'.repeat(20)}`;
    const targetSigner = `0x${'34'.repeat(20)}`;
    const sourceUserId = generateLazyEntityId([sourceSigner], 1n).toLowerCase();
    const targetUserId = generateLazyEntityId([targetSigner], 1n).toLowerCase();
    const sourceHubId = `0x${'41'.repeat(32)}`;
    const targetHubId = `0x${'42'.repeat(32)}`;
    attachSigningReplica(env, sourceUserId, sourceSigner);
    attachSigningReplica(env, targetUserId, targetSigner);

    await expect(
      processRuntime(env, [
        {
          from: remoteRuntime,
          entityId: sourceUserId,
          signerId: sourceSigner,
          entityTxs: [
            {
              type: 'registerCrossJurisdictionSwap',
              data: {
                route: {
                  orderId: 'route-derived-hint-attack',
                  source: { entityId: sourceUserId, counterpartyEntityId: sourceHubId },
                  target: { entityId: targetHubId, counterpartyEntityId: targetUserId },
                  bookOwnerEntityId: sourceHubId,
                  hubEntityId: sourceHubId,
                },
              },
            } as any,
          ],
        },
      ]),
    ).rejects.toThrow('RUNTIME_CROSS_J_EXTERNAL_INGRESS_FORBIDDEN');
  });

  test('cross-j order admission requires the atomic prepared route', () => {
    const sourceUser = `0x${'31'.repeat(32)}`;
    const sourceHub = `0x${'41'.repeat(32)}`;
    const targetHub = `0x${'42'.repeat(32)}`;
    const targetUser = `0x${'32'.repeat(32)}`;
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-admit-atomic-route',
        sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        bookOwnerEntityId: sourceHub,
        source: {
          jurisdiction: 'stack:31337:0x1111111111111111111111111111111111111111',
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: 1_000n,
        },
        target: {
          jurisdiction: 'stack:31338:0x2222222222222222222222222222222222222222',
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 2,
          amount: 900n,
        },
        status: 'intent',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 60_000,
      },
      { runtimeSeed: 'cross-admit-atomic-route', now: 1_000 },
    );
    const restingRoute = { ...route, status: 'resting' as const };
    const state = makeEntityState(sourceHub);
    state.config = {
      ...state.config,
      jurisdiction: {
        ...state.config.jurisdiction,
        name: 'Source admission stack',
        chainId: 31337,
        depositoryAddress: `0x${'11'.repeat(20)}`,
      },
    };
    const env = createEmptyEnv('cross-admit-atomic-route');
    env.state.timestamp = 1_000;

    expect(getCrossJurisdictionBookAdmissionError(state, restingRoute, env.state.timestamp)).toContain(
      'CROSS_J_BOOK_ADMISSION_PENDING',
    );
    const admitted = handleAdmitCrossJurisdictionBookOrderEntityTx(env, state, {
      type: 'admitCrossJurisdictionBookOrder',
      data: { route: restingRoute, reason: 'atomic_account_pair_committed' },
    });
    expect(admitted.swapOffersCreated).toHaveLength(1);
    expect(admitted.newState.crossJurisdictionBookAdmissions?.values().next().value?.status).toBe('admitted');
    expect(() => assertCrossJurisdictionOrderAdmissible(admitted.newState, restingRoute, env.state.timestamp)).not.toThrow();

    const admission = admitted.newState.crossJurisdictionBookAdmissions?.values().next().value;
    if (!admission) throw new Error('test fixture missing cross-j admission');
    admission.status = 'resolving';
    const duplicate = handleAdmitCrossJurisdictionBookOrderEntityTx(env, admitted.newState, {
      type: 'admitCrossJurisdictionBookOrder',
      data: { route: restingRoute, reason: 'duplicate_atomic_commit' },
    });
    expect(duplicate.swapOffersCreated).toHaveLength(0);
    expect(duplicate.newState.crossJurisdictionBookAdmissions?.values().next().value?.status).toBe('resolving');
  });

  test('committed source pull advances source route to resting before fill notice', () => {
    const env = createEmptyEnv('cross-j-source-commit-resting');
    env.state.timestamp = 10_000;
    const sourceUser = `0x${'31'.repeat(32)}`;
    const sourceHub = `0x${'41'.repeat(32)}`;
    const targetHub = `0x${'42'.repeat(32)}`;
    const targetUser = `0x${'32'.repeat(32)}`;
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-source-commit-resting',
        sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        makerEntityId: sourceUser,
        hubEntityId: sourceHub,
        bookOwnerEntityId: sourceHub,
        sourceHubSignerId: '1',
        targetHubSignerId: 'target-hub-signer',
        bookHubSignerId: '1',
        venueId: 'cross:test:1/target:2',
        source: {
          jurisdiction: `stack:31337:0x${'dd'.repeat(20)}`,
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: 1_000n,
        },
        target: {
          jurisdiction: `stack:31338:0x${'de'.repeat(20)}`,
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 2,
          amount: 900n,
        },
        status: 'target_prepared',
        createdAt: 10_000,
        updatedAt: 10_000,
        expiresAt: 60_000,
      },
      { runtimeSeed: 'cross-source-commit-resting', now: 10_000 },
    );
    const sourceHubState = makeEntityState(sourceHub);
    sourceHubState.crossJurisdictionSwaps = new Map([[route.orderId, route]]);
    attachSigningReplica(env, sourceHub, '1');
    const outputs: EntityInput[] = [];
    const swapOffersCreated: SwapOfferEvent[] = [];
    const committedRoute = {
      ...route,
      status: 'resting' as const,
    };

    applyCommittedCrossJurisdictionAccountTxFollowup(
      env,
      sourceHubState,
      sourceUser,
      {
        type: 'cross_pull_lock',
        data: {
          pullId: route.sourcePull!.pullId,
          tokenId: route.sourcePull!.tokenId,
          amount: route.sourcePull!.signedAmount,
          fullHash: route.sourcePull!.fullHash,
          partialRoot: route.sourcePull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(committedRoute, 'source'),
          crossJurisdictionRoute: committedRoute,
        },
      },
      outputs,
      env.state.timestamp,
      swapOffersCreated,
    );

    const sourceRoute = sourceHubState.crossJurisdictionSwaps.get(route.orderId);
    expect(sourceRoute?.status).toBe('resting');
    expect(outputs).toHaveLength(0);
    expect(sourceHubState.crossJurisdictionBookAdmissions?.size).toBe(1);
    expect(sourceHubState.crossJurisdictionBookAdmissions?.values().next().value?.status).toBe('admitted');
    expect(swapOffersCreated).toHaveLength(1);
  });

  test('cross-j same-token swap_offer quantizes by jurisdiction market side', async () => {
    const sourceUser = `0x${'33'.repeat(32)}`;
    const sourceHub = `0x${'43'.repeat(32)}`;
    const targetHub = `0x${'44'.repeat(32)}`;
    const targetUser = `0x${'34'.repeat(32)}`;
    const sourcePull = {
      pullId: 'same-token-source-pull',
      tokenId: 1,
      amount: 2_000_000_000_000n,
      signedAmount: 2_000_000_000_000n,
      fullHash: `0x${'ab'.repeat(32)}`,
      partialRoot: `0x${'bc'.repeat(32)}`,
    };
    const targetPull = {
      pullId: 'same-token-target-pull',
      tokenId: 1,
      amount: 1_000_000_000_000n,
      signedAmount: 1_000_000_000_000n,
      fullHash: `0x${'cd'.repeat(32)}`,
      partialRoot: `0x${'de'.repeat(32)}`,
    };
    const route = {
      orderId: 'cross-same-token-offer',
      makerEntityId: sourceUser,
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      hubEntityId: targetHub,
      bookOwnerEntityId: targetHub,
      venueId:
        'cross:stack:31337:0x1111111111111111111111111111111111111111:1/stack:31338:0x2222222222222222222222222222222222222222:1',
      source: {
        jurisdiction: 'stack:31338:0x2222222222222222222222222222222222222222',
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: sourcePull.amount,
      },
      target: {
        jurisdiction: 'stack:31337:0x1111111111111111111111111111111111111111',
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 1,
        amount: targetPull.amount,
      },
      sourcePull,
      targetPull,
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 60_000,
    } satisfies CrossJurisdictionSwapRoute;
    const admittedRoute = route;
    const account = makeProposalAccount([], sourceUser, sourceHub);
    account.state.pulls = new Map([
      [
        sourcePull.pullId,
        {
          ...sourcePull,
          crossJurisdiction: buildCrossJurisdictionPullBinding(admittedRoute, 'source'),
        },
      ],
    ]);

    const result = await handleSwapOffer(
      account,
      {
        type: 'swap_offer',
        data: {
          offerId: route.orderId,
          giveTokenId: 1,
          ...getStaticSwapTokenDimensions(1, 1),
          giveAmount: route.source.amount,
          wantTokenId: 1,
          wantAmount: route.target.amount,
          maxFee: 0n,
          minNetReceive: route.target.amount,
          priceTicks: 20_000n,
          crossJurisdiction: admittedRoute,
        },
      },
      true,
      1,
    );

    expect(result.ok).toBe(true);
    const offer = account.state.swapOffers.get(route.orderId);
    expect(offer?.giveAmount).toBe(route.source.amount);
    expect(offer?.wantAmount).toBe(route.target.amount);
    expect(offer?.priceTicks).toBe(20_000n);
  });

  test('market maker cross amount fitting round-trips through account swap_offer for both market sides', async () => {
    const cases = [
      {
        label: 'source-base',
        sourceJurisdiction: 'stack:31337:0x1111111111111111111111111111111111111111',
        targetJurisdiction: 'stack:31338:0x2222222222222222222222222222222222222222',
        sourceTokenId: 2,
        targetTokenId: 1,
        sourceAmount: 123_456_789n * SWAP_LOT_SCALE,
        targetAmount: 308_642_000_000_000_000_000_000n,
        priceTicks: 25_000_123n,
      },
      {
        label: 'source-quote',
        sourceJurisdiction: 'stack:31337:0x3333333333333333333333333333333333333333',
        targetJurisdiction: 'stack:31338:0x4444444444444444444444444444444444444444',
        sourceTokenId: 1,
        targetTokenId: 2,
        sourceAmount: 308_642_000_000_000_000_000_000n,
        targetAmount: 123_456_789n * SWAP_LOT_SCALE,
        priceTicks: 25_000_123n,
      },
    ] as const;

    for (const entry of cases) {
      const sourceMm = `0x${(entry.label === 'source-base' ? '37' : '38').repeat(32)}`;
      const sourceHub = `0x${(entry.label === 'source-base' ? '47' : '48').repeat(32)}`;
      const targetHub = `0x${(entry.label === 'source-base' ? '57' : '58').repeat(32)}`;
      const targetMm = `0x${(entry.label === 'source-base' ? '67' : '68').repeat(32)}`;
      const amounts = fitCrossAmountsToOrderbook(
        entry.sourceJurisdiction,
        entry.sourceTokenId,
        entry.sourceAmount,
        entry.targetJurisdiction,
        entry.targetTokenId,
        entry.targetAmount,
        entry.priceTicks,
      );
      if (!amounts) throw new Error(`test fixture did not fit ${entry.label}`);
      const route = buildPreparedCrossJurisdictionRoute(
        {
          orderId: `mm-fit-roundtrip-${entry.label}`,
          sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
          targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
          makerEntityId: sourceMm,
          hubEntityId: sourceHub,
          source: {
            jurisdiction: entry.sourceJurisdiction,
            entityId: sourceMm,
            counterpartyEntityId: sourceHub,
            tokenId: entry.sourceTokenId,
            amount: amounts.sourceAmount,
          },
          target: {
            jurisdiction: entry.targetJurisdiction,
            entityId: targetHub,
            counterpartyEntityId: targetMm,
            tokenId: entry.targetTokenId,
            amount: amounts.targetAmount,
          },
          priceTicks: amounts.priceTicks,
          status: 'intent',
          createdAt: 1_000,
          updatedAt: 1_000,
          expiresAt: 61_000,
        },
        { runtimeSeed: `mm-fit-roundtrip-${entry.label}`, now: 1_000 },
      );
      const restingRoute = withCanonicalCrossJurisdictionRouteHash({
        ...route,
        status: 'resting' as const,
        updatedAt: 1_001,
      });
      const account = makeProposalAccount([], sourceMm, sourceHub);
      account.state.pulls = new Map([
        [
          route.sourcePull!.pullId,
          {
            pullId: route.sourcePull!.pullId,
            tokenId: route.sourcePull!.tokenId,
            amount: route.sourcePull!.signedAmount,
            claimedRatio: 0,
            claimedAmount: 0n,
            fullHash: route.sourcePull!.fullHash,
            partialRoot: route.sourcePull!.partialRoot,
            crossJurisdiction: buildCrossJurisdictionPullBinding(restingRoute, 'source'),
            createdHeight: 1,
            createdTimestamp: 1_000,
          },
        ],
      ]);

      const result = await handleSwapOffer(
        account,
        {
          type: 'swap_offer',
          data: {
            offerId: restingRoute.orderId,
            giveTokenId: restingRoute.source.tokenId,
            ...getStaticSwapTokenDimensions(
              restingRoute.source.tokenId,
              restingRoute.target.tokenId,
            ),
            giveAmount: restingRoute.source.amount,
            wantTokenId: restingRoute.target.tokenId,
            wantAmount: restingRoute.target.amount,
            maxFee: 0n,
            minNetReceive: restingRoute.target.amount,
            crossJurisdiction: restingRoute,
          },
        },
        true,
        1,
      );

      expect(result.ok ? undefined : result.rejection.message).toBeUndefined();
      expect(result.ok).toBe(true);
      const offer = account.state.swapOffers.get(restingRoute.orderId);
      expect(offer?.giveAmount).toBe(amounts.sourceAmount);
      expect(offer?.wantAmount).toBe(amounts.targetAmount);
      expect(offer?.priceTicks).toBe(amounts.priceTicks);
    }
  });

  test('target-side cross-j book owner admits the atomic remote source route', () => {
    const sourceUser = `0x${'35'.repeat(32)}`;
    const sourceHub = `0x${'45'.repeat(32)}`;
    const targetHub = `0x${'46'.repeat(32)}`;
    const targetUser = `0x${'36'.repeat(32)}`;
    const sourcePull = {
      pullId: 'remote-source-pull',
      tokenId: 1,
      amount: 75_000_000_000_000_000_000n,
      signedAmount: 75_000_000_000_000_000_000n,
      fullHash: `0x${'ad'.repeat(32)}`,
      partialRoot: `0x${'be'.repeat(32)}`,
    };
    const targetPull = {
      pullId: 'remote-target-pull',
      tokenId: 2,
      amount: 30_000_000_000_000_000n,
      signedAmount: 30_000_000_000_000_000n,
      fullHash: `0x${'ad'.repeat(32)}`,
      partialRoot: `0x${'be'.repeat(32)}`,
    };
    const route = {
      orderId: 'remote-source-admit',
      makerEntityId: sourceUser,
      sourceDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      targetDisputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      hubEntityId: targetHub,
      bookOwnerEntityId: targetHub,
      venueId: 'cross:base:2/tron:1',
      source: {
        jurisdiction: `stack:31338:0x${'de'.repeat(20)}`,
        entityId: sourceUser,
        counterpartyEntityId: sourceHub,
        tokenId: 1,
        amount: sourcePull.amount,
      },
      target: {
        jurisdiction: `stack:31337:0x${'dd'.repeat(20)}`,
        entityId: targetHub,
        counterpartyEntityId: targetUser,
        tokenId: 2,
        amount: targetPull.amount,
      },
      sourcePull,
      targetPull,
      status: 'resting',
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 60_000,
    } satisfies CrossJurisdictionSwapRoute;
    const env = createEmptyEnv('target-side-cross-book-owner');
    const targetHubState = makeEntityState(targetHub);
    const admitted = handleAdmitCrossJurisdictionBookOrderEntityTx(env, targetHubState, {
      type: 'admitCrossJurisdictionBookOrder',
      data: { route, reason: 'atomic_account_pair_committed' },
    });
    expect(admitted.swapOffersCreated).toHaveLength(1);
    expect(admitted.swapOffersCreated[0]?.accountId).toBe(sourceUser);
    expect(admitted.swapOffersCreated[0]?.fromEntity).toBe(sourceUser);
    expect(admitted.swapOffersCreated[0]?.toEntity).toBe(sourceHub);
    expect(admitted.swapOffersCreated[0]?.crossJurisdiction?.orderId).toBe(route.orderId);
    expect(admitted.swapOffersCreated[0]?.crossJurisdiction?.status).toBe('resting');
  });

  test('htlc_resolve(error) cannot be used by payer to cancel an active lock before expiry', async () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    const amount = 1000n;
    const delta = createDefaultDelta(1);
    delta.leftHold = amount;
    account.state.deltas.set(1, delta);
    account.state.locks.set('lock-1', {
      lockId: 'lock-1',
      hashlock: `0x${'77'.repeat(32)}`,
      timelock: 10_000n,
      revealBeforeHeight: 100,
      amount,
      tokenId: 1,
      senderIsLeft: true,
      createdHeight: 0,
      createdTimestamp: 0,
    });

    const payerResult = await handleHtlcResolve(
      account.state,
      { type: 'htlc_resolve', data: { lockId: 'lock-1', outcome: 'error', reason: 'downstream_error' } },
      true,
      1,
      1_000,
    );
    expect(payerResult.ok).toBe(false);
    expect(account.state.locks.has('lock-1')).toBe(true);
    expect(account.state.deltas.get(1)?.leftHold).toBe(amount);

    const beneficiaryResult = await handleHtlcResolve(
      account.state,
      { type: 'htlc_resolve', data: { lockId: 'lock-1', outcome: 'error', reason: 'downstream_error' } },
      false,
      1,
      1_000,
    );
    expect(beneficiaryResult.ok).toBe(true);
    expect(account.state.locks.has('lock-1')).toBe(false);
    expect(account.state.deltas.get(1)?.leftHold).toBe(0n);
  });
});
