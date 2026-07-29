import { describe, expect, spyOn, test } from 'bun:test';
import { readEntityFrameEventMessages } from '../entity/frame-events';

import { x25519 } from '@noble/curves/ed25519.js';

import {
  applyAccountInput,
  getIncomingAccountDeadlineViolation,
  HTLC_ENFORCEMENT_RESERVE_MS,
  isHtlcSecretEnforcementWindowClosed,
  proposeAccountFrame,
  isWithinAccountFrameBounds,
} from '../account/consensus/index';

import { computeAccountStateRoot, computeAccountStateRootCold } from '../account/state-root';

import { resolveCertifiedAccountCounterpartyProposer } from '../account/counterparty-route';

import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey, signAccountFrame } from '../account/crypto';

import { deriveAccountWatchSeed } from '../protocol/account-watch-seed';

import { applyAccountTx } from '../account/tx/apply';

import { isPullRevealExpired } from '../account/pull-deadline';

import { handleHtlcLock } from '../account/tx/handlers/htlc-lock';

import { handleHtlcResolve } from '../account/tx/handlers/htlc-resolve';

import { createSettlementWorkspaceHash } from '../account/tx/handlers/settle-transition';

import { hashHtlcSecret } from '../protocol/htlc/utils';

import { buildHashLadderProof, revealHashLadder } from '../protocol/htlc/hash-ladder';

import type { MultiRecipientCiphertext } from '../protocol/htlc/multi-recipient';

import { checkAutoRebalance, handleRequestCollateral } from '../account/tx/handlers/request-collateral';

import { handleSwapOffer } from '../account/tx/handlers/swap-offer';

import { createFrameHash, MAX_ACCOUNT_FRAME_TXS } from '../account/consensus/frame';

import { resolveAutoRebalanceFeePolicy, runPostFrameAutoRebalanceCheck } from '../account/consensus/helpers';

import { HTLC, LIMITS } from '../constants';

import {
  ACCOUNT_PENDING_RESEND_AFTER_MS,
  emitCommittedPendingFrameWarnings,
  executeCrontab,
  HTLC_SECRET_ACK_TIMEOUT_MS,
  initCrontab,
} from '../entity/scheduler';

import { encodeBoard, generateLazyEntityId, generateNumberedEntityId, hashBoard } from '../entity/factory';

import { isLeftEntity } from '../entity/id';

import {
  CROSS_J_PENDING_FILL_ACK_TTL_MS,
  MAX_PENDING_CROSS_J_FILL_ACKS,
  applyEntityFrame,
  applyEntityInput,
} from '../entity/consensus/index';

import { createEntityFrameHash } from '../entity/consensus/frame';

import { buildSignedEntityCommand, prepareLocallyAuthoredEntityTxs } from '../entity/command';

import { signedEntityCommandTx } from '../entity/command-codec';

import { buildCollectiveEntityProposalTx } from '../entity/authorization';

import { generateProposalId } from '../entity/tx/proposals';

import { buildEntityHashesToSign } from '../entity/consensus/hanko-witness';

import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeCanonicalEntityConsensusStateHashCold,
  computeEntityFrameAuthorityRoot,
} from '../entity/consensus/state-root';

import {
  assertCrossJurisdictionOrderAdmissible,
  findCrossJurisdictionBookAdmissionForAck,
} from '../orderbook/cross-j-orderbook';

import {
  buildCrossJurisdictionMarketOffer,
  getCrossJurisdictionBookAdmissionError,
  mergeCrossJurisdictionBookAdmission,
} from '../extensions/cross-j/orderbook';

import {
  buildCrossJurisdictionPullBinding,
  buildCrossJurisdictionCloseProof,
  buildCrossJurisdictionPullReveal,
  buildPreparedCrossJurisdictionRoute,
  deriveCrossJurisdictionPrivateSeed,
  withCanonicalCrossJurisdictionRouteHash,
} from '../extensions/cross-j/index';

import { applyEntityTx } from '../entity/tx/apply';

import { applyCommittedCrossJurisdictionAccountTxFollowup } from '../entity/tx/handlers/account-cross-j-followups';

import { buildCrossJurisdictionEntityOutput } from '../entity/tx/cross-j-outputs';

import { handleHtlcOnionAdvance } from '../entity/tx/handlers/htlc-onion-advance';

import {
  handleAdmitCrossJurisdictionBookOrderEntityTx,
  handleCrossJurisdictionBookOrderRemovedEntityTx,
} from '../entity/tx/handlers/cross-j-book-order';

import type { SwapOfferEvent } from '../entity/tx/handlers/account';

import { handleDisputeFinalize, handleDisputeStart, handlePrepareDispute } from '../entity/tx/handlers/dispute';

import { handleJAbortSentBatch } from '../entity/tx/handlers/j-abort-sent-batch';

import { handleJRebroadcast } from '../entity/tx/handlers/j-rebroadcast';

import { handleSetHubConfigEntityTx, handleSetRebalancePolicyEntityTx } from '../entity/tx/handlers/account-admin';

import { buildSettlementSealDraft, processCommittedSettlementTransitionFollowup } from '../entity/tx/handlers/settle';

import { applyJEvent } from '../entity/tx/j-events';

import { applyJEventRange, buildJEventRangeData } from './helpers/j-history';

import { applyFinalizedAccountJEvents } from '../account/tx/handlers/j-event-finality';

import { queueCrossJurisdictionSalvageFromArgumentList } from '../entity/tx/j-events-htlc';

import {
  canonicalDisputeFinalizationEvidenceHash,
  canonicalJurisdictionEventsHash,
  getJEventJurisdictionRef,
} from '../jurisdiction/event-observation';

import { getRuntimeJurisdictionHeight } from '../jurisdiction/height';

import { recordValidatorJHistory } from '../jurisdiction/local-history';

import { buildLocalJPrefixAttestation } from '../jurisdiction/j-prefix-consensus';

import { createEmptyBatch, encodeJBatch } from '../jurisdiction/batch';

import {
  getCertifiedBoardNodeStore,
  resolveCertifiedRegisteredBoardHash,
  resolveObserverCertifiedBoardRecord,
} from '../jurisdiction/board-registry';

import {
  applyCommand,
  createBook,
  getBookOrder,
  getSwapLotScale,
  ORDERBOOK_PRICE_SCALE,
  SWAP_LOT_SCALE,
  type OrderbookExtState,
} from '../orderbook';

import {
  createEmptyEnv,
  processRuntime,
  registerEntityRuntimeHint,
  sendEntityInput,
  validateRuntimeInputAdmission,
} from '../runtime';

import { createJReplica } from '../scenarios/boot';

import { applyMergedEntityInputs, RuntimeEntityInputApplyError } from '../runtime/entity-inputs';

import { MalformedEntityFrameInputError } from '../entity/tx/invariant-errors';

import { applyStorageChanges } from '../runtime/env-events';

import { submitRuntimeJOutbox } from '../runtime/j-submit';

import { registerStructuredLogSink } from '../infra/logger';

import { buildJSubmitAttemptId, registerPendingCommittedJOutbox } from '../runtime/j-submit-state';

import { buffersEqual, safeStringify } from '../protocol/serialization';

import type { ProofBodyStruct } from '../protocol/dispute/proof-body';

import { hydrateAccountDocFromStorage, projectAccountDoc } from '../storage/projections';

import { validateStorageAccountDocValue } from '../storage/authoritative-schema';

import { decodeValidatedBuffer, encodeBuffer } from '../storage/codec';

import { createDefaultDelta } from '../account/delta';

import { cloneEntityState } from '../entity/state-clone';

import {
  buildDisputeArgumentsForSnapshot,
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../protocol/dispute/arguments';

import {
  buildAccountProofBody,
  createDisputeProofHashWithNonce,
  hashProofBodyStruct,
} from '../protocol/dispute/proof-builder';

import { encodeSignedHanko } from '../hanko/codec';

import { resolveHankoBoardDelays } from '../hanko/claims';

import { verifyHankoForHash } from '../hanko/signing';
import { sealAccountDraftAsEntity } from './helpers/account-draft';

import { NobleCryptoProvider } from '../protocol/crypto/noble';

import { computeHtlcEnvelopeContextHash, computeHtlcSecretOfferContextHash } from '../protocol/htlc/envelope';

import { encryptBytesForValidatorManifest } from '../protocol/htlc/multi-recipient';

import { buildHtlcOnionAdvanceTx, hashEncryptedHtlcLayer } from '../protocol/htlc/onion-advance';

import { encodeHtlcSecretOffer, encodeOnionLayer } from '../protocol/htlc/onion-codec';

import {
  computeEntityProfileCertificationHash,
  computeValidatorEncryptionAttestationDigest,
  requireCompleteValidatorEncryptionManifest,
} from '../protocol/htlc/validator-encryption';

import { handleMeshBootstrapLoopError } from '../orchestrator/mesh-bootstrap-fail-fast';

import { fitCrossAmountsToOrderbook } from '../orchestrator/mm-node';

import { cloneAccountState } from '../account/state-clone';
import {
  clearReplayOutputSignerHints,
  installReplayOutputSignerHints,
  resolveEntityProposerId,
} from '../runtime/entity-output-signer';

import { QUOTE_EXPIRY_MS } from '../types';

import type {
  AccountFrame,
  AccountInput,
  AccountState,
  AccountTx,
  ConsensusConfig,
  CrossJurisdictionSwapRoute,
  DisputeFinalizationEvidence,
  EntityInput,
  EntityReplica,
  EntityState,
  EntityTx,
  RuntimeState,
  JInput,
  JurisdictionConfig,
  JurisdictionEvent,
  RuntimeTx,
} from '../types';

import { installCanonicalRegisteredBoardAuthority } from './helpers/registration-evidence';

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

const installSingleSignerBoard = (env: RuntimeState, state: EntityState, slot = '1'): string => {
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
  offdeltas: [],
  tokenIds: [],
  transformers: [],
});

const makeProposalAccount = (mempool: AccountTx[], leftEntity: string, rightEntity: string): AccountState => {
  return {
    leftEntity,
    rightEntity,
    domain: { chainId: 31337, depositoryAddress: `0x${'dd'.repeat(20)}` },
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
    deltas: new Map(),
    locks: new Map(),
    swapOffers: new Map(),
    globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
    currentHeight: 0,
    pendingSignatures: [],
    rollbackCount: 0,
    proofHeader: { fromEntity: leftEntity, toEntity: rightEntity, nextProofNonce: 0 },
    proofBody: { tokenIds: [], deltas: [] },
    frameHistory: [],
    pendingWithdrawals: new Map(),
    requestedRebalance: new Map(),
    requestedRebalanceFeeState: new Map(),
    shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map() } },
    leftPendingJClaims: createEmptyAccountJClaimAccumulator(),
    rightPendingJClaims: createEmptyAccountJClaimAccumulator(),
    lastFinalizedJHeight: 0,
    watchSeed: deriveAccountWatchSeed({
      runtimeSeed: 'audit-failfast-test-helper',
      entityId: leftEntity,
      counterpartyId: rightEntity,
      timestamp: 0,
    }),
    disputeConfig: { leftDisputeDelay: 10, rightDisputeDelay: 10 },
    jNonce: 0,
  } as AccountState;
};

const setSyntheticPendingAccountProposal = (
  account: AccountState,
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
    domain: structuredClone(account.domain),
    proposal: { frame: structuredClone(pendingFrame) },
  };
};

const makeIncomingAccountFrame = (
  account: AccountState,
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
  const browserDepository = (
    env.browserVM as { getDepositoryAddress?: () => string } | undefined
  )?.getDepositoryAddress?.();
  const config = makeSingleSignerConfigFor(signerId);
  const jurisdiction = config.jurisdiction!;
  const depository = browserDepository ?? jurisdiction.depositoryAddress;
  if (!env.jReplicas.has('__audit_test__')) {
    env.jReplicas.set('__audit_test__', {
      name: '__audit_test__',
      chainId: jurisdiction.chainId,
      rpcs: [],
      depositoryAddress: depository,
      entityProviderAddress: jurisdiction.entityProviderAddress,
      contracts: {
        depository,
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
  env.eReplicas.set(`${entityId}:${signerId}`, {
    entityId,
    signerId,
    entityEncPubKey: '',
    entityEncPrivKey: '',
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

const ensureCanonicalCommandBoardAuthority = async (env: RuntimeState, state: EntityState): Promise<void> => {
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
  let replica = Array.from(env.jReplicas.values()).find(
    candidate =>
      candidate.chainId === jurisdiction.chainId &&
      candidate.depositoryAddress?.toLowerCase() === jurisdiction.depositoryAddress.toLowerCase() &&
      candidate.entityProviderAddress?.toLowerCase() === jurisdiction.entityProviderAddress.toLowerCase(),
  );
  if (!replica) {
    replica = createJReplica(env, jurisdiction.name, jurisdiction.depositoryAddress);
    replica.chainId = jurisdiction.chainId;
    replica.depositoryAddress = jurisdiction.depositoryAddress;
    replica.entityProviderAddress = jurisdiction.entityProviderAddress;
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
  env: RuntimeState,
  state: EntityState,
  collectiveTxs: EntityTx[],
  frameTimestamp: number = env.timestamp,
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
  entityEncPrivKey: '',
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
    jBlockChain: [],
    profile: {
      name: 'Audit Entity',
      isHub: false,
      avatar: '',
      bio: '',
      website: '',
    },
    htlcRoutes: new Map(),
    htlcFeesEarned: 0n,
    htlcNotes: new Map(),
    lockBook: new Map(),
    swapTradingPairs: [],
    crontabState: initCrontab(),
  },
});

const makeEntityState = (entityId: string): EntityState => ({
  entityId,
  height: 0,
  timestamp: 1_000,
  nonces: new Map(),
  proposals: new Map(),
  config: makeSingleSignerConfig(),
  reserves: new Map(),
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  profile: {
    name: 'Audit Entity',
    isHub: false,
    avatar: '',
    bio: '',
    website: '',
  },
  htlcRoutes: new Map(),
  htlcFeesEarned: 0n,
  htlcNotes: new Map(),
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
    disputeTimeout: 123,
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
        initialNonce: '7',
        initialProofbodyHash: finalProofbodyHash,
        finalProofbodyHash,
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

const sealAuditJSubmitAttempts = (env: RuntimeState, inputs: JInput[]): void => {
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
      const existing = Array.from(env.eReplicas.values()).find(
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
          entityEncPrivKey: '',
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
      env.eReplicas.set(`${jTx.entityId}:${signerId}`, replica);
    }
  }
  registerPendingCommittedJOutbox(env, inputs);
};

const submitAuditRuntimeJOutbox = async (
  env: RuntimeState,
  inputs: JInput[],
  deps: Parameters<typeof submitRuntimeJOutbox>[2],
): Promise<void> => {
  sealAuditJSubmitAttempts(env, inputs);
  await submitRuntimeJOutbox(env, inputs, deps);
};

describe('audit fail-fast regressions', () => {
  test('Entity flush re-sends LEFT winning proposal after simultaneous-frame collision', async () => {
    const seed = 'entity-flush-simultaneous-left-winner';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.timestamp = 10_000;
    env.browserVM = { getDepositoryAddress: () => hex20('dd') } as typeof env.browserVM;

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

    const leftProposal = await proposeAccountFrame(env, leftAccount, env.timestamp);
    const rightProposal = await proposeAccountFrame(env, rightAccount, env.timestamp);
    if (!leftProposal.success || !leftProposal.accountInput) {
      throw new Error(`LEFT_SIMULTANEOUS_PROPOSAL_FAILED:${leftProposal.error ?? 'missing input'}`);
    }
    if (!rightProposal.success || !rightProposal.accountInput) {
      throw new Error(`RIGHT_SIMULTANEOUS_PROPOSAL_FAILED:${rightProposal.error ?? 'missing input'}`);
    }
    const leftInput = await sealAccountDraftAsEntity(env, left.entityId, left.signerId, leftProposal);
    const rightInput = await sealAccountDraftAsEntity(env, right.entityId, right.signerId, rightProposal);
    if (leftInput.kind !== 'frame') throw new Error('LEFT_SIMULTANEOUS_FRAME_REQUIRED');
    // This collision begins after LEFT has already emitted its signed proposal.
    // Persist the same witnesses that Entity finalization would attach before
    // the peer's competing frame can arrive.
    leftAccount.pendingAccountInput = structuredClone(leftInput);
    leftAccount.currentFrameHanko = leftInput.proposal.frameHanko;
    leftAccount.currentDisputeProofHanko = leftInput.proposal.disputeSeal?.hanko;

    const leftState = makeEntityState(left.entityId);
    leftState.config = makeSingleSignerConfigFor(left.signerId);
    leftState.accounts.set(right.entityId, leftAccount);
    const applied = await applyEntityFrame(
      env,
      leftState,
      [
        {
          type: 'accountInput',
          data: rightInput,
        },
      ],
      env.timestamp,
    );

    const accountOutputs = applied.outputs
      .flatMap(output => output.entityTxs ?? [])
      .filter((tx): tx is Extract<EntityTx, { type: 'accountInput' }> => tx.type === 'accountInput');
    expect(accountOutputs).toHaveLength(1);
    expect(accountOutputs[0]?.data).toEqual(leftInput);
    expect(accountOutputs[0]?.data.kind).toBe('frame');
    expect(applied.newState.accounts.get(right.entityId)?.pendingFrame?.stateHash).toBe(
      leftAccount.pendingFrame?.stateHash,
    );
  });

  test('failed proposal keeps queued txs, including late arrivals, instead of wiping the mempool', async () => {
    const seed = 'account-proposal-failure-retains-mempool';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const firstTx: AccountTx = { type: 'add_delta', data: { tokenId: 1 } };
    const lateTx: AccountTx = { type: 'add_delta', data: { tokenId: 2 } };
    const accountMachine = makeProposalAccount([firstTx], left.entityId, right.entityId);
    attachSigningReplica(env, accountMachine.proofHeader.fromEntity, left.signerId);
    const signingJurisdiction = Array.from(env.jReplicas.values()).find(
      replica =>
        replica.chainId === accountMachine.domain.chainId &&
        replica.contracts?.depository?.toLowerCase() === accountMachine.domain.depositoryAddress.toLowerCase(),
    );
    if (!signingJurisdiction?.contracts) throw new Error('TEST_SIGNING_JURISDICTION_MISSING');
    delete signingJurisdiction.contracts.deltaTransformer;

    queueMicrotask(() => {
      accountMachine.mempool.push(lateTx);
    });

    await expect(proposeAccountFrame(env, accountMachine, env.timestamp)).rejects.toThrow(
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
      watchSeed: account.watchSeed,
      offdeltas: [50n],
      tokenIds: [1n],
      transformers: [],
    };
    const finalProofbodyHash = hashProofBodyStruct(finalProofbody);
    account.deltas.set(1, {
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
    account.disputeProofBodiesByHash = {
      [finalProofbodyHash]: finalProofbody,
    };
    account.activeDispute = {
      startedByLeft: true,
      disputeTimeout: 123,
      initialProofbodyHash: finalProofbodyHash,
      initialNonce: 7,
      finalizeQueued: true,
    } as AccountState['activeDispute'];
    // Prime the incremental trie before the jurisdiction event mutates the
    // same Delta objects in place. Dispute finalization must invalidate it.
    computeAccountStateRoot(account);
    state.accounts.set(counterpartyId, account);
    state.jBatchState = {
      batch: {
        ...createEmptyBatch(),
        disputeFinalizations: [
          {
            counterentity: counterpartyId,
            initialNonce: 7,
            finalNonce: 7,
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
          disputeFinalizations: [
            {
              counterentity: counterpartyId,
              initialNonce: 7,
              finalNonce: 7,
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
    const disputeFinalizedEvent: JurisdictionEvent = {
      type: 'DisputeFinalized',
      data: {
        sender: counterpartyId,
        counterentity: entityId,
        initialNonce: 7,
        initialProofbodyHash: finalProofbodyHash,
        finalProofbodyHash,
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
        leftArguments: '0x',
        rightArguments: '0x',
        starterInitialArguments: '0x',
        starterIncrementedArguments: '0x',
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
    const clonedSealedBatch = cloneEntityState(state).jBatchState!.sentBatch!.batch;
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
    expect(finalized.newState.jBatchState?.batch.reserveToReserve).toEqual([
      {
        receivingEntity: `0x${'56'.repeat(32)}`,
        tokenId: 1,
        amount: 25n,
      },
    ]);
    expect(finalized.newState.jBatchState?.sentBatch).toBeUndefined();
    expect(finalized.newState.jBatchState?.status).toBe('accumulating');
    expect(state.jBatchState?.sentBatch?.encodedBatch).toBe(sealedBatchBefore);
    expect(encodeJBatch(state.jBatchState!.sentBatch!.batch)).toBe(sealedBatchBefore);
    const finalizedDelta = finalized.newState.accounts.get(counterpartyId)?.deltas.get(1);
    expect(finalizedDelta?.collateral).toBe(0n);
    expect(finalizedDelta?.ondelta).toBe(0n);
    expect(finalizedDelta?.offdelta).toBe(0n);
    expect(finalizedDelta?.leftAllowance).toBe(0n);
    expect(finalizedDelta?.rightAllowance).toBe(0n);
    expect(finalized.newState.accounts.get(counterpartyId)?.jNonce).toBe(8);
    const finalizedAccount = finalized.newState.accounts.get(counterpartyId);
    if (!finalizedAccount) throw new Error('FINALIZED_ACCOUNT_MISSING');
    expect(computeAccountStateRoot(finalizedAccount)).toBe(computeAccountStateRootCold(finalizedAccount));
  });

  test('DisputeFinalized rejects missing signed final body before mutating account state', async () => {
    const finalProofbody: ProofBodyStruct = {
      watchSeed: `0x${'f1'.repeat(32)}`,
      offdeltas: [50n],
      tokenIds: [1n],
      transformers: [],
    };
    const fixture = makeDisputeFinalizedFixture('dispute-finalized-body-missing', finalProofbody, false);
    fixture.account.deltas.set(1, { ...createDefaultDelta(1), collateral: 100n, offdelta: 50n });
    const stateBefore = safeStringify(fixture.state);

    await expect(applyDisputeFinalizedFixture(fixture)).rejects.toThrow('J_EVENT_DISPUTE_FINAL_PROOFBODY_MISSING');
    expect(safeStringify(fixture.state)).toBe(stateBefore);
  });

  test('DisputeFinalized rejects an oversized nonce before mutating account state', async () => {
    const finalProofbody: ProofBodyStruct = {
      watchSeed: `0x${'f1'.repeat(32)}`,
      offdeltas: [50n],
      tokenIds: [1n],
      transformers: [],
    };
    const fixture = makeDisputeFinalizedFixture(
      'dispute-finalized-nonce-boundary',
      finalProofbody,
      true,
    );
    fixture.event.data.initialNonce = '9007199254740993';
    const stateBefore = safeStringify(fixture.state);

    await expect(applyDisputeFinalizedFixture(fixture)).rejects.toThrow(
      'J_EVENT_DISPUTE_INITIAL_NONCE_INVALID:9007199254740993',
    );
    expect(safeStringify(fixture.state)).toBe(stateBefore);
  });

  test('DisputeFinalized rejects a stored body whose hash does not match its key', async () => {
    const finalProofbody: ProofBodyStruct = {
      watchSeed: `0x${'f1'.repeat(32)}`,
      offdeltas: [50n],
      tokenIds: [1n],
      transformers: [],
    };
    const fixture = makeDisputeFinalizedFixture('dispute-finalized-body-hash-mismatch', finalProofbody, true);
    fixture.account.disputeProofBodiesByHash![fixture.finalProofbodyHash] = {
      ...finalProofbody,
      offdeltas: [51n],
    };

    await expect(applyDisputeFinalizedFixture(fixture)).rejects.toThrow(
      'J_EVENT_DISPUTE_FINAL_PROOFBODY_HASH_MISMATCH',
    );
  });

  test('DisputeFinalized rejects malformed token/offdelta shape instead of clearing every delta', async () => {
    const malformedProofbody: ProofBodyStruct = {
      watchSeed: `0x${'f1'.repeat(32)}`,
      offdeltas: [],
      tokenIds: [1n],
      transformers: [],
    };
    const fixture = makeDisputeFinalizedFixture('dispute-finalized-body-shape', malformedProofbody, true);
    fixture.account.deltas.set(1, { ...createDefaultDelta(1), collateral: 100n, offdelta: 50n });

    await expect(applyDisputeFinalizedFixture(fixture)).rejects.toThrow('J_DISPUTE_PROOFBODY_LENGTH_MISMATCH');
  });

  test('DisputeFinalized clears only exact proof tokens and retires the consumed evidence epoch', async () => {
    const finalProofbody: ProofBodyStruct = {
      watchSeed: `0x${'f1'.repeat(32)}`,
      offdeltas: [50n],
      tokenIds: [1n],
      transformers: [],
    };
    const fixture = makeDisputeFinalizedFixture('dispute-finalized-exact-token-cleanup', finalProofbody, true);
    const staleHash = `0x${'ab'.repeat(32)}`;
    fixture.account.disputeProofBodiesByHash![staleHash] = makeEmptyProofBody();
    fixture.account.disputeProofNoncesByHash = { [fixture.finalProofbodyHash]: 7, [staleHash]: 6 };
    fixture.account.disputeArgumentSnapshotsByHash = {
      [fixture.finalProofbodyHash]: captureDisputeArgumentSnapshot(
        fixture.account,
        fixture.finalProofbodyHash,
        7,
        finalProofbody,
      ),
      [staleHash]: captureDisputeArgumentSnapshot(fixture.account, staleHash, 6, makeEmptyProofBody()),
    };
    fixture.account.deltas.set(1, { ...createDefaultDelta(1), collateral: 100n, offdelta: 50n });
    fixture.account.deltas.set(2, { ...createDefaultDelta(2), collateral: 200n, offdelta: 75n });

    const finalized = await applyDisputeFinalizedFixture(fixture);
    const account = finalized.newState.accounts.get(fixture.counterpartyId)!;
    expect(account.deltas.get(1)).toMatchObject({ collateral: 0n, ondelta: 0n, offdelta: 0n });
    expect(account.deltas.get(2)).toMatchObject({ collateral: 200n, offdelta: 75n });
    expect(account.disputeProofBodiesByHash).toBeUndefined();
    expect(account.disputeProofNoncesByHash).toBeUndefined();
    expect(account.disputeArgumentSnapshotsByHash).toBeUndefined();
    expect(projectAccountDoc(account).disputeProofBodiesByHash).toBeUndefined();
    expect(projectAccountDoc(account).disputeProofNoncesByHash).toBeUndefined();
    expect(projectAccountDoc(account).disputeArgumentSnapshotsByHash).toBeUndefined();

    const nextProofbody: ProofBodyStruct = { ...finalProofbody, offdeltas: [75n], tokenIds: [2n] };
    const nextHash = hashProofBodyStruct(nextProofbody);
    account.disputeProofBodiesByHash = { [nextHash]: nextProofbody };
    account.disputeProofNoncesByHash = { [nextHash]: 8 };
    storeDisputeArgumentSnapshot(account, captureDisputeArgumentSnapshot(account, nextHash, 8, nextProofbody));
    const persisted = hydrateAccountDocFromStorage(structuredClone(projectAccountDoc(account)));
    expect(Object.keys(persisted.disputeProofBodiesByHash ?? {})).toEqual([nextHash]);
    expect(Object.keys(persisted.disputeProofNoncesByHash ?? {})).toEqual([nextHash]);
    expect(Object.keys(persisted.disputeArgumentSnapshotsByHash ?? {})).toEqual([nextHash]);
  });

  test('DisputeFinalized invalidates a competing settlement workspace and its deferred retry', async () => {
    const finalProofbody: ProofBodyStruct = {
      watchSeed: `0x${'f2'.repeat(32)}`,
      offdeltas: [50n],
      tokenIds: [1n],
      transformers: [],
    };
    const fixture = makeDisputeFinalizedFixture('dispute-finalized-settlement-race', finalProofbody, true);
    fixture.account.deltas.set(1, {
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
    expect((await applyAccountTx(fixture.account, upsertTx, true, 1_000)).success).toBe(true);
    fixture.account.settlementWorkspace!.leftHanko = '0x1234';
    fixture.account.settlementWorkspace!.nonceAtSign = 8;
    fixture.account.settlementWorkspace!.settlementHash = `0x${'81'.repeat(32)}`;
    fixture.account.mempool.push(structuredClone(upsertTx));
    fixture.state.deferredAccountProposals = new Map([
      [fixture.counterpartyId, fixture.account.settlementWorkspace!.workspaceHash],
    ]);
    expect(fixture.account.deltas.get(1)?.leftHold).toBe(4n);

    const finalized = await applyDisputeFinalizedFixture(fixture);
    const account = finalized.newState.accounts.get(fixture.counterpartyId)!;
    expect(account.settlementWorkspace).toBeUndefined();
    expect(account.deltas.get(1)?.leftHold).toBe(0n);
    expect(account.mempool.some(tx => tx.type === 'settle_transition')).toBe(false);
    expect(finalized.newState.deferredAccountProposals?.has(fixture.counterpartyId)).toBe(false);
  });

  test('disputeFinalize waits for on-chain DisputeStarted before drafting a finalization', async () => {
    const starterId = `0x${'41'.repeat(32)}`;
    const finalizerId = `0x${'42'.repeat(32)}`;
    const state = makeEntityState(finalizerId);
    const account = makeProposalAccount([], starterId, finalizerId);
    const initialProof = buildAccountProofBody(account, '');
    account.disputeProofBodiesByHash = {
      [initialProof.proofBodyHash]: initialProof.proofBodyStruct,
    };
    account.activeDispute = {
      startedByLeft: true,
      initialProofbodyHash: initialProof.proofBodyHash,
      initialNonce: 1,
      disputeTimeout: 100,
      jNonce: 0,
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
      observedOnChain: false,
      finalizeQueued: false,
    };
    state.accounts.set(starterId, account);

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

  test('disputeFinalize uses signed counter-proof and incremented starter arguments when a newer proof is available', async () => {
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
    account.domain = { chainId: 31337, depositoryAddress };
    account.proofHeader = { fromEntity: starterId, toEntity: finalizerId, nextProofNonce: 2 };
    account.deltas.set(1, { ...createDefaultDelta(1), offdelta: 50n });

    const initialProof = buildAccountProofBody(account, '');
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, initialProof.proofBodyHash, 1, initialProof.proofBodyStruct),
    );

    account.deltas.set(1, { ...createDefaultDelta(1), offdelta: 75n });
    const counterProof = buildAccountProofBody(account, '');
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, counterProof.proofBodyHash, 2, counterProof.proofBodyStruct),
    );
    account.disputeProofBodiesByHash = {
      [initialProof.proofBodyHash]: initialProof.proofBodyStruct,
      [counterProof.proofBodyHash]: counterProof.proofBodyStruct,
    };
    account.counterpartyDisputeProofBodyHash = counterProof.proofBodyHash;
    account.counterpartyDisputeProofNonce = 2;
    account.counterpartyDisputeProofHanko = '0x1234';
    account.counterpartyDisputeHash = createDisputeProofHashWithNonce(
      account,
      counterProof.proofBodyHash,
      { chainId: 31337, depositoryAddress },
      2,
    );
    account.activeDispute = {
      startedByLeft: true,
      initialProofbodyHash: initialProof.proofBodyHash,
      initialNonce: 1,
      disputeTimeout: 100,
      jNonce: 0,
      starterInitialArguments: '0x1111',
      starterIncrementedArguments: '0x2222',
      observedOnChain: true,
      finalizeQueued: false,
    };
    state.accounts.set(starterId, account);

    const env = createEmptyEnv('counter-finalize-runtime');
    env.quietRuntimeLogs = true;
    env.lastJBlock = 1;
    env.jReplicas.set('Testnet', {
      name: 'Testnet',
      blockNumber: 1n,
      stateRoot: new Uint8Array(32),
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
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
    account.jNonce = 1;
    account.proofHeader = { fromEntity: user.entityId, toEntity: hub.entityId, nextProofNonce: 50 };
    account.deltas.set(1, { ...createDefaultDelta(1), collateral: 10n });

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
    expect(applied.success).toBe(true);
    const result = await processCommittedSettlementTransitionFollowup(
      account,
      transition,
      {
        ...account.currentFrame,
        height: 1,
        timestamp: 1_000,
        accountTxs: [transition],
        byLeft: false,
      },
      hub.entityId,
      userState,
      env,
    );

    expect(result.outputs).toEqual([]);
    expect(result.accountTxs).toEqual([]);
    expect(userState.deferredAccountProposals?.get(hub.entityId)).toBe(account.settlementWorkspace?.workspaceHash);
    expect(buildSettlementSealDraft(account, userState, hub.entityId, env).tx).toMatchObject({
      type: 'settle_transition',
      data: {
        kind: 'seal',
        settlementNonce: 50,
        postProof: { nonce: 51 },
      },
    });
    expect(account.settlementWorkspace?.nonceAtSign).toBeUndefined();
    expect(account.settlementWorkspace?.postSettlementDisputeProof).toBeUndefined();
  });

  test('settlement finalization activates post-settlement dispute hash atomically', () => {
    const leftId = `0x${'31'.repeat(32)}`;
    const rightId = `0x${'32'.repeat(32)}`;
    const depositoryAddress = hex20('1');
    const account = makeProposalAccount([], leftId, rightId);
    account.proofHeader = { fromEntity: leftId, toEntity: rightId, nextProofNonce: 2 };
    account.deltas.set(1, { ...createDefaultDelta(1), offdelta: 50n });

    const postProof = buildAccountProofBody(account, '');
    const postDisputeHash = createDisputeProofHashWithNonce(
      account,
      postProof.proofBodyHash,
      { chainId: 31337, depositoryAddress },
      2,
    );
    account.counterpartyDisputeHash = `0x${'aa'.repeat(32)}`;
    account.settlementWorkspace = {
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
    account.settlementWorkspace.workspaceHash = createSettlementWorkspaceHash(account, account.settlementWorkspace);

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
    account.lastFinalizedJHeight = 7;

    expect(account.settlementWorkspace).toBeUndefined();
    expect(account.currentDisputeHash).toBe(postDisputeHash);
    expect(account.counterpartyDisputeHash).toBe(postDisputeHash);
    expect(account.currentDisputeProofBodyHash).toBe(postProof.proofBodyHash);
    expect(account.counterpartyDisputeProofBodyHash).toBe(postProof.proofBodyHash);
    expect(account.disputeProofNoncesByHash?.[postProof.proofBodyHash]).toBe(2);
    expect(account.jNonce).toBe(1);
  });

  test('disputeStart rejects unsupported incremented argument override instead of silently ignoring it', async () => {
    const entityId = `0x${'31'.repeat(32)}`;
    const counterpartyId = `0x${'32'.repeat(32)}`;
    const env = createEmptyEnv('dispute-start-incremented-override');
    const state = makeEntityState(entityId);

    await expect(
      handleDisputeStart(
        state,
        {
          type: 'disputeStart',
          data: {
            counterpartyEntityId: counterpartyId,
            starterIncrementedArguments: '0x1234',
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
    env.jReplicas.set('Testnet', {
      name: 'Testnet',
      blockNumber: 0n,
      stateRoot: new Uint8Array(32),
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
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
      entityEncPrivKey: '',
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
      deltas: new Map(),
      currentHeight: 0,
      locks: new Map(Array.from({ length: LIMITS.MAX_ACCOUNT_HTLC_LOCKS }, (_, index) => [String(index), {}])),
    };

    const result = await handleHtlcLock(
      accountMachine as Parameters<typeof handleHtlcLock>[0],
      {
        type: 'htlc_lock',
        data: {
          lockId: 'overflow-lock',
          hashlock: `0x${'11'.repeat(32)}`,
          timelock: 1_000_000n,
          revealBeforeHeight: 100,
          amount: 1n,
          tokenId: 1,
        },
      },
      true,
      0,
      1,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(`max ${LIMITS.MAX_ACCOUNT_HTLC_LOCKS}`);
    expect(accountMachine.locks.size).toBe(LIMITS.MAX_ACCOUNT_HTLC_LOCKS);
  });

  test('cross-j committed pull_resolve followup rejects malformed binary instead of skipping it', () => {
    const env = createEmptyEnv('cross-pull-resolve-invalid-binary');
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
            revealedUntilTimestamp: 60_000,
            fullHash: `0x${'aa'.repeat(32)}`,
            partialRoot: `0x${'bb'.repeat(32)}`,
          },
          targetPull: {
            pullId: 'target-pull',
            tokenId: 1,
            amount: 1_000n,
            signedAmount: 1_000n,
            revealedUntilTimestamp: 60_000,
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
          type: 'pull_resolve',
          data: {
            pullId: 'source-pull',
            binary: '0x1234',
          },
        },
        [],
      ),
    ).toThrow('CROSS_J_PULL_RESOLVE_BINARY_INVALID');
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
      cumulativeFillRatio: 100,
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
    env.eReplicas.set(`${sourceHub}:${sourceSigner}`, {
      entityId: sourceHub,
      signerId: sourceSigner,
      entityEncPubKey: '',
      entityEncPrivKey: '',
      mempool: [],
      isProposer: true,
      state: sourceState,
    } satisfies EntityReplica);
    env.eReplicas.set(`${targetHub}:${targetSigner}`, {
      entityId: targetHub,
      signerId: targetSigner,
      entityEncPubKey: '',
      entityEncPrivKey: '',
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
        cumulativeFillRatio: 100,
        cancelRemainder: true,
      },
    };
    const applied = applyCommittedCrossJurisdictionAccountTxFollowup(env, sourceState, sourceUser, ackTx, outputs);

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

    const removed = await applyEntityTx(env, targetState, removal!.entityTxs![0]!);
    const nextBook = removed.newState.orderbookExt?.books.get(pairId);
    expect(nextBook ? getBookOrder(nextBook, namespacedOrderId) : null).toBeNull();
  });

  test('cross-j book-owner fill ack routes admitted remote order to source hub', async () => {
    const env = createEmptyEnv('cross-book-owner-fill-notice');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const lot = SWAP_LOT_SCALE;
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
    const makeCanonicalAccount = (selfId: string, counterpartyId: string): AccountState => {
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
    } as RuntimeState['gossip'];

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
          createdAt: env.timestamp,
          updatedAt: env.timestamp,
          expiresAt: env.timestamp + 60_000,
        },
        { runtimeSeed: 'cross-book-owner-fill-notice', sourceDisputeDelayMs: 5_000, now: env.timestamp },
      );
      return { ...prepared, status: 'resting', updatedAt: env.timestamp };
    };

    const makerRoute = buildRoute(
      'remote-maker-cross',
      sourceJurisdiction,
      remoteMaker,
      sourceHub,
      2,
      30n * lot,
      bookOwnerJurisdiction,
      bookOwnerHub,
      remoteTargetUser,
      1,
      75_000n * lot,
    );
    const takerRoute = buildRoute(
      'local-taker-cross',
      bookOwnerJurisdiction,
      localTaker,
      bookOwnerHub,
      1,
      75_000n * lot,
      sourceJurisdiction,
      bookOwnerHub,
      localTargetUser,
      2,
      30n * lot,
    );

    const sourceState = makeEntityState(sourceHub);
    sourceState.config = makeSingleSignerConfigFor(sourceHubSigner);
    sourceState.config = {
      ...sourceState.config,
      validators: [sourceHubSigner],
      shares: { [sourceHubSigner]: 1n },
    };
    sourceState.crossJurisdictionSwaps = new Map([[makerRoute.orderId, makerRoute]]);
    const makerSourceAccount = makeCanonicalAccount(sourceHub, remoteMaker);
    makerSourceAccount.swapOffers.set(makerRoute.orderId, {
      offerId: makerRoute.orderId,
      giveTokenId: makerRoute.source.tokenId,
      giveAmount: makerRoute.source.amount,
      wantTokenId: makerRoute.target.tokenId,
      wantAmount: makerRoute.target.amount,
      makerIsLeft: makerSourceAccount.leftEntity.toLowerCase() === remoteMaker.toLowerCase(),
      timeInForce: 0,
      createdHeight: 1,
      priceTicks: 25_000_000n,
      crossJurisdiction: makerRoute,
    });
    sourceState.accounts.set(remoteMaker, makerSourceAccount);

    const bookOwnerState = makeEntityState(bookOwnerHub);
    bookOwnerState.config = makeSingleSignerConfigFor(bookOwnerSigner);
    const makerAdmission = mergeCrossJurisdictionBookAdmission(bookOwnerState, makerRoute, env.timestamp);
    makerAdmission.status = 'admitted';
    makerAdmission.admittedAt = env.timestamp;
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
      books: new Map([[pairId, book]]),
      orderPairs: new Map([[`${remoteMaker}:${makerRoute.orderId}`, [pairId]]]),
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
    takerAccount.swapOffers.set(takerRoute.orderId, {
      offerId: takerRoute.orderId,
      giveTokenId: takerRoute.source.tokenId,
      giveAmount: takerRoute.source.amount,
      wantTokenId: takerRoute.target.tokenId,
      wantAmount: takerRoute.target.amount,
      makerIsLeft: takerAccount.leftEntity.toLowerCase() === localTaker.toLowerCase(),
      timeInForce: 0,
      createdHeight: 2,
      priceTicks: 25_000_000n,
      crossJurisdiction: takerRoute,
    });
    bookOwnerState.accounts.set(localTaker, takerAccount);

    const collisionOwner = `0x${'35'.repeat(32)}`;
    const collisionState = makeEntityState(collisionOwner);
    collisionState.config = makeSingleSignerConfigFor(collisionSigner);
    const collisionAccount = makeCanonicalAccount(collisionOwner, remoteMaker);
    collisionAccount.swapOffers.set(makerRoute.orderId, {
      offerId: makerRoute.orderId,
      giveTokenId: makerRoute.source.tokenId,
      giveAmount: makerRoute.source.amount,
      wantTokenId: makerRoute.target.tokenId,
      wantAmount: makerRoute.target.amount,
      makerIsLeft: collisionAccount.leftEntity.toLowerCase() === remoteMaker.toLowerCase(),
      timeInForce: 0,
      createdHeight: 1,
      priceTicks: 25_000_000n,
      crossJurisdiction: makerRoute,
    });
    collisionState.accounts.set(remoteMaker, collisionAccount);
    env.eReplicas.set(`${collisionOwner}:${collisionSigner}`, {
      entityId: collisionOwner,
      signerId: collisionSigner,
      entityEncPubKey: '',
      entityEncPrivKey: '',
      mempool: [],
      isProposer: true,
      state: collisionState,
    } satisfies EntityReplica);
    env.eReplicas.set(`${sourceHub}:${sourceHubSigner}`, {
      entityId: sourceHub,
      signerId: sourceHubSigner,
      entityEncPubKey: '',
      entityEncPrivKey: '',
      mempool: [],
      isProposer: true,
      state: sourceState,
    } satisfies EntityReplica);
    env.eReplicas.set(`${bookOwnerHub}:${bookOwnerSigner}`, {
      entityId: bookOwnerHub,
      signerId: bookOwnerSigner,
      entityEncPubKey: '',
      entityEncPrivKey: '',
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
    makerAdmission.route.sourceHubSignerId = 'committed-source-hub-route';

    const matched = await applyEntityFrame(
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
    expect(sourceNotice?.localRuntimeProtocol).toBe('cross-j');
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

    const sourceApplied = await applyEntityFrame(env, sourceState, [
      {
        type: 'runtimeOutput',
        data: {
          protocol: 'cross-j',
          sourceEntityId: bookOwnerHub,
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
    env.timestamp = 10_000;
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
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: env.timestamp + 60_000,
      },
      { runtimeSeed: 'cross-local-fill-ack-admission-collision', sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
    const restingRoute = { ...route, status: 'resting' as const, updatedAt: env.timestamp };
    const sourceState = makeEntityState(sourceHub);
    installSingleSignerBoard(env, sourceState);
    sourceState.crossJurisdictionSwaps = new Map([[orderId, restingRoute]]);
    const account = makeProposalAccount([], sourceHub, user);
    account.swapOffers.set(orderId, {
      offerId: orderId,
      giveTokenId: restingRoute.source.tokenId,
      giveAmount: restingRoute.source.amount,
      wantTokenId: restingRoute.target.tokenId,
      wantAmount: restingRoute.target.amount,
      makerIsLeft: account.leftEntity.toLowerCase() === user.toLowerCase(),
      timeInForce: 0,
      createdHeight: 1,
      priceTicks: 25_000_000n,
      crossJurisdiction: restingRoute,
    });
    sourceState.accounts.set(user, account);

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
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: env.timestamp + 60_000,
      },
      {
        runtimeSeed: 'cross-local-fill-ack-admission-collision-conflict',
        sourceDisputeDelayMs: 5_000,
        now: env.timestamp,
      },
    );
    const conflictingAdmission = mergeCrossJurisdictionBookAdmission(sourceState, conflictingRoute, env.timestamp);
    conflictingAdmission.status = 'admitted';
    conflictingAdmission.admittedAt = env.timestamp;

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
          pairId,
        },
      },
    ];
    const applied = await applyEntityFrame(
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
