import { describe, expect, spyOn, test } from 'bun:test';

import { x25519 } from '@noble/curves/ed25519.js';

import {
  applyAccountInput,
  getIncomingAccountDeadlineViolation,
  HTLC_ENFORCEMENT_RESERVE_MS,
  isHtlcSecretEnforcementWindowClosed,
  proposeAccountFrame,
  validateAccountFrame,
} from '../account/consensus/index';

import { computeAccountStateRoot, computeAccountStateRootCold } from '../account/state-root';

import { resolveCertifiedAccountCounterpartyProposer } from '../account/counterparty-route';

import { createEmptyAccountJClaimAccumulator } from '../account/j-claim-accumulator';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey, signAccountFrame } from '../account/crypto';

import { deriveAccountWatchSeed } from '../account/watch-seed';

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
  ACCOUNT_TIMEOUT_MS,
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

import { createDefaultDelta } from '../validation-utils';

import { cloneEntityState } from '../state-helpers';

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

import { signEntityHashes, verifyHankoForHash } from '../hanko/signing';

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

import {
  clearReplayOutputSignerHints,
  cloneAccountMachine,
  installReplayOutputSignerHints,
  resolveEntityProposerId,
} from '../state-helpers';

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
  targetSignerId = 'fixture-counterparty-signer',
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
  account.pendingAccountInputSignerId = targetSignerId;
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
  mempool: [],
  isProposer: true,
  state: {
    entityId: `0x${'11'.repeat(32)}`,
    height: 1,
    timestamp: 0,
    nonces: new Map(),
    messages: [],
    proposals: new Map(),
    config: makeSingleSignerConfig(),
    reserves: new Map(),
    accounts: new Map(),
    deferredAccountProposals: new Map(),
    lastFinalizedJHeight: 0,
    jBlockChain: [],
    entityEncPubKey: `0x${'33'.repeat(32)}`,
    entityEncPrivKey: `0x${'44'.repeat(32)}`,
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
  messages: [],
  proposals: new Map(),
  config: makeSingleSignerConfig(),
  reserves: new Map(),
  accounts: new Map(),
  deferredAccountProposals: new Map(),
  lastFinalizedJHeight: 0,
  jBlockChain: [],
  entityEncPubKey: `0x${'55'.repeat(32)}`,
  entityEncPrivKey: `0x${'66'.repeat(32)}`,
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
        initialNonce: 7,
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
  test('cross-j fill notice waits for source offer instead of looping fatal errors', async () => {
    const env = createEmptyEnv('cross-fill-notice-pending-source-offer');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const lot = SWAP_LOT_SCALE;
    const sourceHub = `0x${'20'.repeat(32)}`;
    const sourceUser = `0x${'31'.repeat(32)}`;
    const targetHub = `0x${'32'.repeat(32)}`;
    const targetUser = `0x${'33'.repeat(32)}`;
    const orderId = 'source-offer-race';
    const pairId = 'cross:base:2/tron:1';
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId,
        makerEntityId: sourceUser,
        hubEntityId: targetHub,
        bookOwnerEntityId: targetHub,
        venueId: pairId,
        sourceSignerId: 'source-user-signer',
        sourceHubSignerId: 'source-hub-signer',
        targetHubSignerId: 'target-hub-signer',
        targetSignerId: 'target-user-signer',
        bookHubSignerId: 'target-hub-signer',
        source: {
          jurisdiction: 'base',
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 2,
          amount: 30n * lot,
        },
        target: {
          jurisdiction: 'tron',
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 75_000n * lot,
        },
        status: 'resting',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: env.timestamp + 60_000,
      },
      { runtimeSeed: 'cross-fill-notice-pending-source-offer', sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
    route.status = 'resting';

    const sourceState = makeEntityState(sourceHub);
    installSingleSignerBoard(env, sourceState);
    sourceState.crossJurisdictionSwaps = new Map([[orderId, route]]);
    sourceState.accounts.set(sourceUser, makeProposalAccount([], sourceHub, sourceUser));

    const cappedState = structuredClone(sourceState) as typeof sourceState;
    cappedState.pendingCrossJurisdictionFillAcks = new Map();
    for (let index = 0; index < MAX_PENDING_CROSS_J_FILL_ACKS; index += 1) {
      const oldAck: Extract<AccountTx, { type: 'cross_swap_fill_ack' }> = {
        type: 'cross_swap_fill_ack',
        data: {
          offerId: `old-source-offer-race-${index}`,
          routeHash: route.routeHash,
          fillSeq: index + 1,
          cumulativeFillRatio: index % 65_536,
          cumulativeSourceAmount: 1n,
          cumulativeTargetAmount: 1n,
        },
      };
      cappedState.pendingCrossJurisdictionFillAcks.set(`old-${index}`, {
        accountId: sourceUser,
        tx: oldAck,
        storedAt: env.timestamp - 100_000 - index,
        ttlExpiredAt: env.timestamp - 50_000 - index,
        reason: 'test-cap',
      });
    }
    const fillNoticeTxs: EntityTx[] = [
      {
        type: 'crossJurisdictionFillNotice',
        data: {
          orderId,
          fillSeq: 1,
          incrementalSourceAmount: 30n * lot,
          incrementalTargetAmount: 75_000n * lot,
          cumulativeSourceAmount: 30n * lot,
          cumulativeTargetAmount: 75_000n * lot,
          cumulativeFillRatio: 65_535,
          pairId,
        },
      },
    ];
    await expect(
      applyEntityFrame(env, cappedState, await buildQuorumAuthorizedFrameTxs(env, cappedState, fillNoticeTxs)),
    ).rejects.toThrow('CROSS_J_FILL_ACK_PENDING_CAPACITY');
    expect(cappedState.pendingCrossJurisdictionFillAcks.size).toBe(MAX_PENDING_CROSS_J_FILL_ACKS);
    expect(
      Array.from(cappedState.pendingCrossJurisdictionFillAcks.values()).some(
        entry => entry.tx.data.offerId === orderId && entry.tx.data.fillSeq === 1,
      ),
    ).toBe(false);

    const first = await applyEntityFrame(
      env,
      sourceState,
      await buildQuorumAuthorizedFrameTxs(env, sourceState, fillNoticeTxs),
    );

    expect(first.newState.pendingCrossJurisdictionFillAcks?.size).toBe(1);
    const pendingAccount = first.newState.accounts.get(sourceUser);
    const prematurelyQueued = [
      ...(pendingAccount?.mempool ?? []),
      ...(pendingAccount?.pendingFrame?.accountTxs ?? []),
    ].find(tx => tx.type === 'cross_swap_fill_ack' && tx.data.offerId === orderId);
    expect(prematurelyQueued).toBeUndefined();

    const expiredState = structuredClone(first.newState) as typeof first.newState;
    const originalTimestamp = env.timestamp;
    env.timestamp = originalTimestamp + CROSS_J_PENDING_FILL_ACK_TTL_MS + 1;
    const expiredEnv = env;
    expiredState.timestamp = expiredEnv.timestamp;
    const preserved = await applyEntityFrame(expiredEnv, expiredState, []);
    const preservedAck = preserved.newState.pendingCrossJurisdictionFillAcks?.values().next().value;
    expect(preservedAck?.ttlExpiredAt).toBe(expiredEnv.timestamp);
    expect([...expiredEnv.runtimeState!.securityIncidents!.values()]).toContainEqual(
      expect.objectContaining({
        code: 'CROSS_J_FILL_ACK_TTL_EXPIRED',
        status: 'active',
        entityId: sourceState.entityId,
        offerId: orderId,
      }),
    );
    env.timestamp = originalTimestamp;

    const stateWithOffer = first.newState;
    const sourceAccount = stateWithOffer.accounts.get(sourceUser)!;
    sourceAccount.swapOffers.set(orderId, {
      offerId: orderId,
      giveTokenId: route.source.tokenId,
      giveAmount: route.source.amount,
      wantTokenId: route.target.tokenId,
      wantAmount: route.target.amount,
      makerIsLeft: sourceAccount.leftEntity.toLowerCase() === sourceUser.toLowerCase(),
      timeInForce: 0,
      createdHeight: 1,
      priceTicks: 25_000_000n,
      crossJurisdiction: route,
    });

    const second = await applyEntityFrame(env, stateWithOffer, []);
    expect(second.newState.pendingCrossJurisdictionFillAcks?.size ?? 0).toBe(0);
    const drainedAccount = second.newState.accounts.get(sourceUser);
    const queuedAck = [...(drainedAccount?.mempool ?? []), ...(drainedAccount?.pendingFrame?.accountTxs ?? [])].find(
      tx => tx.type === 'cross_swap_fill_ack' && tx.data.offerId === orderId,
    );
    expect(queuedAck).toBeDefined();
  });

  test('cross-j fill ack admission fallback requires matching route hash', () => {
    const env = createEmptyEnv('cross-fill-ack-admission-fallback');
    env.timestamp = 10_000;
    const sourceHub = `0x${'20'.repeat(32)}`;
    const sourceUser = `0x${'31'.repeat(32)}`;
    const targetHub = `0x${'32'.repeat(32)}`;
    const targetUser = `0x${'33'.repeat(32)}`;
    const orderId = 'source-admission-fallback';
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId,
        makerEntityId: sourceUser,
        hubEntityId: targetHub,
        bookOwnerEntityId: targetHub,
        venueId: 'cross:base:2/tron:1',
        sourceSignerId: 'source-user-signer',
        sourceHubSignerId: 'source-hub-signer',
        targetHubSignerId: 'target-hub-signer',
        targetSignerId: 'target-user-signer',
        bookHubSignerId: 'target-hub-signer',
        source: {
          jurisdiction: 'base',
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 2,
          amount: 10n * SWAP_LOT_SCALE,
        },
        target: {
          jurisdiction: 'tron',
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 1,
          amount: 25_000n * SWAP_LOT_SCALE,
        },
        status: 'resting',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: env.timestamp + 60_000,
      },
      { runtimeSeed: 'cross-fill-ack-admission-fallback', sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
    const state = makeEntityState(targetHub);
    const routeHash = route.routeHash || 'route-hash';
    const admission = {
      orderId,
      routeHash,
      sourceEntityId: sourceUser,
      bookOwnerEntityId: targetHub,
      status: 'admitted' as const,
      route,
      updatedAt: env.timestamp,
    };
    state.crossJurisdictionBookAdmissions = new Map([[`${sourceUser.toLowerCase()}:${orderId}`, admission]]);

    expect(findCrossJurisdictionBookAdmissionForAck(state, sourceUser, orderId)).toBe(admission);
    expect(findCrossJurisdictionBookAdmissionForAck(state, sourceUser, orderId, `0x${'ff'.repeat(32)}`)).toBeNull();
    expect(findCrossJurisdictionBookAdmissionForAck(state, sourceUser, orderId, routeHash)).toBe(admission);
    expect(findCrossJurisdictionBookAdmissionForAck(state, targetHub, orderId)).toBeNull();
    expect(findCrossJurisdictionBookAdmissionForAck(state, targetHub, orderId, `0x${'ff'.repeat(32)}`)).toBeNull();
    expect(findCrossJurisdictionBookAdmissionForAck(state, targetHub, orderId, routeHash)).toBe(admission);
  });

  test('committed cross-j signer requires its local sibling and ignores unrelated topology', () => {
    const missing = createEmptyEnv('cross-output-topology-missing');
    const minimal = createEmptyEnv('cross-output-topology-minimal');
    const populated = createEmptyEnv('cross-output-topology-populated');
    const target = `0x${'ab'.repeat(32)}`;
    const committedSigner = `0x${'cd'.repeat(20)}`;
    const staleSigner = `0x${'ef'.repeat(20)}`;
    const txs: EntityTx[] = [{ type: 'j_broadcast', data: {} }];
    attachSigningReplica(minimal, target, committedSigner);
    attachSigningReplica(populated, target, committedSigner);
    populated.eReplicas.set('stale-topology', {
      entityId: target.toUpperCase(),
      signerId: staleSigner,
      mempool: [],
      isProposer: true,
      state: {
        ...makeEntityState(target.toUpperCase()),
        config: makeSingleSignerConfigFor(staleSigner),
      },
    } satisfies EntityReplica);

    expect(() => buildCrossJurisdictionEntityOutput(missing, target, txs, committedSigner)).toThrow(
      'CROSS_J_SIBLING_TARGET_NOT_LOCAL',
    );
    expect(buildCrossJurisdictionEntityOutput(minimal, target, txs, committedSigner)).toEqual(
      buildCrossJurisdictionEntityOutput(populated, target, txs, committedSigner),
    );
  });

  test('cross-j rejects target-side bonus economics before route commitment', () => {
    const unsupportedRoute = {
      orderId: 'target-bonus-unsupported',
      priceImprovementMode: 'target_bonus',
    } as unknown as CrossJurisdictionSwapRoute;

    expect(() => withCanonicalCrossJurisdictionRouteHash(unsupportedRoute)).toThrow(
      'CROSS_J_PRICE_IMPROVEMENT_MODE_UNSUPPORTED:target-bonus-unsupported:target_bonus',
    );
  });

  test('prepareDispute removes same-account orderbook rows before disputeStart', async () => {
    const env = createEmptyEnv('dispute-start-orderbook-freeze');
    const hubId = `0x${'90'.repeat(32)}`;
    const userId = `0x${'91'.repeat(32)}`;
    const offerId = 'dispute-freeze-offer';
    const pairId = '1/2';
    const namespacedOrderId = `${userId}:${offerId}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    const account = makeProposalAccount([], hubId, userId);
    account.swapOffers.set(offerId, {
      offerId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 2,
      wantAmount: 2_000n,
      makerIsLeft: false,
      createdHeight: 1,
      quantizedGive: 1_000n,
      quantizedWant: 2_000n,
      priceTicks: 2_000n,
    });
    hubState.accounts.set(userId, account);
    let book = createBook({ bucketWidthTicks: 1n, maxOrders: 10, stpPolicy: 1 });
    book = applyCommand(book, {
      kind: 0,
      ownerId: userId,
      orderId: namespacedOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 2_000n,
      qtyLots: 1n,
    }).state;
    hubState.orderbookExt = {
      books: new Map([[pairId, book]]),
      orderPairs: new Map([[namespacedOrderId, [pairId]]]),
      referrals: new Map(),
    } as unknown as OrderbookExtState;

    const result = await handlePrepareDispute(
      hubState,
      {
        type: 'prepareDispute',
        data: { counterpartyEntityId: userId },
      },
      env,
    );

    const nextBook = result.newState.orderbookExt?.books.get(pairId);
    expect(nextBook ? getBookOrder(nextBook, namespacedOrderId) : null).toBeNull();
    expect(result.newState.messages.some(msg => msg.includes('Dispute removed 1 local orderbook row'))).toBe(true);
  });

  test('prepareDispute routes remote cross-j removal from the committed book signer', async () => {
    const env = createEmptyEnv('dispute-start-cross-j-remote-book');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const sourceHub = `0x${'92'.repeat(32)}`;
    const sourceUser = `0x${'93'.repeat(32)}`;
    const targetHub = `0x${'94'.repeat(32)}`;
    const targetUser = `0x${'95'.repeat(32)}`;
    const offerId = 'dispute-cross-j-remote-book';
    const state = makeEntityState(sourceHub);
    state.config = makeSingleSignerConfigFor('source-hub-signer');
    const account = makeProposalAccount([], sourceHub, sourceUser);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: offerId,
        makerEntityId: sourceUser,
        hubEntityId: targetHub,
        bookOwnerEntityId: targetHub,
        sourceSignerId: 'source-user-signer',
        sourceHubSignerId: 'source-hub-signer',
        targetHubSignerId: 'committed-book-owner-signer',
        targetSignerId: 'target-user-signer',
        bookHubSignerId: 'committed-book-owner-signer',
        source: {
          jurisdiction: 'stack:31338:0x2222222222222222222222222222222222222222',
          entityId: sourceUser,
          counterpartyEntityId: sourceHub,
          tokenId: 1,
          amount: 1_000n,
        },
        target: {
          jurisdiction: 'stack:31337:0x1111111111111111111111111111111111111111',
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 2,
          amount: 2_000n,
        },
        status: 'resting',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
        expiresAt: env.timestamp + 60_000,
      },
      { runtimeSeed: 'dispute-start-cross-j-remote-book', sourceDisputeDelayMs: 5_000, now: env.timestamp },
    );
    account.swapOffers.set(offerId, {
      offerId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 2,
      wantAmount: 2_000n,
      makerIsLeft: false,
      createdHeight: 1,
      crossJurisdiction: route,
    });
    state.accounts.set(sourceUser, account);
    state.crossJurisdictionSwaps = new Map([[offerId, route]]);
    mergeCrossJurisdictionBookAdmission(state, route, env.timestamp).status = 'admitted';

    const result = await handlePrepareDispute(
      state,
      { type: 'prepareDispute', data: { counterpartyEntityId: sourceUser } },
      env,
    );

    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toMatchObject({
      entityId: targetHub,
      signerId: 'committed-book-owner-signer',
      entityTxs: [
        {
          type: 'removeCrossJurisdictionBookOrder',
          data: { orderId: offerId, sourceEntityId: sourceUser, reason: 'account_dispute_prepare' },
        },
      ],
    });

    const afterAck = await handleCrossJurisdictionBookOrderRemovedEntityTx(env, result.newState, {
      type: 'crossJurisdictionBookOrderRemoved',
      data: {
        orderId: offerId,
        sourceEntityId: sourceUser,
        sourceAccountId: sourceUser,
        route,
        removedAt: env.timestamp,
        reason: 'account_dispute_prepare',
      },
    });
    const preparedAccount = afterAck.newState.accounts.get(sourceUser)!;
    expect(preparedAccount.disputePrepare?.pendingOrderbookRemovalIds).toBeUndefined();
    expect(afterAck.newState.messages.some(msg => msg.includes('Missing counterparty dispute hanko'))).toBe(true);
  });

  test('prepareDispute freezes account and removes orderbook rows without queuing on-chain disputeStart', async () => {
    const env = createEmptyEnv('prepare-dispute-orderbook-freeze');
    const hubId = `0x${'92'.repeat(32)}`;
    const userId = `0x${'93'.repeat(32)}`;
    const offerId = 'prepare-dispute-offer';
    const pairId = '1/2';
    const namespacedOrderId = `${userId}:${offerId}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    const account = makeProposalAccount([], hubId, userId);
    account.swapOffers.set(offerId, {
      offerId,
      giveTokenId: 1,
      giveAmount: 1_000n,
      wantTokenId: 2,
      wantAmount: 2_000n,
      makerIsLeft: false,
      createdHeight: 1,
      quantizedGive: 1_000n,
      quantizedWant: 2_000n,
      priceTicks: 2_000n,
    });
    hubState.accounts.set(userId, account);
    let book = createBook({ bucketWidthTicks: 1n, maxOrders: 10, stpPolicy: 1 });
    book = applyCommand(book, {
      kind: 0,
      ownerId: userId,
      orderId: namespacedOrderId,
      side: 1,
      tif: 0,
      postOnly: false,
      priceTicks: 2_000n,
      qtyLots: 1n,
    }).state;
    hubState.orderbookExt = {
      books: new Map([[pairId, book]]),
      orderPairs: new Map([[namespacedOrderId, [pairId]]]),
      referrals: new Map(),
    } as unknown as OrderbookExtState;

    const result = await handlePrepareDispute(
      hubState,
      {
        type: 'prepareDispute',
        data: { counterpartyEntityId: userId, description: 'test-prepare' },
      },
      env,
    );

    const nextAccount = result.newState.accounts.get(userId)!;
    const nextBook = result.newState.orderbookExt?.books.get(pairId);
    expect(nextAccount.status).toBe('dispute_preparing');
    expect(nextAccount.disputePrepare?.reason).toBe('test-prepare');
    expect(nextBook ? getBookOrder(nextBook, namespacedOrderId) : null).toBeNull();
    expect(result.newState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
  });

  test('disputeStart freezes optimistic traffic and treats an unknown HTLC secret as optional evidence', async () => {
    const env = createEmptyEnv('prepare-dispute-awaiting-secret');
    const hubId = `0x${'94'.repeat(32)}`;
    const userId = `0x${'95'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    const account = makeProposalAccount(
      [
        {
          type: 'set_credit_limit',
          data: { tokenId: 1, amount: 5n },
        } as AccountTx,
      ],
      hubId,
      userId,
    );
    setSyntheticPendingAccountProposal(
      account,
      [
        {
          type: 'set_credit_limit',
          data: { tokenId: 1, amount: 7n },
        } as AccountTx,
      ],
      hubState.timestamp,
    );
    hubState.accounts.set(userId, account);
    const hashlock = `0x${'44'.repeat(32)}`;
    hubState.htlcRoutes.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      inboundEntity: userId,
      inboundLockId: 'await-secret-lock',
      createdTimestamp: hubState.timestamp,
    });
    hubState.lockBook.set('await-secret-lock', {
      lockId: 'await-secret-lock',
      accountId: userId,
      tokenId: 1,
      amount: 10n,
      hashlock,
      timelock: BigInt(hubState.timestamp + 60_000),
      direction: 'incoming',
      createdAt: BigInt(hubState.timestamp),
    });

    const prepared = await handlePrepareDispute(
      hubState,
      {
        type: 'prepareDispute',
        data: { counterpartyEntityId: userId },
      },
      env,
    );
    const result = await handleDisputeStart(
      prepared.newState,
      { type: 'disputeStart', data: { counterpartyEntityId: userId } },
      env,
    );

    const nextAccount = result.newState.accounts.get(userId)!;
    expect(result.newState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
    expect(result.newState.messages.some(msg => msg.includes('htlcAwaitingSecret'))).toBe(false);
    expect(result.newState.messages.some(msg => msg.includes('Missing counterparty dispute hanko'))).toBe(true);
    expect(nextAccount.pendingFrame).toBeUndefined();
    expect(nextAccount.mempool).toEqual([]);
  });

  test('disputeStart ignores stale HTLC routes whose live lock is already gone', async () => {
    const env = createEmptyEnv('prepare-dispute-stale-htlc-route');
    const hubId = `0x${'94'.repeat(32)}`;
    const userId = `0x${'96'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    hubState.accounts.set(userId, makeProposalAccount([], hubId, userId));
    hubState.htlcRoutes.set(`0x${'45'.repeat(32)}`, {
      hashlock: `0x${'45'.repeat(32)}`,
      tokenId: 1,
      amount: 10n,
      inboundEntity: userId,
      inboundLockId: 'stale-timeout-lock',
      createdTimestamp: hubState.timestamp,
    });

    const prepared = await handlePrepareDispute(
      hubState,
      {
        type: 'prepareDispute',
        data: { counterpartyEntityId: userId },
      },
      env,
    );
    const result = await handleDisputeStart(
      prepared.newState,
      { type: 'disputeStart', data: { counterpartyEntityId: userId } },
      env,
    );

    expect(result.newState.messages.some(msg => msg.includes('htlcAwaitingSecret'))).toBe(false);
    expect(result.newState.messages.some(msg => msg.includes('Missing counterparty dispute hanko'))).toBe(true);
  });

  test('committed HTLC forward enforces announced PPM fee, not only base fee', async () => {
    const seed = 'htlc-forward-ppm-fee';
    const env = createEmptyEnv(seed);
    const signerId = deriveSignerAddressSync(seed, 'hub');
    const signerKey = deriveSignerKeySync(seed, 'hub');
    const nextHopSignerId = deriveSignerAddressSync(seed, 'next-hop');
    const nextHopSignerKey = deriveSignerKeySync(seed, 'next-hop');
    registerSignerKey(env, signerId, signerKey);
    registerSignerKey(env, nextHopSignerId, nextHopSignerKey);
    const hubId = generateLazyEntityId([signerId], 1n).toLowerCase();
    const payerId = `0x${'a1'.repeat(32)}`;
    const nextHopId = generateLazyEntityId([nextHopSignerId], 1n).toLowerCase();
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor(signerId);
    hubState.hubRebalanceConfig = {
      matchingStrategy: 'amount',
      policyVersion: 1,
      routingFeePPM: 100_000,
      baseFee: 10n,
    };
    hubState.accounts.set(
      nextHopId,
      isLeftEntity(hubId, nextHopId)
        ? makeProposalAccount([], hubId, nextHopId)
        : makeProposalAccount([], nextHopId, hubId),
    );
    const crypto = new NobleCryptoProvider();
    const keyPair = x25519.keygen();
    hubState.entityEncPubKey = hexBytes(keyPair.publicKey);
    hubState.entityEncPrivKey = hexBytes(keyPair.secretKey);
    const signerPublicKey = new ethers.SigningKey(hexBytes(signerKey)).publicKey.toLowerCase();
    const attestationBody = {
      version: 'xln:validator-encryption-key:v1' as const,
      entityId: hubId,
      signerId,
      signer: signerId,
      publicKey: signerPublicKey,
      weight: 1,
      encryptionPublicKey: hubState.entityEncPubKey,
    };
    const manifest = requireCompleteValidatorEncryptionManifest(
      {
        entityId: hubId,
        threshold: 1,
        validators: [
          {
            signerId,
            signer: signerId,
            publicKey: signerPublicKey,
            weight: 1,
          },
        ],
      },
      [
        {
          ...attestationBody,
          signature: signAccountFrame(env, signerId, computeValidatorEncryptionAttestationDigest(attestationBody)),
        },
      ],
    );
    hubState.profileEncryptionManifest = structuredClone(manifest);
    const lockId = 'ppm-fee-lock';
    const finalSecret = `0x${'a4'.repeat(32)}`;
    const hashlock = hashHtlcSecret(finalSecret);
    const timelock = BigInt(hubState.timestamp + 120_000);
    const contextHash = computeHtlcEnvelopeContextHash({
      entityId: hubId,
      lockId,
      hashlock,
      tokenId: 1,
      amount: 1_000_000n,
      timelock,
      revealBeforeHeight: 100,
    });
    const routingStateHash = ethers.keccak256(ethers.toUtf8Bytes('ppm-fee-routing-state'));
    const profileHash = computeEntityProfileCertificationHash(manifest.hash, routingStateHash);
    const [profileHanko] = await signEntityHashes(env, hubId, signerId, [profileHash], hubState);
    if (!profileHanko) throw new Error('TEST_PROFILE_HANKO_MISSING');
    const profileCertification = { profileHash, routingStateHash, hanko: profileHanko };

    const nextHopState = makeEntityState(nextHopId);
    nextHopState.config = makeSingleSignerConfigFor(nextHopSignerId);
    const nextHopKeyPair = x25519.keygen();
    const nextHopEncryptionPublicKey = hexBytes(nextHopKeyPair.publicKey);
    const nextHopSignerPublicKey = new ethers.SigningKey(hexBytes(nextHopSignerKey)).publicKey.toLowerCase();
    const nextHopAttestationBody = {
      version: 'xln:validator-encryption-key:v1' as const,
      entityId: nextHopId,
      signerId: nextHopSignerId,
      signer: nextHopSignerId,
      publicKey: nextHopSignerPublicKey,
      weight: 1,
      encryptionPublicKey: nextHopEncryptionPublicKey,
    };
    const nextHopManifest = requireCompleteValidatorEncryptionManifest(
      {
        entityId: nextHopId,
        threshold: 1,
        validators: [
          {
            signerId: nextHopSignerId,
            signer: nextHopSignerId,
            publicKey: nextHopSignerPublicKey,
            weight: 1,
          },
        ],
      },
      [
        {
          ...nextHopAttestationBody,
          signature: signAccountFrame(
            env,
            nextHopSignerId,
            computeValidatorEncryptionAttestationDigest(nextHopAttestationBody),
          ),
        },
      ],
    );
    const nextHopRoutingStateHash = ethers.keccak256(ethers.toUtf8Bytes('next-hop-routing-state'));
    const nextHopProfileHash = computeEntityProfileCertificationHash(nextHopManifest.hash, nextHopRoutingStateHash);
    const [nextHopProfileHanko] = await signEntityHashes(
      env,
      nextHopId,
      nextHopSignerId,
      [nextHopProfileHash],
      nextHopState,
    );
    if (!nextHopProfileHanko) throw new Error('TEST_NEXT_HOP_PROFILE_HANKO_MISSING');
    const forwardAmount = 999_990n;
    const forwardTimelock = timelock - BigInt(HTLC.MIN_TIMELOCK_DELTA_MS);
    const forwardRevealBeforeHeight = 100 - HTLC.MIN_REVEAL_HEIGHT_DELTA_BLOCKS;
    const innerContextHash = computeHtlcEnvelopeContextHash({
      entityId: nextHopId,
      lockId: `${lockId}-fwd`,
      hashlock,
      tokenId: 1,
      amount: forwardAmount,
      timelock: forwardTimelock,
      revealBeforeHeight: forwardRevealBeforeHeight,
    });
    const secretOffer = await encryptBytesForValidatorManifest(
      encodeHtlcSecretOffer({ secret: finalSecret }),
      manifest,
      profileCertification,
      computeHtlcSecretOfferContextHash({
        entityId: nextHopId,
        payerEntityId: hubId,
        beneficiaryEntityId: nextHopId,
        lockId: `${lockId}-fwd`,
        hashlock,
        tokenId: 1,
        amount: forwardAmount,
        timelock: forwardTimelock,
        revealBeforeHeight: forwardRevealBeforeHeight,
      }),
      crypto,
      signerId,
    );
    const innerEnvelope = await encryptBytesForValidatorManifest(
      encodeOnionLayer({ finalRecipient: true, secretOffer }),
      nextHopManifest,
      {
        profileHash: nextHopProfileHash,
        routingStateHash: nextHopRoutingStateHash,
        hanko: nextHopProfileHanko,
      },
      innerContextHash,
      crypto,
      nextHopSignerId,
    );
    const encryptedLayer = await encryptBytesForValidatorManifest(
      encodeOnionLayer({
        nextHop: nextHopId,
        innerEnvelope,
        forwardAmount: forwardAmount.toString(),
      }),
      manifest,
      profileCertification,
      contextHash,
      crypto,
      signerId,
    );
    const accountMachine = isLeftEntity(payerId, hubId)
      ? makeProposalAccount([], payerId, hubId)
      : makeProposalAccount([], hubId, payerId);
    accountMachine.locks.set(lockId, {
      lockId,
      hashlock,
      timelock,
      revealBeforeHeight: 100,
      amount: 1_000_000n,
      tokenId: 1,
      senderIsLeft: true,
      createdHeight: 1,
      createdTimestamp: hubState.timestamp,
      envelopeHash: hashEncryptedHtlcLayer(encryptedLayer),
    });
    hubState.accounts.set(payerId, accountMachine);
    const lock = accountMachine.locks.get(lockId);
    if (!lock) throw new Error('TEST_HTLC_LOCK_MISSING');
    const advanceTx = buildHtlcOnionAdvanceTx(hubState, payerId, lock, encryptedLayer, {
      nextHop: nextHopId,
      innerEnvelope,
      forwardAmount: forwardAmount.toString(),
    });
    const result = await handleHtlcOnionAdvance(env, hubState, advanceTx);

    expect(result.accountTxs).toHaveLength(1);
    expect(result.accountTxs[0]?.accountId).toBe(payerId);
    expect(result.accountTxs[0]?.tx).toEqual({
      type: 'htlc_resolve',
      data: { lockId, outcome: 'error', reason: 'fee_below_ppm' },
    });
    expect(result.newState.htlcRoutes.has(hashlock)).toBe(false);

    const replay = await handleHtlcOnionAdvance(env, structuredClone(hubState), advanceTx);
    expect(replay.accountTxs).toEqual(result.accountTxs);
    expect(replay.newState.htlcRoutes).toEqual(result.newState.htlcRoutes);
  });

  test('disputeStart folds evidence tx mempool into dispute arguments instead of blocking', async () => {
    const env = createEmptyEnv('prepare-dispute-evidence-mempool');
    const hubId = `0x${'96'.repeat(32)}`;
    const userId = `0x${'97'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    hubState.accounts.set(
      userId,
      makeProposalAccount(
        [
          {
            type: 'swap_resolve',
            data: { offerId: 'pending-fill', fillRatio: 32_768, cancelRemainder: false },
          } as AccountTx,
        ],
        hubId,
        userId,
      ),
    );

    const prepared = await handlePrepareDispute(
      hubState,
      {
        type: 'prepareDispute',
        data: { counterpartyEntityId: userId },
      },
      env,
    );
    const result = await handleDisputeStart(
      prepared.newState,
      { type: 'disputeStart', data: { counterpartyEntityId: userId } },
      env,
    );

    expect(result.newState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
    expect(result.newState.messages.some(msg => msg.includes('argumentMempool:swap_resolve'))).toBe(false);
    expect(result.newState.messages.some(msg => msg.includes('Missing counterparty dispute hanko'))).toBe(true);
  });

  test('disputeStart allows matching pending pull_resolve when explicit starter pull args are supplied', async () => {
    const env = createEmptyEnv('prepare-dispute-explicit-pull-evidence');
    env.timestamp = 11_000;
    const hubId = `0x${'9a'.repeat(32)}`;
    const userId = `0x${'9b'.repeat(32)}`;
    const targetHub = `0x${'9c'.repeat(32)}`;
    const targetUser = `0x${'9d'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'explicit-pull-evidence',
        makerEntityId: userId,
        hubEntityId: hubId,
        source: {
          jurisdiction: `stack:1:0x${'a1'.repeat(20)}`,
          entityId: userId,
          counterpartyEntityId: hubId,
          tokenId: 1,
          amount: 100n,
        },
        target: {
          jurisdiction: `stack:2:0x${'a2'.repeat(20)}`,
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 2,
          amount: 200n,
        },
        status: 'resting',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
      },
      {
        runtimeSeed: 'prepare-dispute-explicit-pull-evidence',
        sourceDisputeDelayMs: 5_000,
        now: env.timestamp,
      },
    );
    const binary = buildCrossJurisdictionPullReveal(
      route,
      0x1234,
      deriveCrossJurisdictionPrivateSeed('prepare-dispute-explicit-pull-evidence', route),
    ).binary;
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const crossPullArgs = abiCoder.encode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
      [{ fillRatios: [], secrets: [], pulls: [binary] }],
    );
    const starterInitialArguments = abiCoder.encode(['bytes[]'], [[crossPullArgs]]);
    hubState.accounts.set(
      userId,
      makeProposalAccount(
        [
          {
            type: 'pull_resolve',
            data: { pullId: route.targetPull!.pullId, binary },
          } as AccountTx,
        ],
        hubId,
        userId,
      ),
    );

    const prepared = await handlePrepareDispute(
      hubState,
      {
        type: 'prepareDispute',
        data: { counterpartyEntityId: userId },
      },
      env,
    );
    const result = await handleDisputeStart(
      prepared.newState,
      {
        type: 'disputeStart',
        data: { counterpartyEntityId: userId, starterInitialArguments },
      },
      env,
    );

    expect(result.newState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
    expect(result.newState.messages.some(msg => msg.includes('argumentMempool:pull_resolve'))).toBe(false);
    expect(result.newState.messages.some(msg => msg.includes('Missing counterparty dispute hanko'))).toBe(true);
  });

  test('disputeStart treats pending cross_pull_close as foldable dispute evidence', async () => {
    const env = createEmptyEnv('prepare-dispute-cross-close-evidence');
    env.timestamp = 12_000;
    env.browserVM = { getDepositoryAddress: () => hex20('dd') } as any;
    const hubSigner = registerLazySigner('prepare-dispute-cross-close-evidence', 'hub');
    const hubId = hubSigner.entityId;
    const userId = `0x${'ab'.repeat(32)}`;
    const targetHub = `0x${'ac'.repeat(32)}`;
    const targetUser = `0x${'ad'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor(hubSigner.signerId);
    attachSigningReplica(env, hubId, hubSigner.signerId);
    const route = buildPreparedCrossJurisdictionRoute(
      {
        orderId: 'cross-close-evidence',
        makerEntityId: userId,
        hubEntityId: hubId,
        source: {
          jurisdiction: `stack:1:0x${'b1'.repeat(20)}`,
          entityId: userId,
          counterpartyEntityId: hubId,
          tokenId: 1,
          amount: 100n,
        },
        target: {
          jurisdiction: `stack:2:0x${'b2'.repeat(20)}`,
          entityId: targetHub,
          counterpartyEntityId: targetUser,
          tokenId: 2,
          amount: 200n,
        },
        cumulativeFillRatio: 0x4000,
        filledSourceAmount: 25n,
        filledTargetAmount: 50n,
        status: 'clearing',
        createdAt: env.timestamp,
        updatedAt: env.timestamp,
      },
      {
        runtimeSeed: 'prepare-dispute-cross-close-evidence',
        sourceDisputeDelayMs: 5_000,
        now: env.timestamp,
      },
    );
    const binary = buildCrossJurisdictionPullReveal(
      route,
      0x4000,
      deriveCrossJurisdictionPrivateSeed('prepare-dispute-cross-close-evidence', route),
    ).binary;
    const closeTx: AccountTx = {
      type: 'cross_pull_close',
      data: {
        pullId: route.sourcePull!.pullId,
        binary,
        proof: buildCrossJurisdictionCloseProof(route, binary),
      },
    };
    const account = makeProposalAccount([closeTx], hubId, userId);
    account.pulls = new Map([
      [
        route.sourcePull!.pullId,
        {
          pullId: route.sourcePull!.pullId,
          tokenId: route.sourcePull!.tokenId,
          amount: route.sourcePull!.signedAmount,
          claimedRatio: 0,
          claimedAmount: 0n,
          revealedUntilTimestamp: route.sourcePull!.revealedUntilTimestamp,
          fullHash: route.sourcePull!.fullHash,
          partialRoot: route.sourcePull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
          createdHeight: 0,
          createdTimestamp: env.timestamp,
        },
      ],
    ]);
    const delta = createDefaultDelta(route.sourcePull!.tokenId);
    delta.rightHold = BigInt(route.sourcePull!.amount);
    account.deltas.set(route.sourcePull!.tokenId, delta);
    const proposed = await proposeAccountFrame(env, account, env.timestamp);
    expect(proposed.success).toBe(true);
    const pendingHeight = proposed.accountInput!.proposal.frame.height;
    account.pendingAccountInputSignerId = 'fixture-counterparty-signer';
    hubState.accounts.set(userId, account);

    const prepared = await handlePrepareDispute(
      hubState,
      {
        type: 'prepareDispute',
        data: { counterpartyEntityId: userId },
      },
      env,
    );
    const result = await handleDisputeStart(
      prepared.newState,
      { type: 'disputeStart', data: { counterpartyEntityId: userId } },
      env,
    );

    expect(result.newState.jBatchState?.batch.disputeStarts ?? []).toEqual([]);
    expect(result.newState.messages.some(msg => msg.includes(`pendingFrame:${pendingHeight}`))).toBe(false);
    expect(result.newState.messages.some(msg => msg.includes('argumentMempool:cross_pull_close'))).toBe(false);
    expect(result.newState.messages.some(msg => msg.includes('Missing counterparty dispute hanko'))).toBe(true);
  });

  test('disputeFinalize queues the exact proof despite unknown HTLC evidence and stale optimistic traffic', async () => {
    const env = createEmptyEnv('counter-dispute-awaiting-secret');
    const hubId = `0x${'98'.repeat(32)}`;
    const userId = `0x${'99'.repeat(32)}`;
    const hubState = makeEntityState(hubId);
    hubState.config = makeSingleSignerConfigFor('hub-signer');
    attachSigningReplica(env, hubId, 'hub-signer');
    const account = makeProposalAccount([], hubId, userId);
    account.deltas.set(1, createDefaultDelta(1));
    account.locks.set('counter-await-secret-lock', {
      lockId: 'counter-await-secret-lock',
      hashlock: `0x${'55'.repeat(32)}`,
      timelock: BigInt(hubState.timestamp + 60_000),
      amount: 10n,
      tokenId: 1,
      senderIsLeft: false,
      createdHeight: 1,
      createdTimestamp: hubState.timestamp,
    });
    const initialProof = buildAccountProofBody(account, hex20('99'));
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, initialProof.proofBodyHash, 1, initialProof.proofBodyStruct),
    );
    account.disputeProofBodiesByHash = {
      [initialProof.proofBodyHash]: initialProof.proofBodyStruct,
    };
    account.status = 'disputed';
    account.activeDispute = {
      startedByLeft: false,
      initialProofbodyHash: initialProof.proofBodyHash,
      initialNonce: 1,
      disputeTimeout: 100,
      jNonce: 1,
      starterInitialArguments: '0x',
      starterIncrementedArguments: '0x',
      observedOnChain: true,
      finalizeQueued: false,
    };
    setSyntheticPendingAccountProposal(
      account,
      [
        {
          type: 'set_credit_limit',
          data: { tokenId: 1, amount: 9n },
        } as AccountTx,
      ],
      hubState.timestamp,
    );
    account.mempool = [
      {
        type: 'set_credit_limit',
        data: { tokenId: 1, amount: 11n },
      } as AccountTx,
    ];
    hubState.accounts.set(userId, account);
    const hashlock = `0x${'55'.repeat(32)}`;
    hubState.htlcRoutes.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount: 10n,
      inboundEntity: userId,
      inboundLockId: 'counter-await-secret-lock',
      createdTimestamp: hubState.timestamp,
    });
    hubState.lockBook.set('counter-await-secret-lock', {
      lockId: 'counter-await-secret-lock',
      accountId: userId,
      tokenId: 1,
      amount: 10n,
      hashlock,
      timelock: BigInt(hubState.timestamp + 60_000),
      direction: 'incoming',
      createdAt: BigInt(hubState.timestamp),
    });

    const result = await handleDisputeFinalize(
      hubState,
      {
        type: 'disputeFinalize',
        data: { counterpartyEntityId: userId },
      },
      env,
    );

    const finalization = result.newState.jBatchState?.batch.disputeFinalizations[0];
    const nextAccount = result.newState.accounts.get(userId)!;
    expect(finalization).toBeDefined();
    expect(finalization?.initialProofbodyHash).toBe(initialProof.proofBodyHash);
    expect(finalization?.finalProofbody).toEqual(initialProof.proofBodyStruct);
    expect(finalization?.starterArguments).toBe('0x');
    expect(finalization?.otherArguments).toBe('0x');
    expect(result.newState.messages.some(msg => msg.includes('htlcAwaitingSecret'))).toBe(false);
    expect(nextAccount.pendingFrame).toBeUndefined();
    expect(nextAccount.mempool).toEqual([]);
  });
});
