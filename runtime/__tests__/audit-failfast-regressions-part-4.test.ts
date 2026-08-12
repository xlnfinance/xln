import { describe, expect, spyOn, test } from 'bun:test';
import { createAccountConsensusContext } from '../entity/account/account-consensus-context';
import { sealAccountDraftAsEntity } from './helpers/account-draft';

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

import { resolveCertifiedAccountCounterpartyProposer } from '../runtime/routing/account-counterparty-route';

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
  ACCOUNT_PENDING_STALE_WARNING_MS,
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
import { buildCertifiedEntityOutputHashes } from '../entity/consensus/output/certification';

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

import { applyMergedEntityInputs, RuntimeEntityInputApplyError } from '../runtime/input-pipeline/entity-inputs';

import { MalformedEntityFrameInputError } from '../entity/tx/invariant-errors';

import { applyStorageChanges } from '../runtime/observability/env-events';

import { submitRuntimeJOutbox } from '../runtime/jurisdiction/j-submit';

import { registerStructuredLogSink } from '../infra/logger';

import { buildJSubmitAttemptId, registerPendingCommittedJOutbox } from '../runtime/jurisdiction/j-submit-state';

import { buffersEqual, safeStringify } from '../protocol/serialization';

import type { ProofBodyStruct } from '../protocol/dispute/proof-body';

import { hydrateAccountDocFromStorage, projectAccountDoc } from '../storage/read/projections';

import { validateStorageAccountDocValue } from '../storage/schema/authoritative-schema';

import { decodeValidatedBuffer, encodeBuffer } from '../storage/codec/codec';

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
} from '../runtime/delivery/entity-output-signer';

import { QUOTE_EXPIRY_MS } from '../types/finance/rebalance';

import type { AccountFrame, AccountInput, AccountReplica, AccountState, AccountTx } from '../types/account';
import type { ConsensusConfig, EntityInput, EntityReplica, EntityState, JurisdictionConfig } from '../entity/types';
import type { RuntimeReplica, RuntimeTx } from '../runtime/types';
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

describe('audit fail-fast regressions', () => {
  test('entity validator signs only the secondary hash manifest emitted by local replay', async () => {
    const seed = 'entity-validator-local-secondary-manifest seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.state.timestamp = 42_500;
    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    registerSignerKey(env, first.signerId, deriveSignerKeySync(seed, '1'));
    registerSignerKey(env, second.signerId, deriveSignerKeySync(seed, '2'));
    const entityId = generateLazyEntityId([first.signerId, second.signerId], 2n).toLowerCase();
    const config: ConsensusConfig = {
      ...makeSingleSignerConfigFor(first.signerId),
      threshold: 2n,
      validators: [first.signerId, second.signerId],
      shares: { [first.signerId]: 1n, [second.signerId]: 1n },
    };
    const collectiveTxs: EntityTx[] = [
      {
        type: 'profile-update',
        data: { profile: { entityId, name: 'Manifest Bound' } },
      } as any,
    ];
    const baseState = makeEntityState(entityId);
    baseState.config = config;
    const frameTxs = await buildQuorumAuthorizedFrameTxs(env, baseState, collectiveTxs);
    const { newState: replayedState, collectedHashes = [], outputs, events } = await applyEntityFrame(
      env,
      baseState,
      frameTxs,
      env.state.timestamp,
    );
    const leaderState = { activeValidatorId: first.signerId, view: 0, changedAtHeight: 0 };
    const frameHash = await createEntityFrameHash('genesis', 1, env.state.timestamp, frameTxs, {
      ...replayedState,
      entityId,
      height: 1,
      timestamp: env.state.timestamp,
      leaderState,
    });
    const localManifest = buildEntityHashesToSign(
      entityId,
      1,
      frameHash,
      [
        ...collectedHashes,
        ...buildCertifiedEntityOutputHashes(replayedState, env, 1, frameHash, outputs),
      ],
    );
    const stateRoot = computeCanonicalEntityConsensusStateHash({
      ...replayedState,
      entityId,
      height: 1,
      timestamp: env.state.timestamp,
      leaderState,
    });
    const authorityRoot = computeEntityFrameAuthorityRoot(
      buildEntityFrameAuthority({
        ...replayedState,
        entityId,
        height: 1,
        timestamp: env.state.timestamp,
        leaderState,
      }),
    );
    const attackerHash = ethers.keccak256(ethers.toUtf8Bytes('attacker-selected-dispute-hash'));
    const validatorReplica: EntityReplica = {
      entityId,
      signerId: second.signerId,
      entityEncPubKey: '',
      mempool: [],
      isProposer: false,
      state: baseState,
    };

    const invalidFrameHashResult = await applyEntityInput(env, validatorReplica, {
      entityId,
      signerId: second.signerId,
      proposedFrame: {
        height: 1,
        parentFrameHash: 'genesis',
        stateRoot,
        authorityRoot,
        timestamp: env.state.timestamp,
        txs: frameTxs,
        events: [],
        hash: ethers.keccak256(ethers.toUtf8Bytes('proposer-selected-invalid-frame-hash')),
        leader: { proposerSignerId: first.signerId, view: 0 },
        hashesToSign: localManifest,
      },
    });
    expect(invalidFrameHashResult.outcome).toEqual({
      kind: 'rejected',
      code: 'PROPOSAL_FRAME_HASH_MISMATCH',
    });
    expect(invalidFrameHashResult.outputs).toEqual([]);
    expect(invalidFrameHashResult.workingReplica.lockedFrame).toBeUndefined();

    const forgedProposalResult = await applyEntityInput(env, validatorReplica, {
      entityId,
      signerId: second.signerId,
      proposedFrame: {
        height: 1,
        timestamp: env.state.timestamp,
        txs: frameTxs,
        events: [],
        hash: frameHash,
        leader: { proposerSignerId: first.signerId, view: 0 },
        hashesToSign: [...localManifest, { hash: attackerHash, type: 'dispute', context: 'attacker-selected' }],
      },
    });

    expect(forgedProposalResult.outcome.kind).toBe('rejected');
    expect(forgedProposalResult.outputs).toEqual([]);
    expect(forgedProposalResult.workingReplica.lockedFrame).toBeUndefined();

    const proposerFrameSignature = signAccountFrame(env, first.signerId, frameHash);
    const honestProposal = {
      height: 1,
      parentFrameHash: 'genesis',
      stateRoot,
      authorityRoot,
      timestamp: env.state.timestamp,
      txs: frameTxs,
      events,
      hash: frameHash,
      leader: { proposerSignerId: first.signerId, view: 0 },
      hashesToSign: localManifest,
      collectedSigs: new Map([[first.signerId, [proposerFrameSignature]]]),
    };
    const precommitResult = await applyEntityInput(env, validatorReplica, {
      entityId,
      signerId: second.signerId,
      proposedFrame: honestProposal,
    });
    expect(precommitResult.outcome).toEqual({ kind: 'committed' });
    expect(precommitResult.outputs.some(
      output => output.hashPrecommitFrame?.frameHash === frameHash,
    )).toBe(true);
    const validatorPrecommitSignatures = localManifest.map(({ hash }) =>
      signAccountFrame(env, second.signerId, hash),
    );
    const precommitReplica: EntityReplica = {
      ...validatorReplica,
      lockedFrame: {
        ...honestProposal,
        hashesToSign: localManifest,
        collectedSigs: new Map([[second.signerId, validatorPrecommitSignatures]]),
      },
    };

    const signaturesBySigner = new Map([
      [first.signerId, localManifest.map(({ hash }) => signAccountFrame(env, first.signerId, hash))],
      [second.signerId, localManifest.map(({ hash }) => signAccountFrame(env, second.signerId, hash))],
    ]);
    const relabeledManifest = localManifest.map((entry, index) =>
      index === 0 ? { ...entry, type: 'accountFrame' as const, context: 'relabeled-after-precommit' } : entry,
    );
    const mutatedCommitResult = await applyEntityInput(env, precommitReplica, {
      entityId,
      signerId: second.signerId,
      proposedFrame: {
        ...honestProposal,
        hashesToSign: relabeledManifest,
        collectedSigs: signaturesBySigner,
      },
    });

    expect(mutatedCommitResult.outcome.kind).toBe('rejected');
    expect(mutatedCommitResult.workingReplica.state.height).toBe(0);

    env.runtimeId = `0x${'71'.repeat(20)}`;
    env.infrastructure ??= {};
    env.infrastructure.entityRuntimeHints = new Map();
    env.state.eReplicas.set(`${entityId}:${second.signerId}`, precommitReplica);
    const remoteEntityId = `0x${'72'.repeat(32)}`;
    const lockedMempoolSize = precommitReplica.mempool.length;
    const mergedResult = await applyMergedEntityInputs(
      env,
      [
        {
          from: `0x${'73'.repeat(20)}`,
          entityId,
          signerId: second.signerId,
          entityTxs: [
            {
              type: 'accountInput',
              data: { fromEntityId: remoteEntityId, toEntityId: entityId },
            } as never,
          ],
          proposedFrame: {
            ...honestProposal,
            hash: ethers.keccak256(ethers.toUtf8Bytes('commit-does-not-match-validator-lock')),
            collectedSigs: signaturesBySigner,
          },
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
          resolveSoleLocalSignerForEntity: () => second.signerId,
          getP2P: () => null,
        },
      },
    );

    expect(mergedResult.appliedEntityInputs).toEqual([]);
    expect(env.state.eReplicas.get(`${entityId}:${second.signerId}`)?.mempool).toHaveLength(lockedMempoolSize);
    expect(env.infrastructure.entityRuntimeHints.has(remoteEntityId)).toBe(false);
  });

  test('entity catch-up commit rejects a secondary hash not emitted by local replay', async () => {
    const seed = 'entity-commit-secondary-signature-binding seed alpha beta gamma';
    const env = createEmptyEnv(seed);
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    env.state.timestamp = 43_000;
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
    const { newState: honestFrameState } = await applyEntityFrame(env, honestBaseState, frameTxs, env.state.timestamp);
    const honestNewState: EntityState = {
      ...honestFrameState,
      entityId,
      height: 1,
      timestamp: env.state.timestamp,
    };
    const frameHash = await createEntityFrameHash('genesis', 1, env.state.timestamp, frameTxs, honestNewState);
    const secondaryHash = ethers.keccak256(ethers.toUtf8Bytes('account-frame-secondary-hash'));
    const frameSig = signAccountFrame(env, signerId, frameHash);
    const secondarySig = signAccountFrame(env, signerId, secondaryHash);
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
        timestamp: env.state.timestamp,
        txs: frameTxs,
        hash: frameHash,
        leader: { proposerSignerId: signerId, view: 0 },
        hashesToSign: [
          { hash: frameHash, type: 'entityFrame', context: 'entity-frame' },
          { hash: secondaryHash, type: 'accountFrame', context: 'account-frame' },
        ],
        collectedSigs: new Map([[signerId, [frameSig, secondarySig]]]),
      },
    });

    expect(result.workingReplica.state.height).toBe(0);
    expect(result.workingReplica.state.profile.name).not.toBe('Signed Profile');
  });

  test('swap_offer refuses to add more than the configured per-account cap', async () => {
    const accountMachine = {
      state: {
        leftEntity: 'left',
        rightEntity: 'right',
        deltas: new Map(),
        swapOffers: new Map(Array.from({ length: LIMITS.MAX_ACCOUNT_SWAP_OFFERS }, (_, index) => [String(index), {}])),
      },
    };

    const result = await handleSwapOffer(
      accountMachine as Parameters<typeof handleSwapOffer>[0],
      {
        type: 'swap_offer',
        data: {
          offerId: 'overflow-offer',
          giveTokenId: 1,
          giveAmount: 100n,
          wantTokenId: 2,
          wantAmount: 100n,
        },
      },
      true,
      1,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain(`max ${LIMITS.MAX_ACCOUNT_SWAP_OFFERS}`);
    expect(accountMachine.state.swapOffers.size).toBe(LIMITS.MAX_ACCOUNT_SWAP_OFFERS);
  });

  test('proposeAccountFrame accepts a 1000 tx account frame', async () => {
    const seed = 'account-frame-cap-seed';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.state.timestamp = 1_000;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const mempool = Array.from({ length: MAX_ACCOUNT_FRAME_TXS }, () => ({
      type: 'add_delta' as const,
      // Exercise the 1000-tx frame cap without manufacturing a ProofBody that
      // the jurisdiction rejects (>128 distinct token rows). add_delta is
      // intentionally idempotent, so every tx still replays deterministically.
      data: { tokenId: 1 },
    }));
    const accountMachine = makeProposalAccount(mempool, left.entityId, right.entityId);
    attachSigningReplica(env, accountMachine.proofHeader.fromEntity, left.signerId);

    const result = await proposeAccountFrame(createAccountConsensusContext(env), accountMachine, env.state.timestamp);

    expect(result.success).toBe(true);
    expect(result.accountInput?.proposal.frame.accountTxs).toHaveLength(MAX_ACCOUNT_FRAME_TXS);
    expect(accountMachine.pendingFrame?.accountTxs).toHaveLength(MAX_ACCOUNT_FRAME_TXS);
    expect(accountMachine.mempool).toHaveLength(0);
  });

  test('proposeAccountFrame bundles the last outbound ACK into the next frame for loss recovery', async () => {
    const seed = 'account-frame-ack-loss-recovery';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.state.timestamp = 1_000;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const accountMachine = makeProposalAccount(
      [{ type: 'add_delta', data: { tokenId: 1 } }],
      left.entityId,
      right.entityId,
    );
    accountMachine.currentHeight = 10;
    accountMachine.currentFrame = {
      ...accountMachine.currentFrame,
      height: 10,
      stateHash: `0x${'ab'.repeat(32)}`,
    };
    accountMachine.lastOutboundFrameAck = {
      height: 10,
      counterpartyEntityId: right.entityId,
      response: {
        kind: 'ack',
        fromEntityId: left.entityId,
        toEntityId: right.entityId,
        domain: { ...accountMachine.state.domain },
        disputeConfig: { ...accountMachine.state.disputeConfig },
        ack: {
          height: 10,
          frameHash: accountMachine.currentFrame.stateHash,
          frameHanko: `0x${'cd'.repeat(65)}`,
        },
      },
    };
    attachSigningReplica(env, accountMachine.proofHeader.fromEntity, left.signerId);

    const result = await proposeAccountFrame(createAccountConsensusContext(env), accountMachine, env.state.timestamp);

    expect(result.success).toBe(true);
    expect(result.accountInput?.kind).toBe('frame_ack');
    expect(result.accountInput?.kind === 'frame_ack' ? result.accountInput.ack.height : undefined).toBe(10);
    expect(result.accountInput?.kind === 'frame_ack' ? result.accountInput.ack.frameHanko : undefined).toBe(
      accountMachine.lastOutboundFrameAck?.response.ack.frameHanko,
    );
    expect(result.accountInput?.proposal.frame.height).toBe(11);
    expect(accountMachine.pendingAccountInput?.kind).toBe('frame_ack');
  });

  test('credit-limit-only frame reuses unchanged on-chain dispute proof', async () => {
    const seed = 'account-credit-limit-reuses-proof';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.state.timestamp = 1_000;
    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const accountMachine = makeProposalAccount(
      [{ type: 'set_credit_limit', data: { tokenId: 1, amount: 100n } }],
      left.entityId,
      right.entityId,
    );
    accountMachine.state.deltas.set(1, createDefaultDelta(1));
    accountMachine.currentDisputeProofBodyHash = buildAccountProofBody(accountMachine, '').proofBodyHash;
    accountMachine.currentDisputeProofNonce = 1;
    accountMachine.currentDisputeProofProposerIsLeft = true;
    accountMachine.state.jNonce = 0;
    accountMachine.currentDisputeHash = createDisputeProofHashWithNonce(
      accountMachine.state,
      accountMachine.currentDisputeProofBodyHash,
      { chainId: 31337, depositoryAddress: hex20('dd') },
      1,
      true,
    );
    accountMachine.currentDisputeProofHanko = '0xcafe';
    const nonceBefore = accountMachine.proofHeader.nextProofNonce;
    attachSigningReplica(env, left.entityId, left.signerId);

    const result = await proposeAccountFrame(createAccountConsensusContext(env), accountMachine, env.state.timestamp);

    expect(result.success).toBe(true);
    expect(result.accountInput?.kind === 'frame' ? result.accountInput.proposal.disputeSeal : undefined).toEqual({
      hanko: '0xcafe',
      hash: accountMachine.currentDisputeHash,
      proofBodyHash: accountMachine.currentDisputeProofBodyHash,
      proofNonce: 1,
      proposerIsLeft: true,
    });
    expect(accountMachine.proofHeader.nextProofNonce).toBe(nonceBefore);
  });

  test('consumed dispute proof nonce opens a fresh persisted evidence epoch', async () => {
    const seed = 'account-consumed-proof-opens-evidence-epoch';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.state.timestamp = 1_000;
    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const accountMachine = makeProposalAccount(
      [{ type: 'set_credit_limit', data: { tokenId: 1, amount: 100n } }],
      left.entityId,
      right.entityId,
    );
    accountMachine.state.deltas.set(1, createDefaultDelta(1));
    const proof = buildAccountProofBody(accountMachine, '');
    accountMachine.currentDisputeProofBodyHash = proof.proofBodyHash;
    accountMachine.currentDisputeProofNonce = 7;
    accountMachine.state.jNonce = 8;
    accountMachine.disputeProofBodiesByHash = undefined;
    accountMachine.disputeProofNoncesByHash = undefined;
    accountMachine.disputeArgumentSnapshotsByHash = undefined;
    attachSigningReplica(env, left.entityId, left.signerId);

    const result = await proposeAccountFrame(createAccountConsensusContext(env), accountMachine, env.state.timestamp);

    expect(result.success).toBe(true);
    expect(result.accountInput?.kind === 'frame' ? result.accountInput.proposal.disputeSeal : undefined).toMatchObject({
      proofBodyHash: proof.proofBodyHash,
      proofNonce: 9,
    });
    expect(Object.keys(accountMachine.disputeProofBodiesByHash ?? {})).toEqual([proof.proofBodyHash]);
    expect(accountMachine.disputeProofNoncesByHash).toEqual({ [proof.proofBodyHash]: 9 });
    expect(Object.keys(accountMachine.disputeArgumentSnapshotsByHash ?? {})).toEqual([proof.proofBodyHash]);
    const persisted = hydrateAccountDocFromStorage(structuredClone(projectAccountDoc(accountMachine)));
    expect(Object.keys(persisted.disputeProofBodiesByHash ?? {})).toEqual([proof.proofBodyHash]);
    expect(persisted.disputeProofNoncesByHash).toEqual({ [proof.proofBodyHash]: 9 });
    expect(Object.keys(persisted.disputeArgumentSnapshotsByHash ?? {})).toEqual([proof.proofBodyHash]);
  });

  test('account frame property matrix preserves explicit zero jHeight through receive, replay, and ACK commit', async () => {
    const propertyCases = [1, 10, 100].flatMap(accountHeight =>
      [3, 11, 101].flatMap(finalizedJHeight =>
        [1, 2, 11].map(revealMargin => ({
          accountHeight,
          finalizedJHeight,
          revealBeforeHeight: finalizedJHeight + revealMargin,
          revealMargin,
        })),
      ),
    );
    for (const { accountHeight, finalizedJHeight, revealBeforeHeight, revealMargin } of propertyCases) {
      const seed = `account-frame-zero-jheight-${accountHeight}-${finalizedJHeight}-${revealBeforeHeight}`;
      const env = createEmptyEnv(seed);
      env.quietRuntimeLogs = true;
      env.state.timestamp = 10_000;

      const first = registerLazySigner(seed, '1');
      const second = registerLazySigner(seed, '2');
      const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
      const right = left === first ? second : first;
      attachSigningReplica(env, left.entityId, left.signerId);
      attachSigningReplica(env, right.entityId, right.signerId);

      const makeFundedDelta = () => ({
        ...createDefaultDelta(1),
        leftCreditLimit: 10n,
      });
      const lockId = `zero-jheight-lock-${accountHeight}-${revealBeforeHeight}`;
      const htlcTx: AccountTx = {
        type: 'htlc_lock',
        data: {
          lockId,
          hashlock: `0x${'31'.repeat(32)}`,
          timelock: BigInt(env.state.timestamp + 60_000),
          revealBeforeHeight,
          amount: 1n,
          tokenId: 1,
        },
      };
      const previousStateHash = `0x${'ab'.repeat(32)}`;
      const proposerAccount = makeProposalAccount([htlcTx], left.entityId, right.entityId);
      proposerAccount.state.lastFinalizedJHeight = finalizedJHeight;
      proposerAccount.currentHeight = accountHeight;
      proposerAccount.currentFrame = {
        ...proposerAccount.currentFrame,
        height: accountHeight,
        timestamp: env.state.timestamp - 1,
        stateHash: previousStateHash,
      };
      proposerAccount.state.deltas.set(1, makeFundedDelta());

      const proposed = await proposeAccountFrame(createAccountConsensusContext(env), proposerAccount, env.state.timestamp, 0);
      if (!proposed.success) throw new Error(`ZERO_JHEIGHT_PROPOSAL_FAILED:${proposed.error}`);
      expect(proposed.success).toBe(true);
      expect(proposed.accountInput?.proposal.frame.jHeight).toBe(0);
      const sealedProposal = await sealAccountDraftAsEntity(
        env,
        left.entityId,
        left.signerId,
        proposed,
      );

      const receiverAccount = makeProposalAccount([], left.entityId, right.entityId);
      receiverAccount.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };
      receiverAccount.state.lastFinalizedJHeight = finalizedJHeight;
      receiverAccount.currentHeight = accountHeight;
      receiverAccount.currentFrame = {
        ...receiverAccount.currentFrame,
        height: accountHeight,
        timestamp: env.state.timestamp - 1,
        stateHash: previousStateHash,
      };
      receiverAccount.state.deltas.set(1, makeFundedDelta());
      const replayedReceiverAccount = hydrateAccountDocFromStorage(structuredClone(projectAccountDoc(receiverAccount)));

      const result = await applyAccountInput(createAccountConsensusContext(env), receiverAccount, sealedProposal);
      const replayResult = await applyAccountInput(createAccountConsensusContext(env), replayedReceiverAccount, sealedProposal);

      if (!result.success) throw new Error(`ZERO_JHEIGHT_RECEIVE_FAILED:${result.error}`);
      if (!replayResult.success) throw new Error(`ZERO_JHEIGHT_REPLAY_FAILED:${replayResult.error}`);
      expect(replayResult.success).toBe(true);
      expect(receiverAccount.currentHeight).toBe(accountHeight + 1);
      expect(receiverAccount.currentFrame.jHeight).toBe(0);
      expect(receiverAccount.state.locks.has(lockId)).toBe(true);
      expect(safeStringify(projectAccountDoc(replayedReceiverAccount))).toBe(
        safeStringify(projectAccountDoc(receiverAccount)),
      );
      expect(replayResult.response).toEqual(result.response);

      if (!result.response) throw new Error('ZERO_JHEIGHT_ACK_MISSING');
      const sealedResponse = await sealAccountDraftAsEntity(
        env,
        right.entityId,
        right.signerId,
        { accountInput: result.response, hashesToSign: result.hashesToSign },
      );
      if (accountHeight === 1 && finalizedJHeight === 3 && revealMargin === 1) {
        const tamperedResponse = structuredClone(sealedResponse);
        if (tamperedResponse.kind !== 'ack' && tamperedResponse.kind !== 'frame_ack') {
          throw new Error('ZERO_JHEIGHT_ACK_KIND_INVALID');
        }
        tamperedResponse.ack.frameHash = `0x${'ff'.repeat(32)}`;
        const tamperedResult = await applyAccountInput(createAccountConsensusContext(env), structuredClone(proposerAccount), tamperedResponse);
        expect(tamperedResult.success).toBe(false);
        expect(tamperedResult.error).toContain('ACK frameHash mismatch');
      }
      const ackResult = await applyAccountInput(createAccountConsensusContext(env), proposerAccount, sealedResponse);
      expect(ackResult.success).toBe(true);
      expect(proposerAccount.currentHeight).toBe(accountHeight + 1);
      expect(proposerAccount.currentFrame.jHeight).toBe(0);
      expect(proposerAccount.currentFrame.stateHash).toBe(receiverAccount.currentFrame.stateHash);
      expect(proposerAccount.state.locks.has(lockId)).toBe(true);
    }
  }, 15_000);

  test('account storage keeps last outbound ACK so restored runtimes can bundle the next frame', () => {
    const accountMachine = makeProposalAccount([], hex20('11'), hex20('22'));
    accountMachine.lastOutboundFrameAck = {
      height: 8,
      counterpartyEntityId: hex20('22'),
      response: {
        kind: 'ack',
        fromEntityId: hex20('11'),
        toEntityId: hex20('22'),
        ack: { height: 8, frameHash: `0x${'08'.repeat(32)}`, frameHanko: `0x${'aa'.repeat(65)}` },
      },
    };
    accountMachine.hankoSignature = `0x${'bb'.repeat(65)}`;
    accountMachine.pendingForwards = [
      {
        route: [hex20('33'), hex20('44')],
        tokenId: 1,
        amount: 123n,
        description: 'pending-forward-storage',
      },
    ];

    const doc = projectAccountDoc(accountMachine);

    expect(doc.lastOutboundFrameAck).toEqual(accountMachine.lastOutboundFrameAck);
    expect(doc.hankoSignature).toBe(accountMachine.hankoSignature);
    expect(doc.pendingForwards).toEqual(accountMachine.pendingForwards);
  });

  test('crontab resends bundled ACK plus pending frame after relay loss', async () => {
    const env = createEmptyEnv('account-frame-bundled-resend');
    env.quietRuntimeLogs = true;
    const replica = makeReplicaMissingPrevFrameHash();
    replica.state.timestamp = 100_000;
    const counterpartyId = hex20('22');
    const counterpartySignerId = hex20('23');
    env.gossip = {
      getProfiles: () => [
        {
          entityId: counterpartyId,
          metadata: {
            board: {
              validators: [{ signerId: counterpartySignerId }],
            },
          },
        },
      ],
    } as RuntimeReplica['gossip'];
    const pendingFrame = {
      height: 11,
      timestamp: replica.state.timestamp - ACCOUNT_PENDING_RESEND_AFTER_MS - 1,
      jHeight: 0,
      accountTxs: [{ type: 'add_delta' as const, data: { tokenId: 1 } }],
      prevFrameHash: `0x${'ab'.repeat(32)}`,
      accountStateRoot: `0x${'00'.repeat(32)}`,
      deltas: [],
      stateHash: `0x${'cd'.repeat(32)}`,
      byLeft: true,
    };
    const accountMachine = makeProposalAccount([], replica.entityId, counterpartyId);
    accountMachine.pendingFrame = pendingFrame;
    accountMachine.pendingAccountInput = {
      kind: 'frame_ack',
      fromEntityId: replica.entityId,
      toEntityId: counterpartyId,
      ack: { height: 10, frameHash: pendingFrame.prevFrameHash, frameHanko: `0x${'12'.repeat(65)}` },
      proposal: { frame: pendingFrame, frameHanko: `0x${'34'.repeat(65)}` },
    };
    replica.state.accounts.set(counterpartyId, accountMachine);

    const outputs = await executeCrontab(env, replica, replica.state.crontabState!, {
      manualBroadcastInInput: false,
      accountChanges: new Set(),
    });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.entityId).toBe(counterpartyId);
    expect(outputs[0]?.signerId).toBeUndefined();
    expect(outputs[0]?.entityTxs).toEqual([{ type: 'accountInput', data: accountMachine.pendingAccountInput }]);
  });

  test('expired HTLC never rolls back its signed pending Account frame', async () => {
    const env = createEmptyEnv('pending-htlc-exact-timelock');
    env.quietRuntimeLogs = true;
    const replica = makeReplicaMissingPrevFrameHash();
    replica.state.timestamp = 100_000;
    const counterpartyId = hex20('22');
    const accountMachine = makeProposalAccount([], replica.entityId, counterpartyId);
    accountMachine.pendingFrame = {
      height: 11,
      timestamp: 90_000,
      jHeight: 0,
      accountTxs: [
        {
          type: 'htlc_lock',
          data: {
            lockId: `0x${'45'.repeat(32)}`,
            hashlock: `0x${'46'.repeat(32)}`,
            timelock: 100_000n,
            revealBeforeHeight: 100,
            amount: 1n,
            tokenId: 1,
          },
        },
      ],
      prevFrameHash: `0x${'ab'.repeat(32)}`,
      accountStateRoot: `0x${'00'.repeat(32)}`,
      deltas: [],
      stateHash: `0x${'cd'.repeat(32)}`,
      byLeft: true,
    };
    replica.state.accounts.set(counterpartyId, accountMachine);
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const outputs = await executeCrontab(env, replica, replica.state.crontabState!, {
        manualBroadcastInInput: false,
        accountChanges: new Set(),
      });
      expect(outputs).toEqual([]);
      expect(accountMachine.pendingFrame?.height).toBe(11);
      expect(accountMachine.pendingFrame?.accountTxs[0]?.type).toBe('htlc_lock');
    } finally {
      warning.mockRestore();
    }
  });

  test('restored Account resolves its counterparty proposer from the certified frame Hanko without gossip', async () => {
    const counterpartySeed = 'account-certified-counterparty-route';
    const counterpartySignerId = deriveSignerAddressSync(counterpartySeed, '1').toLowerCase();
    const counterpartyId = generateLazyEntityId([counterpartySignerId], 1n).toLowerCase();
    const localEntityId = `0x${'24'.repeat(32)}`;
    const account = makeProposalAccount([], localEntityId, counterpartyId);
    const frameHash = `0x${'bc'.repeat(32)}`;
    account.currentHeight = 1;
    account.currentFrame = {
      ...account.currentFrame,
      height: 1,
      stateHash: frameHash,
      accountStateRoot: frameHash,
    };
    account.counterpartyFrameHanko = signedHankoForTest(
      frameHash,
      [deriveSignerKeySync(counterpartySeed, '1')],
      [],
      [[counterpartyId, [0n], [1n], 1n]],
    );
    const env = createEmptyEnv('account-certified-counterparty-route-local');

    expect(() => resolveEntityProposerId(env, counterpartyId, 'legacy-gossip-route')).toThrow(
      'SIGNER_RESOLUTION_FAILED',
    );
    expect(await resolveCertifiedAccountCounterpartyProposer(env, account, counterpartyId)).toBe(counterpartySignerId);
  });

  test('crontab resends a restored pending frame without persisting transport routing', async () => {
    const env = createEmptyEnv('account-frame-restored-resend');
    env.quietRuntimeLogs = true;
    const replica = makeReplicaMissingPrevFrameHash();
    replica.state.timestamp = 100_000;
    const counterpartyId = `0x${'25'.repeat(32)}`;
    const counterpartySignerId = hex20('26');
    const pendingFrame = {
      height: 11,
      timestamp: replica.state.timestamp - ACCOUNT_PENDING_RESEND_AFTER_MS - 1,
      jHeight: 0,
      accountTxs: [{ type: 'add_delta' as const, data: { tokenId: 1 } }],
      prevFrameHash: '',
      accountStateRoot: `0x${'00'.repeat(32)}`,
      deltas: [],
      stateHash: '',
      byLeft: true,
    };
    const accountMachine = makeProposalAccount([], replica.entityId, counterpartyId);
    accountMachine.currentHeight = 10;
    const committedFrame = {
      ...accountMachine.currentFrame,
      height: 10,
      timestamp: pendingFrame.timestamp - 1,
      prevFrameHash: `0x${'aa'.repeat(32)}`,
      stateHash: '',
      byLeft: true,
    };
    committedFrame.stateHash = await createFrameHash(committedFrame);
    pendingFrame.prevFrameHash = committedFrame.stateHash;
    pendingFrame.stateHash = await createFrameHash(pendingFrame);
    accountMachine.currentFrame = committedFrame;
    accountMachine.pendingFrame = pendingFrame;
    accountMachine.pendingAccountInput = {
      kind: 'frame',
      fromEntityId: replica.entityId,
      toEntityId: counterpartyId,
      domain: structuredClone(accountMachine.state.domain),
      proposal: { frame: pendingFrame, frameHanko: `0x${'34'.repeat(65)}` },
    };
    const persistedAccount = projectAccountDoc(accountMachine);
    const restoredAccount = hydrateAccountDocFromStorage(
      decodeValidatedBuffer(encodeBuffer(persistedAccount), validateStorageAccountDocValue),
    );
    const corruptFrameBinding = projectAccountDoc(accountMachine);
    if (!corruptFrameBinding.pendingAccountInput || corruptFrameBinding.pendingAccountInput.kind !== 'frame') {
      throw new Error('TEST_PENDING_ACCOUNT_INPUT_REQUIRED');
    }
    corruptFrameBinding.pendingAccountInput.proposal.frame.stateHash = `0x${'ff'.repeat(32)}`;
    expect(() => decodeValidatedBuffer(encodeBuffer(corruptFrameBinding), validateStorageAccountDocValue)).toThrow(
      'pendingAccountInput proposal must exactly match pendingFrame',
    );
    const corruptEndpointBinding = projectAccountDoc(accountMachine);
    if (!corruptEndpointBinding.pendingAccountInput) throw new Error('TEST_PENDING_ACCOUNT_INPUT_REQUIRED');
    corruptEndpointBinding.pendingAccountInput.fromEntityId = `0x${'ee'.repeat(32)}`;
    expect(() => decodeValidatedBuffer(encodeBuffer(corruptEndpointBinding), validateStorageAccountDocValue)).toThrow(
      'pendingAccountInput endpoints must match proofHeader',
    );
    const corruptDomainBinding = projectAccountDoc(accountMachine);
    if (!corruptDomainBinding.pendingAccountInput) throw new Error('TEST_PENDING_ACCOUNT_INPUT_REQUIRED');
    corruptDomainBinding.pendingAccountInput.domain = {
      ...corruptDomainBinding.pendingAccountInput.domain,
      chainId: 1,
    };
    expect(() => decodeValidatedBuffer(encodeBuffer(corruptDomainBinding), validateStorageAccountDocValue)).toThrow(
      'pendingAccountInput domain must match Account domain',
    );
    replica.state.accounts.set(counterpartyId, restoredAccount);
    const outputs = await executeCrontab(env, replica, replica.state.crontabState!, {
      manualBroadcastInInput: false,
      accountChanges: new Set(),
    });

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.entityId).toBe(counterpartyId);
    expect(outputs[0]?.signerId).toBeUndefined();
    expect(outputs[0]?.entityTxs).toEqual([{ type: 'accountInput', data: restoredAccount.pendingAccountInput }]);
  });

  test('pending-frame liveness warning is evaluated from committed post-frame state', () => {
    const replica = makeReplicaMissingPrevFrameHash();
    replica.state.timestamp = 100_000;
    const counterpartyId = hex20('24');
    const account = makeProposalAccount([], replica.entityId, counterpartyId);
    account.pendingFrame = {
      height: 11,
      timestamp: replica.state.timestamp - ACCOUNT_PENDING_STALE_WARNING_MS - 1,
      jHeight: 0,
      accountTxs: [{ type: 'add_delta', data: { tokenId: 1 } }],
      prevFrameHash: `0x${'ab'.repeat(32)}`,
      accountStateRoot: `0x${'00'.repeat(32)}`,
      deltas: [],
      stateHash: `0x${'cd'.repeat(32)}`,
      byLeft: true,
    };
    replica.state.accounts.set(counterpartyId, account);
    const previousState = structuredClone(replica.state);
    const committedPending = structuredClone(replica.state);
    committedPending.crontabState!.tasks.get('maintainPendingAccounts')!.lastRun = committedPending.timestamp;
    const committedAcked = structuredClone(committedPending);
    delete committedAcked.accounts.get(counterpartyId)!.pendingFrame;
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      emitCommittedPendingFrameWarnings(previousState, committedPending);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('PENDING-FRAME-STALE'));
      warning.mockClear();

      emitCommittedPendingFrameWarnings(previousState, committedAcked);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  test('applyAccountInput re-acks duplicate committed frames when the original ACK was lost', async () => {
    const seed = 'account-frame-duplicate-reack';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const accountMachine = makeProposalAccount([], left.entityId, right.entityId);
    accountMachine.currentHeight = 10;
    accountMachine.currentFrame = {
      ...accountMachine.currentFrame,
      height: 10,
      stateHash: `0x${'ef'.repeat(32)}`,
    };
    accountMachine.lastOutboundFrameAck = {
      height: 10,
      counterpartyEntityId: right.entityId,
      response: {
        kind: 'ack',
        fromEntityId: left.entityId,
        toEntityId: right.entityId,
        ack: {
          height: 10,
          frameHash: accountMachine.currentFrame.stateHash,
          frameHanko: `0x${'12'.repeat(65)}`,
          disputeSeal: {
            hanko: `0x${'13'.repeat(65)}`,
            hash: `0x${'14'.repeat(32)}`,
            proofBodyHash: `0x${'15'.repeat(32)}`,
            proofNonce: 7,
          },
        },
      },
    };

    const result = await applyAccountInput(createAccountConsensusContext(env), accountMachine, {
      kind: 'frame',
      fromEntityId: right.entityId,
      toEntityId: left.entityId,
      domain: { ...accountMachine.state.domain },
      disputeConfig: { ...accountMachine.state.disputeConfig },
      signerId: right.signerId,
      proposal: {
        frame: {
          ...accountMachine.currentFrame,
          prevFrameHash: `0x${'34'.repeat(32)}`,
        },
        frameHanko: `0x${'56'.repeat(65)}`,
      },
    });

    expect(result.success).toBe(true);
    expect(result.response?.kind).toBe('ack');
    expect(result.response?.kind === 'ack' ? result.response.ack.height : undefined).toBe(10);
    expect(result.response).toEqual(accountMachine.lastOutboundFrameAck.response);
  });

  test('Entity flush batches ACK and successor without mutating live Entity replicas', async () => {
    const seed = 'account-frame-bundled-proposal-lost';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.state.timestamp = 10_000;

    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);
    const liveHubTasks = [left, right].map(({ entityId, signerId }) => {
      const task = env.state.eReplicas.get(`${entityId}:${signerId}`)?.state.crontabState?.tasks.get('hubRebalance');
      if (!task) throw new Error(`TEST_HUB_REBALANCE_TASK_MISSING:${entityId}`);
      task.lastRun = 500;
      return task;
    });

    const proposer = makeProposalAccount([{ type: 'add_delta', data: { tokenId: 1 } }], left.entityId, right.entityId);
    const receiver = makeProposalAccount([{ type: 'add_delta', data: { tokenId: 2 } }], left.entityId, right.entityId);
    receiver.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };

    const proposed = await proposeAccountFrame(createAccountConsensusContext(env), proposer, env.state.timestamp);
    if (!proposed.success || !proposed.accountInput) {
      throw new Error(`BUNDLED_ACK_SOURCE_PROPOSAL_FAILED:${proposed.error ?? 'missing input'}`);
    }
    const sealedProposal = await sealAccountDraftAsEntity(
      env,
      left.entityId,
      left.signerId,
      proposed,
    );
    const accepted = await applyAccountInput(createAccountConsensusContext(env), receiver, sealedProposal);

    expect(accepted.success).toBe(true);
    expect(accepted.response?.kind).toBe('ack');
    expect(receiver.currentHeight).toBe(1);
    expect(receiver.pendingFrame).toBeUndefined();
    expect(receiver.lastOutboundFrameAck?.height).toBe(1);
    expect(liveHubTasks.map(task => task.lastRun)).toEqual([500, 500]);
    const flushed = await proposeAccountFrame(createAccountConsensusContext(env), receiver, env.state.timestamp);
    if (!flushed.success || flushed.accountInput?.kind !== 'frame_ack') {
      throw new Error('ENTITY_FLUSHED_ACK_RESPONSE_MISSING');
    }
    const sealedFlushed = await sealAccountDraftAsEntity(
      env,
      right.entityId,
      right.signerId,
      {
        accountInput: flushed.accountInput,
        hashesToSign: [...(accepted.hashesToSign ?? []), ...(flushed.hashesToSign ?? [])],
      },
    );
    if (sealedFlushed.kind !== 'frame_ack') throw new Error('ENTITY_FLUSHED_ACK_FRAME_REQUIRED');
    const proposalSeal = sealedFlushed.proposal.disputeSeal;
    const ackSeal = sealedFlushed.ack.disputeSeal;
    expect(ackSeal).toBeDefined();
    expect(proposalSeal).toBeDefined();
    expect([...(accepted.hashesToSign ?? []), ...(flushed.hashesToSign ?? [])]).toEqual(
      expect.arrayContaining([
        {
          hash: sealedProposal.proposal.frame.stateHash,
          type: 'accountFrame',
          context: `account:${left.entityId.slice(-8)}:ack:1`,
        },
        {
          hash: ackSeal!.hash,
          type: 'dispute',
          context: `account:${left.entityId.slice(-8)}:ack-dispute`,
        },
        {
          hash: sealedFlushed.proposal.frame.stateHash,
          type: 'accountFrame',
          context: expect.stringContaining(':frame:2'),
        },
        {
          hash: proposalSeal!.hash,
          type: 'dispute',
          context: expect.stringContaining(':dispute'),
        },
      ]),
    );
    expect(
      new Set([...(accepted.hashesToSign ?? []), ...(flushed.hashesToSign ?? [])].map(({ hash }) => hash)).size,
    ).toBe(4);
    const committedBundled = await applyAccountInput(createAccountConsensusContext(env), proposer, sealedFlushed);
    expect(committedBundled.success).toBe(true);
    expect(liveHubTasks.map(task => task.lastRun)).toEqual([500, 500]);
    expect(proposer.currentHeight).toBe(2);
    expect(proposer.counterpartyDisputeProofBodyHash).toBe(proposalSeal?.proofBodyHash);
    expect(proposer.counterpartyDisputeProofHanko).toBe(proposalSeal?.hanko);
    const retainedAck = structuredClone(receiver.lastOutboundFrameAck?.response);

    // The new proposal can be discarded independently (for example by the
    // simultaneous-frame tiebreaker). The ACK for committed height 1 remains.
    delete receiver.pendingFrame;
    delete receiver.pendingAccountInput;
    const retried = await applyAccountInput(createAccountConsensusContext(env), receiver, sealedProposal);

    expect(retried.success).toBe(true);
    expect(retried.response).toEqual(retainedAck);
    expect(retried.response?.kind).toBe('ack');
    expect(receiver.currentHeight).toBe(1);
  });

  test('applyAccountInput re-sends bundled ACK plus frame when that response was lost', async () => {
    const seed = 'account-frame-duplicate-bundled-response';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const accountMachine = makeProposalAccount([], left.entityId, right.entityId);
    accountMachine.currentHeight = 10;
    accountMachine.currentFrame = {
      ...accountMachine.currentFrame,
      height: 10,
      stateHash: `0x${'ef'.repeat(32)}`,
    };
    const pendingFrame = {
      ...accountMachine.currentFrame,
      height: 11,
      prevFrameHash: accountMachine.currentFrame.stateHash,
      stateHash: `0x${'ab'.repeat(32)}`,
    };
    accountMachine.pendingFrame = pendingFrame;
    accountMachine.pendingAccountInput = {
      kind: 'frame_ack',
      fromEntityId: left.entityId,
      toEntityId: right.entityId,
      domain: { ...accountMachine.state.domain },
      disputeConfig: { ...accountMachine.state.disputeConfig },
      ack: {
        height: 10,
        frameHash: accountMachine.currentFrame.stateHash,
        frameHanko: `0x${'12'.repeat(65)}`,
      },
      proposal: { frame: pendingFrame, frameHanko: `0x${'34'.repeat(65)}` },
    };
    delete accountMachine.lastOutboundFrameAck;

    const result = await applyAccountInput(createAccountConsensusContext(env), accountMachine, {
      kind: 'frame',
      fromEntityId: right.entityId,
      toEntityId: left.entityId,
      domain: { ...accountMachine.state.domain },
      signerId: right.signerId,
      disputeConfig: { ...accountMachine.state.disputeConfig },
      proposal: {
        frame: {
          ...accountMachine.currentFrame,
          prevFrameHash: `0x${'56'.repeat(32)}`,
        },
        frameHanko: `0x${'78'.repeat(65)}`,
      },
    });

    expect(result.success).toBe(true);
    expect(result.response).toEqual(accountMachine.pendingAccountInput);
    expect(result.response?.kind).toBe('frame_ack');
    expect(accountMachine.currentHeight).toBe(10);
    expect(accountMachine.pendingFrame?.height).toBe(11);
  });

  test('applyAccountInput fails loud when the full duplicate ACK cache was lost', async () => {
    const seed = 'account-frame-duplicate-reack-cache-miss';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    attachSigningReplica(env, left.entityId, left.signerId);
    const accountMachine = makeProposalAccount([], left.entityId, right.entityId);
    accountMachine.currentHeight = 10;
    accountMachine.currentFrame = {
      ...accountMachine.currentFrame,
      height: 10,
      stateHash: `0x${'ef'.repeat(32)}`,
    };
    delete accountMachine.lastOutboundFrameAck;

    const result = await applyAccountInput(createAccountConsensusContext(env), accountMachine, {
      kind: 'frame',
      fromEntityId: right.entityId,
      toEntityId: left.entityId,
      domain: { ...accountMachine.state.domain },
      signerId: right.signerId,
      disputeConfig: { ...accountMachine.state.disputeConfig },
      proposal: {
        frame: {
          ...accountMachine.currentFrame,
          prevFrameHash: `0x${'34'.repeat(32)}`,
        },
        frameHanko: `0x${'56'.repeat(65)}`,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('DUPLICATE_ACK_CACHE_MISSING: height=10');
  });

  test('applyAccountInput ignores obsolete ACK after dispute freeze clears pending frame', async () => {
    const seed = 'account-frame-frozen-obsolete-ack';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const accountMachine = makeProposalAccount([], left.entityId, right.entityId);
    accountMachine.currentHeight = 8;
    accountMachine.currentFrame = {
      ...accountMachine.currentFrame,
      height: 8,
      stateHash: `0x${'ef'.repeat(32)}`,
    };
    accountMachine.status = 'disputed';
    delete accountMachine.pendingFrame;
    delete accountMachine.pendingAccountInput;

    const result = await applyAccountInput(createAccountConsensusContext(env), accountMachine, {
      kind: 'ack',
      fromEntityId: right.entityId,
      toEntityId: left.entityId,
      domain: { ...accountMachine.state.domain },
      ack: { height: 9, frameHash: `0x${'09'.repeat(32)}`, frameHanko: `0x${'12'.repeat(65)}` },
      disputeConfig: { ...accountMachine.state.disputeConfig },
    });

    expect(result.success).toBe(true);
    expect(result.response).toBeUndefined();
    expect(accountMachine.currentHeight).toBe(8);
    expect(result.events.some(event => event.includes('Ignored obsolete ACK for frozen account frame 9'))).toBe(true);
  });

  test('applyAccountInput tolerates reordered next ACK before local pending frame install', async () => {
    const seed = 'account-frame-early-next-ack';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;

    const left = registerLazySigner(seed, '1');
    const right = registerLazySigner(seed, '2');
    const accountMachine = makeProposalAccount([], left.entityId, right.entityId);
    accountMachine.currentHeight = 19;
    accountMachine.currentFrame = {
      ...accountMachine.currentFrame,
      height: 19,
      stateHash: `0x${'ef'.repeat(32)}`,
    };
    delete accountMachine.pendingFrame;
    delete accountMachine.pendingAccountInput;

    const result = await applyAccountInput(createAccountConsensusContext(env), accountMachine, {
      kind: 'ack',
      fromEntityId: right.entityId,
      toEntityId: left.entityId,
      domain: { ...accountMachine.state.domain },
      ack: { height: 20, frameHash: `0x${'20'.repeat(32)}`, frameHanko: `0x${'12'.repeat(65)}` },
      disputeConfig: { ...accountMachine.state.disputeConfig },
    });

    expect(result.success).toBe(true);
    expect(result.response).toBeUndefined();
    expect(accountMachine.currentHeight).toBe(19);
    expect(accountMachine.pendingFrame).toBeUndefined();
    expect(result.events).toContain('Ignored early ACK for frame 20 (current=19, pending=none)');
  });

  test('applyAccountInput rejects frames whose byLeft does not match the signed proposer', async () => {
    const seed = 'account-frame-by-left-binding';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.state.timestamp = 10_000;

    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);

    const receiverAccount = makeProposalAccount([], left.entityId, right.entityId);
    receiverAccount.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };

    const tx: AccountTx = {
      type: 'set_credit_limit',
      data: { tokenId: 1, amount: 100n },
    };
    const maliciousFrame = {
      height: 1,
      timestamp: env.state.timestamp,
      jHeight: 0,
      accountTxs: [tx],
      prevFrameHash: 'genesis',
      accountStateRoot: `0x${'00'.repeat(32)}`,
      stateHash: '',
      byLeft: false,
      deltas: [
        {
          tokenId: 1,
          collateral: 0n,
          ondelta: 0n,
          offdelta: 0n,
          leftCreditLimit: 100n,
          rightCreditLimit: 0n,
          leftAllowance: 0n,
          rightAllowance: 0n,
          leftHold: 0n,
          rightHold: 0n,
        },
      ],
    };
    maliciousFrame.stateHash = await createFrameHash(maliciousFrame);
    const [newHanko] = await signEntityHashes(env, left.entityId, left.signerId, [maliciousFrame.stateHash]);

    const result = await applyAccountInput(createAccountConsensusContext(env), receiverAccount, {
      kind: 'frame',
      fromEntityId: left.entityId,
      toEntityId: right.entityId,
      domain: { ...receiverAccount.state.domain },
      disputeConfig: { ...receiverAccount.state.disputeConfig },
      proposal: { frame: maliciousFrame, frameHanko: newHanko! },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Frame proposer side mismatch');
    expect(receiverAccount.state.deltas.get(1)?.leftCreditLimit ?? 0n).toBe(0n);
  });

  test('applyAccountInput rejects dispute seal hash mismatch before committing frame', async () => {
    const seed = 'account-frame-poisoned-dispute-seal';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.state.timestamp = 10_000;

    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);

    const receiverAccount = makeProposalAccount([], left.entityId, right.entityId);
    receiverAccount.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };
    const tx: AccountTx = {
      type: 'set_credit_limit',
      data: { tokenId: 1, amount: 100n },
    };
    const frame = {
      height: 1,
      timestamp: env.state.timestamp,
      jHeight: 0,
      accountTxs: [tx],
      prevFrameHash: 'genesis',
      accountStateRoot: `0x${'00'.repeat(32)}`,
      stateHash: '',
      byLeft: true,
      deltas: [
        {
          tokenId: 1,
          collateral: 0n,
          ondelta: 0n,
          offdelta: 0n,
          leftCreditLimit: 100n,
          rightCreditLimit: 0n,
          leftAllowance: 0n,
          rightAllowance: 0n,
          leftHold: 0n,
          rightHold: 0n,
        },
      ],
    };
    frame.stateHash = await createFrameHash(frame);
    const [newHanko] = await signEntityHashes(env, left.entityId, left.signerId, [frame.stateHash]);
    const poisonedHash = `0x${'ab'.repeat(32)}`;
    const [newDisputeHanko] = await signEntityHashes(env, left.entityId, left.signerId, [poisonedHash]);

    const result = await applyAccountInput(createAccountConsensusContext(env), receiverAccount, {
      kind: 'frame',
      fromEntityId: left.entityId,
      toEntityId: right.entityId,
      domain: { ...receiverAccount.state.domain },
      disputeConfig: { ...receiverAccount.state.disputeConfig },
      proposal: {
        frame,
        frameHanko: newHanko!,
        disputeSeal: {
          hanko: newDisputeHanko!,
          hash: poisonedHash,
          proofBodyHash: `0x${'11'.repeat(32)}`,
          proofNonce: 0,
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ACCOUNT_PROPOSAL:DISPUTE_SEAL_HASH_MISMATCH');
    expect(receiverAccount.currentHeight).toBe(0);
    expect(receiverAccount.state.deltas.get(1)?.leftCreditLimit ?? 0n).toBe(0n);
    expect(receiverAccount.counterpartyDisputeHash).toBeUndefined();
  });

  test('invalid simultaneous proposal cannot roll back the pending frame', async () => {
    const seed = 'invalid-simultaneous-proposal-is-atomic';
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
    if (!leftProposal.success || !leftProposal.accountInput || leftProposal.accountInput.kind !== 'frame') {
      throw new Error(`LEFT_SIMULTANEOUS_PROPOSAL_FAILED:${leftProposal.error ?? 'missing frame'}`);
    }
    if (!rightProposal.success || !rightProposal.accountInput || rightProposal.accountInput.kind !== 'frame') {
      throw new Error(`RIGHT_SIMULTANEOUS_PROPOSAL_FAILED:${rightProposal.error ?? 'missing frame'}`);
    }
    const sealedLeftProposal = await sealAccountDraftAsEntity(
      env,
      left.entityId,
      left.signerId,
      leftProposal,
    );

    const invalidInput = structuredClone(sealedLeftProposal);
    invalidInput.proposal.frameHanko = `0x${'ff'.repeat(65)}`;
    const stateBefore = safeStringify(rightAccount);
    const result = await applyAccountInput(createAccountConsensusContext(env), rightAccount, invalidInput);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid hanko signature');
    expect(safeStringify(rightAccount)).toBe(stateBefore);

    const accepted = await applyAccountInput(createAccountConsensusContext(env), rightAccount, sealedLeftProposal);
    expect(accepted.success).toBe(true);
    expect(rightAccount.currentHeight).toBe(1);
    // Account apply only commits the winning frame and restores the losing
    // intent. The Entity's one final proposableAccounts pass owns creation of
    // the successor frame, so direct apply must not install it early.
    expect(rightAccount.pendingFrame).toBeUndefined();
    expect(rightAccount.mempool).toEqual([{ type: 'add_delta', data: { tokenId: 2 } }]);
    expect(rightAccount.rollbackCount).toBe(1);
  });

  test('LEFT always wins a valid same-height collision regardless of settlement evidence', async () => {
    const seed = 'settlement-nonce-collision-left-wins';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.state.timestamp = 10_000;

    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);

    const staleSettlementSeal: AccountTx = {
      type: 'settle_transition',
      data: {
        kind: 'seal',
        revision: 1,
        workspaceHash: `0x${'71'.repeat(32)}`,
        settlementNonce: 1,
        settlementHash: `0x${'72'.repeat(32)}`,
        postProof: {
          nonce: 2,
          proofBodyHash: `0x${'73'.repeat(32)}`,
          disputeHash: `0x${'74'.repeat(32)}`,
          hanko: '0x1234',
        },
        settlementHanko: '0x5678',
      },
    };
    const leftAccount = makeProposalAccount([], left.entityId, right.entityId);
    setSyntheticPendingAccountProposal(leftAccount, [staleSettlementSeal], env.state.timestamp);

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
    const rightProposal = await proposeAccountFrame(createAccountConsensusContext(env), rightAccount, env.state.timestamp);
    if (
      !rightProposal.success ||
      !rightProposal.accountInput ||
      rightProposal.accountInput.kind !== 'frame' ||
      !rightProposal.accountInput.proposal.disputeSeal
    ) {
      throw new Error(`RIGHT_NONCE_COLLISION_PROPOSAL_FAILED:${rightProposal.error ?? 'missing signed proof'}`);
    }
    expect(rightProposal.accountInput.proposal.disputeSeal.proofNonce).toBe(1);
    const sealedRightProposal = await sealAccountDraftAsEntity(
      env,
      right.entityId,
      right.signerId,
      rightProposal,
    );

    const result = await applyAccountInput(createAccountConsensusContext(env), leftAccount, sealedRightProposal);
    expect(result.success).toBe(true);
    expect(result.events).toContainEqual(expect.stringContaining('LEFT-WINS'));
    expect(result.response).toEqual(leftAccount.pendingAccountInput);
    expect(leftAccount.currentHeight).toBe(0);
    expect(leftAccount.pendingFrame?.accountTxs).toEqual([staleSettlementSeal]);
    expect(leftAccount.mempool).toEqual([]);
    expect(leftAccount.rollbackCount).toBe(0);
  });

  test('deadline rejection preserves the complete live Account and warmed commitment cache', async () => {
    const seed = 'deadline-rejection-complete-account-atomicity';
    const env = createEmptyEnv(seed);
    env.quietRuntimeLogs = true;
    env.state.timestamp = 10_000;

    const first = registerLazySigner(seed, '1');
    const second = registerLazySigner(seed, '2');
    const left = isLeftEntity(first.entityId, second.entityId) ? first : second;
    const right = left === first ? second : first;
    attachSigningReplica(env, left.entityId, left.signerId);
    attachSigningReplica(env, right.entityId, right.signerId);

    const receiver = makeProposalAccount([{ type: 'add_delta', data: { tokenId: 2 } }], left.entityId, right.entityId);
    receiver.proofHeader = { fromEntity: right.entityId, toEntity: left.entityId, nextProofNonce: 0 };
    receiver.state.deltas.set(1, {
      ...createDefaultDelta(1),
      rightCreditLimit: 100n,
      rightHold: 5n,
    });
    receiver.state.locks.set('existing-lock', {
      lockId: 'existing-lock',
      hashlock: `0x${'31'.repeat(32)}`,
      timelock: 100_000n,
      revealBeforeHeight: 100,
      amount: 5n,
      tokenId: 1,
      senderIsLeft: false,
      createdHeight: 0,
      createdTimestamp: 0,
    });
    receiver.state.swapOffers.set('existing-offer', {
      offerId: 'existing-offer',
      giveTokenId: 1,
      giveAmount: 7n,
      wantTokenId: 2,
      wantAmount: 9n,
      makerIsLeft: false,
      createdHeight: 0,
    });

    const localPending = await proposeAccountFrame(createAccountConsensusContext(env), receiver, env.state.timestamp);
    if (!localPending.success || !localPending.accountInput) {
      throw new Error(`TEST_LOCAL_PENDING_PROPOSAL_FAILED:${localPending.error ?? 'missing input'}`);
    }
    const beforeBytes = encodeBuffer(projectAccountDoc(receiver));
    const beforeState = safeStringify(receiver);
    const beforeRoot = computeAccountStateRoot(receiver.state);
    expect(computeAccountStateRootCold(receiver.state)).toBe(beforeRoot);

    const opaqueOffer = {
      version: 'xln:htlc-multi-recipient:v1',
      manifest: {
        entityId: right.entityId,
        threshold: 0,
        attestations: [],
        hash: `0x${'41'.repeat(32)}`,
      },
      profileCertification: {
        profileHash: `0x${'42'.repeat(32)}`,
        routingStateHash: `0x${'43'.repeat(32)}`,
        hanko: `0x${'44'.repeat(65)}`,
      },
      contextHash: `0x${'45'.repeat(32)}`,
      nonce: 'AAAAAAAAAAAAAAAA',
      ciphertext: 'AAAA',
      recipients: [],
    } as MultiRecipientCiphertext;
    const frame: AccountFrame = {
      height: 1,
      timestamp: env.state.timestamp,
      jHeight: 0,
      accountTxs: [
        {
          type: 'htlc_resolve',
          data: { lockId: 'existing-lock', outcome: 'offer', offer: opaqueOffer },
        },
        {
          type: 'htlc_lock',
          data: {
            lockId: 'unsafe-lock',
            hashlock: `0x${'51'.repeat(32)}`,
            timelock: BigInt(env.state.timestamp + HTLC_ENFORCEMENT_RESERVE_MS),
            revealBeforeHeight: 100,
            amount: 1n,
            tokenId: 1,
          },
        },
      ],
      prevFrameHash: 'genesis',
      accountStateRoot: `0x${'00'.repeat(32)}`,
      stateHash: '',
      byLeft: true,
      deltas: [],
    };
    frame.stateHash = await createFrameHash(frame);
    const [frameHanko] = await signEntityHashes(env, left.entityId, left.signerId, [frame.stateHash]);
    const rejected = await applyAccountInput(
      createAccountConsensusContext(env),
      receiver,
      {
        kind: 'frame',
        fromEntityId: left.entityId,
        toEntityId: right.entityId,
        domain: { ...receiver.state.domain },
        disputeConfig: { ...receiver.state.disputeConfig },
        proposal: { frame, frameHanko: frameHanko! },
      },
      {
        entityTimestamp: env.state.timestamp,
        finalizedJHeight: 0,
      },
    );

    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain('HTLC_LOCK_ENFORCEMENT_WINDOW_TOO_SHORT');
    expect(safeStringify(receiver)).toBe(beforeState);
    expect(buffersEqual(encodeBuffer(projectAccountDoc(receiver)), beforeBytes)).toBeTrue();
    expect(receiver.pendingFrame).toEqual(localPending.accountInput.proposal.frame);
    expect(receiver.pendingAccountInput).toEqual(localPending.accountInput);
    expect(receiver.mempool).toEqual([]);
    expect(receiver.state.locks.get('existing-lock')?.secretOffer).toBeUndefined();
    expect(receiver.state.swapOffers.get('existing-offer')?.giveAmount).toBe(7n);
    const afterTiming: Parameters<typeof computeAccountStateRoot>[1] = {};
    expect(computeAccountStateRoot(receiver.state, afterTiming)).toBe(beforeRoot);
    expect(computeAccountStateRootCold(receiver.state)).toBe(beforeRoot);
    for (const namespace of ['deltas', 'locks', 'swapOffers']) {
      expect(afterTiming.mapStatus?.[namespace]).toMatchObject({ mode: 'cached', dirtyKeys: 0 });
    }
  });
});
