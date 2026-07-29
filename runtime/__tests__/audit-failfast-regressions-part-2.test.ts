import { describe, expect, spyOn, test } from 'bun:test';
import { readEntityFrameEventMessages } from '../state-helpers';

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
  cloneAccountState,
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

const sealAccountDraftAsEntity = async (
  env: RuntimeState,
  entityId: string,
  signerId: string,
  draft: {
    accountInput?: AccountInput;
    hashesToSign?: Array<{ hash: string; type: 'accountFrame' | 'dispute'; context: string }>;
  },
): Promise<AccountInput> => {
  if (!draft.accountInput || !draft.hashesToSign?.length) {
    throw new Error('TEST_ACCOUNT_DRAFT_MANIFEST_REQUIRED');
  }
  const input = structuredClone(draft.accountInput);
  const hankos = await signEntityHashes(
    env,
    entityId,
    signerId,
    draft.hashesToSign.map(entry => entry.hash),
  );
  const witness = new Map(
    draft.hashesToSign.map((entry, index) => {
      const hanko = hankos[index];
      if (!hanko) throw new Error(`TEST_ACCOUNT_DRAFT_HANKO_MISSING:${entry.context}`);
      return [entry.hash.toLowerCase(), hanko] as const;
    }),
  );
  const requireWitness = (hash: string): NonNullable<ReturnType<typeof witness.get>> => {
    const hanko = witness.get(hash.toLowerCase());
    if (!hanko) throw new Error(`TEST_ACCOUNT_DRAFT_WITNESS_UNDECLARED:${hash}`);
    return hanko;
  };
  if (input.kind === 'ack' || input.kind === 'frame_ack') {
    input.ack.frameHanko = requireWitness(input.ack.frameHash);
    if (input.ack.disputeSeal) {
      input.ack.disputeSeal.hanko = requireWitness(input.ack.disputeSeal.hash);
    }
  }
  if (input.kind === 'frame' || input.kind === 'frame_ack') {
    input.proposal.frameHanko = requireWitness(input.proposal.frame.stateHash);
    if (input.proposal.disputeSeal) {
      input.proposal.disputeSeal.hanko = requireWitness(input.proposal.disputeSeal.hash);
    }
  }
  return input;
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
  test('signed non-deadline account frame remains valid after a ten-minute outage', async () => {
    const seed = 'account-frame-watcher-lag';
    const env = createEmptyEnv(seed);
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);
    const proposer = makeProposalAccount(
      [{ type: 'set_credit_limit', data: { tokenId: 1, amount: 100n } }],
      left.entityId,
      right.entityId,
    );
    const receiver = cloneAccountState(proposer);
    receiver.mempool = [];
    receiver.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };

    const proposal = await proposeAccountFrame(env, proposer, env.timestamp, 9);
    if (!proposal.success || !proposal.accountInput) throw new Error(proposal.error || 'proposal failed');
    const sealedProposal = await sealAccountDraftAsEntity(env, left.entityId, left.signerId, proposal);
    const result = await applyAccountInput(env, receiver, sealedProposal, {
      entityTimestamp: env.timestamp + 10 * 60_000,
      finalizedJHeight: 10,
    });

    expect(result.success).toBe(true);
    expect(receiver.currentHeight).toBe(1);
  });

  test('Entity flush batches a committed peer J-claim ACK with the local claim', async () => {
    const seed = 'account-j-claim-overlay-batched-ack';
    const env = createEmptyEnv(seed);
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);
    const claim: AccountTx = {
      type: 'j_event_claim',
      data: {
        jHeight: 7,
        jBlockHash: `0x${'73'.repeat(32)}`,
        events: [
          {
            type: 'AccountSettled',
            data: {
              leftEntity: left.entityId,
              rightEntity: right.entityId,
              tokenId: 1,
              leftReserve: '0',
              rightReserve: '0',
              collateral: '5',
              ondelta: '0',
              nonce: 1,
            },
          },
        ],
      },
    };
    const proposer = makeProposalAccount([structuredClone(claim)], left.entityId, right.entityId);
    const receiver = cloneAccountState(proposer);
    receiver.mempool = [structuredClone(claim)];
    receiver.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };

    const proposed = await proposeAccountFrame(env, proposer, env.timestamp, 7);
    if (!proposed.success || !proposed.accountInput) throw new Error(proposed.error || 'proposal failed');
    const sealedProposal = await sealAccountDraftAsEntity(env, left.entityId, left.signerId, proposed);
    const result = await applyAccountInput(env, receiver, sealedProposal, {
      entityTimestamp: env.timestamp,
      finalizedJHeight: 7,
    });

    expect(result.success).toBe(true);
    expect(result.response?.kind).toBe('ack');
    const newClaimNodes = new Map(
      result.accountJClaimNodeChanges?.newNodes.map(({ hash, node }) => [hash, node]) ?? [],
    );
    const flushed = await proposeAccountFrame(env, receiver, env.timestamp, 7, {
      get: hash => newClaimNodes.get(hash),
    });
    expect(flushed.success).toBe(true);
    expect(flushed.accountInput?.kind).toBe('frame_ack');
    if (flushed.accountInput?.kind !== 'frame_ack') throw new Error('expected Entity-flushed frame_ack');
    expect(receiver.pendingAccountInput?.kind).toBe('frame_ack');
    expect(receiver.pendingAccountInput).toEqual(flushed.accountInput);
    expect(flushed.accountInput.proposal.frame.accountTxs.map(tx => tx.type)).toEqual(['j_event_claim']);
    expect(receiver.currentHeight).toBe(1);
    expect(receiver.pendingFrame?.height).toBe(2);
    expect(receiver.leftPendingJClaims.count).toBe(1n);
    expect(receiver.rightPendingJClaims.count).toBe(0n);
    expect(result.accountJClaimNodeChanges?.newNodes.map(({ hash }) => hash)).toEqual([
      receiver.leftPendingJClaims.root,
    ]);
    expect(result.accountJClaimNodeChanges?.replacedNodeHashes).toEqual([]);
  });

  test('account frame freshness rejects future skew but permits old and regressed signed frames', () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    const oldFrame = makeIncomingAccountFrame(
      account,
      { type: 'set_credit_limit', data: { tokenId: 1, amount: 1n } },
      true,
      1_000,
    );
    const futureFrame = { ...oldFrame, timestamp: 130_001 };
    const regressedFrame = { ...oldFrame, timestamp: 999 };

    expect(isWithinAccountFrameBounds(oldFrame, 100_000)).toBe(true);
    expect(isWithinAccountFrameBounds(futureFrame, 100_000)).toBe(false);
    expect(isWithinAccountFrameBounds(regressedFrame, 100_000)).toBe(true);
  });

  test('HTLC secret enforcement reserve closes on either entity time or finalized J-height', () => {
    const lock = { timelock: 100_000n, revealBeforeHeight: 20 };
    expect(
      isHtlcSecretEnforcementWindowClosed(lock, {
        entityTimestamp: 69_999,
        finalizedJHeight: 20,
      }),
    ).toBe(false);
    expect(
      isHtlcSecretEnforcementWindowClosed(lock, {
        entityTimestamp: 70_000,
        finalizedJHeight: 20,
      }),
    ).toBe(true);
    expect(
      isHtlcSecretEnforcementWindowClosed(lock, {
        entityTimestamp: 1,
        finalizedJHeight: 21,
      }),
    ).toBe(true);
  });

  test('late invalid HTLC preimage never becomes dispute evidence', () => {
    const secret = `0x${'82'.repeat(32)}`;
    const account = makeProposalAccount([], 'alice', 'hub');
    account.locks.set('late-preimage-lock', {
      lockId: 'late-preimage-lock',
      hashlock: hashHtlcSecret(secret),
      timelock: 10n,
      revealBeforeHeight: 1,
      amount: 1n,
      tokenId: 1,
      senderIsLeft: true,
      createdHeight: 0,
      createdTimestamp: 0,
    });
    const context = { entityTimestamp: 100, finalizedJHeight: 2 };
    const frameFor = (candidate: string) =>
      makeIncomingAccountFrame(
        account,
        {
          type: 'htlc_resolve',
          data: { lockId: 'late-preimage-lock', outcome: 'secret', secret: candidate },
        },
        false,
      );

    expect(getIncomingAccountDeadlineViolation(account, frameFor(`0x${'83'.repeat(32)}`), context)).toBeUndefined();
    expect(getIncomingAccountDeadlineViolation(account, frameFor(secret), context)?.evidenceSecrets).toEqual([
      { hashlock: hashHtlcSecret(secret), secret },
    ]);
  });

  test('late signed HTLC secret is retained as evidence and prepares a dispute', async () => {
    const seed = 'late-htlc-secret-dispute';
    const env = createEmptyEnv(seed);
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);
    const secret = `0x${'91'.repeat(32)}`;
    const hashlock = hashHtlcSecret(secret);
    const lockId = 'late-secret-lock';
    const upstreamEntityId = `0x${'73'.repeat(32)}`;
    const upstreamLockId = 'late-secret-upstream-lock';
    const amount = 7n;
    const timelock = BigInt(env.timestamp + HTLC_ENFORCEMENT_RESERVE_MS - 1);
    const resolveTx: AccountTx = {
      type: 'htlc_resolve',
      data: { lockId, outcome: 'secret', secret },
    };
    const proposer = makeProposalAccount([resolveTx], left.entityId, right.entityId);
    const receiver = cloneAccountState(proposer);
    receiver.mempool = [];
    receiver.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };
    for (const account of [proposer, receiver]) {
      const delta = createDefaultDelta(1);
      delta.rightHold = amount;
      account.deltas.set(1, delta);
      account.locks.set(lockId, {
        lockId,
        hashlock,
        timelock,
        revealBeforeHeight: 100,
        amount,
        tokenId: 1,
        senderIsLeft: false,
        createdHeight: 0,
        createdTimestamp: 0,
      });
    }
    const proposal = await proposeAccountFrame(env, proposer, env.timestamp, 1);
    if (!proposal.success || !proposal.accountInput) throw new Error(proposal.error || 'proposal failed');
    const sealedProposal = await sealAccountDraftAsEntity(env, left.entityId, left.signerId, proposal);

    const receiverState = makeEntityState(right.entityId);
    receiverState.config = makeSingleSignerConfigFor(right.signerId);
    receiverState.timestamp = env.timestamp;
    receiverState.lastFinalizedJHeight = 1;
    receiverState.accounts.set(left.entityId, receiver);
    receiverState.htlcRoutes.set(hashlock, {
      hashlock,
      tokenId: 1,
      amount,
      inboundEntity: upstreamEntityId,
      inboundLockId: upstreamLockId,
      outboundEntity: left.entityId,
      outboundLockId: lockId,
      createdTimestamp: env.timestamp,
    });
    const applied = await applyEntityTx(env, receiverState, {
      type: 'accountInput',
      data: sealedProposal,
    });

    const rejectedAccount = applied.newState.accounts.get(left.entityId)!;
    expect(rejectedAccount.currentHeight).toBe(0);
    expect(rejectedAccount.status).toBe('dispute_preparing');
    expect(rejectedAccount.counterpartyFrameHanko).toBeUndefined();
    expect(applied.newState.htlcRoutes.get(hashlock)).toMatchObject({
      secret,
      inboundEntity: upstreamEntityId,
      inboundLockId: upstreamLockId,
      outboundEntity: left.entityId,
      outboundLockId: lockId,
      secretAckPending: true,
      secretAckStartedAt: env.timestamp,
      secretAckDeadlineAt: env.timestamp + HTLC_SECRET_ACK_TIMEOUT_MS,
    });
    expect(applied.newState.crontabState?.hooks.get(`htlc-secret-ack:${hashlock}`)).toEqual({
      id: `htlc-secret-ack:${hashlock}`,
      triggerAt: env.timestamp + HTLC_SECRET_ACK_TIMEOUT_MS,
      type: 'htlc_secret_ack_timeout',
      data: {
        hashlock,
        counterpartyEntityId: upstreamEntityId,
        inboundLockId: upstreamLockId,
      },
    });
    expect(applied.accountTxs).toContainEqual({
      accountId: upstreamEntityId,
      tx: {
        type: 'htlc_resolve',
        data: { lockId: upstreamLockId, outcome: 'secret', secret },
      },
    });

    const proofbodyHash = `0x${'ab'.repeat(32)}`;
    storeDisputeArgumentSnapshot(
      rejectedAccount,
      captureDisputeArgumentSnapshot(rejectedAccount, proofbodyHash, 0, makeEmptyProofBody()),
    );
    const { leftArguments } = buildDisputeArgumentsForSnapshot(
      rejectedAccount,
      applied.newState,
      left.entityId,
      proofbodyHash,
      { secretsSide: 'left' },
    );
    const [wrapped] = ethers.AbiCoder.defaultAbiCoder().decode(['bytes[]'], leftArguments);
    const [transformerArguments] = ethers.AbiCoder.defaultAbiCoder().decode(
      ['tuple(uint16[] fillRatios, bytes32[] secrets, bytes[] pulls)'],
      wrapped[0],
    );
    expect(Array.from(transformerArguments.secrets)).toEqual([secret]);
  });

  test('signed deterministic replay failure freezes only the account and retains evidence', async () => {
    const seed = 'signed-invalid-account-frame';
    const env = createEmptyEnv(seed);
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);

    const receiver = makeProposalAccount([], left.entityId, right.entityId);
    receiver.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };
    const invalidFrame = makeIncomingAccountFrame(
      receiver,
      { type: 'set_credit_limit', data: { tokenId: 1, amount: -1n } },
      true,
      env.timestamp,
      0,
    );
    invalidFrame.prevFrameHash = 'genesis';
    invalidFrame.stateHash = await createFrameHash(invalidFrame);
    const [frameHanko] = await signEntityHashes(env, left.entityId, left.signerId, [invalidFrame.stateHash]);
    if (!frameHanko) throw new Error('SIGNED_INVALID_FRAME_HANKO_MISSING');
    const accountInput: AccountInput = {
      kind: 'frame',
      fromEntityId: left.entityId,
      toEntityId: right.entityId,
      domain: structuredClone(receiver.domain),
      proposal: { frame: invalidFrame, frameHanko },
    };

    const accountResult = await applyAccountInput(env, cloneAccountState(receiver), accountInput, {
      entityTimestamp: env.timestamp,
      finalizedJHeight: 0,
    });
    expect(accountResult.success).toBe(false);
    expect(accountResult.disputeRequired?.reason).toContain('Credit limit cannot be negative');
    expect(accountResult.disputeRequired?.signedFrame).toEqual({ frame: invalidFrame, frameHanko });

    const receiverState = makeEntityState(right.entityId);
    receiverState.config = makeSingleSignerConfigFor(right.signerId);
    receiverState.timestamp = env.timestamp;
    receiverState.accounts.set(left.entityId, receiver);
    const applied = await applyEntityTx(env, receiverState, {
      type: 'accountInput',
      data: accountInput,
    });
    const rejectedAccount = applied.newState.accounts.get(left.entityId)!;
    expect(rejectedAccount.currentHeight).toBe(0);
    expect(rejectedAccount.deltas.size).toBe(0);
    expect(rejectedAccount.status).toBe('dispute_preparing');
    expect(rejectedAccount).not.toHaveProperty('rejectedFrameEvidence');
    expect(rejectedAccount.shadow.rejectedFrameEvidence).toEqual({
      reason: expect.stringContaining('Credit limit cannot be negative'),
      frame: invalidFrame,
      frameHanko,
    });
  });

  test('signed stale settlement seal is rejected without mutating or disputing the account', async () => {
    const seed = 'signed-stale-settlement-seal';
    const env = createEmptyEnv(seed);
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);

    const receiver = makeProposalAccount([], left.entityId, right.entityId);
    receiver.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };
    receiver.deltas.set(1, {
      ...createDefaultDelta(1),
      leftCreditLimit: 10n,
    });
    const workspaceResult = await applyAccountTx(
      receiver,
      {
        type: 'settle_transition',
        data: {
          kind: 'upsert',
          revision: 1,
          ops: [{ type: 'r2r', tokenId: 1, amount: 1n }],
          executorIsLeft: true,
        },
      },
      true,
      env.timestamp,
    );
    expect(workspaceResult.success).toBe(true);
    receiver.proofHeader.nextProofNonce = 9;
    const workspaceHash = receiver.settlementWorkspace!.workspaceHash;
    const staleSeal: AccountTx = {
      type: 'settle_transition',
      data: {
        kind: 'seal',
        revision: 1,
        workspaceHash,
        settlementNonce: 8,
        settlementHash: `0x${'81'.repeat(32)}`,
        postProof: {
          nonce: 9,
          proofBodyHash: `0x${'82'.repeat(32)}`,
          disputeHash: `0x${'83'.repeat(32)}`,
          hanko: '0x1234',
        },
        settlementHanko: '0x5678',
      },
    };
    const staleFrame = makeIncomingAccountFrame(receiver, staleSeal, true, env.timestamp, 0);
    staleFrame.prevFrameHash = 'genesis';
    staleFrame.stateHash = await createFrameHash(staleFrame);
    const [frameHanko] = await signEntityHashes(env, left.entityId, left.signerId, [staleFrame.stateHash]);
    if (!frameHanko) throw new Error('SIGNED_STALE_SETTLEMENT_FRAME_HANKO_MISSING');
    const accountInput: AccountInput = {
      kind: 'frame',
      fromEntityId: left.entityId,
      toEntityId: right.entityId,
      domain: structuredClone(receiver.domain),
      proposal: { frame: staleFrame, frameHanko },
    };
    const before = safeStringify(receiver);

    const accountResult = await applyAccountInput(env, receiver, accountInput, {
      entityTimestamp: env.timestamp,
      finalizedJHeight: 0,
    });
    expect(accountResult.success).toBe(false);
    expect(accountResult.rejected?.reason).toContain('SETTLEMENT_SEAL_NONCE_MISMATCH:8:9');
    expect(accountResult.disputeRequired).toBeUndefined();
    expect(safeStringify(receiver)).toBe(before);

    const receiverState = makeEntityState(right.entityId);
    receiverState.config = makeSingleSignerConfigFor(right.signerId);
    receiverState.timestamp = env.timestamp;
    receiverState.accounts.set(left.entityId, cloneAccountState(receiver));
    const applied = await applyEntityTx(env, receiverState, {
      type: 'accountInput',
      data: accountInput,
    });
    const rejectedAccount = applied.newState.accounts.get(left.entityId)!;
    expect(rejectedAccount.status).toBe('active');
    expect(rejectedAccount.currentHeight).toBe(0);
    expect(rejectedAccount.shadow.rejectedFrameEvidence).toBeUndefined();
    expect(applied.newState.jBatchState?.batch.disputeStarts ?? []).toHaveLength(0);
  });

  test('receiver-local preflight rejects stale creation of unenforceable HTLC and pull locks', () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    const context = { entityTimestamp: 100_000, finalizedJHeight: 50 };
    const htlcTx: AccountTx = {
      type: 'htlc_lock',
      data: {
        lockId: 'stale-lock',
        hashlock: `0x${'31'.repeat(32)}`,
        timelock: 120_000n,
        revealBeforeHeight: 50,
        amount: 1n,
        tokenId: 1,
      },
    };
    const pullProof = buildHashLadderProof('stale-pull-lock');
    const pullTx: AccountTx = {
      type: 'pull_lock',
      data: {
        pullId: 'stale-pull',
        tokenId: 1,
        amount: -1n,
        revealedUntilTimestamp: 120_000,
        fullHash: pullProof.fullHash,
        partialRoot: pullProof.partialRoot,
      },
    };

    expect(
      getIncomingAccountDeadlineViolation(account, makeIncomingAccountFrame(account, htlcTx, true), context)?.reason,
    ).toContain('HTLC_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT');
    expect(
      getIncomingAccountDeadlineViolation(account, makeIncomingAccountFrame(account, pullTx, true), context)?.reason,
    ).toContain('PULL_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT');
  });

  test('receiver-local preflight matches Solidity pull deadline seconds exactly', () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    const proof = buildHashLadderProof('stale-pull-resolve');
    const reveal = revealHashLadder(proof, 32_768);
    account.pulls = new Map([
      [
        'pull-1',
        {
          pullId: 'pull-1',
          tokenId: 1,
          amount: -100n,
          claimedRatio: 0,
          claimedAmount: 0n,
          revealedUntilTimestamp: 20_000,
          fullHash: proof.fullHash,
          partialRoot: proof.partialRoot,
          createdHeight: 0,
          createdTimestamp: 0,
        },
      ],
    ]);
    const claimFrame = makeIncomingAccountFrame(
      account,
      {
        type: 'pull_resolve',
        data: { pullId: 'pull-1', binary: reveal.binary },
      },
      false,
    );

    expect(isPullRevealExpired(20_000, 20_999)).toBe(false);
    expect(isPullRevealExpired(20_000, 21_000)).toBe(true);
    expect(
      getIncomingAccountDeadlineViolation(account, claimFrame, { entityTimestamp: 20_999, finalizedJHeight: 1 }),
    ).toBeUndefined();

    expect(
      getIncomingAccountDeadlineViolation(account, claimFrame, { entityTimestamp: 21_000, finalizedJHeight: 1 })
        ?.reason,
    ).toContain('PULL_CLAIM_AFTER_LOCAL_EXPIRY');
    expect(
      getIncomingAccountDeadlineViolation(
        account,
        makeIncomingAccountFrame(
          account,
          {
            type: 'cross_pull_close',
            data: {
              pullId: 'pull-1',
              binary: reveal.binary,
              proof: {
                orderId: 'order-1',
                routeHash: `0x${'51'.repeat(32)}`,
                sourcePullId: 'pull-1',
                targetPullId: 'pull-2',
                fillRatio: reveal.fillRatio,
                cumulativeSourceAmount: 50n,
                cumulativeTargetAmount: 50n,
                binaryHash: `0x${'52'.repeat(32)}`,
                closeMode: 'partial_cancel_remainder',
              },
            },
          },
          false,
        ),
        { entityTimestamp: 21_000, finalizedJHeight: 1 },
      )?.reason,
    ).toContain('CROSS_PULL_CLAIM_AFTER_LOCAL_EXPIRY');
  });

  test('receiver-local preflight blocks payer pull cancellation before local expiry', () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    const proof = buildHashLadderProof('early-pull-cancel');
    account.pulls = new Map([
      [
        'pull-1',
        {
          pullId: 'pull-1',
          tokenId: 1,
          amount: -100n,
          claimedRatio: 0,
          claimedAmount: 0n,
          revealedUntilTimestamp: 120_000,
          fullHash: proof.fullHash,
          partialRoot: proof.partialRoot,
          createdHeight: 0,
          createdTimestamp: 0,
        },
      ],
    ]);

    expect(
      getIncomingAccountDeadlineViolation(
        account,
        makeIncomingAccountFrame(
          account,
          {
            type: 'pull_cancel',
            data: { pullId: 'pull-1', reason: 'expired' },
          },
          true,
          120_001,
        ),
        { entityTimestamp: 100_000, finalizedJHeight: 1 },
      )?.reason,
    ).toContain('PULL_PAYER_CANCEL_BEFORE_LOCAL_EXPIRY');

    expect(
      getIncomingAccountDeadlineViolation(
        account,
        makeIncomingAccountFrame(
          account,
          {
            type: 'pull_cancel',
            data: { pullId: 'pull-1', reason: 'expired' },
          },
          true,
          120_999,
        ),
        { entityTimestamp: 120_999, finalizedJHeight: 1 },
      )?.reason,
    ).toContain('PULL_PAYER_CANCEL_BEFORE_LOCAL_EXPIRY');

    expect(
      getIncomingAccountDeadlineViolation(
        account,
        makeIncomingAccountFrame(
          account,
          {
            type: 'pull_cancel',
            data: { pullId: 'pull-1', reason: 'expired' },
          },
          true,
          121_000,
        ),
        { entityTimestamp: 121_000, finalizedJHeight: 1 },
      ),
    ).toBeUndefined();
  });

  test('receiver-local preflight blocks payer HTLC timeout using future peer J-height', () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    account.locks.set('lock-1', {
      lockId: 'lock-1',
      hashlock: `0x${'41'.repeat(32)}`,
      timelock: 120_000n,
      revealBeforeHeight: 10,
      amount: 100n,
      tokenId: 1,
      senderIsLeft: true,
      createdHeight: 0,
      createdTimestamp: 0,
    });

    expect(
      getIncomingAccountDeadlineViolation(
        account,
        makeIncomingAccountFrame(
          account,
          {
            type: 'htlc_resolve',
            data: { lockId: 'lock-1', outcome: 'error', reason: 'timeout' },
          },
          true,
          100_000,
          11,
        ),
        { entityTimestamp: 100_000, finalizedJHeight: 5 },
      )?.reason,
    ).toContain('HTLC_PAYER_CANCEL_BEFORE_LOCAL_EXPIRY');

    expect(
      getIncomingAccountDeadlineViolation(
        account,
        makeIncomingAccountFrame(
          account,
          {
            type: 'htlc_resolve',
            data: { lockId: 'lock-1', outcome: 'error', reason: 'timeout' },
          },
          true,
          120_000,
          5,
        ),
        { entityTimestamp: 120_000, finalizedJHeight: 5 },
      ),
    ).toBeUndefined();
  });

  test('receiver-local preflight follows HTLC transitions before checking reused ids', () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    const secret = `0x${'42'.repeat(32)}`;
    account.locks.set('reused-lock', {
      lockId: 'reused-lock',
      hashlock: hashHtlcSecret(secret),
      timelock: 300_000n,
      revealBeforeHeight: 100,
      amount: 100n,
      tokenId: 1,
      senderIsLeft: true,
      createdHeight: 0,
      createdTimestamp: 0,
    });
    const frame = makeIncomingAccountFrame(
      account,
      {
        type: 'htlc_resolve',
        data: { lockId: 'reused-lock', outcome: 'secret', secret },
      },
      false,
    );
    frame.accountTxs.push({
      type: 'htlc_lock',
      data: {
        lockId: 'reused-lock',
        hashlock: `0x${'43'.repeat(32)}`,
        timelock: 120_000n,
        revealBeforeHeight: 51,
        amount: 100n,
        tokenId: 1,
      },
    });

    expect(
      getIncomingAccountDeadlineViolation(account, frame, { entityTimestamp: 100_000, finalizedJHeight: 50 })?.reason,
    ).toContain('HTLC_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT');
  });

  test('receiver-local preflight never mutates a live HTLC while simulating an offer', () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    account.locks.set('offer-lock', {
      lockId: 'offer-lock',
      hashlock: `0x${'44'.repeat(32)}`,
      timelock: 300_000n,
      revealBeforeHeight: 100,
      amount: 100n,
      tokenId: 1,
      senderIsLeft: true,
      createdHeight: 0,
      createdTimestamp: 0,
    });
    const before = structuredClone(account.locks);
    const beforeRoot = computeAccountStateRootCold(account);
    const offer: MultiRecipientCiphertext = {
      version: 'xln:htlc-multi-recipient:v1',
      manifest: {} as MultiRecipientCiphertext['manifest'],
      profileCertification: {} as MultiRecipientCiphertext['profileCertification'],
      contextHash: `0x${'45'.repeat(32)}`,
      nonce: 'AAAAAAAAAAAAAAAA',
      ciphertext: 'AAAA',
      recipients: [],
    };

    expect(
      getIncomingAccountDeadlineViolation(
        account,
        makeIncomingAccountFrame(
          account,
          {
            type: 'htlc_resolve',
            data: { lockId: 'offer-lock', outcome: 'offer', offer },
          },
          false,
        ),
        { entityTimestamp: 100_000, finalizedJHeight: 50 },
      ),
    ).toBeUndefined();
    expect(account.locks).toEqual(before);
    expect(computeAccountStateRootCold(account)).toBe(beforeRoot);
  });

  test('receiver-local preflight follows pull cancellation before checking reused ids', () => {
    const account = makeProposalAccount([], 'alice', 'hub');
    const existingProof = buildHashLadderProof('existing-reused-pull');
    const replacementProof = buildHashLadderProof('replacement-reused-pull');
    account.pulls = new Map([
      [
        'reused-pull',
        {
          pullId: 'reused-pull',
          tokenId: 1,
          amount: -100n,
          claimedRatio: 0,
          claimedAmount: 0n,
          revealedUntilTimestamp: 120_000,
          fullHash: existingProof.fullHash,
          partialRoot: existingProof.partialRoot,
          createdHeight: 0,
          createdTimestamp: 0,
        },
      ],
    ]);
    const frame = makeIncomingAccountFrame(
      account,
      {
        type: 'pull_cancel',
        data: { pullId: 'reused-pull', reason: 'expired' },
      },
      true,
      121_000,
    );
    frame.accountTxs.push({
      type: 'pull_lock',
      data: {
        pullId: 'reused-pull',
        tokenId: 1,
        amount: -100n,
        revealedUntilTimestamp: 130_000,
        fullHash: replacementProof.fullHash,
        partialRoot: replacementProof.partialRoot,
      },
    });

    expect(
      getIncomingAccountDeadlineViolation(account, frame, { entityTimestamp: 121_000, finalizedJHeight: 50 })?.reason,
    ).toContain('PULL_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT');
  });

  test('failed account tx mutations do not leak into later valid txs in the same proposal', async () => {
    const env = createEmptyEnv('account-tx-atomicity');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;
    env.browserVM = { getDepositoryAddress: () => hex20('dd') } as any;
    const { signerId, entityId: left } = registerLazySigner('account-tx-atomicity', '1');
    attachSigningReplica(env, left, signerId);
    const right = `0x${'ff'.repeat(32)}`;
    const account = makeProposalAccount(
      [
        {
          type: 'direct_payment',
          data: {
            tokenId: 1,
            amount: 100n,
            fromEntityId: right,
            toEntityId: left,
            route: [''],
          },
        },
        {
          type: 'set_credit_limit',
          data: {
            tokenId: 1,
            amount: 500n,
          },
        },
      ],
      left,
      right,
    );
    account.deltas.set(1, {
      tokenId: 1,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 0n,
      leftCreditLimit: 0n,
      rightCreditLimit: 1_000n,
      leftAllowance: 0n,
      rightAllowance: 0n,
      leftHold: 0n,
      rightHold: 0n,
    });

    const result = await proposeAccountFrame(env, account, env.timestamp);

    expect(result.success).toBe(true);
    expect(result.accountInput?.proposal.frame?.accountTxs.map(tx => tx.type)).toEqual(['set_credit_limit']);
    const frameDelta = result.accountInput?.proposal.frame?.deltas.find(delta => delta.tokenId === 1);
    expect(frameDelta?.offdelta).toBe(0n);
    expect(frameDelta?.rightCreditLimit).toBe(500n);
  });

  test('proposer and receiver use the exact Entity frame timestamp for pull state', async () => {
    const env = createEmptyEnv('account-frame-timestamp-parity');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 1_000;
    const depositoryAddress = hex20('dd');
    env.browserVM = { getDepositoryAddress: () => depositoryAddress } as any;
    const { signerId, entityId: left } = registerLazySigner('account-frame-timestamp-parity', '1');
    attachSigningReplica(env, left, signerId);
    const right = `0x${'ff'.repeat(32)}`;
    const pullLock: AccountTx = {
      type: 'pull_lock',
      data: {
        pullId: 'timestamp-parity-pull',
        tokenId: 1,
        amount: -100n,
        revealedUntilTimestamp: 10_000,
        fullHash: `0x${'a1'.repeat(32)}`,
        partialRoot: `0x${'b2'.repeat(32)}`,
      },
    };
    const proposer = makeProposalAccount([pullLock], left, right);
    proposer.currentHeight = 4;
    proposer.currentFrame.height = 4;
    proposer.currentFrame.timestamp = env.timestamp;
    proposer.currentFrame.stateHash = `0x${'cc'.repeat(32)}`;
    const delta = createDefaultDelta(1);
    delta.leftCreditLimit = 1_000n;
    proposer.deltas.set(1, delta);
    const receiver = cloneAccountState(proposer);
    receiver.proofHeader = { fromEntity: right, toEntity: left, nextProofNonce: 0 };

    const proposed = await proposeAccountFrame(env, proposer, env.timestamp);
    if (!proposed.success) throw new Error(proposed.error || 'proposal failed');
    const frame = proposed.accountInput!.proposal.frame;
    expect(frame.timestamp).toBe(env.timestamp);

    const replayed = await applyAccountTx(receiver, pullLock, frame.byLeft!, frame.timestamp, frame.jHeight, true, env);
    expect(replayed.success).toBe(true);
    expect(computeAccountStateRoot(receiver)).toBe(frame.accountStateRoot);
  });

  test('nested Account proposal accepts a future committed Entity timestamp across validator ticks', async () => {
    const seed = 'account-frame-entity-timestamp-authority';
    const proposerEnv = createEmptyEnv(seed);
    const validatorEnv = createEmptyEnv(seed);
    proposerEnv.timestamp = 1_000;
    validatorEnv.timestamp = 1_100;
    proposerEnv.browserVM = { getDepositoryAddress: () => hex20('dd') } as typeof proposerEnv.browserVM;
    validatorEnv.browserVM = { getDepositoryAddress: () => hex20('dd') } as typeof validatorEnv.browserVM;
    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    attachSigningReplica(proposerEnv, left.entityId, left.signerId);
    attachSigningReplica(validatorEnv, left.entityId, left.signerId);
    const base = makeProposalAccount(
      [{ type: 'set_credit_limit', data: { tokenId: 1, amount: 100n } }],
      left.entityId,
      right.entityId,
    );
    base.deltas.set(1, createDefaultDelta(1));
    const committedEntityTimestamp = 1_777;

    const proposer = await proposeAccountFrame(proposerEnv, cloneAccountState(base), committedEntityTimestamp);
    const validator = await proposeAccountFrame(validatorEnv, cloneAccountState(base), committedEntityTimestamp);

    expect(proposer.success).toBe(true);
    expect(validator.success).toBe(true);
    expect(proposer.accountInput?.proposal.frame.timestamp).toBe(committedEntityTimestamp);
    expect(validator.accountInput?.proposal.frame).toEqual(proposer.accountInput?.proposal.frame);
  });

  test('profile update preserves the committed Entity timestamp across validator ticks', async () => {
    const entityId = `0x${'a7'.repeat(32)}`;
    const proposerState = makeEntityState(entityId);
    const validatorState = makeEntityState(entityId);
    proposerState.timestamp = 777;
    validatorState.timestamp = 777;
    const proposerEnv = createEmptyEnv('profile-timestamp-proposer');
    const validatorEnv = createEmptyEnv('profile-timestamp-validator');
    proposerEnv.timestamp = 1_000;
    validatorEnv.timestamp = 1_100;
    const tx = {
      type: 'profile-update',
      data: { profile: { entityId, name: 'Committed timestamp' } },
    } as const;

    const proposer = await applyEntityTx(proposerEnv, proposerState, tx);
    const validator = await applyEntityTx(validatorEnv, validatorState, tx);

    expect(proposer.newState.timestamp).toBe(777);
    expect(validator.newState).toEqual(proposer.newState);
  });

  test('r2c quote expiry uses the committed Entity timestamp across validator ticks', async () => {
    const entityId = `0x${'a8'.repeat(32)}`;
    const counterpartyId = `0x${'a9'.repeat(32)}`;
    const quoteId = 1_000;
    const makeState = (): EntityState => {
      const state = makeEntityState(entityId);
      state.timestamp = quoteId + QUOTE_EXPIRY_MS;
      state.reserves.set(1, 100n);
      const account = makeProposalAccount([], entityId, counterpartyId);
      account.shadow.rebalance.activeQuote = {
        quoteId,
        tokenId: 1,
        amount: 10n,
        feeTokenId: 1,
        feeAmount: 1n,
        accepted: true,
      };
      state.accounts.set(counterpartyId, account);
      return state;
    };
    const proposerEnv = createEmptyEnv('r2c-timestamp-proposer');
    const validatorEnv = createEmptyEnv('r2c-timestamp-validator');
    proposerEnv.timestamp = quoteId + QUOTE_EXPIRY_MS;
    validatorEnv.timestamp = proposerEnv.timestamp + 1;
    const tx = {
      type: 'r2c',
      data: {
        counterpartyId,
        tokenId: 1,
        amount: 10n,
        rebalanceQuoteId: quoteId,
        rebalanceFeeTokenId: 1,
        rebalanceFeeAmount: 1n,
      },
    } as const;

    const proposer = await applyEntityTx(proposerEnv, makeState(), tx);
    const validator = await applyEntityTx(validatorEnv, makeState(), tx);

    expect(validator.newState).toEqual(proposer.newState);
    expect(readEntityFrameEventMessages(validator.newState).some(message => message.includes('quote expired'))).toBe(false);
  });

  test('openAccount rejects an unmaterialized watch seed and replays the signed seed identically', async () => {
    const seed = 'open-account-watch-seed-materialization';
    const proposerEnv = createEmptyEnv(seed);
    const validatorEnv = createEmptyEnv('different-validator-runtime-seed');
    proposerEnv.timestamp = 1_000;
    validatorEnv.timestamp = 1_100;
    const author = registerLazySigner(seed, '1');
    const targetEntityId = `0x${'b7'.repeat(32)}`;
    const state = makeEntityState(author.entityId);
    state.timestamp = 777;
    state.config = makeSingleSignerConfigFor(author.signerId);
    attachSigningReplica(proposerEnv, author.entityId, author.signerId);
    const installTarget = (env: RuntimeState): void => {
      const target = makeEntityState(targetEntityId);
      target.config = state.config;
      env.eReplicas.set(`${targetEntityId}:target-signer`, {
        entityId: targetEntityId,
        signerId: 'target-signer',
        entityEncPubKey: '',
        entityEncPrivKey: '',
        mempool: [],
        isProposer: true,
        state: target,
      });
    };
    installTarget(proposerEnv);
    installTarget(validatorEnv);
    const rawTx = {
      type: 'openAccount',
      data: { targetEntityId },
    } as const;

    const rejected = await applyEntityTx(proposerEnv, state, rawTx);
    expect(rejected.skippedError).toBe('OPEN_ACCOUNT_WATCH_SEED_REQUIRED');
    expect(rejected.newState.accounts.size).toBe(0);

    const [commandTx] = prepareLocallyAuthoredEntityTxs(proposerEnv, state, author.signerId, [rawTx]);
    if (commandTx?.type !== 'entityCommand') throw new Error('TEST_OPEN_ACCOUNT_COMMAND_MISSING');
    const proposalTx = commandTx.data.txs[0];
    if (proposalTx?.type !== 'propose' || proposalTx.data.action.type !== 'entity_transaction') {
      throw new Error('TEST_OPEN_ACCOUNT_PROPOSAL_MISSING');
    }
    const materializedTx = proposalTx.data.action.data.txs[0];
    if (materializedTx?.type !== 'openAccount') throw new Error('TEST_OPEN_ACCOUNT_TX_MISSING');
    expect(materializedTx.data.watchSeed).toMatch(/^0x[0-9a-f]{64}$/);

    const proposer = await applyEntityTx(proposerEnv, makeEntityState(author.entityId), materializedTx);
    const validatorState = makeEntityState(author.entityId);
    validatorState.config = state.config;
    const validator = await applyEntityTx(validatorEnv, validatorState, materializedTx);
    expect(validator.newState.accounts.get(targetEntityId)?.watchSeed).toBe(
      proposer.newState.accounts.get(targetEntityId)?.watchSeed,
    );
  });

  test('proposeAccountFrame throws instead of dropping invalid cross-j fill ack', async () => {
    const env = createEmptyEnv('cross-fill-ack-propose-failfast');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const left = `0x${'11'.repeat(32)}`;
    const right = `0x${'22'.repeat(32)}`;
    const account = makeProposalAccount(
      [
        {
          type: 'cross_swap_fill_ack',
          data: {
            offerId: 'missing-cross-offer',
            fillSeq: 1,
            incrementalSourceAmount: 1n,
            incrementalTargetAmount: 1n,
            cumulativeSourceAmount: 1n,
            cumulativeTargetAmount: 1n,
            cumulativeFillRatio: 1,
            executionSourceAmount: 1n,
            executionTargetAmount: 1n,
            cancelRemainder: false,
            pairId: 'cross:testnet:1/tron:1',
          },
        },
      ],
      left,
      right,
    );

    await expect(proposeAccountFrame(env, account, env.timestamp)).rejects.toThrow(/CROSS_J_FILL_ACK_PROPOSAL_FAILED/);
    expect(account.mempool).toHaveLength(1);
  });

  test('proposeAccountFrame throws instead of dropping invalid cross-j pull resolve', async () => {
    const env = createEmptyEnv('cross-pull-resolve-propose-failfast');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const left = `0x${'11'.repeat(32)}`;
    const right = `0x${'22'.repeat(32)}`;
    const account = makeProposalAccount(
      [
        {
          type: 'pull_resolve',
          data: {
            pullId: 'target-pull',
            binary: '0x1234',
          },
        },
      ],
      left,
      right,
    );
    account.pulls = new Map([
      [
        'target-pull',
        {
          pullId: 'target-pull',
          tokenId: 1,
          amount: 1_000n,
          claimedRatio: 0,
          claimedAmount: 0n,
          revealedUntilTimestamp: 60_000,
          fullHash: `0x${'aa'.repeat(32)}`,
          partialRoot: `0x${'bb'.repeat(32)}`,
          crossJurisdiction: {
            orderId: 'cross-pull-propose-failfast',
            routeHash: `0x${'cc'.repeat(32)}`,
            leg: 'target',
            status: 'clearing',
            cumulativeFillRatio: 1,
          },
          createdHeight: 0,
          createdTimestamp: 1,
        },
      ],
    ]);

    await expect(proposeAccountFrame(env, account, env.timestamp)).rejects.toThrow(
      /CROSS_J_PULL_RESOLVE_PROPOSAL_FAILED/,
    );
    expect(account.mempool).toHaveLength(1);
  });

  test('proposeAccountFrame throws instead of dropping invalid cross-j swap offer', async () => {
    const env = createEmptyEnv('cross-swap-offer-propose-failfast');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const left = `0x${'11'.repeat(32)}`;
    const right = `0x${'22'.repeat(32)}`;
    const amount = SWAP_LOT_SCALE;
    const route = withCanonicalCrossJurisdictionRouteHash({
      orderId: 'cross-swap-offer-propose-failfast',
      makerEntityId: left,
      hubEntityId: right,
      source: {
        jurisdiction: `stack:1:0x${'c1'.repeat(20)}`,
        entityId: left,
        counterpartyEntityId: right,
        tokenId: 1,
        amount,
      },
      target: {
        jurisdiction: `stack:2:0x${'c2'.repeat(20)}`,
        entityId: right,
        counterpartyEntityId: left,
        tokenId: 2,
        amount,
      },
      sourcePull: {
        pullId: 'missing-source-pull',
        tokenId: 1,
        amount: -amount,
        signedAmount: -amount,
        revealedUntilTimestamp: 60_000,
        fullHash: `0x${'aa'.repeat(32)}`,
        partialRoot: `0x${'bb'.repeat(32)}`,
      },
      targetPull: {
        pullId: 'target-pull',
        tokenId: 2,
        amount,
        signedAmount: amount,
        revealedUntilTimestamp: 60_000,
        fullHash: `0x${'dd'.repeat(32)}`,
        partialRoot: `0x${'ee'.repeat(32)}`,
      },
      priceTicks: ORDERBOOK_PRICE_SCALE,
      status: 'resting',
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 60_000,
    } as CrossJurisdictionSwapRoute);
    const account = makeProposalAccount(
      [
        {
          type: 'swap_offer',
          data: {
            offerId: route.orderId,
            giveTokenId: 1,
            giveAmount: amount,
            wantTokenId: 2,
            wantAmount: amount,
            crossJurisdiction: route,
          },
        },
      ],
      left,
      right,
    );

    await expect(proposeAccountFrame(env, account, env.timestamp)).rejects.toThrow(
      /CROSS_J_SWAP_OFFER_PROPOSAL_FAILED/,
    );
    expect(account.mempool).toHaveLength(1);
  });

  test('proposeAccountFrame keeps valid swap_resolve txs when optimistic batch validation falls back', async () => {
    const env = createEmptyEnv('swap-resolve-batch-fallback');
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    env.browserVM = {
      getDepositoryAddress: () => hex20('dd'),
    } as typeof env.browserVM;

    const makerIdentity = registerLazySigner('swap-resolve-batch-fallback', 'maker');
    const hubIdentity = registerLazySigner('swap-resolve-batch-fallback', 'hub');
    const maker = makerIdentity.entityId;
    const hub = hubIdentity.entityId;
    const makerIsLeft = isLeftEntity(maker, hub);
    const [leftEntity, rightEntity] = makerIsLeft ? [maker, hub] : [hub, maker];
    const giveAmount = SWAP_LOT_SCALE;
    const wantAmount = 3_000n * SWAP_LOT_SCALE;
    const validTx: Extract<AccountTx, { type: 'swap_resolve' }> = {
      type: 'swap_resolve',
      data: {
        offerId: 'valid-batch-fill',
        fillRatio: 65_535,
        fillNumerator: 1n,
        fillDenominator: 1n,
        cancelRemainder: true,
        executionGiveAmount: giveAmount,
        executionWantAmount: wantAmount,
      },
    };
    const invalidTx: Extract<AccountTx, { type: 'swap_resolve' }> = {
      type: 'swap_resolve',
      data: {
        offerId: 'missing-batch-fill',
        fillRatio: 65_535,
        fillNumerator: 1n,
        fillDenominator: 1n,
        cancelRemainder: true,
        executionGiveAmount: giveAmount,
        executionWantAmount: wantAmount,
      },
    };
    const account = makeProposalAccount([validTx, invalidTx], leftEntity, rightEntity);
    account.proofHeader = { fromEntity: hub, toEntity: maker, nextProofNonce: 0 };
    attachSigningReplica(env, hub, hubIdentity.signerId);

    const giveDelta = createDefaultDelta(2);
    giveDelta.leftCreditLimit = 10n ** 30n;
    giveDelta.rightCreditLimit = 10n ** 30n;
    if (makerIsLeft) giveDelta.leftHold = giveAmount;
    else giveDelta.rightHold = giveAmount;
    account.deltas.set(2, giveDelta);

    const wantDelta = createDefaultDelta(1);
    wantDelta.leftCreditLimit = 10n ** 30n;
    wantDelta.rightCreditLimit = 10n ** 30n;
    account.deltas.set(1, wantDelta);

    account.swapOffers.set('valid-batch-fill', {
      offerId: 'valid-batch-fill',
      giveTokenId: 2,
      giveAmount,
      wantTokenId: 1,
      wantAmount,
      priceTicks: 3_000n * ORDERBOOK_PRICE_SCALE,
      timeInForce: 0,
      makerIsLeft,
      createdHeight: 0,
      quantizedGive: giveAmount,
      quantizedWant: wantAmount,
    });

    const result = await proposeAccountFrame(env, account, env.timestamp);

    expect(result.success).toBe(true);
    expect(result.accountInput?.proposal.frame.accountTxs).toEqual([validTx]);
    expect(account.pendingFrame?.accountTxs).toEqual([validTx]);
    expect(account.mempool).toEqual([]);
  });

  test('same-chain offers match and queue both resolves in one hub Entity frame', async () => {
    const seed = 'same-chain-single-hub-frame';
    const env = createEmptyEnv(seed);
    env.timestamp = 10_000;
    env.quietRuntimeLogs = true;
    const hub = registerLazySigner(seed, 'hub');
    const maker = registerLazySigner(seed, 'maker');
    const taker = registerLazySigner(seed, 'taker');
    for (const identity of [hub, maker, taker]) {
      attachSigningReplica(env, identity.entityId, identity.signerId);
    }

    const fundedAccount = (proposerId: string, counterpartyId: string): AccountState => {
      const leftEntity = isLeftEntity(proposerId, counterpartyId) ? proposerId : counterpartyId;
      const rightEntity = leftEntity === proposerId ? counterpartyId : proposerId;
      const account = makeProposalAccount([], leftEntity, rightEntity);
      account.proofHeader = { fromEntity: proposerId, toEntity: counterpartyId, nextProofNonce: 0 };
      for (const tokenId of [1, 2]) {
        account.deltas.set(tokenId, {
          ...createDefaultDelta(tokenId),
          leftCreditLimit: 10n ** 24n,
          rightCreditLimit: 10n ** 24n,
        });
      }
      return account;
    };

    const proposalFor = async (
      identity: typeof maker,
      tx: Extract<AccountTx, { type: 'swap_offer' }>,
    ): Promise<{ input: AccountInput; hubAccount: AccountState }> => {
      const proposerAccount = fundedAccount(identity.entityId, hub.entityId);
      proposerAccount.mempool.push(tx);
      const proposed = await proposeAccountFrame(env, proposerAccount, env.timestamp, 0);
      if (!proposed.success || !proposed.accountInput) {
        throw new Error(`SAME_CHAIN_PROPOSAL_FAILED:${proposed.error || 'missing input'}`);
      }
      return {
        input: await sealAccountDraftAsEntity(env, identity.entityId, identity.signerId, proposed),
        hubAccount: fundedAccount(hub.entityId, identity.entityId),
      };
    };

    const baseAmount = SWAP_LOT_SCALE;
    const quoteAmount = 1_000_000n;
    const makerOffer = await proposalFor(maker, {
      type: 'swap_offer',
      data: {
        offerId: 'same-frame-maker',
        giveTokenId: 2,
        giveAmount: baseAmount,
        wantTokenId: 1,
        wantAmount: quoteAmount,
      },
    });
    const takerOffer = await proposalFor(taker, {
      type: 'swap_offer',
      data: {
        offerId: 'same-frame-taker',
        giveTokenId: 1,
        giveAmount: quoteAmount,
        wantTokenId: 2,
        wantAmount: baseAmount,
      },
    });

    const hubState = makeEntityState(hub.entityId);
    hubState.config = makeSingleSignerConfigFor(hub.signerId);
    hubState.profile.isHub = true;
    hubState.accounts.set(maker.entityId, makerOffer.hubAccount);
    hubState.accounts.set(taker.entityId, takerOffer.hubAccount);
    hubState.orderbookExt = {
      books: new Map(),
      orderPairs: new Map(),
      referrals: new Map(),
      hubProfile: {
        entityId: hub.entityId,
        name: 'Single-frame Hub',
        minTradeSize: 0n,
        spreadDistribution: {
          makerBps: 0,
          takerBps: 10_000,
          hubBps: 0,
          makerReferrerBps: 0,
          takerReferrerBps: 0,
        },
        referenceTokenId: 1,
        supportedPairs: ['1/2'],
      },
    };

    const result = await applyEntityFrame(
      env,
      hubState,
      [
        { type: 'accountInput', data: makerOffer.input },
        { type: 'accountInput', data: takerOffer.input },
      ],
      env.timestamp,
    );

    for (const accountId of [maker.entityId, taker.entityId]) {
      const pending = result.newState.accounts.get(accountId)?.pendingFrame;
      expect(pending?.accountTxs.some(tx => tx.type === 'swap_resolve')).toBe(true);
    }
    expect(
      result.outputs.filter(output =>
        output.entityTxs?.some(
          tx =>
            tx.type === 'accountInput' &&
            'proposal' in tx.data &&
            tx.data.proposal.frame.accountTxs.some(accountTx => accountTx.type === 'swap_resolve'),
        ),
      ),
    ).toHaveLength(2);
  });

  test('entity frame commits mark the entity core doc dirty for storage replay', async () => {
    const seed = 'entity-frame-storage-mark seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 10_000;
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const replica = {
      entityId,
      signerId,
      entityEncPubKey: '',
      entityEncPrivKey: '',
      mempool: [],
      isProposer: true,
      state: makeEntityState(entityId),
    } as EntityReplica;
    replica.state.config = makeSingleSignerConfigFor(signerId);

    await applyEntityInput(env, replica, {
      entityId,
      signerId,
      entityTxs: [
        {
          type: 'profile-update',
          data: {
            profile: {
              entityId,
              name: 'Storage Marked',
            },
          },
        } as any,
      ],
    });
    const marks = env.runtimeState?.currentStorageOverlayMarks ?? [];
    expect(marks.some(record => record.family === 'entity' && record.entityId === entityId)).toBe(true);
  });

  test('entity reducers return exact storage changes and invalidate account Merkle cache only after success', async () => {
    const entityId = `0x${'a1'.repeat(32)}`;
    const counterpartyId = `0x${'b2'.repeat(32)}`;
    const env = createEmptyEnv('storage changes reducer seed alpha beta gamma');
    const state = makeEntityState(entityId);
    state.accounts.set(counterpartyId, makeProposalAccount([], entityId, counterpartyId));
    env.eReplicas.set(`${entityId}:test`, {
      entityId,
      signerId: 'test',
      entityEncPubKey: '',
      entityEncPrivKey: '',
      mempool: [],
      isProposer: true,
      state,
    });

    const reduced = await applyEntityTx(env, state, {
      type: 'profile-update',
      data: { profile: { entityId, name: 'Storage changes' } },
    });
    expect(env.runtimeState?.currentStorageOverlayMarks ?? []).toEqual([]);
    expect(reduced.storageChanges).toEqual([{ family: 'entity', entityId }]);
    applyStorageChanges(env, reduced.newState, reduced.storageChanges);
    expect(env.runtimeState?.currentStorageOverlayMarks).toEqual([{ family: 'entity', entityId }]);

    const rejected = await applyEntityTx(env, reduced.newState, { type: '__unknown__' } as unknown as EntityTx);
    expect(rejected.skippedError).toContain('ENTITY_TX_UNHANDLED');
    expect(rejected.storageChanges).toEqual([]);
    expect(env.runtimeState?.currentStorageOverlayMarks).toEqual([{ family: 'entity', entityId }]);

    const cachedRoot = computeCanonicalEntityConsensusStateHash(state);
    state.accounts.get(counterpartyId)!.currentHeight += 1;
    expect(computeCanonicalEntityConsensusStateHash(state)).toBe(cachedRoot);
    applyStorageChanges(env, state, [{ family: 'account', entityId, counterpartyId }]);
    const invalidatedRoot = computeCanonicalEntityConsensusStateHash(state);
    expect(invalidatedRoot).not.toBe(cachedRoot);
    expect(invalidatedRoot).toBe(computeCanonicalEntityConsensusStateHashCold(state));
    expect(env.runtimeState?.currentStorageOverlayMarks).toContainEqual({
      family: 'account',
      entityId,
      counterpartyId,
    });
  });

  test('crontab-only canonical mutations stay local until Entity frame commit', async () => {
    const seed = 'crontab-storage-mark seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(signerId);
    state.timestamp = 50_000;
    state.crontabState = initCrontab();
    state.crontabState.tasks.clear();
    state.crontabState.hooks.set('test-settlement-window', {
      id: 'test-settlement-window',
      triggerAt: 49_000,
      type: 'settlement_window',
      data: {},
    });
    const replica = {
      entityId,
      signerId,
      entityEncPubKey: '',
      entityEncPrivKey: '',
      mempool: [],
      isProposer: true,
      state,
    } as EntityReplica;

    await executeCrontab(env, replica, state.crontabState, {
      manualBroadcastInInput: false,
      accountChanges: new Set(),
    });

    const marks = env.runtimeState?.currentStorageOverlayMarks ?? [];
    expect(state.crontabState.hooks.has('test-settlement-window')).toBe(false);
    expect(marks).toEqual([]);
  });

  test('single-signer j_broadcast attaches consensus hanko to J batch output', async () => {
    const seed = 'single-signer-j-broadcast-hanko seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.timestamp = 30_000;
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const jurisdiction = {
      name: 'Testnet',
      address: 'http://localhost:8545',
      depositoryAddress: hex20('1'),
      entityProviderAddress: hex20('2'),
      chainId: 31337,
    };
    env.activeJurisdiction = 'Testnet';
    env.jReplicas.set('Testnet', {
      name: 'Testnet',
      blockNumber: 0n,
      stateRoot: new Uint8Array(32),
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      position: { x: 0, y: 0, z: 0 },
      depositoryAddress: jurisdiction.depositoryAddress,
      entityProviderAddress: jurisdiction.entityProviderAddress,
      contracts: {
        account: hex20('3'),
        depository: jurisdiction.depositoryAddress,
        entityProvider: jurisdiction.entityProviderAddress,
        deltaTransformer: hex20('4'),
      },
      rpcs: [jurisdiction.address],
      chainId: jurisdiction.chainId,
    });
    const state = makeEntityState(entityId);
    state.config = {
      ...makeSingleSignerConfigFor(signerId),
      jurisdiction,
    };
    const batch = createEmptyBatch();
    batch.reserveToReserve.push({
      receivingEntity: `0x${'ef'.repeat(32)}`,
      tokenId: 1,
      amount: 10n,
    });
    state.jBatchState = {
      batch,
      jurisdiction,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'accumulating',
      entityNonce: 0,
    };
    const replica = {
      entityId,
      signerId,
      entityEncPubKey: '',
      entityEncPrivKey: '',
      mempool: [],
      isProposer: true,
      state,
    } as EntityReplica;

    const result = await applyEntityInput(env, replica, {
      entityId,
      signerId,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    });

    expect(result.jOutputs).toHaveLength(1);
    const jTx = result.jOutputs[0]?.jTxs[0];
    expect(jTx?.type).toBe('batch');
    if (jTx?.type === 'batch') {
      expect(jTx.data.batchHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      expect(jTx.data.encodedBatch).toMatch(/^0x/);
      expect(jTx.data.entityNonce).toBe(1);
      expect(jTx.data.batchGeneration).toBe(1);
      expect(jTx.data.hankoSignature).toMatch(/^0x/);
    }
    expect(result.workingReplica.state.jBatchState?.broadcastCount).toBe(1);
  });
});
