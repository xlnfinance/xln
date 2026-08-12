import { describe, expect, spyOn, test } from 'bun:test';

import { x25519 } from '@noble/curves/ed25519.js';

import {
  applyAccountInput,
  getIncomingAccountDeadlineViolation,
  HTLC_ENFORCEMENT_RESERVE_MS,
  isHtlcSecretEnforcementWindowClosed,
  proposeAccountFrame,
  isWithinAccountFrameBounds,
} from '../account/consensus/index';

import { computeAccountStateRoot, computeAccountStateRootCold } from '../account/commitment/state-root';

import { resolveCertifiedAccountCounterpartyProposer } from '../runtime/account-counterparty-route';

import { createEmptyAccountJClaimAccumulator } from '../account/j-claims/j-claim-accumulator';

import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey, signAccountFrame } from '../account/crypto';

import { deriveAccountWatchSeed } from '../protocol/account-watch-seed';

import { applyAccountTx } from '../account/tx/apply';


import { handleHtlcLock } from '../account/tx/handlers/htlc/lock';

import { handleHtlcResolve } from '../account/tx/handlers/htlc/resolve';

import { createSettlementWorkspaceHash } from '../account/tx/handlers/settlement/transition';

import { hashHtlcSecret } from '../protocol/htlc/utils';

import { buildHashLadderProof, revealHashLadder } from '../protocol/htlc/hash-ladder';

import type { MultiRecipientCiphertext } from '../protocol/htlc/multi-recipient';

import { checkAutoRebalance, handleRequestCollateral } from '../account/tx/handlers/rebalance/request-collateral';

import { handleSwapOffer } from '../account/tx/handlers/swap/offer/index';

import { createFrameHash, MAX_ACCOUNT_FRAME_TXS } from '../account/consensus/frame/hash';

import { resolveAutoRebalanceFeePolicy, runPostFrameAutoRebalanceCheck } from '../account/consensus/helpers';

import { HTLC, LIMITS } from '../config/constants';

import {
  ACCOUNT_PENDING_RESEND_AFTER_MS,
  emitCommittedPendingFrameWarnings,
  executeCrontab,
  initCrontab,
} from '../entity/scheduler';
import { HTLC_SECRET_ACK_TIMEOUT_MS } from '../entity/tx/htlc-route-lifecycle';

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

import { signedEntityCommandTx } from '../entity/command/command-codec';

import { buildCollectiveEntityProposalTx } from '../entity/auth/authorization';

import { generateProposalId } from '../entity/tx/proposals';

import { buildEntityHashesToSign } from '../entity/consensus/input/hanko-witness';

import {
  buildEntityFrameAuthority,
  computeCanonicalEntityConsensusStateHash,
  computeCanonicalEntityConsensusStateHashCold,
  computeEntityFrameAuthorityRoot,
} from '../entity/consensus/state-root';

import {
  assertCrossJurisdictionOrderAdmissible,
  findCrossJurisdictionBookAdmissionForAck,
} from '../orderbook/cross-j/orderbook';

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

import { applyFinalizedAccountJEvents } from '../account/tx/handlers/j-events/finality';

import { queueCrossJurisdictionSalvageFromFinalizedArguments } from '../entity/tx/j-events-htlc';

import {
  canonicalDisputeFinalizationEvidenceHash,
  canonicalJurisdictionEventsHash,
  getJEventJurisdictionRef,
} from '../jurisdiction/machine/event-observation';

import { getRuntimeJurisdictionHeight } from '../jurisdiction/machine/height';

import { recordValidatorJHistory } from '../jurisdiction/machine/local-history';

import { buildLocalJPrefixAttestation } from '../jurisdiction/machine/j-prefix-consensus';

import { createEmptyBatch, encodeJBatch } from '../jurisdiction/machine/batch';

import {
  getCertifiedBoardNodeStore,
  resolveCertifiedRegisteredBoardHash,
  resolveObserverCertifiedBoardRecord,
} from '../jurisdiction/machine/board-registry';

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

import { createDefaultDelta } from '../account/state/delta';

import { cloneEntityState } from '../entity/state-clone';

import { buildDisputeArgumentsForSnapshot } from '../entity/dispute-arguments';
import {
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

import { computeHtlcEnvelopeContextHash, computeHtlcSecretOfferContextHash } from '../protocol/htlc/codec/envelope';

import { encryptBytesForValidatorManifest } from '../protocol/htlc/multi-recipient';

import { buildHtlcOnionAdvanceTx } from '../entity/htlc/onion-advance';
import { hashEncryptedHtlcLayer } from '../protocol/htlc/codec/onion-layer';

import { encodeHtlcSecretOffer, encodeOnionLayer } from '../protocol/htlc/codec/onion';

import {
  computeEntityProfileCertificationHash,
  computeValidatorEncryptionAttestationDigest,
  requireCompleteValidatorEncryptionManifest,
} from '../protocol/htlc/validator-encryption';

import { handleMeshBootstrapLoopError } from '../orchestrator/mesh-bootstrap-fail-fast';

import { fitCrossAmountsToOrderbook } from '../orchestrator/mm-node';

import { cloneAccountReplica } from '../account/state/state-clone';
import {
  clearReplayOutputSignerHints,
  installReplayOutputSignerHints,
  resolveEntityProposerId,
} from '../runtime/entity-output-signer';

import { QUOTE_EXPIRY_MS } from '../types/finance/rebalance';

import type { AccountFrame, AccountInput, AccountReplica, AccountState, AccountTx } from '../types/account';
import type { ConsensusConfig, EntityInput, EntityReplica, EntityState, JurisdictionConfig } from '../entity/types';
import type { RuntimeReplica, RuntimeTx } from '../runtime/types';
import type { JAdapter } from '../jurisdiction/adapter/types';
import { attachLiveJAdapter } from '../runtime/live-jadapters';
import type { JInput } from '../jurisdiction/machine/input';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import type { DisputeFinalizationEvidence, JurisdictionEvent } from '../types/jurisdiction-events';
import type { EntityTx } from '../types/entity-tx';

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
      globalCreditLimits: { ownLimit: 0n, peerLimit: 0n },
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

const installAuditJAdapter = (env: RuntimeReplica, adapter: JAdapter): void => {
  env.state.jReplicas.set('Testnet', {
    name: 'Testnet',
    blockNumber: 0n,
    stateRoot: null,
    mempool: [],
    blockDelayMs: 0,
    lastBlockTimestamp: 0,
    chainId: 31337,
    position: { x: 0, y: 0, z: 0 },
  });
  attachLiveJAdapter(env, 'Testnet', adapter);
};

describe('audit fail-fast regressions', () => {
  test('finalized j-events mark mutated account docs dirty for storage replay', async () => {
    const seed = 'j-event-account-storage-mark seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.state.timestamp = 20_000;
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const counterpartyId = `0x${'34'.repeat(32)}`;
    const state = makeEntityState(entityId);
    state.config = makeSingleSignerConfigFor(signerId);
    env.state.jReplicas.set('AuditTestnet', {
      name: 'AuditTestnet',
      blockNumber: 0n,
      stateRoot: null,
      mempool: [],
      blockDelayMs: 0,
      lastBlockTimestamp: 0,
      chainId: 31337,
      position: { x: 0, y: 0, z: 0 },
      contracts: {
        depository: `0x${'dd'.repeat(20)}`,
        entityProvider: `0x${'ee'.repeat(20)}`,
        account: `0x${'aa'.repeat(20)}`,
        deltaTransformer: `0x${'bb'.repeat(20)}`,
      },
    });
    const entityIsLeft = isLeftEntity(entityId, counterpartyId);
    const account = makeProposalAccount(
      [],
      entityIsLeft ? entityId : counterpartyId,
      entityIsLeft ? counterpartyId : entityId,
    );
    const finalProofbody = makeEmptyProofBody();
    const finalProofbodyHash = hashProofBodyStruct(finalProofbody);
    account.disputeProofBodiesByHash = { [finalProofbodyHash]: finalProofbody };
    account.activeDispute = {
      startedByLeft: true,
      initialProofbodyHash: finalProofbodyHash,
      initialNonce: 7,
      disputeTimeout: 1700000100,
      disputeStartTimestamp: 1700000000,
      jNonce: 7,
      starterInitialArguments: '0x',
      starterCounterArguments: '0x',
      starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
      finalizeQueued: true,
    };
    state.accounts.set(counterpartyId, account);
    const replica = {
      entityId,
      signerId,
      entityEncPubKey: '',
      mempool: [],
      isProposer: true,
      state,
    } as EntityReplica;
    const disputeFinalizedEvent: JurisdictionEvent = {
      type: 'DisputeFinalized',
      data: {
        sender: entityId,
        counterentity: counterpartyId,
        initialNonce: 7,
        initialProofbodyHash: finalProofbodyHash,
        finalProofbodyHash,
        finalizationEvidenceHash: ethers.ZeroHash,
        finalProofbody,
      },
    };
    const signed = prepareJEventInput(env, entityId, signerId, {
      blockNumber: 22,
      blockHash: `0x${'99'.repeat(32)}`,
      transactionHash: `0x${'88'.repeat(32)}`,
      events: [disputeFinalizedEvent],
      jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
    });

    const rangeData = buildJEventRangeData(
      state,
      {
        from: signerId,
        jurisdictionRef: getJEventJurisdictionRef(state.config.jurisdiction),
        observedAt: 22,
        blockNumber: 22,
        blockHash: `0x${'99'.repeat(32)}`,
        transactionHash: `0x${'88'.repeat(32)}`,
        event: disputeFinalizedEvent,
        ...signed,
      },
      env,
    );
    replica.jHistory = recordValidatorJHistory(undefined, {
      jurisdictionRef: rangeData.jurisdictionRef,
      scannedThroughHeight: rangeData.scannedThroughHeight,
      tipBlockHash: rangeData.tipBlockHash,
      headers: Array.from({ length: rangeData.scannedThroughHeight }, (_, index) => {
        const jHeight = index + 1;
        return {
          jHeight,
          jBlockHash: jHeight === 22 ? rangeData.tipBlockHash : `0x${jHeight.toString(16).padStart(64, '0')}`,
        };
      }),
      blocks: rangeData.blocks.map(block => ({
        jurisdictionRef: rangeData.jurisdictionRef,
        jHeight: block.blockNumber,
        jBlockHash: block.blockHash,
        eventsHash: block.eventsHash,
        events: block.events,
        ...(block.disputeFinalizationEvidence
          ? { disputeFinalizationEvidence: block.disputeFinalizationEvidence }
          : {}),
        ...(block.disputeFinalizationEvidenceHash
          ? { disputeFinalizationEvidenceHash: block.disputeFinalizationEvidenceHash }
          : {}),
      })),
    });
    const attestation = buildLocalJPrefixAttestation(env, replica);
    if (!attestation) throw new Error('TEST_J_PREFIX_ATTESTATION_MISSING');
    const applied = await applyEntityInput(env, replica, {
      entityId,
      signerId,
      jPrefixAttestations: new Map([[signerId, attestation]]),
    });
    expect(applied.outcome).toEqual({ kind: 'committed' });
    expect(applied.newState.lastFinalizedJHeight).toBe(rangeData.scannedThroughHeight);
    expect(env.infrastructure?.currentStorageOverlayMarks ?? []).toEqual([]);
    expect(
      applied.storageChanges.some(
        record =>
          record.family === 'account' &&
          record.entityId === entityId &&
          record.counterpartyId === counterpartyId.toLowerCase(),
      ),
    ).toBe(true);
  });

  test('j_abort_sent_batch does not requeue dispute finalize after on-chain finalize already cleared activeDispute', async () => {
    const entityId = `0x${'aa'.repeat(32)}`;
    const counterpartyId = `0x${'bb'.repeat(32)}`;
    const state = makeEntityState(entityId);
    const account = makeProposalAccount([], entityId, counterpartyId);
    delete account.activeDispute;
    state.accounts.set(counterpartyId, account);
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
        encodedBatch: '0x',
        entityNonce: 1,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
        submitAttempts: 1,
      },
      entityNonce: 1,
    };

    const result = await handleJAbortSentBatch(
      state,
      {
        type: 'j_abort_sent_batch',
        data: { reason: 'submit_failed:E5()', requeueToCurrent: true },
      },
      createEmptyEnv('abort-stale-finalize'),
    );

    expect(result.newState.jBatchState?.sentBatch).toBeUndefined();
    expect(result.newState.jBatchState?.batch.disputeFinalizations.length).toBe(0);
    expect(result.newState.jBatchState?.status).toBe('empty');
  });

  test('j_abort_sent_batch never resurrects dispute finalize into current batch', async () => {
    const entityId = `0x${'cc'.repeat(32)}`;
    const counterpartyId = `0x${'dd'.repeat(32)}`;
    const state = makeEntityState(entityId);
    const account = makeProposalAccount([], entityId, counterpartyId);
    account.activeDispute = {
      startedByLeft: true,
      disputeTimeout: 1700000123,
      disputeStartTimestamp: 1700000000,
      initialProofbodyHash: `0x${'44'.repeat(32)}`,
      initialNonce: 5,
      finalizeQueued: true,
    } as AccountState['activeDispute'];
    state.accounts.set(counterpartyId, account);
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
          disputeFinalizations: [
            {
              counterentity: counterpartyId,
              initialNonce: 5,
              finalNonce: 5,
              initialProofbodyHash: `0x${'44'.repeat(32)}`,
              finalProofbody: makeEmptyProofBody(),
              starterArguments: '0x',
              otherArguments: '0x',
              sig: '0x',
              startedByLeft: true,
              cooperative: false,
            },
          ],
        },
        batchHash: `0x${'55'.repeat(32)}`,
        encodedBatch: '0x',
        entityNonce: 1,
        firstSubmittedAt: 1000,
        lastSubmittedAt: 1000,
      },
    };

    const result = await handleJAbortSentBatch(
      state,
      {
        type: 'j_abort_sent_batch',
        data: {
          reason: 'submit_failed',
          requeueToCurrent: true,
        },
      },
      createEmptyEnv('abort-finalize-regression'),
    );

    expect(result.newState.jBatchState?.sentBatch).toBeUndefined();
    expect(result.newState.jBatchState?.batch.disputeFinalizations).toEqual([]);
    expect(result.newState.accounts.get(counterpartyId)?.activeDispute?.finalizeQueued).toBe(false);
  });

  test('submitRuntimeJOutbox queues a durable transient result without poisoning Entity consensus', async () => {
    const entityId = `0x${'ab'.repeat(32)}`;
    const signerId = `0x${'cd'.repeat(20)}`;
    const batchHash = `0x${'11'.repeat(32)}`;
    const env = createEmptyEnv('j-submit-fail-fast');
    env.runtimeId = signerId;
    env.state.timestamp = 123;
    env.scenarioMode = false;
    const state = makeEntityState(entityId);
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
        },
        batchHash,
        encodedBatch: '0x1234',
        entityNonce: 1,
        firstSubmittedAt: 123,
        lastSubmittedAt: 123,
        submitAttempts: 1,
      },
    };
    env.state.eReplicas.set(`${entityId}:1`, {
      entityId,
      signerId,
      entityEncPubKey: '',
      mempool: [],
      isProposer: true,
      state,
    } as EntityReplica);
    installAuditJAdapter(env, {
      submitTx: async () => ({ success: false, error: 'ECONNREFUSED' }),
      pollNow: async () => {},
    } as JAdapter);
    const queuedInputs: EntityInput[] = [];
    const queuedRuntimeTxs: RuntimeTx[] = [];

    await submitAuditRuntimeJOutbox(
      env,
      [
        {
          jurisdictionName: 'Testnet',
          jTxs: [
            {
              type: 'batch',
              entityId,
              data: {
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
                batchHash,
                encodedBatch: '0x1234',
                entityNonce: 1,
                hankoSignature: '0x1234',
                batchSize: 1,
                signerId,
                runtimeSubmitAttempt: { attemptId: 'transient-attempt-1', attemptNumber: 1, attemptedAt: 123 },
              },
              timestamp: env.state.timestamp,
            } as any,
          ],
        },
      ],
      {
        enqueueRuntimeInputs: (_env, inputs, runtimeTxs) => {
          queuedInputs.push(...(inputs ?? []));
          queuedRuntimeTxs.push(...(runtimeTxs ?? []));
        },
      },
    );

    expect(queuedInputs).toHaveLength(0);
    expect(queuedRuntimeTxs).toMatchObject([
      {
        type: 'recordJSubmitResult',
        data: { outcome: 'transientFailure', message: 'ECONNREFUSED' },
      },
    ]);
    expect(state.jBatchState?.status).toBe('sent');
    expect(state.jBatchState?.failedAttempts).toBe(0);
    expect(state.jBatchState?.sentBatch).toBeDefined();
    expect(state.jBatchState?.sentBatch?.lastFailure).toBeUndefined();
    expect(state.jBatchState?.sentBatch?.terminalFailure).toBeUndefined();
  });

  test('submitRuntimeJOutbox never reads contract account state to reconcile a dispute batch', async () => {
    const entityId = `0x${'ac'.repeat(32)}`;
    const counterpartyId = `0x${'bd'.repeat(32)}`;
    const signerId = `0x${'ce'.repeat(20)}`;
    const batchHash = `0x${'13'.repeat(32)}`;
    const disputeFinalize = {
      counterentity: counterpartyId,
      initialNonce: 3,
      finalNonce: 3,
      initialProofbodyHash: `0x${'14'.repeat(32)}`,
      finalProofbody: makeEmptyProofBody(),
      starterArguments: '0x',
      otherArguments: '0x',
      sig: '0x',
      startedByLeft: true,
      cooperative: false,
    };
    const batch = { ...createEmptyBatch(), disputeFinalizations: [disputeFinalize] };
    const env = createEmptyEnv('j-submit-stale-dispute-finalize');
    env.runtimeId = signerId;
    env.state.timestamp = 125;
    const state = makeEntityState(entityId);
    state.jBatchState = {
      batch: createEmptyBatch(),
      jurisdiction: null,
      lastBroadcast: 0,
      broadcastCount: 0,
      failedAttempts: 0,
      status: 'sent',
      sentBatch: {
        batch,
        batchHash,
        encodedBatch: '0x1234',
        entityNonce: 1,
        firstSubmittedAt: 125,
        lastSubmittedAt: 125,
        submitAttempts: 1,
      },
    };
    env.state.eReplicas.set(`${entityId}:1`, {
      entityId,
      signerId,
      entityEncPubKey: '',
      mempool: [],
      isProposer: true,
      state,
    } as EntityReplica);
    let submitCalls = 0;
    let accountReadCalls = 0;
    installAuditJAdapter(env, {
      getAccountInfo: async () => {
        accountReadCalls += 1;
        throw new Error('contract account state must not be read by runtime');
      },
      submitTx: async () => {
        submitCalls += 1;
        return { success: true, events: [], txHash: `0x${'18'.repeat(32)}` };
      },
      pollNow: async () => {},
    } as JAdapter);
    const queuedInputs: EntityInput[] = [];

    await submitAuditRuntimeJOutbox(
      env,
      [
        {
          jurisdictionName: 'Testnet',
          jTxs: [
            {
              type: 'batch',
              entityId,
              data: {
                batch,
                batchHash,
                encodedBatch: '0x1234',
                entityNonce: 1,
                hankoSignature: '0x1234',
                batchSize: 1,
                signerId,
                runtimeSubmitAttempt: { attemptId: 'reconcile-before-1', attemptNumber: 1, attemptedAt: 125 },
              },
              timestamp: env.state.timestamp,
            } as any,
            {
              type: 'batch',
              entityId: `0x${'19'.repeat(32)}`,
              data: {
                batch: createEmptyBatch(),
                batchHash: `0x${'19'.repeat(32)}`,
                entityNonce: 1,
                signerId,
                batchSize: 0,
                runtimeSubmitAttempt: { attemptId: 'reconcile-before-2', attemptNumber: 1, attemptedAt: 125 },
              },
              timestamp: env.state.timestamp,
            } as any,
          ],
        },
      ],
      {
        enqueueRuntimeInputs: (_env, inputs) => queuedInputs.push(...(inputs ?? [])),
      },
    );

    expect(accountReadCalls).toBe(0);
    expect(submitCalls).toBe(2);
    expect(state.jBatchState?.sentBatch).toBeDefined();
    expect(queuedInputs).toEqual([]);
  });

  test('submitRuntimeJOutbox classifies submit results without reading contract finality', async () => {
    const entityId = `0x${'ca'.repeat(32)}`;
    const counterpartyId = `0x${'cb'.repeat(32)}`;
    const signerId = `0x${'cc'.repeat(20)}`;
    const initialProofbodyHash = `0x${'cd'.repeat(32)}`;
    const env = createEmptyEnv('j-submit-post-failure-reconcile');
    env.runtimeId = signerId;
    env.state.timestamp = 126;
    let accountReadCalls = 0;
    let submitCalls = 0;
    installAuditJAdapter(env, {
      getAccountInfo: async () => {
        accountReadCalls += 1;
        throw new Error('contract account state must not be read by runtime');
      },
      submitTx: async () => {
        submitCalls += 1;
        return submitCalls === 1
          ? { success: false, error: 'staticCall revert: E5()' }
          : { success: true, events: [], txHash: `0x${'ce'.repeat(32)}` };
      },
      pollNow: async () => {},
    } as JAdapter);
    const queuedInputs: EntityInput[] = [];
    const queuedRuntimeTxs: RuntimeTx[] = [];
    const disputeBatch = {
      ...createEmptyBatch(),
      disputeFinalizations: [
        {
          counterentity: counterpartyId,
          initialNonce: 7,
          finalNonce: 7,
          initialProofbodyHash,
          finalProofbody: makeEmptyProofBody(),
          starterArguments: '0x',
          otherArguments: '0x',
          sig: '0x',
          startedByLeft: true,
          cooperative: false,
        },
      ],
    };

    await submitAuditRuntimeJOutbox(
      env,
      [
        {
          jurisdictionName: 'Testnet',
          jTxs: [
            {
              type: 'batch',
              entityId,
              data: {
                batch: disputeBatch,
                batchHash: `0x${'d2'.repeat(32)}`,
                encodedBatch: '0x1234',
                entityNonce: 7,
                hankoSignature: '0x1234',
                batchSize: 1,
                signerId,
                runtimeSubmitAttempt: { attemptId: 'reconcile-after-1', attemptNumber: 1, attemptedAt: 126 },
              },
              timestamp: env.state.timestamp,
            } as any,
            {
              type: 'batch',
              entityId: `0x${'d3'.repeat(32)}`,
              data: {
                batch: createEmptyBatch(),
                batchHash: `0x${'d3'.repeat(32)}`,
                entityNonce: 1,
                signerId,
                batchSize: 0,
                runtimeSubmitAttempt: { attemptId: 'reconcile-after-2', attemptNumber: 1, attemptedAt: 126 },
              },
              timestamp: env.state.timestamp,
            } as any,
          ],
        },
      ],
      {
        enqueueRuntimeInputs: (_env, inputs, runtimeTxs) => {
          queuedInputs.push(...(inputs ?? []));
          queuedRuntimeTxs.push(...(runtimeTxs ?? []));
        },
      },
    );

    expect(accountReadCalls).toBe(0);
    expect(submitCalls).toBe(2);
    expect(queuedInputs).toEqual([]);
    expect(queuedRuntimeTxs.map(tx => (tx.type === 'recordJSubmitResult' ? tx.data.outcome : tx.type))).toEqual([
      'terminalFailure',
      'submitted',
    ]);
  });

  test('submitRuntimeJOutbox keeps E5 fatal without matching finalized-dispute evidence', async () => {
    const entityId = `0x${'ae'.repeat(32)}`;
    const signerId = `0x${'cf'.repeat(20)}`;
    const env = createEmptyEnv('j-submit-unproven-e5');
    env.runtimeId = signerId;
    env.state.timestamp = 126;
    installAuditJAdapter(env, {
      submitTx: async () => ({ success: false, error: 'staticCall revert: E5()' }),
      pollNow: async () => {},
    } as JAdapter);
    const queuedRuntimeTxs: RuntimeTx[] = [];

    await submitAuditRuntimeJOutbox(
      env,
      [
        {
          jurisdictionName: 'Testnet',
          jTxs: [
            {
              type: 'batch',
              entityId,
              data: {
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
                batchHash: `0x${'18'.repeat(32)}`,
                encodedBatch: '0x1234',
                entityNonce: 1,
                hankoSignature: '0x1234',
                batchSize: 1,
                signerId,
                runtimeSubmitAttempt: { attemptId: 'fatal-e5-1', attemptNumber: 1, attemptedAt: 126 },
              },
              timestamp: env.state.timestamp,
            } as any,
          ],
        },
      ],
      {
        enqueueRuntimeInputs: (_env, _inputs, runtimeTxs) => queuedRuntimeTxs.push(...(runtimeTxs ?? [])),
      },
    );
    expect(queuedRuntimeTxs).toMatchObject([
      {
        type: 'recordJSubmitResult',
        data: { outcome: 'terminalFailure', message: 'staticCall revert: E5()' },
      },
    ]);
  });

  test('submitRuntimeJOutbox queues terminal staticCall result without mutating Entity consensus', async () => {
    const entityId = `0x${'ad'.repeat(32)}`;
    const signerId = `0x${'cd'.repeat(20)}`;
    const batchHash = `0x${'12'.repeat(32)}`;
    const env = createEmptyEnv('j-submit-staticcall-fail-fast');
    env.runtimeId = signerId;
    env.state.timestamp = 124;
    env.scenarioMode = false;
    const state = makeEntityState(entityId);
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
        },
        batchHash,
        encodedBatch: '0x1234',
        entityNonce: 1,
        firstSubmittedAt: 124,
        lastSubmittedAt: 124,
        submitAttempts: 1,
      },
    };
    env.state.eReplicas.set(`${entityId}:1`, {
      entityId,
      signerId,
      entityEncPubKey: '',
      mempool: [],
      isProposer: true,
      state,
    } as EntityReplica);
    installAuditJAdapter(env, {
      submitTx: async () => ({ success: false, error: 'staticCall revert: E3()' }),
      pollNow: async () => {},
    } as JAdapter);
    const queuedRuntimeTxs: RuntimeTx[] = [];

    await submitAuditRuntimeJOutbox(
      env,
      [
        {
          jurisdictionName: 'Testnet',
          jTxs: [
            {
              type: 'batch',
              entityId,
              data: {
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
                batchHash,
                encodedBatch: '0x1234',
                entityNonce: 1,
                hankoSignature: '0x1234',
                batchSize: 1,
                signerId,
                runtimeSubmitAttempt: { attemptId: 'fatal-e3-1', attemptNumber: 1, attemptedAt: 124 },
              },
              timestamp: env.state.timestamp,
            } as any,
          ],
        },
      ],
      { enqueueRuntimeInputs: (_env, _inputs, runtimeTxs) => queuedRuntimeTxs.push(...(runtimeTxs ?? [])) },
    );

    expect(queuedRuntimeTxs).toMatchObject([
      {
        type: 'recordJSubmitResult',
        data: { outcome: 'terminalFailure', message: 'staticCall revert: E3()' },
      },
    ]);
    expect(state.jBatchState?.status).toBe('sent');
    expect(state.jBatchState?.failedAttempts).toBe(0);
    expect(state.jBatchState?.sentBatch?.terminalFailure).toBeUndefined();
    expect(state.jBatchState?.sentBatch?.lastFailure).toBeUndefined();
  });

  test('submitRuntimeJOutbox skips sealed batches owned by another runtime signer', async () => {
    const entityId = `0x${'ae'.repeat(32)}`;
    const localRuntimeId = `0x${'11'.repeat(20)}`;
    const remoteSignerId = `0x${'22'.repeat(20)}`;
    const env = createEmptyEnv('j-submit-non-local-signer-skip');
    env.runtimeId = localRuntimeId;
    env.state.timestamp = 125;
    let adapterCalls = 0;
    installAuditJAdapter(env, {
      submitTx: async () => {
        adapterCalls += 1;
        return { success: true };
      },
      pollNow: async () => {},
    } as JAdapter);
    const queuedRuntimeTxs: RuntimeTx[] = [];

    await submitAuditRuntimeJOutbox(
      env,
      [
        {
          jurisdictionName: 'Testnet',
          jTxs: [
            {
              type: 'batch',
              entityId,
              data: {
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
                batchHash: `0x${'13'.repeat(32)}`,
                encodedBatch: '0x1234',
                entityNonce: 1,
                hankoSignature: '0x1234',
                batchSize: 1,
                signerId: remoteSignerId,
                runtimeSubmitAttempt: { attemptId: 'non-local-1', attemptNumber: 1, attemptedAt: 125 },
              },
              timestamp: env.state.timestamp,
            } as any,
          ],
        },
      ],
      { enqueueRuntimeInputs: (_env, _inputs, runtimeTxs) => queuedRuntimeTxs.push(...(runtimeTxs ?? [])) },
    );

    expect(adapterCalls).toBe(0);
    expect(queuedRuntimeTxs).toMatchObject([
      {
        type: 'recordJSubmitResult',
        data: { outcome: 'terminalFailure' },
      },
    ]);
  });

  test('submitRuntimeJOutbox submits RuntimeReplica-local multi-signer batches even when runtimeId differs', async () => {
    const entityId = `0x${'af'.repeat(32)}`;
    const runtimeId = `0x${'33'.repeat(20)}`;
    const localScenarioSignerId = '97';
    const env = createEmptyEnv('j-submit-local-multi-signer');
    env.runtimeId = runtimeId;
    env.state.timestamp = 126;
    let adapterCalls = 0;
    installAuditJAdapter(env, {
      submitTx: async (_tx: unknown, options: { signerId?: string; signerPrivateKey?: Uint8Array }) => {
        adapterCalls += 1;
        expect(options.signerId).toBe(localScenarioSignerId);
        expect(options.signerPrivateKey).toBeInstanceOf(Uint8Array);
        return { success: true };
      },
      pollNow: async () => {},
    } as JAdapter);

    await submitAuditRuntimeJOutbox(
      env,
      [
        {
          jurisdictionName: 'Testnet',
          jTxs: [
            {
              type: 'batch',
              entityId,
              data: {
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
                batchHash: `0x${'14'.repeat(32)}`,
                encodedBatch: '0x1234',
                entityNonce: 1,
                hankoSignature: '0x1234',
                batchSize: 1,
                signerId: localScenarioSignerId,
                runtimeSubmitAttempt: { attemptId: 'local-multisig-1', attemptNumber: 1, attemptedAt: 126 },
              },
              timestamp: env.state.timestamp,
            } as any,
          ],
        },
      ],
      { enqueueRuntimeInputs: () => {} },
    );

    expect(adapterCalls).toBe(1);
  });

  test('submitRuntimeJOutbox rejects non-empty consensus batch before adapter when hanko is missing', async () => {
    const env = createEmptyEnv('j-submit-unsealed-batch');
    env.state.timestamp = 123;
    let adapterCalls = 0;
    installAuditJAdapter(env, {
      submitTx: async () => {
        adapterCalls += 1;
        return { success: true };
      },
      pollNow: async () => {},
    } as JAdapter);
    const queuedRuntimeTxs: RuntimeTx[] = [];

    await submitAuditRuntimeJOutbox(
      env,
      [
        {
          jurisdictionName: 'Testnet',
          jTxs: [
            {
              type: 'batch',
              entityId: `0x${'ac'.repeat(32)}`,
              data: {
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
                batchSize: 1,
                signerId: `0x${'cd'.repeat(20)}`,
                batchHash: `0x${'15'.repeat(32)}`,
                entityNonce: 1,
                runtimeSubmitAttempt: { attemptId: 'missing-hanko-1', attemptNumber: 1, attemptedAt: 123 },
              },
              timestamp: env.state.timestamp,
            } as any,
          ],
        },
      ],
      {
        enqueueRuntimeInputs: (_env, _inputs, runtimeTxs) => queuedRuntimeTxs.push(...(runtimeTxs ?? [])),
      },
    );

    expect(adapterCalls).toBe(0);
    expect(queuedRuntimeTxs).toMatchObject([
      {
        type: 'recordJSubmitResult',
        data: { outcome: 'terminalFailure' },
      },
    ]);
  });

  test('request_collateral checks prepaid fee against derived outCapacity', () => {
    const feeDelta = {
      tokenId: 1,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 100n,
      leftCreditLimit: 0n,
      rightCreditLimit: 1000n,
      leftAllowance: 0n,
      rightAllowance: 0n,
      leftHold: 95n,
      rightHold: 0n,
    };
    const accountMachine = {
      state: {
        deltas: new Map([[1, feeDelta]]),
        requestedRebalance: new Map<number, bigint>(),
        requestedRebalanceFeeState: new Map(),
      },
    };

    const result = handleRequestCollateral(
      accountMachine as Parameters<typeof handleRequestCollateral>[0],
      {
        type: 'request_collateral',
        data: { tokenId: 1, amount: 50n, feeTokenId: 1, feeAmount: 10n, policyVersion: 1 },
      },
      true,
      0,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('insufficient fee capacity');
    expect(accountMachine.state.requestedRebalance.size).toBe(0);
    expect(feeDelta.offdelta).toBe(100n);
  });

  test('request_collateral keeps an existing pending request immutable', () => {
    const delta = {
      tokenId: 1,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 1_000n,
      leftCreditLimit: 0n,
      rightCreditLimit: 2_000n,
      leftAllowance: 0n,
      rightAllowance: 0n,
      leftHold: 0n,
      rightHold: 0n,
    };
    const accountMachine = {
      state: {
        deltas: new Map([[1, delta]]),
        requestedRebalance: new Map<number, bigint>([[1, 590n]]),
        requestedRebalanceFeeState: new Map([
          [
            1,
            {
              feeTokenId: 1,
              feePaidUpfront: 10n,
              requestedAmount: 590n,
              policyVersion: 1,
              requestedAt: 1,
              requestedByLeft: true,
            },
          ],
        ]),
      },
      shadow: { rebalance: { policy: new Map(), submittedAtByToken: new Map([[1, 123]]) } },
    };

    const result = handleRequestCollateral(
      accountMachine as Parameters<typeof handleRequestCollateral>[0],
      {
        type: 'request_collateral',
        data: { tokenId: 1, amount: 800n, feeTokenId: 1, feeAmount: 20n, policyVersion: 1 },
      },
      true,
      2,
    );

    expect(result.success).toBe(true);
    expect(accountMachine.state.requestedRebalance.get(1)).toBe(590n);
    expect(accountMachine.state.requestedRebalanceFeeState.get(1)?.feePaidUpfront).toBe(10n);
    expect(accountMachine.shadow.rebalance.submittedAtByToken.get(1)).toBe(123);
    expect(delta.offdelta).toBe(1_000n);
  });

  test('auto-rebalance never tops up an existing pending request', () => {
    const usd = 10n ** 18n;
    const accountMachine = {
      state: {
        leftEntity: `0x${'11'.repeat(32)}`,
        rightEntity: `0x${'ff'.repeat(32)}`,
        settlementWorkspace: { status: 'sent' },
        requestedRebalance: new Map<number, bigint>([[1, 590n * usd]]),
        requestedRebalanceFeeState: new Map([
          [
            1,
            {
              feeTokenId: 1,
              feePaidUpfront: 10n * usd,
              requestedAmount: 590n * usd,
              policyVersion: 1,
              requestedAt: 1,
              requestedByLeft: true,
            },
          ],
        ]),
        deltas: new Map([
          [
            1,
            {
              tokenId: 1,
              collateral: 590n * usd,
              ondelta: 0n,
              offdelta: 1_390n * usd,
              leftCreditLimit: 0n,
              rightCreditLimit: 2_000n * usd,
              leftAllowance: 0n,
              rightAllowance: 0n,
              leftHold: 0n,
              rightHold: 0n,
            },
          ],
        ]),
        rebalanceFeePolicies: new Map([
          [
            1,
            {
              right: {
                policyVersion: 1,
                baseFee: 10n * usd,
                gasFee: 0n,
                liquidityFeeBps: 0n,
                updatedAt: 1,
              },
            },
          ],
        ]),
      },
      mempool: [],
      pendingFrame: undefined,
      shadow: {
        rebalance: {
          policy: new Map([
            [
              1,
              {
                r2cRequestSoftLimit: 500n * usd,
                hardLimit: 10_000n * usd,
                maxAcceptableFee: 100n * usd,
              },
            ],
          ]),
          submittedAtByToken: new Map([[1, 123]]),
        },
      },
    };

    const txs = checkAutoRebalance(
      accountMachine as Parameters<typeof checkAutoRebalance>[0],
      `0x${'11'.repeat(32)}`,
      `0x${'ff'.repeat(32)}`,
    );

    expect(txs).toHaveLength(0);

    const delta = accountMachine.state.deltas.get(1);
    if (!delta) throw new Error('TEST_REBALANCE_DELTA_MISSING');
    delta.offdelta = 2_590n * usd;
    expect(
      checkAutoRebalance(
        accountMachine as Parameters<typeof checkAutoRebalance>[0],
        `0x${'11'.repeat(32)}`,
        `0x${'ff'.repeat(32)}`,
      ),
    ).toHaveLength(0);
  });

  test('auto-rebalance fee policy ignores live sibling topology', () => {
    const env = createEmptyEnv('rebalance-policy-consensus-purity');
    const entityId = `0x${'13'.repeat(32)}`;
    const hubId = `0x${'14'.repeat(32)}`;
    const account = makeProposalAccount([], entityId, hubId);
    const hubState = makeEntityState(hubId);
    hubState.hubRebalanceConfig = {
      matchingStrategy: 'amount',
      policyVersion: 9,
      routingFeePPM: 0,
      baseFee: 999n,
      rebalanceLiquidityFeeBps: 88n,
    };
    env.state.eReplicas.set(`${hubId}:hub`, {
      entityId: hubId,
      signerId: 'hub',
      entityEncPubKey: '',
      state: hubState,
    } as never);

    expect(resolveAutoRebalanceFeePolicy(account, entityId, 1)).toBeUndefined();

    account.state.rebalanceFeePolicies = new Map([
      [
        1,
        {
          right: {
            policyVersion: 3,
            baseFee: 7n,
            liquidityFeeBps: 5n,
            gasFee: 11n,
            updatedAt: 1,
          },
        },
      ],
    ]);
    expect(resolveAutoRebalanceFeePolicy(account, entityId, 1)).toEqual({
      policyVersion: 3,
      baseFee: 7n,
      liquidityFeeBps: 5n,
      gasFee: 11n,
    });
  });

  test('explicit rebalance policy AccountTx binds the snapshot to proposer side and token', async () => {
    const leftId = `0x${'15'.repeat(32)}`;
    const rightId = `0x${'f5'.repeat(32)}`;
    const account = makeProposalAccount([], leftId, rightId);
    account.state.deltas.set(1, createDefaultDelta(1));
    const tx: AccountTx = {
      type: 'rebalance_policy',
      data: {
        tokenId: 1,
        policyVersion: 4,
        baseFee: 7n,
        liquidityFeeBps: 5n,
        gasFee: 11n,
      },
    };

    const result = await applyAccountTx(account, tx, true, 123, 0);

    expect(result.success).toBe(true);
    expect(account.state.rebalanceFeePolicies?.get(1)?.left).toEqual({
      policyVersion: 4,
      baseFee: 7n,
      liquidityFeeBps: 5n,
      gasFee: 11n,
      updatedAt: 123,
    });
    expect(account.state.rebalanceFeePolicies?.get(1)?.right).toBeUndefined();

    const retry = await applyAccountTx(account, tx, true, 999, 0);
    expect(retry.success).toBe(true);
    expect(account.state.rebalanceFeePolicies?.get(1)?.left?.updatedAt).toBe(123);

    const beforeConflict = computeAccountStateRoot(account.state);
    const conflict = await applyAccountTx(
      account,
      {
        ...tx,
        data: { ...tx.data, baseFee: 8n },
      },
      true,
      999,
      0,
    );
    expect(conflict).toMatchObject({ success: false, error: expect.stringContaining('REBALANCE_POLICY_EQUIVOCATION') });
    expect(computeAccountStateRoot(account.state)).toBe(beforeConflict);

    const stale = await applyAccountTx(
      account,
      {
        ...tx,
        data: { ...tx.data, policyVersion: 3 },
      },
      true,
      999,
      0,
    );
    expect(stale.success).toBe(true);
    expect(computeAccountStateRoot(account.state)).toBe(beforeConflict);

    const right = await applyAccountTx(
      account,
      {
        ...tx,
        data: { ...tx.data, policyVersion: 1, baseFee: 13n },
      },
      false,
      456,
      0,
    );
    expect(right.success).toBe(true);
    expect(account.state.rebalanceFeePolicies?.get(1)?.right?.baseFee).toBe(13n);
    expect(account.state.rebalanceFeePolicies?.get(1)?.left?.baseFee).toBe(7n);
  });

  test('rebalance policy rejects non-bigint fee terms before mutating Account state', async () => {
    const leftId = `0x${'18'.repeat(32)}`;
    const rightId = `0x${'f8'.repeat(32)}`;
    const account = makeProposalAccount([], leftId, rightId);
    account.state.deltas.set(1, createDefaultDelta(1));
    const before = computeAccountStateRoot(account.state);
    const malformed = {
      type: 'rebalance_policy',
      data: { tokenId: 1, policyVersion: 1, baseFee: 7, liquidityFeeBps: 5, gasFee: 11 },
    } as unknown as AccountTx;

    const result = await applyAccountTx(account, malformed, true, 123, 0);

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('invalid fee types') });
    expect(computeAccountStateRoot(account.state)).toBe(before);
    expect(account.state.rebalanceFeePolicies).toBeUndefined();
  });

  test('auto-rebalance output order survives compact storage map canonicalization', () => {
    const entityId = `0x${'19'.repeat(32)}`;
    const hubId = `0x${'f9'.repeat(32)}`;
    const account = makeProposalAccount([], entityId, hubId);
    for (const tokenId of [3, 1, 2]) {
      const delta = createDefaultDelta(tokenId);
      delta.offdelta = 1_000n;
      delta.rightCreditLimit = 2_000n;
      account.state.deltas.set(tokenId, delta);
      account.shadow.rebalance.policy.set(tokenId, {
        r2cRequestSoftLimit: 100n,
        hardLimit: 2_000n,
        maxAcceptableFee: 100n,
      });
      const policies = account.state.rebalanceFeePolicies ?? new Map();
      policies.set(tokenId, {
        right: {
          policyVersion: 1,
          baseFee: 1n,
          liquidityFeeBps: 0n,
          gasFee: 0n,
          updatedAt: 1,
        },
      });
      account.state.rebalanceFeePolicies = policies;
    }
    const restored = hydrateAccountDocFromStorage(
      decodeValidatedBuffer(encodeBuffer(projectAccountDoc(account)), validateStorageAccountDocValue),
    );

    const liveTxs = checkAutoRebalance(account, entityId, hubId);
    const restoredTxs = checkAutoRebalance(restored, entityId, hubId);

    expect(liveTxs).toEqual(restoredTxs);
    expect(liveTxs.map(tx => tx.data.tokenId)).toEqual([1, 2, 3]);
  });

  test('setHubConfig publishes an explicit fee policy into every established Account lane', () => {
    const env = createEmptyEnv('rebalance-policy-publish');
    const hubId = `0x${'16'.repeat(32)}`;
    const userId = `0x${'f6'.repeat(32)}`;
    const state = makeEntityState(hubId);
    const account = makeProposalAccount([], hubId, userId);
    account.state.deltas.set(1, createDefaultDelta(1));
    account.state.deltas.set(2, createDefaultDelta(2));
    state.accounts.set(userId, account);

    const result = handleSetHubConfigEntityTx(env, state, {
      type: 'setHubConfig',
      data: {
        policyVersion: 4,
        rebalanceLiquidityFeeBps: 5n,
      },
    });

    expect(result.accountTxs?.map(({ tx }) => tx)).toEqual([
      {
        type: 'rebalance_policy',
        data: { tokenId: 1, policyVersion: 4, baseFee: 100_000n, liquidityFeeBps: 5n, gasFee: 0n },
      },
      {
        type: 'rebalance_policy',
        data: { tokenId: 2, policyVersion: 4, baseFee: 100_000_000_000_000_000n, liquidityFeeBps: 5n, gasFee: 0n },
      },
    ]);
    expect(result.outputs).toHaveLength(1);
    expect(() =>
      handleSetHubConfigEntityTx(env, result.newState, {
        type: 'setHubConfig',
        data: { policyVersion: 4, rebalanceLiquidityFeeBps: 6n },
      }),
    ).toThrow('HUB_REBALANCE_POLICY_EQUIVOCATION:version=4');
    expect(() =>
      handleSetHubConfigEntityTx(env, result.newState, {
        type: 'setHubConfig',
        data: { policyVersion: 3, rebalanceLiquidityFeeBps: 5n },
      }),
    ).toThrow('HUB_REBALANCE_POLICY_VERSION_STALE:3<4');
  });

  test('bilateral rebalance policies survive compact storage decode with strict shape validation', () => {
    const leftId = `0x${'17'.repeat(32)}`;
    const rightId = `0x${'f7'.repeat(32)}`;
    const account = makeProposalAccount([], leftId, rightId);
    account.state.deltas.set(1, createDefaultDelta(1));
    account.state.rebalanceFeePolicies = new Map([
      [
        1,
        {
          left: { policyVersion: 2, baseFee: 3n, liquidityFeeBps: 4n, gasFee: 5n, updatedAt: 6 },
          right: { policyVersion: 7, baseFee: 8n, liquidityFeeBps: 9n, gasFee: 10n, updatedAt: 11 },
        },
      ],
    ]);
    const root = computeAccountStateRoot(account.state);

    const restored = hydrateAccountDocFromStorage(
      decodeValidatedBuffer(encodeBuffer(projectAccountDoc(account)), validateStorageAccountDocValue),
    );

    expect(restored.state.rebalanceFeePolicies).toEqual(account.state.rebalanceFeePolicies);
    expect(computeAccountStateRoot(restored.state)).toBe(root);

    const corrupt = projectAccountDoc(account);
    const left = corrupt.state.rebalanceFeePolicies?.get(1)?.left;
    if (!left) throw new Error('TEST_REBALANCE_POLICY_REQUIRED');
    (left as typeof left & { unexpected: boolean }).unexpected = true;
    expect(() => decodeValidatedBuffer(encodeBuffer(corrupt), validateStorageAccountDocValue)).toThrow(
      'contains unexpected fields',
    );
  });

  test('post-frame auto-rebalance uses explicit owner role and committed exact fees', async () => {
    const entityId = `0x${'15'.repeat(32)}`;
    const hubId = `0x${'f5'.repeat(32)}`;
    const account = makeProposalAccount([], entityId, hubId);
    account.state.rebalanceFeePolicies = new Map([
      [
        1,
        {
          right: {
            policyVersion: 4,
            baseFee: 7n,
            liquidityFeeBps: 5n,
            gasFee: 11n,
            updatedAt: 1,
          },
        },
      ],
    ]);
    account.shadow.rebalance.policy.set(1, {
      r2cRequestSoftLimit: 500n,
      hardLimit: 100_000n,
      maxAcceptableFee: 1_000n,
    });
    const delta = createDefaultDelta(1);
    delta.offdelta = 60_000n;
    delta.rightCreditLimit = 100_000n;
    account.state.deltas.set(1, delta);
    const withSibling = createEmptyEnv('rebalance-explicit-role-with-sibling');
    const withoutSibling = createEmptyEnv('rebalance-explicit-role-without-sibling');
    const misleadingOwner = makeEntityState(entityId);
    misleadingOwner.hubRebalanceConfig = {
      matchingStrategy: 'amount',
      policyVersion: 99,
      routingFeePPM: 0,
      baseFee: 999n,
    };
    withSibling.state.eReplicas.set(`${entityId}:misleading`, {
      entityId,
      signerId: 'misleading',
      entityEncPubKey: '',
      state: misleadingOwner,
    } as never);

    const [withResult, withoutResult] = await Promise.all([
      runPostFrameAutoRebalanceCheck(structuredClone(account), entityId, hubId, 1, false),
      runPostFrameAutoRebalanceCheck(structuredClone(account), entityId, hubId, 1, false),
    ]);

    expect(withResult).toEqual(withoutResult);
    expect(withResult[0]?.data.feeAmount).toBe(48n);
  });

  test('private rebalance policy immediately queues collateral for existing exposure', () => {
    const env = createEmptyEnv('rebalance-policy-existing-exposure');
    const entityId = `0x${'11'.repeat(32)}`;
    const hubId = `0x${'ff'.repeat(32)}`;
    const usd = 10n ** 18n;
    const state = makeEntityState(entityId);
    const account = makeProposalAccount([], entityId, hubId);
    account.state.rebalanceFeePolicies = new Map([
      [
        1,
        {
          right: {
            policyVersion: 1,
            baseFee: 1n * usd,
            liquidityFeeBps: 1n,
            gasFee: 0n,
            updatedAt: 1,
          },
        },
      ],
    ]);
    account.state.deltas.set(1, {
      tokenId: 1,
      collateral: 0n,
      ondelta: 0n,
      offdelta: 550n * usd,
      leftCreditLimit: 0n,
      rightCreditLimit: 2_000n * usd,
      leftAllowance: 0n,
      rightAllowance: 0n,
      leftHold: 0n,
      rightHold: 0n,
    });
    state.accounts.set(hubId, account);

    const result = handleSetRebalancePolicyEntityTx(env, state, {
      type: 'setRebalancePolicy',
      data: {
        counterpartyEntityId: hubId,
        tokenId: 1,
        r2cRequestSoftLimit: 500n * usd,
        hardLimit: 10_000n * usd,
        maxAcceptableFee: 20n * usd,
      },
    });

    expect(result.newState.accounts.get(hubId)?.shadow.rebalance.policy.get(1)?.r2cRequestSoftLimit).toBe(500n * usd);
    expect(result.accountTxs).toHaveLength(1);
    expect(result.accountTxs?.[0]?.tx.type).toBe('request_collateral');
    expect(result.accountTxs?.[0]?.tx.data.feeAmount).toBe(1_055_000_000_000_000_000n);
    expect(result.outputs).toHaveLength(1);
    expect('rebalancePolicy' in result.newState.accounts.get(hubId)!).toBe(false);
  });

  test('auto-rebalance does not top up pending request fee when liquidity fee grows', () => {
    const usd = 10n ** 18n;
    const previousRequest = 590n * usd;
    const outPeerCredit = 1_100n * usd;
    const previousFee = 150_100_000_000_000_000n;
    const requiredFee = 210_000_000_000_000_000n;
    const delta = {
      tokenId: 1,
      collateral: previousRequest,
      ondelta: 0n,
      offdelta: previousRequest + outPeerCredit,
      leftCreditLimit: 2_000n * usd,
      rightCreditLimit: 2_000n * usd,
      leftAllowance: 0n,
      rightAllowance: 0n,
      leftHold: 0n,
      rightHold: 0n,
    };
    const accountMachine = {
      state: {
        leftEntity: `0x${'11'.repeat(32)}`,
        rightEntity: `0x${'ff'.repeat(32)}`,
        settlementWorkspace: { status: 'sent' },
        deltas: new Map([[1, delta]]),
        requestedRebalance: new Map<number, bigint>([[1, previousRequest]]),
        requestedRebalanceFeeState: new Map([
          [
            1,
            {
              feeTokenId: 1,
              feePaidUpfront: previousFee,
              requestedAmount: previousRequest,
              policyVersion: 1,
              requestedAt: 1,
              requestedByLeft: true,
            },
          ],
        ]),
        rebalanceFeePolicies: new Map([
          [
            1,
            {
              right: {
                policyVersion: 1,
                baseFee: usd / 10n,
                gasFee: 0n,
                liquidityFeeBps: 1n,
                updatedAt: 1,
              },
            },
          ],
        ]),
      },
      mempool: [],
      pendingFrame: undefined,
      shadow: {
        rebalance: {
          policy: new Map([
            [
              1,
              {
                r2cRequestSoftLimit: 500n * usd,
                hardLimit: 10_000n * usd,
                maxAcceptableFee: 300n * usd,
              },
            ],
          ]),
          submittedAtByToken: new Map([[1, 123]]),
        },
      },
    };

    const txs = checkAutoRebalance(
      accountMachine as Parameters<typeof checkAutoRebalance>[0],
      `0x${'11'.repeat(32)}`,
      `0x${'ff'.repeat(32)}`,
    );

    expect(txs).toHaveLength(0);

    const result = handleRequestCollateral(
      accountMachine as Parameters<typeof handleRequestCollateral>[0],
      {
        type: 'request_collateral',
        data: { tokenId: 1, amount: outPeerCredit, feeTokenId: 1, feeAmount: requiredFee, policyVersion: 1 },
      },
      true,
      2,
    );

    expect(result.success).toBe(true);
    expect(accountMachine.state.requestedRebalance.get(1)).toBe(previousRequest);
    expect(accountMachine.state.requestedRebalanceFeeState.get(1)?.feePaidUpfront).toBe(previousFee);
    expect(accountMachine.state.requestedRebalanceFeeState.get(1)?.requestedAmount).toBe(previousRequest);
    expect(accountMachine.shadow.rebalance.submittedAtByToken.get(1)).toBe(123);
    expect(delta.offdelta).toBe(previousRequest + outPeerCredit);
  });

  test('entity proposal fails fast when prevFrameHash is missing above genesis', async () => {
    const seed = 'audit-entity-missing-parent-seed';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;

    const replica = makeReplicaMissingPrevFrameHash();
    const { signerId, entityId } = registerLazySigner(seed, '1');
    replica.entityId = entityId;
    replica.signerId = signerId;
    replica.state.entityId = entityId;
    replica.state.config = makeSingleSignerConfigFor(signerId);
    const entityInput: EntityInput = {
      entityId: replica.entityId,
      entityTxs: [
        {
          type: 'chatMessage',
          data: { message: 'forces single-signer frame creation' },
        },
      ],
    };

    await expect(applyEntityInput(env, replica, entityInput)).rejects.toThrow('ENTITY_FRAME_CHAIN_CORRUPTED');
  });

  test('entity mempool admission rejects overflow before clone and push', async () => {
    const env = createEmptyEnv('entity-mempool-admission-overflow');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const replica = makeReplicaMissingPrevFrameHash();
    const queuedTx: EntityTx = {
      type: 'chatMessage',
      data: { message: 'already queued' },
    };
    replica.mempool = Array.from({ length: LIMITS.MEMPOOL_SIZE }, () => queuedTx);

    const result = await applyEntityInput(env, replica, {
      entityId: replica.entityId,
      entityTxs: [
        {
          type: 'chatMessage',
          data: { message: 'must not allocate into mempool' },
        },
      ],
    });

    expect(result.outcome).toEqual({ kind: 'rejected', code: 'ENTITY_MEMPOOL_ADMISSION_REJECTED' });
    expect(result.workingReplica).toBe(replica);
    expect(result.outputs).toEqual([]);
    expect(result.jOutputs).toEqual([]);
    expect(replica.mempool).toHaveLength(LIMITS.MEMPOOL_SIZE);
  });

  test('rejected remote entity input creates neither applied receipt nor route hint', async () => {
    const env = createEmptyEnv('entity-input-rejected-route-hint');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.runtimeId = `0x${'51'.repeat(20)}`;
    env.infrastructure ??= {};
    env.infrastructure.entityRuntimeHints = new Map();
    const replica = makeReplicaMissingPrevFrameHash();
    const queuedTx: EntityTx = { type: 'chatMessage', data: { message: 'full' } };
    replica.mempool = Array.from({ length: LIMITS.MEMPOOL_SIZE }, () => queuedTx);
    env.state.eReplicas.set(`${replica.entityId}:${replica.signerId}`, replica);
    const remoteEntityId = `0x${'52'.repeat(32)}`;

    const result = await applyMergedEntityInputs(
      env,
      [
        {
          from: `0x${'53'.repeat(20)}`,
          entityId: replica.entityId,
          signerId: replica.signerId,
          entityTxs: [
            {
              type: 'accountInput',
              data: { fromEntityId: remoteEntityId, toEntityId: replica.entityId },
            } as never,
          ],
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
          resolveSoleLocalSignerForEntity: () => replica.signerId,
          getP2P: () => null,
        },
      },
    );

    expect(result.appliedEntityInputs).toEqual([]);
    expect(env.infrastructure.entityRuntimeHints.has(remoteEntityId)).toBe(false);
  });

  test('entity commit catch-up derives committed state only from local replay', async () => {
    const seed = 'entity-commit-catch-up-state-binding seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.state.timestamp = 42_000;
    const { signerId, entityId } = registerLazySigner(seed, '1');
    const collectiveTxs: EntityTx[] = [
      {
        type: 'profile-update',
        data: {
          profile: {
            entityId,
            name: 'Signed Profile',
          },
        },
      } as any,
    ];

    const honestBaseState = makeEntityState(entityId);
    honestBaseState.config = makeSingleSignerConfigFor(signerId);
    const frameTxs = await buildQuorumAuthorizedFrameTxs(env, honestBaseState, collectiveTxs);
    const { newState: honestFrameState, collectedHashes = [] } = await applyEntityFrame(
      env,
      honestBaseState,
      frameTxs,
      env.state.timestamp,
    );
    const honestNewState: EntityState = {
      ...honestFrameState,
      entityId,
      height: 1,
      timestamp: env.state.timestamp,
      leaderState: { activeValidatorId: signerId, view: 0, changedAtHeight: 0 },
    };
    const frameHash = await createEntityFrameHash('genesis', 1, env.state.timestamp, frameTxs, honestNewState);
    const hashesToSign = buildEntityHashesToSign(entityId, 1, frameHash, collectedHashes);
    const stateRoot = computeCanonicalEntityConsensusStateHash(honestNewState);
    const authorityRoot = computeEntityFrameAuthorityRoot(buildEntityFrameAuthority(honestNewState));
    const frameSignatures = hashesToSign.map(({ hash }) => signAccountFrame(env, signerId, hash));
    const replica = {
      entityId,
      signerId,
      entityEncPubKey: '',
      mempool: [],
      isProposer: false,
      state: makeEntityState(entityId),
    } as EntityReplica;
    replica.state.config = makeSingleSignerConfigFor(signerId);

    const result = await applyEntityInput(env, replica, {
      entityId,
      signerId,
      proposedFrame: {
        height: 1,
        parentFrameHash: 'genesis',
        stateRoot,
        authorityRoot,
        timestamp: env.state.timestamp,
        txs: frameTxs,
        events: [],
        hash: frameHash,
        leader: { proposerSignerId: signerId, view: 0 },
        hashesToSign,
        collectedSigs: new Map([[signerId, frameSignatures]]),
      },
    });
    expect(result.workingReplica.state.height).toBe(1);
    expect(result.workingReplica.state.profile.name).toBe('Signed Profile');
  });
});
